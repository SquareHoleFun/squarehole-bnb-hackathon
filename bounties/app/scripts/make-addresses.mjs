// Writes the page's addresses file for chain 97 FROM the entries' own deployment files, so nobody types an address:
//   ../flap/deployments/97.json       the factories (written by the Flap entry's Deploy script)
//   ../flap/deployments/97-sale.json  the first sale (written by its CreateSale script)
//   ../flap/deployments/97-usdt.json  the token-quote factories (DeployToken), and 97-usdt-sale.json, once they exist
//   ../flap/deployments/97-rules-native.json, 97-rules-usdt.json  the rules pairs (DeployRules), once they exist
//   ../openfour/deployments/97.json   the OpenFour copy and its tokens, once that entry's real run exists (optional)
//   ../core/deployments/97-rail-shop.json  the card shops' factory (core's DeployRailShopFactory: `.factory`), once it exists
//   ../flap/deployments/97-stake.json      the holders' stake factory (flap's DeployStake: `.factory`), once it exists
// usage: node scripts/make-addresses.mjs [out]   (default public/addresses.json; `--check` compares instead of writing)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => {
  const p = path.join(app, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : undefined;
};

const RECORDED_RULES_SALES = [
  '../flap/deployments/97-rules-native-sale.json',
  '../flap/deployments/97-rules-usdt-sale.json',
  '../flap/deployments/97-shop-rules-usdt-sale.json',
].map(read).filter((sale) => sale !== undefined);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const RPC_URLS = ['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-testnet-dataseed.bnbchain.org'];

/** What the page calls the token quote on screen (its on-chain symbol is "USD"). */
export const TEST_QUOTE_LABEL = 'USDT (test)';

function rulesPair({ launcherFactory, rulesVaultFactory }, kind, recordedSales) {
  const sales = recordedSales
    .filter((sale) => (sale.quote === ZERO_ADDRESS ? 'native' : 'token') === kind)
    .filter((sale) => sale.rulesVaultFactory === undefined || sale.rulesVaultFactory.toLowerCase() === rulesVaultFactory.toLowerCase())
    .map(({ launcher, token }) => ({ launcher, token }));
  return { launcherFactory, rulesVaultFactory, sales };
}

export function addressesFor({ flap, sale, usdt, usdtSale, openfour, rulesNative, rulesUsdt, shops, stake }, recordedSales = RECORDED_RULES_SALES) {
  if (!flap || flap.chainId !== 97) throw new Error('the Flap deployment file must be for chain 97');
  const out = {
    chainId: 97,
    rpcUrl: RPC_URLS[0],
    rpcUrls: RPC_URLS,
    explorer: 'https://testnet.bscscan.com',
    // the earliest of the deployments' first blocks: every factory's and Core's creation events are read from there
    fromBlock: String(
      [flap.deployBlock, usdt?.deployBlock, rulesNative?.deployBlock, rulesUsdt?.deployBlock, openfour?.fromBlock === undefined ? undefined : Number(openfour.fromBlock)]
        .filter((b) => typeof b === 'number')
        .reduce((a, b) => Math.min(a, b)),
    ),
    flap: {
      portal: flap.portal,
      tokenImpl: flap.tokenImpl,
      pileVaultFactory: flap.pileVaultFactory,
      curveLauncherFactory: flap.curveLauncherFactory,
      sales: sale ? [{ launcher: sale.launcher, token: sale.token }] : [],
      ...(usdt
        ? {
            tokenQuote: {
              quote: usdt.quote,
              label: TEST_QUOTE_LABEL,
              launcherFactory: usdt.tokenCurveLauncherFactory,
              pileVaultFactory: usdt.tokenPileVaultFactory,
              sales: usdtSale ? [{ launcher: usdtSale.launcher, token: usdtSale.token }] : [],
            },
          }
        : {}),
      // SH-287: lane f's rules pairs (deployments/97-rules-native.json, 97-rules-usdt.json), once they exist.
      ...(rulesNative || rulesUsdt
        ? {
            rules: {
              ...(rulesNative ? { native: rulesPair(rulesNative, 'native', recordedSales) } : {}),
              ...(rulesUsdt ? { token: rulesPair(rulesUsdt, 'token', recordedSales) } : {}),
            },
          }
        : {}),
    },
  };
  if (openfour) {
    out.openfour = {
      core: openfour.core,
      tools: openfour.tools,
      ...(openfour.wbnb ? { wbnb: openfour.wbnb } : {}),
      ...(openfour.presetId !== undefined ? { presetId: String(openfour.presetId) } : {}),
      ...(openfour.taxPresetId !== undefined ? { taxPresetId: String(openfour.taxPresetId) } : {}),
      ...(openfour.taxTemplate ? { taxTemplate: openfour.taxTemplate } : {}),
      ...(openfour.rulesTemplate ? { rulesTemplate: openfour.rulesTemplate } : {}),
      ...(openfour.quotes ? { quotes: openfour.quotes } : {}),
      tokens: (openfour.tokens ?? []).map((t) => ({
        token: t.token,
        ...(t.kind ? { kind: t.kind } : {}),
        ...(t.pile ? { pile: t.pile } : {}),
        ...(t.taxVaultClone ? { taxVaultClone: t.taxVaultClone } : {}),
        ...(typeof t.tokenUri === 'string' ? { tokenUri: t.tokenUri } : {}),
      })),
    };
  }
  // SH-281 step 3: the two factories whose payees the pages name and link; nothing without their files.
  for (const [name, f] of [['shops', shops], ['railStake', stake]]) {
    if (!f) continue;
    if (f.chainId !== undefined && Number(f.chainId) !== 97) throw new Error(`the ${name} deployment file must be for chain 97`);
    if (typeof f.factory !== 'string') throw new Error(`the ${name} deployment file has no factory`);
    out[name] = { factory: f.factory };
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const check = process.argv.includes('--check');
  const target = path.join(app, process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'public/addresses.json');
  const text =
    JSON.stringify(
      addressesFor({
        flap: read('../flap/deployments/97.json'),
        sale: read('../flap/deployments/97-sale.json'),
        usdt: read('../flap/deployments/97-usdt.json'),
        usdtSale: read('../flap/deployments/97-usdt-sale.json'),
        openfour: read('../openfour/deployments/97.json'),
        rulesNative: read('../flap/deployments/97-rules-native.json'),
        rulesUsdt: read('../flap/deployments/97-rules-usdt.json'),
        shops: read('../core/deployments/97-rail-shop.json'),
        stake: read('../flap/deployments/97-stake.json'),
      }),
      null,
      2,
    ) + '\n';
  if (check) {
    const now = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (now !== text) {
      console.error(`${path.relative(app, target)} differs from the deployment files: run node scripts/make-addresses.mjs`);
      process.exit(1);
    }
    console.log('addresses file matches the deployment files');
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    console.log(`wrote ${path.relative(app, target)}`);
  }
}
