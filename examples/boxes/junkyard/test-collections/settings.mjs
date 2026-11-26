// Offline public bindings -> the Create page's actual Download BoxSpec serializer. No chain client or signer.
import '../../../../packages/chain/scripts/register-ts.mjs';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildKit, settingsText, json } from '../../../../scripts/kits/settings.mjs';
import { pictureTypes } from '../../../../scripts/kits/app.mjs';
import { readBytes } from '../../../../scripts/ipfs/pin-raw-lib.mjs';
import { collections } from './art.mjs';

function exactKeys(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'object required');
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'binding keys');
}
function raw(value, max = (1n << 128n) - 1n) {
  assert.ok(typeof value === 'string' && /^[1-9][0-9]*$/.test(value), 'positive raw decimal string required');
  const parsed = BigInt(value);
  assert.ok(parsed <= max, 'raw value out of range');
  return parsed;
}
function address(value) {
  assert.ok(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !/^0x0{40}$/.test(value), 'address required');
  return value; // as given: the launch tooling refuses lowercased addresses (SH-LAKE-HOUSE's Junkyard replay, F1)
}

export async function buildSettings(bindings) {
  exactKeys(bindings, ['chainId', 'blockNumber', 'safe', 'factory', 'nativeRaise', 'testGold', 'collections', ...(bindings?.creatorBuy === undefined ? [] : ['creatorBuy'])]);
  assert.equal(bindings.chainId, '11155111', 'Sepolia only');
  raw(bindings.blockNumber);
  exactKeys(bindings.testGold, ['address', 'name', 'symbol', 'decimals', 'listingId', 'raise']);
  const gold = bindings.testGold;
  assert.equal(gold.name, 'Test Gold');
  assert.equal(gold.symbol, 'tGOLD');
  assert.equal(gold.decimals, '18');
  raw(gold.listingId, (1n << 32n) - 1n);
  raw(gold.raise); raw(bindings.nativeRaise); address(bindings.factory);
  exactKeys(bindings.collections, collections.map(c => c.key));
  const addresses = Object.fromEntries(collections.map(c => [c.key, address(bindings.collections[c.key])]));
  assert.equal(new Set(Object.values(addresses)).size, 5, 'duplicate collection');
  const kit = await buildKit('junkyard', { ...(bindings.creatorBuy === undefined ? {} : { creatorBuy: bindings.creatorBuy }), owner: address(bindings.safe), nativeRaise: bindings.nativeRaise,
    priceListing: { id: gold.listingId, token: address(gold.address), raise: gold.raise }, collections: addresses });
  assert.deepEqual(kit.unresolved, []);
  const logo = Buffer.from(kit.pictures.find(p => p.role === 'logo').bytes);
  const extension = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[pictureTypes.pictureType(logo)];
  return { name: 'trash-boxspec-v2.json', text: settingsText(kit), spec: kit.spec,
    starter: kit.starter.map(item => ({ ...item, id: BigInt(item.id) })), listing: kit.context.pricing, logo, logoName: `logo.${extension}` };
}

export async function writeSettings(bindings, destination) {
  const result = await buildSettings(bindings);
  await mkdir(destination); // fresh directory only; retain partial exports for review
  await writeFile(join(destination, result.name), result.text, { flag: 'wx' });
  await writeFile(join(destination, 'starter.json'), json({ chainId: bindings.chainId, blockNumber: bindings.blockNumber,
    safe: bindings.safe, factory: bindings.factory, items: result.starter }), { flag: 'wx' });
  await writeFile(join(destination, result.logoName), result.logo, { flag: 'wx' });
  await writeFile(join(destination, 'pin-manifest.json'), json({ files: [{ path: result.logoName, role: 'logo', sha256: result.spec.coverSha256 }] }), { flag: 'wx' });
  return result;
}
function isEntry() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isEntry()) {
  try {
    if (process.argv.length !== 4 || process.argv.slice(2).some(arg => arg.startsWith('-'))) throw new Error('usage');
    const bindings = JSON.parse((await readBytes(process.argv[2], 65_536)).toString('utf8'));
    await writeSettings(bindings, process.argv[3]);
    process.stdout.write('Wrote trash-boxspec-v2.json, starter.json and public logo pin manifest. No transaction sent.\n');
  } catch {
    process.stderr.write('Settings export refused; use settings.mjs PUBLIC_BINDINGS_JSON NEW_DIRECTORY with verified Sepolia bindings.\n');
    process.exitCode = 1;
  }
}
