#!/usr/bin/env bash
# Browser tests of the OpenFour rail against a LOCAL FORK of BSC Testnet (anvil, port 8581 by default; reads only from
# the public endpoint). Uses the OpenFour entry's own tools in a copy outside this tree, as its rehearsal does: the
# kit's fork-deploy brings up a developer-owned copy, then the entry's scripts/pile.js makes a quote coin and the tax
# template, registers the Pile Bonding preset and creates one token of each kind. Writes public/local/addresses.json,
# runs e2e/four.spec.ts (one worker, port 5471) as the entry's signer address (impersonated on the fork: no key in
# the page), with the dev server's stand-in for the site's creation signer (scripts/four-sign-standin.cjs), and stops
# anvil. The entry's scripts sign with OPENFOUR_LOCAL_DEV=1: a PUBLIC test key it refuses off a loopback endpoint.
# With FOUR_RULES=1 (SH-287) the fork also gets our RulesTaxVault template (deployed from the entry's compiled artifact by
# the same developer account), the addresses file names it (openfour.rulesTemplate) and the signer stand-in offers the
# tax-rules kind; without it, everything is as before.
# usage: WORK=<folder with bounties/openfour installed (npm ci) and bounties/core> [FOUR_RULES=1] scripts/four-fork.sh [playwright args...]
set -u
cd "$(dirname "$0")/.." || exit 1
APP=$PWD
: "${WORK:?set WORK}"
PORT=${FOUR_FORK_PORT:-8581}
OF=$WORK/bounties/openfour

rsync -a --exclude node_modules --exclude out --exclude .cache --exclude artifacts --exclude cache ../openfour/ "$OF/"
rsync -a --delete --exclude out --exclude cache ../core/ "$WORK/bounties/core/"
cd "$OF" || exit 1
npx hardhat compile --quiet > "$WORK/compile.log" 2>&1 || { echo "compile failed"; tail -n 20 "$WORK/compile.log"; exit 1; }

# shellcheck source=/dev/null
source scripts/local-fork.sh # starts anvil on $PORT, stops it on exit; sets RPC, RPC_URL, OPENFOUR_OUT_DIR
FROM=$(cast block-number -r "$RPC")
export OPENFOUR_LOCAL_DEV=1
DEV=$(cast wallet address --mnemonic "test test test test test test test test test test test junk" --mnemonic-index 4242)
fund "$DEV"
cast rpc anvil_impersonateAccount "$DEV" -r "$RPC" > /dev/null
kit() { node -r ./scripts/signer-preload.js scripts/kit.js "$@" --expect-signer "$DEV" >> "$WORK/pile.log" 2>&1 || { echo "kit $* failed"; tail -n 20 "$WORK/pile.log"; exit 1; }; }
pile() { node -r ./scripts/signer-preload.js scripts/pile.js "$@" --expect-signer "$DEV" >> "$WORK/pile.log" 2>&1 || { echo "pile.js $* failed"; tail -n 20 "$WORK/pile.log"; exit 1; }; }
: > "$WORK/pile.log"
kit fork
pile mock-quote
TETH=$(node -e 'console.log(require(process.argv[1]).quote)' "$PWD/$OPENFOUR_OUT_DIR/mock-quote.json")
pile tax-template
RULES_TEMPLATE=
if [ "${FOUR_RULES:-0}" = 1 ]; then
  RULES_TEMPLATE=$(node -e '
const { ethers } = require("ethers");
const a = require(process.argv[1]);
const p = new ethers.JsonRpcProvider(process.argv[2]);
(async () => {
  const s = await p.getSigner(process.argv[3]);
  const c = await new ethers.ContractFactory(a.abi, a.bytecode, s).deploy("0xD99D1c33F9fC3444f8101754aBC46c52416550D1");
  await c.waitForDeployment();
  console.log(await c.getAddress());
})().catch((e) => { console.error(e.shortMessage || e.message); process.exit(1); });
' "$PWD/artifacts/contracts/RulesTaxVault.sol/RulesTaxVault.json" "$RPC" "$DEV") || { echo "rules template deploy failed"; exit 1; }
  echo "rules template $RULES_TEMPLATE"
fi
QUOTE=$TETH RAISE_AMOUNT=1 pile create-tax
pile register
QUOTE=$TETH RAISE_AMOUNT=1 pile create

node -e '
const fs = require("fs"), path = require("path");
const [dir, rpc, from, out, rulesTemplate] = process.argv.slice(1);
const r = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const fork = r("fork-deployment.json"), quote = r("mock-quote.json").quote;
const preset = r("launch-preset.json"), tax = r("launch-tax.json");
const a = { chainId: 97, rpcUrls: [rpc], explorer: "https://testnet.bscscan.com", fromBlock: from,
  openfour: { core: fork.addresses.core, tools: fork.addresses.tools, wbnb: fork.addresses.wbnb,
    presetId: String(r("preset-registration.json").presetId), taxPresetId: String(fork.presets.bondingTaxV1),
    taxTemplate: r("tax-template.json").template, quotes: [quote],
    tokens: [ { token: preset.token, kind: "preset", pile: preset.pile },
              { token: tax.token, kind: "tax", taxVaultClone: tax.taxVaultClone } ] } };
if (rulesTemplate) a.openfour.rulesTemplate = rulesTemplate;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(a, null, 2) + "\n");
console.log("core", a.openfour.core, "preset token", preset.token, "tax token", tax.token, "from block", from);
' "$PWD/$OPENFOUR_OUT_DIR" "$RPC" "$FROM" "$APP/public/local/addresses.json" "$RULES_TEMPLATE" || exit 1

cd "$APP" || exit 1
export PILE_SIGN_STANDIN=$APP/scripts/four-sign-standin.cjs FOUR_WORK=$WORK FOUR_RPC=$RPC FOUR_OUT=$OF/$OPENFOUR_OUT_DIR FOUR_QUOTES=$TETH FOUR_RULES_TEMPLATE=$RULES_TEMPLATE
FOUR_ACCOUNT=$DEV PILE_RPC=$RPC npx playwright test --workers=1 ${FOUR_SPECS:-e2e/four.spec.ts e2e/four-picture.spec.ts} "$@"
