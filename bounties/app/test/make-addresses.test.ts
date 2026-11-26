import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkConfig } from '../src/lib/config';

// SH-281 step 3b: the generator maps the shop and stake factories from their deployment files when they exist, and
// nothing when they do not (then the output equals the committed file byte for byte).
const here = path.dirname(fileURLToPath(import.meta.url));
const json = (rel: string) => {
  const p = path.join(here, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : undefined;
};
type Gen = { addressesFor: (i: Record<string, unknown>, recordedSales?: Record<string, unknown>[]) => Record<string, unknown> };
const gen = async () => (await import(pathToFileURL(path.join(here, '../scripts/make-addresses.mjs')).href)) as Gen;
const inputs = {
  flap: json('../../flap/deployments/97.json'),
  sale: json('../../flap/deployments/97-sale.json'),
  usdt: json('../../flap/deployments/97-usdt.json'),
  usdtSale: json('../../flap/deployments/97-usdt-sale.json'),
  openfour: json('../../openfour/deployments/97.json'),
  rulesNative: json('../../flap/deployments/97-rules-native.json'),
  rulesUsdt: json('../../flap/deployments/97-rules-usdt.json'),
};
const text = (o: unknown) => JSON.stringify(o, null, 2) + '\n';
// as core's DeployRailShopFactory and flap's DeployStake write them
const SHOP_FILE = { chainId: 97, routers: ['0x00000000000000000000000000000000000000a1'], collections: ['0x00000000000000000000000000000000000000a2'], factory: '0x00000000000000000000000000000000000000f1' };
const STAKE_FILE = { chainId: 97, deployBlock: 123, factory: '0x00000000000000000000000000000000000000f2' };

describe('the addresses file: shop and stake factories', () => {
  it('the files on disk give public/addresses.json byte for byte; neither factory file gives it without those two keys', async () => {
    const { addressesFor } = await gen();
    const onDisk = { ...inputs, shops: json('../../core/deployments/97-rail-shop.json'), stake: json('../../flap/deployments/97-stake.json') };
    const committed = fs.readFileSync(path.join(here, '../public/addresses.json'), 'utf8');
    expect(text(addressesFor(onDisk))).toBe(committed);
    const { shops: _s, railStake: _r, ...rest } = JSON.parse(committed);
    expect(text(addressesFor({ ...inputs, shops: undefined, stake: undefined }))).toBe(text(rest));
  });
  it('each alone, and both: the factory under its key, everything else unchanged, a valid addresses file', async () => {
    const { addressesFor } = await gen();
    const base = addressesFor(inputs);
    const shopOnly = addressesFor({ ...inputs, shops: SHOP_FILE });
    expect(shopOnly).toEqual({ ...base, shops: { factory: SHOP_FILE.factory } });
    const stakeOnly = addressesFor({ ...inputs, stake: STAKE_FILE });
    expect(stakeOnly).toEqual({ ...base, railStake: { factory: STAKE_FILE.factory } });
    const both = addressesFor({ ...inputs, shops: SHOP_FILE, stake: STAKE_FILE });
    expect(both).toEqual({ ...base, shops: { factory: SHOP_FILE.factory }, railStake: { factory: STAKE_FILE.factory } });
    const r = checkConfig(both);
    expect(r.ok && r.value.shops?.factory).toBe(SHOP_FILE.factory);
    expect(r.ok && r.value.railStake?.factory).toBe(STAKE_FILE.factory);
    expect(both.fromBlock).toBe(base.fromBlock); // the factories' reads are direct: the first block stays
  });
  it('refuses a file for another chain or without a factory', async () => {
    const { addressesFor } = await gen();
    expect(() => addressesFor({ ...inputs, shops: { ...SHOP_FILE, chainId: 56 } })).toThrow('chain 97');
    expect(() => addressesFor({ ...inputs, stake: { chainId: 97 } })).toThrow('no factory');
  });
});

describe('the recorded launches', () => {
  const native = json('../../flap/deployments/97-rules-native-sale.json');
  const usdt = json('../../flap/deployments/97-rules-usdt-sale.json');
  const shop = json('../../flap/deployments/97-shop-rules-usdt-sale.json');
  const entry = ({ launcher, token }: { launcher: string; token: string }) => ({ launcher, token });

  it('names all three rules sales in file order under their quote pairs', async () => {
    const { addressesFor } = await gen();
    const out = addressesFor(inputs);
    expect(out).toHaveProperty('flap.rules.native.sales', [entry(native)]);
    expect(out).toHaveProperty('flap.rules.token.sales', [entry(usdt), entry(shop)]);
  });

  it('matches the vault factory regardless of case and leaves out a sale from another factory', async () => {
    const { addressesFor } = await gen();
    const out = addressesFor(inputs, [
      { ...native, rulesVaultFactory: native.rulesVaultFactory.toLowerCase() },
      { ...usdt, rulesVaultFactory: native.rulesVaultFactory },
    ]);
    expect(out).toHaveProperty('flap.rules.native.sales', [entry(native)]);
    expect(out).toHaveProperty('flap.rules.token.sales', []);
  });

  it('gives each pair an empty list without records and omits the pairs without deployments', async () => {
    const { addressesFor } = await gen();
    const out = addressesFor(inputs, []);
    expect(out).toHaveProperty('flap.rules.native.sales', []);
    expect(out).toHaveProperty('flap.rules.token.sales', []);
    expect(addressesFor({ ...inputs, rulesNative: undefined, rulesUsdt: undefined })).not.toHaveProperty('flap.rules');
  });

  it('copies only string picture links for OpenFour tokens', async () => {
    const { addressesFor } = await gen();
    const tokens = [{ token: native.token, tokenUri: '' }, { token: usdt.token, tokenUri: 1 }];
    const out = addressesFor({ ...inputs, openfour: { ...inputs.openfour, tokens } });
    expect(out).toHaveProperty('openfour.tokens', [tokens[0], { token: usdt.token }]);
  });
});
