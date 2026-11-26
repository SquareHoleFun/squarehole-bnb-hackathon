// Writes deployments/97.json from the real run's records (no address typed): the copy, both preset ids, the tax
// template, the two launches, the block the run started at (for a page's event reads), the quote coins a visitor may
// choose and the public read endpoints. The field names are the ones bounties/app/scripts/make-addresses.mjs reads
// (core, tools, wbnb, presetId, taxPresetId, taxTemplate, quotes, tokens[].token/kind/pile/taxVaultClone); the other
// fields are for people and other pages.
// SH-287: when the rules run's records exist (tax-rules-template.json, launch-tax-rules.json), also `rulesTemplate`
// and the rules launch as a token of kind "tax-rules" (with its splitter, pile, rules and picture link).
// usage: node scripts/write-deployment.js <records folder (the run's out/)>
"use strict";

const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
if (!dir) throw new Error("usage: node scripts/write-deployment.js <records folder>");
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const fork = read("fork-deployment.json");
const started = read("fork-started.json");
const reg = read("preset-registration.json");
const tpl = read("tax-template.json");
const tax = read("launch-tax.json");
const preset = read("launch-preset.json");
const optional = (f) => (fs.existsSync(path.join(dir, f)) ? read(f) : null);
const rtpl = optional("tax-rules-template.json");
const rules = optional("launch-tax-rules.json");
if (Boolean(rtpl) !== Boolean(rules)) throw new Error("the rules template and the rules launch: one record without the other");

// One run, one copy: every record names the same endpoint, chain, wallet and Registry.
const run = fork.run;
for (const [name, r] of Object.entries({ reg, tpl, tax, preset, ...(rules ? { rtpl, rules } : {}) })) {
  const x = r.run;
  if (x.chainId !== 97 || x.block1Hash !== run.block1Hash || x.signer !== run.signer || x.registry !== run.registry) throw new Error(`${name}: another run or copy`);
}
if (run.registry !== fork.addresses.registry || started.run.signer !== run.signer) throw new Error("the deployment records disagree");

const out = {
  chainId: 97,
  rpcUrls: ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet-dataseed.bnbchain.org"],
  fromBlock: String(started.startBlock),
  runWallet: run.signer,
  registry: fork.addresses.registry,
  core: fork.addresses.core,
  tools: fork.addresses.tools,
  feeRouter: fork.addresses.feeRouter,
  wbnb: fork.addresses.wbnb,
  presetId: String(reg.presetId),
  taxPresetId: String(fork.presets.bondingTaxV1),
  taxTemplate: tpl.template,
  ...(rules ? { rulesTemplate: rtpl.template } : {}),
  tradeModuleImplementation: reg.tradeModuleImplementation,
  presetValidator: reg.validator,
  quotes: [fork.addresses.wbnb, preset.quote],
  tokens: [
    { token: preset.token, kind: "preset", quote: preset.quote, pile: preset.pile, tradeModule: preset.tradeModule, vault: preset.vault, createTx: preset.createTx },
    { token: tax.token, kind: "tax", quote: tax.quote, pile: tax.pile, taxVaultClone: tax.taxVaultClone, forwardVault: tax.forwardVault, vault: tax.vault, createTx: tax.createTx },
    ...(rules ? [{
      token: rules.token, kind: "tax-rules", quote: rules.quote, splitter: rules.splitter, pile: rules.pile, taxVaultClone: rules.taxVaultClone,
      forwardVault: rules.forwardVault, vault: rules.vault, rules: rules.rules, name: rules.name, symbol: rules.symbol, tokenUri: rules.tokenUri, createTx: rules.createTx,
    }] : []),
  ],
};
const target = path.resolve(__dirname, "..", "deployments", "97.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${path.relative(process.cwd(), target)}`);
