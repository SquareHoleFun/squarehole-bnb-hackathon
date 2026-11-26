#!/usr/bin/env node
/**
 * SH-261: a demo box's settings for BNB Chain testnet (chain 97), written by the kits' own tool
 * (scripts/kits/settings.mjs, the Create page's `buildSpecV2` and Download BoxSpec bytes) from the kit's `bnb` registry
 * row, bound to the chain-97 listings of an extras file (`bnb-testnet/97-extras.json`, written by
 * packages/contracts/script/bnb/bnb-testnet.mjs `files`). Nothing is typed by hand: the listing id, coin and raise come
 * from that file.
 *
 *   node packages/chain/scripts/bnb-boxes/settings.mjs <kit> --extras <97-extras.json> [--out <file>] [--items-out <dir>]
 *
 * Without --out the file goes where the tool puts a profile's settings (examples/boxes/<kit>/settings/bnb/). It reads
 * local files only: no network, no key, no transaction.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const ZERO = '0x0000000000000000000000000000000000000000';
/** A registry coin and the chain-97 listing symbol that stands in for it (lane c's coins, SH-260). */
export const BNB_STAND_INS = Object.freeze({ ETH: 'BNB', NVDAon: 'tNVDA', USDC: 'tUSDC', PAXG: 'tGOLD', TEST_GOLD: 'tGOLD', TEST_PEPE: 'tPEPE' });
/** The kit tool's asset binding keys and the chain-97 coins behind them. */
const ASSET_KEYS = Object.freeze({ TEST_USDC: 'tUSDC', TEST_NVDA: 'tNVDA', TEST_GOLD: 'tGOLD', TEST_PEPE: 'tPEPE' });

/**
 * The public bindings of one kit row on chain 97: its price listing (its raise: the extras file's, or `raise` when
 * given: the raise read from the chain at creation), the native raise, the test coins and, for The Alchemist, the
 * directory id of the converter route from the price coin to the pile coin.
 */
export function bindingsFor(row, extras, { raise = null } = {}) {
  assert.equal(extras.schema, 'square-hole-bnb-testnet-extras/1', 'a chain-97 extras file is required');
  assert.equal(extras.chainId, 97, 'the extras file must be chain 97\'s');
  const symbol = BNB_STAND_INS[row.priceCoin.symbol];
  assert.ok(symbol, `${row.id}: no chain-97 stand-in for ${row.priceCoin.symbol}`);
  const listing = extras.listings.find(l => l.symbol === symbol);
  assert.ok(listing, `${row.id}: chain 97 lists no ${symbol}`);
  assert.equal(String(listing.decimals), row.priceCoin.decimals, `${row.id}: ${symbol} decimals`);
  const native = extras.listings.find(l => l.id === 0);
  assert.ok(native && native.token === ZERO, 'the native listing is id 0');
  const assets = Object.fromEntries(Object.entries(ASSET_KEYS).flatMap(([key, coin]) => extras.coins[coin] ? [[key, extras.coins[coin].address]] : []));
  const alchemist = Object.values(row.fees).some(side => side.choice === 'alchemist');
  let alchemistRow;
  if (alchemist) {
    const pile = BNB_STAND_INS[row.contents.seed.symbol];
    const name = `converter ${symbol} to ${pile}`;
    const module = extras.feeModuleDirectory.modules.find(m => m.name === name && !m.withdrawn);
    assert.ok(module, `${row.id}: chain 97's directory has no route "${name}"`);
    alchemistRow = String(module.id);
  }
  const priceRaise = raise === null ? String(listing.raise) : String(raise);
  return {
    priceListing: { id: String(listing.id), token: listing.token, raise: priceRaise },
    nativeRaise: listing.id === 0 ? priceRaise : String(native.raise),
    assets,
    ...(alchemistRow === undefined ? {} : { alchemistRow }),
  };
}

/**
 * A collection kit's numbered items as Create's Load settings takes them (the bundle's `items/` folder): `<id>.png`, a 3D
 * kit's `<id>.glb` beside it, and `traits.csv`, the reviewed bytes exactly.
 */
export function writeItems(kit, directory) {
  mkdirSync(directory, { recursive: true });
  for (const item of kit.items) {
    writeFileSync(resolve(directory, `${item.id}.png`), item.bytes);
    if (item.model) writeFileSync(resolve(directory, `${item.id}.glb`), item.model.bytes);
  }
  writeFileSync(resolve(directory, 'traits.csv'), kit.traitsCsv);
  return kit.items.length;
}

export async function writeBnbSettings(id, extrasPath, out = null, itemsOut = null, { raise = null } = {}) {
  const { loadProfileExamples } = await import('../../../../packages/box-spec/examples/v2/registry.mjs');
  const { buildKit, settingsPath, settingsText } = await import('../../../../scripts/kits/settings.mjs');
  const row = loadProfileExamples('bnb').find(example => example.id === id);
  assert.ok(row, `no bnb registry row ${id}`);
  const extras = JSON.parse(readFileSync(extrasPath, 'utf8'));
  const bindings = bindingsFor(row, extras, { raise });
  // The price coin's asset binding is the listing's own token (the tool checks they agree).
  const kit = await buildKit(id, bindings, { profile: 'bnb' });
  const path = resolve(ROOT, out ?? settingsPath(kit));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, settingsText(kit));
  const items = itemsOut ? writeItems(kit, resolve(ROOT, itemsOut)) : 0;
  return { path, kit, bindings, items };
}

function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
  try {
    assert.ok(args[0] && !args[0].startsWith('--') && flag('--extras'), 'usage: settings.mjs <kit> --extras <97-extras.json> [--out <file>] [--items-out <dir>]');
    const { path, kit, bindings, items } = await writeBnbSettings(args[0], resolve(flag('--extras')), flag('--out'), flag('--items-out'));
    if (items) process.stdout.write(`${items} items written to ${resolve(ROOT, flag('--items-out'))}\n`);
    process.stdout.write(`${path}\nlisting ${bindings.priceListing.id} ${bindings.priceListing.token} raise ${bindings.priceListing.raise}; ${kit.unresolved.length} unresolved bindings\n`);
    if (kit.unresolved.length > 0) process.stdout.write(`${JSON.stringify(kit.unresolved)}\n`);
  } catch (error) {
    console.error(`bnb settings refused: ${error.message}`);
    process.exitCode = 1;
  }
}
