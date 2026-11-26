import '../../../../packages/chain/scripts/register-ts.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSettings, writeSettings } from './settings.mjs';
import { buildKit, settingsText } from '../../../../scripts/kits/settings.mjs';
import { collections } from './art.mjs';
const { boxSpecFile } = await import('../../../../apps/web/src/features/create/v2/model.ts');
const { decodeBoxSpecV2, encodeBoxSpecV2, specHashV2 } = await import('../../../../packages/box-spec/src/generated/box-spec.v2.ts');
const { shopConfigV2 } = await import('../../../../packages/chain/src/core/v2/m2-spec-v2.ts');
const { parseAttributes } = await import('../../../../packages/artwork/src/attributes.ts');
const { readArt } = await import('../../../../apps/web/src/features/create/art-files.ts');

const address = n => `0x${BigInt(n).toString(16).padStart(40, '0')}`;
const bindings = () => ({ chainId: '11155111', blockNumber: '12345678', safe: address(40), factory: address(41),
  nativeRaise: '4206980085000000000',
  testGold: { address: address(42), name: 'Test Gold', symbol: 'tGOLD', decimals: '18', listingId: '9', raise: '1000000000000000000' },
  collections: Object.fromEntries(collections.map((c, i) => [c.key, address(50 + i)])),
});
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const scratch = () => { mkdirSync(join(root, '.cache/tmp'), { recursive: true }); return mkdtempSync(join(root, '.cache/tmp/junk-settings-')); };

test('settings use Download BoxSpec bytes, Test Gold, five collections and ten committed starter ids', async () => {
  const input = bindings();
  const result = await buildSettings(input);
  const body = JSON.parse(result.text);
  assert.equal(result.name, 'trash-boxspec-v2.json');
  assert.equal(body.format, 'squarehole.boxspec/2');
  assert.equal(body.revealList, null);
  assert.equal(body.demo, undefined);
  assert.equal(body.spec.boxType, 4);
  assert.equal(body.spec.pricing.token, input.testGold.address);
  assert.equal(body.spec.raise, input.testGold.raise);
  assert.equal(body.encoded, encodeBoxSpecV2(result.spec));
  assert.equal(body.specHash, specHashV2(decodeBoxSpecV2(body.encoded)));
  assert.equal(body.pictures.length, 1); // stock NFTs are external collections, not the shop's own art
  const logo = body.pictures[0];
  assert.equal(logo.role, 'logo');
  assert.equal(logo.sha256, `0x${createHash('sha256').update(Buffer.from(logo.base64, 'base64')).digest('hex')}`);
  assert.equal(logo.sha256, result.spec.coverSha256);
  const canonical = boxSpecFile(result.spec, { pricing: result.listing, listings: [result.listing] },
    { pictures: [{ role: 'logo', sha256: logo.sha256, bytes: Buffer.from(logo.base64, 'base64') }], revealList: null });
  assert.equal(result.text, canonical.parts.join(''));
  const shop = shopConfigV2(result.spec.contentsParams);
  assert.deepEqual(shop.collections.map(c => c.toLowerCase()), Object.values(input.collections));
  assert.equal(shop.curator.toLowerCase(), input.safe);
  assert.equal(shop.seedT, 180000000000000000000000000n);
  assert.equal(shop.pickBps, 20000);
  assert.equal(shop.listDelay, 604800);
  assert.equal(result.starter.length, 10);
  for (let i = 0; i < 5; ++i) assert.deepEqual(result.starter.slice(i * 2, i * 2 + 2).map(s => s.id), [1n, 2n]);
  assert.equal(result.starter.at(-1).nextHash, `0x${'0'.repeat(64)}`);
});

test('bindings refuse wrong chain, incomplete/duplicate collections, non-test gold and imprecise amounts', async () => {
  const reject = async edit => { const input = bindings(); edit(input); await assert.rejects(buildSettings(input)); };
  await reject(b => { b.chainId = '1'; });
  await reject(b => { b.safe = address(0); });
  await reject(b => { b.collections[collections[0].key] = b.collections[collections[1].key]; });
  await reject(b => { b.collections = Object.fromEntries(Object.entries(b.collections).slice(1)); });
  await reject(b => { b.collections.extra = address(100); });
  await reject(b => { b.testGold.name = 'Gold'; });
  await reject(b => { b.testGold.symbol = 'PAXG'; });
  await reject(b => { b.testGold.decimals = '6'; });
  await reject(b => { b.testGold.listingId = '4294967296'; });
  await reject(b => { b.testGold.raise = 1000000000000000000; });
  await reject(b => { b.nativeRaise = '0'; });
  await reject(b => { b.testGold.raise = '1e18'; });
  await reject(b => { b.openAt = '1'; }); // recipe structure has no unreviewed override
});

test('numbered PNGs and optional traits pass the Create page reader for every collection', async () => {
  for (const c of collections) {
    const text = readFileSync(new URL(`art/${c.key}/traits.json`, import.meta.url), 'utf8');
    const parsed = parseAttributes('traits.json', text);
    assert.equal(parsed.ok, true);
    assert.deepEqual([...parsed.items.keys()], ['1', '2']);
    const files = ['1', '2'].map(id => new File([readFileSync(new URL(`art/${c.key}/${id}.png`, import.meta.url))], `${id}.png`));
    files.push(new File([text], 'traits.json'));
    const art = await readArt(files, { env: {
      digest: async bytes => `0x${createHash('sha256').update(bytes).digest('hex')}`,
      thumbnail: async () => null,
      salt: () => `0x${'0'.repeat(64)}`, // reader-only public test input; no hidden edition is built
    } });
    assert.deepEqual(art.problems, []);
    assert.deepEqual(art.items.map(item => item.id), [1, 2]);
    assert.ok(art.items.every(item => item.traits.length === 2));
  }
});

test('settings writer is fresh-directory only and CLI handles symlinks without import side effects', async () => {
  const dir = scratch();
  const result = await writeSettings(bindings(), join(dir, 'export'));
  assert.equal(readFileSync(join(dir, 'export', result.name), 'utf8'), result.text);
  const starter = JSON.parse(readFileSync(join(dir, 'export', 'starter.json'), 'utf8'));
  assert.equal(starter.items.length, 10);
  assert.equal(starter.chainId, '11155111');
  await assert.rejects(writeSettings(bindings(), join(dir, 'export')));
  symlinkSync(fileURLToPath(new URL('./', import.meta.url)), join(dir, 'kit'), 'dir');
  const bad = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', join(dir, 'kit/settings.mjs'), '--unknown'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Settings export refused/);
  const imported = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('settings.mjs', import.meta.url).href)})`], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout + imported.stderr, '');
});

test('L1: the two Junkyard entry points produce identical settings and free-tier logos', async () => {
  const b = bindings();
  const legacy = await buildSettings(b);
  const kit = await buildKit('junkyard', { owner: b.safe, nativeRaise: b.nativeRaise,
    priceListing: { id: b.testGold.listingId, token: b.testGold.address, raise: b.testGold.raise }, collections: b.collections });
  assert.equal(legacy.text, settingsText(kit));
  const { fitsFree } = await import('../../../../apps/web/src/features/pictures/arweave-publish.ts');
  const { pictureType } = await import('../../../../apps/web/src/features/pictures/picture-type.ts');
  assert.ok(fitsFree(11155111, 107_520)(legacy.logo.length, pictureType(legacy.logo)));
});
