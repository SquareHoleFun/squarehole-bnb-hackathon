import { reviewedManifestForPlatform } from '../kits/bag-holders-normal-zero-platform-exception.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { buildKit, cliArgs, KIT_IDS, planManifest, settingsPath, settingsText, writeSettings } from '../kits/settings.mjs';
import { BINDING_SLOTS, JUNKYARD_SEPOLIA_COLLECTIONS, SHOP_STOCK_COLLECTIONS, SEPOLIA_STAND_INS } from '../kits/catalog.mjs';
import { specV2, modelV2, artwork, recipes } from '../kits/app.mjs';
import { UNIQUE_KITS } from '../kits/unique.mjs';
const { validateBoxSpecV2, decodeBoxSpecV2 } = specV2;
const { boxSpecFile } = modelV2;
const { sha256Hex, unpackTraits } = artwork;
const THREE_D = ['rent-free', 'bag-holders'];

// Independent decoder checks the actual metadataTable wire bytes, including string lengths and EOF.
function decodeMetadataTable(bytes) {
  let offset = 0;
  assert.equal(bytes[offset++], 1);
  const descriptionLength = bytes.readUInt16BE(offset); offset += 2 + descriptionLength;
  const text = () => { const n = bytes[offset++]; const value = bytes.subarray(offset, offset + n).toString('ascii'); offset += n; return value; };
  const traitTypes = Array.from({ length: bytes[offset++] }, () => {
    const name = text();
    return { name, values: Array.from({ length: bytes[offset++] }, text) };
  });
  assert.equal(offset, bytes.length);
  return { traitTypes };
}

for (const id of KIT_IDS) {
  test(`${id}: deterministic Create download, validated spec and embedded picture bytes`, async () => {
    // Unique producers have their one fresh double-build test in kits-unique.test.mjs.
    const options = { fresh: !Object.hasOwn(UNIQUE_KITS, id) };
    const kit = await buildKit(id, {}, options);
    const text = settingsText(kit);
    assert.equal(settingsText(await buildKit(id, {}, options)), text);
    assert.equal(text, boxSpecFile(kit.spec, kit.context, { pictures: kit.pictures, models: kit.models, revealList: kit.revealList }).parts.join(''));
    if (['rent-free', 'bag-holders', 'link-marines-v2', 'exit-liquidity'].includes(id)) {
      const manifest = reviewedManifestForPlatform(id, JSON.parse(readFileSync(`examples/boxes/${id}/unique/manifest.json`, 'utf8')));
      const rows = manifest.entries ?? manifest.items;
      assert.equal(new Set(kit.items.map(item => item.sha256)).size, rows.length);
      const types = decodeMetadataTable(Buffer.from(kit.spec.metadataTable.slice(2), 'hex')).traitTypes;
      assert.equal(kit.traitsCsv.split('\n')[0], ['id', ...Object.keys(rows[0].traits)].join(','));
      for (const [index, entry] of kit.revealList.items.entries()) {
        const wanted = rows[index];
        assert.equal(entry.imageSha256, `0x${wanted.picture.sha256}`);
        assert.equal(entry.modelSha256, THREE_D.includes(id) ? `0x${wanted.model.sha256}` : `0x${'0'.repeat(64)}`);
        assert.equal(kit.art.items[index].modelSha256, THREE_D.includes(id) ? `0x${wanted.model.sha256}` : undefined, 'Create’s reader holds the reviewed model');
        const values = unpackTraits(BigInt(entry.traitsPacked), types.length);
        assert.deepEqual(Object.fromEntries(types.map((type, i) => [type.name, type.values[values[i] - 1]])), wanted.traits);
        assert.deepEqual(Object.fromEntries(kit.art.items[index].traits.map(t => [t.trait, t.value])), wanted.traits);
      }
    }
    const file = JSON.parse(text);
    // SH-CREATE-ITEM-MODELS: a 3D kit's file carries its models (typed GLBs, exact bytes); every other file is as before.
    assert.deepEqual(Object.keys(file), ['format', 'specHash', 'encoded', 'spec', 'pictures', ...(THREE_D.includes(id) ? ['models'] : []), 'revealList']);
    if (THREE_D.includes(id)) {
      const listed = new Set(kit.revealList.items.map(entry => entry.modelSha256));
      assert.equal(file.models.length, listed.size);
      assert.deepEqual(file.models.map(model => model.sha256), [...listed].sort(), 'each distinct model once, in sha256 order');
      for (const model of file.models) {
        assert.equal(model.type, 'model/gltf-binary');
        assert.equal(artwork.glbSha256(Buffer.from(model.base64, 'base64')), model.sha256, 'a self-contained GLB with its committed sha256');
      }
    }
    assert.equal(file.format, 'squarehole.boxspec/2');
    assert.equal(file.spec.pricing.listingId, 0);
    assert.equal(file.spec.openAt, 0);
    assert.equal(validateBoxSpecV2(decodeBoxSpecV2(file.encoded), { listing: kit.context.pricing }).reason, 0);
    for (const picture of file.pictures) assert.equal(sha256Hex(Buffer.from(picture.base64, 'base64')), picture.sha256);
    const row = JSON.parse(readFileSync(`packages/box-spec/examples/v2/${id}.json`, 'utf8'));
    assert.equal(file.spec.tokenName, row.name);
    assert.equal(file.spec.tokenSymbol, row.ticker);
    assert.equal(BigInt(file.spec.n), BigInt(row.contents.size));
    for (const side of ['buyers', 'sellers']) {
      const fee = row.fees[side];
      const expected = fee.choice === 'alchemist' ? recipes.alchemistPick(0) : recipes.pickFor(fee.choice, { keep: 1, burn: 2, depth: 3 }[fee.inside] ?? 1, 2);
      assert.deepEqual(kit.spec[side], recipes.sideOf(expected));
    }
    // A download with a public reveal list (an open collection) lives only in the ignored build/ directory.
    const path = settingsPath(kit);
    assert.equal(path, `examples/boxes/${id}/${kit.revealList ? 'build' : 'settings'}/${id}-boxspec-v2.json`);
    assert.equal(kit.revealList === null, ['dragons-hoard', 'one-dollar', 'gpu-poor', 'junkyard', 'the-alchemist', 'one-collection-shop', 'frog-kiln', 'paper-certificates', 'lake-house', 'card-shop'].includes(id));
    if (kit.revealList === null) assert.equal(readFileSync(path, 'utf8'), text, 'committed settings must be fresh');
    else if (existsSync(path)) assert.equal(readFileSync(path, 'utf8'), text, 'built settings must be fresh');
    assert.equal(existsSync(`examples/boxes/${id}/settings/${id}-boxspec-v2.json`), kit.revealList === null, 'no reveal list in settings/');
    for (const picture of kit.pictures) {
      const checked = artwork.inspectImage(picture.bytes, { maxBytes: 1_048_576, minSide: 1, maxSide: picture.role === 'banner' ? 1600 : 4096 });
      assert.ok(checked.ok);
      if (picture.role !== 'item') assert.ok(Math.max(checked.width, checked.height) <= (picture.role === 'banner' ? 1600 : ['logo', 'collection cover'].includes(picture.role) ? 1200 : 1024));
    }
    // SH-CREATE-ITEM-MODELS: the launch tooling's settings reader (create-example-v2 --settings, sepolia-launch-pack
    // --inputs) takes every kit's download as written: a 3D kit's models and an open kit's public list among them.
    const { readExampleSettings } = await import('../../packages/chain/scripts/create-example-v2-settings.mjs');
    assert.equal(specV2.encodeBoxSpecV2(readExampleSettings(text)), file.encoded);
  });
}

test('the public kit menu refuses unknown and path-like ids before reading art', async () => {
  assert.equal(KIT_IDS.length, 15); // SH-262 adds the card shop
  for (const id of ['../bag-holders', 'unknown']) await assert.rejects(buildKit(id), /supported kit/);
});

test('shop preserves all ten starter identities, seed, tiers, limits, ceiling and creator buy', async () => {
  const kit = await buildKit('junkyard');
  assert.deepEqual([kit.input.v2.shop.curator, kit.input.v2.shop.curatorAddress], ['creator', '']);
  const { shopConfigV2, starterCommitmentV2 } = await import('../../packages/chain/src/core/v2/m2-spec-v2.ts');
  const config = shopConfigV2(kit.spec.contentsParams);
  assert.equal(kit.starter.length, 10);
  // The registry and Sepolia stock both name TA-40's five Test Junk collections, ids 1 and 2 each at tier 0.
  const junk = JSON.parse(readFileSync('examples/boxes/junkyard/test-collections/catalog.json', 'utf8')).collections;
  assert.deepEqual(JUNKYARD_SEPOLIA_COLLECTIONS.map(c => c.id), ['bent-cans', 'lost-cogs', 'split-boots', 'cracked-mugs', 'tangled-wires']);
  assert.deepEqual(JUNKYARD_SEPOLIA_COLLECTIONS.map(c => c.id), junk.map(c => c.key));
  assert.deepEqual(kit.starter.map(i => i.id), ['1', '2', '1', '2', '1', '2', '1', '2', '1', '2']);
  assert.deepEqual(kit.starter.map(i => i.tier), Array(10).fill(0));
  const slots = JUNKYARD_SEPOLIA_COLLECTIONS.map(c => BINDING_SLOTS[c.id]);
  assert.deepEqual(slots, ['11', '12', '13', '14', '15'].map(n => `0x${'0'.repeat(32)}002300${n}`));
  assert.deepEqual(kit.starter.map(i => i.collection), slots.flatMap(a => [a, a]));
  assert.deepEqual(config.collections.map(c => c.toLowerCase()), slots);
  assert.deepEqual(config.tiers, [0, 0, 0, 0, 0]);
  assert.deepEqual(kit.row.contents.shop.collections, JUNKYARD_SEPOLIA_COLLECTIONS);
  // The registry now names Test Gold directly; this older template still starts in ETH until L1 binds it.
  assert.equal(kit.row.priceCoin.symbol, 'TEST_GOLD');
  assert.equal(SEPOLIA_STAND_INS.PAXG, SEPOLIA_STAND_INS.TEST_GOLD);
  assert.equal(kit.spec.pricing.listingId, 0);
  assert.deepEqual(kit.unresolved.map(b => b.field), ['owner', 'priceCoin', ...JUNKYARD_SEPOLIA_COLLECTIONS.map(c => `collections.${c.id}`)]);
  assert.match(kit.unresolved.find(b => b.field === 'priceCoin').resolve, /^TEST_GOLD listing \(registry TEST_GOLD\)/);
  assert.deepEqual(config.givePricesT, kit.row.contents.shop.givePricesT.map(BigInt));
  assert.equal(config.seedT, BigInt(kit.row.contents.shop.seedT));
  assert.equal(config.pickBps, 20000);
  assert.equal(config.weeklyBps, 1000);
  assert.equal(config.collectionBps, 250);
  assert.equal(config.listDelay, 604800);
  assert.equal(kit.spec.creatorBuy, 300000000000000000n);
  assert.equal(starterCommitmentV2(kit.spec).setHash, kit.starter[0].hash);
  // Recompute independently, using the chain's encoding recipe (not the writer's starterEntries).
  const { createRequire } = await import('node:module');
  const { keccak256, encodeAbiParameters, zeroHash } = createRequire(new URL('../../packages/chain/package.json', import.meta.url))('viem');
  let tail = zeroHash;
  for (const item of kit.starter.toReversed()) {
    assert.equal(item.nextHash, tail);
    tail = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }], [item.collection, BigInt(item.id), item.tier, tail]));
    assert.equal(item.hash, tail);
  }
});

test('one-collection shop: one TA-40 slot, ten ordered starters, a zero curator, a two-give seed and ETH as listed', async () => {
  const kit = await buildKit('one-collection-shop');
  assert.deepEqual([kit.input.v2.shop.curator, kit.input.v2.shop.curatorAddress], ['none', '']);
  const { shopConfigV2, starterCommitmentV2 } = await import('../../packages/chain/src/core/v2/m2-spec-v2.ts');
  const config = shopConfigV2(kit.spec.contentsParams);
  const slot = BINDING_SLOTS['bent-cans'];
  assert.equal(slot, `0x${'0'.repeat(32)}00230011`, 'the same TA-40 slot as the Junkyard uses for Test Junk Bent Cans');
  assert.deepEqual(config.collections.map(c => c.toLowerCase()), [slot]);
  assert.deepEqual(config.tiers, [0]);
  assert.equal(config.curator, '0x0000000000000000000000000000000000000000', 'no curator: a fixed list');
  assert.equal(config.seedT, 2n * config.givePricesT[0], 'T worth exactly two sell-backs');
  assert.deepEqual(config.givePricesT, kit.row.contents.shop.givePricesT.map(BigInt));
  assert.deepEqual([config.pickBps, config.weeklyBps, config.collectionBps, config.listDelay], [20000, 1000, 250, 604800]);
  assert.deepEqual(kit.starter.map(i => i.id), ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
  assert.ok(kit.starter.every(i => i.collection === slot && i.tier === 0));
  assert.equal(starterCommitmentV2(kit.spec).setHash, kit.starter[0].hash);
  assert.equal(starterCommitmentV2(kit.spec).count, 10);
  // Priced in native ETH at listing 0, so no price-coin binding or conversion is left for the loader.
  assert.deepEqual([kit.spec.pricing.listingId, kit.spec.pricing.token], [0, '0x0000000000000000000000000000000000000000']);
  assert.equal(kit.spec.creatorBuy, 10000000000000000n);
  assert.deepEqual(kit.unresolved.map(b => b.field), ['owner', 'collections.bent-cans']);
  // A shop names no owner, payee or curator in its spec: only the collection slot is an address placeholder.
  assert.deepEqual([kit.spec.marketplaceOwner, kit.spec.creatorFeeRecipient], Array(2).fill('0x0000000000000000000000000000000000000000'));
  const owner = `0x${'a'.repeat(40)}`; const cans = `0x${'c'.repeat(40)}`;
  const bound = await buildKit('one-collection-shop', { owner, collections: { 'bent-cans': cans } });
  assert.deepEqual(bound.unresolved, []);
  assert.deepEqual(shopConfigV2(bound.spec.contentsParams).collections.map(c => c.toLowerCase()), [cans]);
  assert.ok(bound.starter.every(i => i.collection === cans));
  await assert.rejects(buildKit('one-collection-shop', { collections: { 'scrap-a': cans } }), /unknown binding/);
});

test('Load settings: this shop file loads once its ten starter ids are typed, keeps no curator, and a placeholder collection never loads', async () => {
  const kit = await buildKit('one-collection-shop');
  const loading = await import('../../apps/web/src/features/create/v2/load-settings.ts');
  const digest = async bytes => sha256Hex(bytes);
  const listings = kit.context.listings;
  const read = await loading.readSettingsFile(settingsText(kit), digest);
  assert.equal(read.ok, true);
  // SH-SHOP-CREATE: the file commits its ten starters only by hash and count, so Load settings asks for their ids and
  // takes only the kit's (ids 3 to 12); the Junkyard's committed file loads the same way with ids 1 and 2 of each.
  const setup = await loading.setupOf(read.value, listings, async () => null);
  assert.equal(setup.ok, true, setup.error);
  assert.equal(setup.value.starters, 10);
  assert.deepEqual(loading.withStarters(setup.value, ['3-11'], listings), { ok: false, error: loading.LOAD_WORDS.startersNotSetup });
  const typed = loading.withStarters(setup.value, [kit.starter.map(item => item.id).join(', ')], listings);
  assert.equal(typed.ok, true, typed.error);
  const junkyard = await loading.readSettingsFile(readFileSync('examples/boxes/junkyard/settings/junkyard-boxspec-v2.json', 'utf8'), digest);
  const junk = await loading.setupOf(junkyard.value, listings, async () => null);
  assert.equal(junk.ok, true, junk.error);
  assert.equal(loading.withStarters(junk.value, JUNKYARD_SEPOLIA_COLLECTIONS.map(c => c.starterIds.join(', ')), listings).ok, true);
  // The chain is still asked about the collection: the placeholder slot is refused.
  const slot = BINDING_SLOTS['bent-cans'];
  const finish = answer => loading.finishLoad(typed.value, null, listings, kit.spec.pricing.token, 0, { salt: () => `0x${'0'.repeat(64)}`, shopChecks: new Map([[slot, answer]]) });
  assert.deepEqual(finish('no-code'), { ok: false, error: loading.LOAD_WORDS.cannotKeep('No contract at this address') });
  assert.deepEqual(finish('unknown'), { ok: false, error: loading.LOAD_WORDS.shopUnchecked });
  assert.deepEqual(loading.finishLoad(typed.value, null, listings, kit.spec.pricing.token, 0, { salt: () => `0x${'0'.repeat(64)}` }),
    { ok: false, error: loading.LOAD_WORDS.shopUnchecked }, 'no answers from the chain: refused');
  // "No curator" (the zero curator) is kept; the ids stay as typed.
  const loaded = finish('erc721');
  assert.equal(loaded.ok, true, loaded.error);
  assert.deepEqual([loaded.value.v2.shop.curator, loaded.value.v2.shop.curatorAddress, loaded.value.v2.shop.collections[0].ids], ['none', '', '3, 4, 5, 6, 7, 8, 9, 10, 11, 12']);
});

test('pile seeds retain their own units, leave-behind and pending Alchemist selection', async () => {
  for (const [id, seed, leave] of [['dragons-hoard', 1000000000000000000n, 500], ['one-dollar', 1000000000000000000n, 0], ['the-alchemist', 0n, 500]]) {
    const kit = await buildKit(id);
    const params = leave === 0 ? { ...specV2.decodePileParams(kit.spec.contentsParams), leaveBehindBps: 0 } : specV2.decodePileParamsV21(kit.spec.contentsParams);
    assert.equal(params.seedAmount, seed);
    assert.equal(params.leaveBehindBps, leave);
    if (id === 'the-alchemist') {
      assert.equal(kit.row.status, 'pending');
      assert.equal(kit.spec.buyers.a.dest, 9);
      assert.equal(kit.spec.buyers.a.leg, 1);
      assert.ok(kit.unresolved.some(b => b.field === 'alchemistRow'));
      assert.ok(kit.unresolved.some(b => b.field === 'assets.TEST_GOLD'));
    }
  }
});

test('explicit public bindings replace slots without implying deployment, malformed bindings fail', async () => {
  const owner = `0x${'a'.repeat(40)}`;
  const gold = `0x${'b'.repeat(40)}`;
  const kit = await buildKit('the-alchemist', { owner, assets: { TEST_GOLD: gold }, alchemistRow: '17', priceListing: { id: '8', token: coinAddress('c'), raise: '42069800850000000000' } });
  assert.deepEqual(kit.unresolved, []);
  assert.equal(specV2.decodeModuleDestParams(kit.spec.buyers.a.destParams).id, 17);
  assert.equal(specV2.decodePileParamsV21(kit.spec.contentsParams).asset.toLowerCase(), gold);
  for (const invalid of [{ secret: 'no' }, { owner: 'bad' }, { assets: { ETH: gold } }, { alchemistRow: 4 }, { alchemistRow: '4294967296' }]) await assert.rejects(buildKit('gpu-poor', invalid));
  const collections = Object.fromEntries(JUNKYARD_SEPOLIA_COLLECTIONS.map((c, i) => [c.id, `0x${String(i + 1).repeat(40)}`]));
  const shop = await buildKit('junkyard', { owner, assets: { TEST_GOLD: gold }, collections });
  assert.deepEqual(shop.unresolved.map(b => b.field), ['priceCoin'], 'an asset address alone does not bind a listing');
  assert.deepEqual(shop.starter.map(i => i.collection), Object.values(collections).flatMap(a => [a, a]));
  await assert.rejects(buildKit('junkyard', { collections: { 'scrap-a': gold } }), /unknown binding/);
});

test('programs run through symlinks and imports have no output or writes', () => {
  mkdirSync('.cache/tmp', { recursive: true });
  const scratch = mkdtempSync('.cache/tmp/kits-entry-');
  for (const file of ['settings.mjs', 'bundle.mjs']) {
    const link = resolve(scratch, file);
    symlinkSync(resolve('scripts/kits', file), link);
    const run = spawnSync(process.execPath, [link, '--unknown'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /kit (settings|bundle) refused/);
    assert.doesNotMatch(run.stderr, /cwebp is required/);
    assert.equal(run.stdout, '');
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import('./scripts/kits/${file}')`], { encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '');
    assert.doesNotMatch(imported.stderr, /refused/);
  }
});

for (const program of ['settings', 'bundle']) {
  test(`af1: ${program} CLI reports missing cwebp`, () => {
    mkdirSync('.cache/tmp', { recursive: true });
    const bin = resolve(mkdtempSync('.cache/tmp/kits-no-cwebp-'));
    const run = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', `scripts/kits/${program}.mjs`, 'dragons-hoard'],
      { env: { ...process.env, PATH: bin }, encoding: 'utf8' });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(run.stderr, `kit ${program} refused: cwebp is required for the offline free-picture encoder.\n`);
  });
}

test('af1: missing cwebp has a dedicated encoder error code', () => {
  mkdirSync('.cache/tmp', { recursive: true });
  const bin = resolve(mkdtempSync('.cache/tmp/kits-encoder-no-cwebp-'));
  const run = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { buildKit } from './scripts/kits/settings.mjs';
    await assert.rejects(buildKit('dragons-hoard'), { code: 'ERR_CWEBP_REQUIRED' });
  `], { env: { ...process.env, PATH: bin }, encoding: 'utf8' });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '');
  assert.equal(run.stderr, '');
});

test('a stuck cwebp fails the encoder within its time limit instead of blocking', () => {
  mkdirSync('.cache/tmp', { recursive: true });
  const bin = resolve(mkdtempSync('.cache/tmp/kits-stuck-cwebp-'));
  writeFileSync(resolve(bin, 'cwebp'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const started = Date.now();
  const run = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { buildKit } from './scripts/kits/settings.mjs';
    await assert.rejects(buildKit('dragons-hoard'), { code: 'ERR_CWEBP_TIMEOUT' });
  `], { env: { ...process.env, PATH: `${bin}:/bin:/usr/bin`, SH_KITS_CWEBP_TIMEOUT_MS: '500' }, encoding: 'utf8', timeout: 25_000 });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Date.now() - started < 25_000, 'the stub sleeps 30 s; the limit ended it');
});

test('the writer puts a reveal-list download into build/ and a reveal-free one into settings/, byte for byte', async () => {
  mkdirSync('.cache/tmp', { recursive: true });
  const scratch = resolve(mkdtempSync('.cache/tmp/kits-write-'));
  for (const [id, folder] of [['bag-holders', 'build'], ['junkyard', 'settings']]) {
    const kit = await buildKit(id);
    const written = writeSettings(kit, scratch);
    assert.equal(written, `examples/boxes/${id}/${folder}/${id}-boxspec-v2.json`);
    assert.equal(readFileSync(resolve(scratch, written), 'utf8'), settingsText(kit));
    assert.equal(existsSync(resolve(scratch, `examples/boxes/${id}/${folder === 'build' ? 'settings' : 'build'}`)), false);
    assert.equal(JSON.parse(readFileSync(resolve(scratch, written), 'utf8')).revealList === null, folder === 'settings');
  }
});

// SH-EX-L1: real public bytes and bindings; no RPC or deployed-address claims.
const coinAddress = digit => `0x${digit.repeat(40)}`;
const bindingFor = id => {
  const row = JSON.parse(readFileSync(`packages/box-spec/examples/v2/${id}.json`, 'utf8'));
  const native = row.priceCoin.symbol === 'ETH';
  return { owner: coinAddress('a'), nativeRaise: '100000000000000000', ...(row.creator ? { creatorBuy: '1' } : {}),
    priceListing: { id: native ? '0' : '9', token: native ? `0x${'0'.repeat(40)}` : coinAddress('b'), raise: '42069800850000000000' },
    assets: { TEST_GOLD: coinAddress(id === 'the-alchemist' ? 'c' : 'b') }, alchemistRow: '17',
    collections: Object.fromEntries(SHOP_STOCK_COLLECTIONS.map((c, i) => [c.id, coinAddress(String(i + 1))])) };
};

test('L1: every kit logo and cover fits the signed free item at 107520 bytes', async () => {
  const { fitsFree } = await import('../../apps/web/src/features/pictures/arweave-publish.ts');
  const { pictureType } = await import('../../apps/web/src/features/pictures/picture-type.ts');
  for (const id of KIT_IDS) {
    const kit = await buildKit(id);
    for (const p of kit.pictures.filter(p => ['logo', 'collection cover'].includes(p.role))) {
      assert.ok(fitsFree(11155111, 107_520)(p.bytes.length, pictureType(p.bytes)), `${id} ${p.role}: ${p.bytes.length}`);
    }
  }
});

test('L1: all non-native kits flag priceCoin, and public listing bindings resolve every kit', async () => {
  for (const id of KIT_IDS) {
    const plain = await buildKit(id);
    assert.equal(plain.unresolved.some(b => b.field === 'priceCoin'), plain.row.priceCoin.symbol !== 'ETH', id);
    const binding = bindingFor(id);
    const kit = await buildKit(id, binding);
    assert.deepEqual(kit.unresolved, [], id);
    assert.equal(kit.spec.pricing.listingId, Number(binding.priceListing.id));
    assert.equal(kit.spec.pricing.token.toLowerCase(), binding.priceListing.token);
    assert.equal(kit.spec.raise, BigInt(binding.priceListing.raise));
    assert.equal(kit.context.pricing.class, { ETH: 1, USDC: 3, NVDAon: 4 }[kit.row.priceCoin.symbol] ?? 5, 'Sepolia preset listing class');
    assert.equal(validateBoxSpecV2(kit.spec, { listing: kit.context.pricing }).reason, 0);
  }
  assert.deepEqual(['NVDAon', 'LINK', 'TEST_FROG', 'TEST_PEPE'].map(key => SEPOLIA_STAND_INS[key]?.key),
    ['TEST_NVDA', 'TEST_LINK', 'TEST_FROG', 'TEST_PEPE']);
});

test('L1: One Dollar follows price through Load; its seed is one coin in the listing units', async () => {
  const loading = await import('../../apps/web/src/features/create/v2/load-settings.ts');
  for (const bindings of [{}, bindingFor('one-dollar')]) {
    const kit = await buildKit('one-dollar', bindings);
    const pile = specV2.decodePileParams(kit.spec.contentsParams);
    assert.equal(pile.asset.toLowerCase(), kit.spec.pricing.token.toLowerCase());
    assert.equal(pile.seedAmount, 10n ** BigInt(kit.context.pricing.decimals));
    const file = await loading.readSettingsFile(settingsText(kit), async b => sha256Hex(b));
    assert.equal(file.ok, true);
    const setup = await loading.setupOf(file.value, kit.context.listings, async () => null);
    assert.equal(setup.ok, true, setup.error);
    assert.equal(setup.value.info.pileFollowsPrice, true);
    const next = { ...kit.context.pricing, id: 11, token: coinAddress('d'), decimals: 6 };
    const changed = loading.repriceLoaded(setup.value.v2, next.token, setup.value.info, [...kit.context.listings, next]);
    assert.equal(changed.ok, true);
    assert.equal(changed.value.v2.pile.asset, next.token);
    assert.equal(changed.value.v2.pile.seed, '1');
  }
});

test('SH-LAKE-HOUSE: the pile follows the price coin and starts empty; both fee sides go to it; the About line is exact', async () => {
  const loading = await import('../../apps/web/src/features/create/v2/load-settings.ts');
  const about = 'Test coins. Mock house, not legal title. Payments go into the pile; hand in HOUSE for a share.';
  for (const bindings of [{}, bindingFor('lake-house')]) {
    const kit = await buildKit('lake-house', bindings);
    assert.equal(kit.spec.description, about);
    assert.deepEqual([kit.spec.tokenName, kit.spec.tokenSymbol, kit.spec.boxType, kit.spec.creatorBuy], ['Lake House', 'HOUSE', 5, 0n]);
    const pile = specV2.decodePileParams(kit.spec.contentsParams);
    assert.equal(pile.asset.toLowerCase(), kit.spec.pricing.token.toLowerCase(), 'the pile is in the price coin');
    assert.equal(pile.seedAmount, 0n, 'empty at the start, in any decimals');
    assert.equal(kit.spec.contentsParams.length, 2 + 128, 'no leave-behind: the 64-byte PileParams');
    for (const side of [kit.spec.buyers, kit.spec.sellers]) assert.deepEqual([side.a.leg, side.a.dest], [1, 7], 'To the pile');
    assert.deepEqual(kit.unresolved.map(b => b.field), bindings.priceListing ? [] : ['priceCoin']);
    const file = await loading.readSettingsFile(settingsText(kit), async b => sha256Hex(b));
    assert.equal(file.ok, true);
    const setup = await loading.setupOf(file.value, kit.context.listings, async () => null);
    assert.equal(setup.ok, true, setup.error);
    assert.equal(setup.value.info.pileFollowsPrice, true);
    const next = { ...kit.context.pricing, id: 11, token: coinAddress('d'), decimals: 6 };
    const changed = loading.repriceLoaded(setup.value.v2, next.token, setup.value.info, [...kit.context.listings, next]);
    assert.equal(changed.ok, true);
    assert.deepEqual([changed.value.v2.pile.asset, changed.value.v2.pile.seed], [next.token, '0']);
  }
  const bound = await buildKit('lake-house', bindingFor('lake-house'));
  assert.equal(bound.context.pricing.decimals, 6);
  assert.equal(bound.context.pricing.class, 3, 'tUSDC is the STABLE preset');
});

test('L1: hidden public templates use the plan counts and sorted traits without images or secrets', async () => {
  const { parsePlan } = await import('../../apps/web/src/features/create/art-plan.ts');
  assert.equal(KIT_IDS.length, 15); // SH-262 adds the card shop
  for (const id of ['frog-kiln', 'paper-certificates']) {
    const kit = await buildKit(id);
    const plan = parsePlan(readFileSync(`examples/boxes/${id}/plan.csv`, 'utf8'));
    assert.deepEqual(plan.issues, []);
    assert.equal(kit.spec.n, plan.total);
    assert.equal(kit.spec.artMode, 2);
    assert.equal(kit.spec.revealListId, `0x${'0'.repeat(64)}`);
    assert.equal(kit.revealList, null);
    assert.equal(kit.proofs, null);
    assert.equal(kit.art, null);
    assert.deepEqual(kit.items, []);
    assert.ok(kit.pictures.every(p => p.role !== 'item'));
    assert.equal(settingsText(await buildKit(id)), settingsText(kit));
    assert.equal(kit.plan.specimen, id === 'paper-certificates' ? '0' : null);
    assert.doesNotMatch(settingsText(kit), /"salt"|"proof"|"seed"/);
  }
});

test('L1: locked descriptions stay coin-neutral', async () => {
  for (const id of KIT_IDS) {
    const kit = await buildKit(id);
    assert.doesNotMatch(kit.spec.description, /\b(?:ETH|USDC|NVDA|LINK|PEPE|FROG|PAXG)\b|Test Gold|starts in|initial price/i, id);
  }
});

test('listing bindings reject lossy numbers, mismatched native ids, conflicting assets and over-raise buys', async () => {
  const good = bindingFor('gpu-poor');
  for (const priceListing of [null, {}, { ...good.priceListing, extra: 'x' },
    { ...good.priceListing, id: 9 }, { ...good.priceListing, id: '4294967296' },
    { ...good.priceListing, raise: 123 }, { ...good.priceListing, raise: '1e18' },
    { ...good.priceListing, raise: '0' }, { ...good.priceListing, raise: (1n << 256n).toString() },
    { ...good.priceListing, id: '0' }, { ...good.priceListing, token: `0x${'0'.repeat(40)}` },
  ]) await assert.rejects(buildKit('gpu-poor', { priceListing }));
  await assert.rejects(buildKit('dragons-hoard', { priceListing: good.priceListing }), /coin kind/);
  await assert.rejects(buildKit('gpu-poor', { ...good, assets: { TEST_NVDA: coinAddress('c') } }), /disagree/);
  const shop = bindingFor('junkyard');
  await assert.rejects(buildKit('junkyard', { ...shop, creatorBuy: shop.priceListing.raise }), /below the raise/);
  await assert.rejects(buildKit('junkyard', { ...shop, creatorBuy: 1 }), /decimal string/);
});

test('creator buy conversion rounds up exactly and a new native raise needs a fresh quote', async () => {
  const b = bindingFor('junkyard');
  delete b.creatorBuy;
  b.nativeRaise = '4206980085000000000';
  b.priceListing.raise = '9007199254740993';
  const kit = await buildKit('junkyard', b);
  const numerator = 300000000000000000n * BigInt(b.priceListing.raise);
  assert.equal(kit.spec.creatorBuy, (numerator + BigInt(b.nativeRaise) - 1n) / BigInt(b.nativeRaise));
  assert.deepEqual(kit.unresolved, []);
  const missing = { ...b }; delete missing.nativeRaise;
  assert.deepEqual((await buildKit('junkyard', missing)).unresolved.map(u => u.field), ['nativeRaise']);
  await assert.rejects(buildKit('junkyard', { ...b, nativeRaise: '100000000000000000' }), /freshly quoted/);
  assert.equal((await buildKit('junkyard', { ...b, nativeRaise: '100000000000000000', creatorBuy: '1' })).spec.creatorBuy, 1n);
});

for (const id of ['frog-kiln', 'paper-certificates']) {
  test(`L1B: ${id} commits its own public hidden SVG within the placeholder and settings limits`, async () => {
    const { decodePlaceholdersParams } = await import('../../packages/box-spec/src/generated/box-spec.v1.ts');
    const { MAX_SETTINGS_BYTES } = await import('../../apps/web/src/features/create/v2/load-settings.ts');
    const kit = await buildKit(id);
    const hiddenSvg = readFileSync(`examples/boxes/${id}/art/hidden.svg`, 'utf8').replace(/[\r\n]/g, '');
    assert.ok(Buffer.byteLength(hiddenSvg) <= 4096, `${id}: report oversized art to the integrator; do not change it`);
    assert.match(hiddenSvg, /^[\x20-\x7e]+$/, 'one line of printable ASCII');
    const placeholders = kit.spec.addOns.filter(addOn => addOn.id === 1);
    assert.equal(placeholders.length, 1);
    const committed = decodePlaceholdersParams(placeholders[0].params).hiddenSvg;
    assert.ok(Buffer.from(committed).equals(Buffer.from(hiddenSvg)), `${id}: placeholders must commit art/hidden.svg as one line`);
    assert.equal(kit.input.form.hiddenSvg, committed);
    assert.equal(validateBoxSpecV2(kit.spec, { listing: kit.context.pricing }).reason, 0, 'all spec limits, including SVG field 105');
    assert.ok(Buffer.byteLength(settingsText(kit)) <= MAX_SETTINGS_BYTES, 'Create settings file limit');
    const manifest = planManifest(kit);
    assert.equal(readFileSync(`examples/boxes/${id}/settings/${id}-plan.json`, 'utf8'), `${JSON.stringify(manifest, null, 2)}\n`, 'committed plan binds the regenerated settings bytes');
    assert.doesNotMatch(JSON.stringify(manifest), /"(?:items|salt|salts|proof|proofs|revealList)"/);
  });
}

test('L1B: plan.path and marker stay compatible with apps/web/src/features/create/v2/load-settings.ts PLAN_PATH and templateMarker', async () => {
  const loading = await import('../../apps/web/src/features/create/v2/load-settings.ts');
  const sha256 = bytes => `0x${createHash('sha256').update(bytes).digest('hex')}`;
  for (const id of ['frog-kiln', 'paper-certificates']) {
    const kit = await buildKit(id);
    const manifest = planManifest(kit);
    const path = `examples/boxes/${id}/plan.csv`;
    const hash = sha256(readFileSync(path));
    const marker = sha256(`squarehole.hidden-kit-template/1:${id}:${hash}`);
    assert.equal(manifest.plan.path, path, 'L1 path contract: update load-settings.ts PLAN_PATH together');
    assert.equal(manifest.plan.sha256, hash);
    assert.equal(manifest.plan.templateRoot, marker, 'L1 marker contract: update load-settings.ts templateMarker together');
    assert.equal(kit.spec.revealRoot, marker);
    assert.equal(loading.templateMarker(id, hash), marker);
    assert.deepEqual(loading.readPlanManifest(JSON.stringify(manifest)), { ok: true, value: {
      settingsSha256: sha256(settingsText(kit)), kit: id, planSha256: hash, count: kit.spec.n, templateRoot: marker,
    } });
    for (const wrong of [`${id}/plan.csv`, `examples/boxes/${id}/other.csv`, `examples/boxes/${id}/../plan.csv`]) {
      assert.equal(loading.readPlanManifest(JSON.stringify({ ...manifest, plan: { ...manifest.plan, path: wrong } })).ok, false, wrong);
    }
  }
});

test('hidden template exports a public plan manifest and loads only when it is bound', async () => {
  const loading = await import('../../apps/web/src/features/create/v2/load-settings.ts');
  mkdirSync('.cache/tmp', { recursive: true });
  const root = mkdtempSync('.cache/tmp/kits-hidden-plan-');
  for (const id of ['frog-kiln', 'paper-certificates']) {
    const kit = await buildKit(id, bindingFor(id));
    writeSettings(kit, root);
    const manifest = JSON.parse(readFileSync(`${root}/examples/boxes/${id}/settings/${id}-plan.json`, 'utf8'));
    assert.equal(manifest.format, 'squarehole.hidden-kit-plan/1');
    assert.deepEqual(manifest.plan, kit.plan);
    assert.equal(manifest.settingsSha256, sha256Hex(Buffer.from(settingsText(kit))));
    const file = await loading.readSettingsFile(settingsText(kit), async b => sha256Hex(b));
    assert.equal(file.ok, true);
    assert.deepEqual(await loading.setupOf(file.value, kit.context.listings, async () => null),
      { ok: false, error: loading.LOAD_WORDS.picture('the item pictures') });
    const parsed = loading.readPlanManifest(JSON.stringify(manifest));
    assert.equal(parsed.ok, true, parsed.error);
    const bound = loading.bindPlanTemplate(file.value, manifest.settingsSha256, parsed.value);
    assert.equal(bound.ok, true, bound.error);
    const setup = await loading.setupOf(bound.value, kit.context.listings, async () => null);
    assert.equal(setup.ok, true, setup.error);
    assert.equal(setup.value.form.hiddenSvg, kit.input.form.hiddenSvg);
  }
});


test('Link Marines v2 preserves all ranks and squads with price-coin rations; v1 still eats', async () => {
  const kit = await buildKit('link-marines-v2');
  const assignment = JSON.parse(readFileSync('examples/boxes/link-marines-v2/assignment.json', 'utf8'));
  assert.equal(assignment.modelPolicy, '2d');
  assert.equal(kit.spec.tokenSymbol, 'MARINE');
  for (const side of [kit.spec.buyers, kit.spec.sellers]) {
    assert.deepEqual([side.a.leg, side.a.dest, BigInt(side.a.destParams)], [1, 8, 3n]);
  }
  assert.equal(kit.items.length, 420);
  assert.equal(new Set(kit.items.map(item => item.sha256)).size, 420);
  const csv = kit.traitsCsv.trimEnd().split('\n');
  assert.equal(csv[0], 'id,Rank,Squad,Face,Eyes,Grooming,Collar,Mouth,Prop,Wall');
  for (const [i, item] of assignment.items.entries()) {
    assert.equal(kit.items[i].id, item.id);
    assert.deepEqual(kit.items[i].traits, item.traits);
    assert.equal(kit.items[i].sha256, item.picture.sha256);
    assert.equal(item.model, null);
    assert.equal(csv[i + 1], [item.id, ...Object.values(kit.items[i].traits)].map(v => `"${v}"`).join(','));
  }
  assert.equal(kit.revealList.items.length, 420);
  const old = await buildKit('link-marines');
  for (const side of [old.spec.buyers, old.spec.sellers]) assert.deepEqual([side.a.leg, side.a.dest], [1, 1]);
});


test('SH-CREATE-ITEM-MODELS: no model switch is left; the CLI takes a kit and its bindings only', () => {
  assert.deepEqual(cliArgs(['rent-free']), { ids: ['rent-free'], bindings: {} });
  assert.throws(() => cliArgs(['rent-free', '--experimental-models']), /usage/);
});

// SH-CREATE-ITEM-MODELS (T01, F1/F2): the builder's 3D commitment is Create's own, proved three ways: the six-field leaves
// encoded independently of the app, Create's reader and commitment on the numbered files, and Create's Load settings of
// the builder's own file with those files (the page rebuilds the identical spec, its root and list id from the file's salts).
for (const id of THREE_D) {
  test(`${id}: the builder's models, leaves, root and list id are Create's, and Create loads the file it writes`, async () => {
    const { createRequire } = await import('node:module');
    const { keccak256, encodeAbiParameters } = createRequire(new URL('../../packages/chain/package.json', import.meta.url))('viem');
    const { readArt } = await import('../../apps/web/src/features/create/art-files.ts');
    const { commitArt, revealList } = await import('../../apps/web/src/features/create/create-model.ts');
    const loading = await import('../../apps/web/src/features/create/v2/load-settings.ts');
    const kit = await buildKit(id);
    const manifest = reviewedManifestForPlatform(id, JSON.parse(readFileSync(`examples/boxes/${id}/unique/manifest.json`, 'utf8')));
    const rows = manifest.entries ?? manifest.items;
    // 1. Every leaf, encoded here from the reviewed manifest and the list's salts: the six words, the model's among them.
    const leaves = kit.revealList.items.map((entry, i) => {
      assert.equal(entry.modelSha256, `0x${rows[i].model.sha256}`);
      assert.equal(entry.avatarSha256, `0x${'0'.repeat(64)}`);
      return keccak256(encodeAbiParameters(['uint256', 'uint128', 'bytes32', 'bytes32', 'bytes32', 'bytes32'].map(type => ({ type })),
        [BigInt(entry.id), BigInt(entry.traitsPacked), `0x${rows[i].picture.sha256}`, entry.avatarSha256, `0x${rows[i].model.sha256}`, entry.salt]));
    });
    assert.equal(artwork.buildBoxTree(leaves, leaves.length).root, kit.spec.revealRoot);
    assert.equal(sha256Hex(Buffer.from(artwork.canonicalJson(kit.revealList))), kit.spec.revealListId);
    // 2. Create's reader and commitment on the numbered files the bundle writes (items/<id>.png, <id>.glb, traits.csv).
    const files = [...kit.items.map(item => new File([item.bytes], `${item.id}.png`, { type: 'image/png' })),
      ...kit.items.map(item => new File([item.model.bytes], `${item.id}.glb`, { type: 'model/gltf-binary' })), new File([kit.traitsCsv], 'traits.csv')];
    const salts = kit.revealList.items.map(entry => entry.salt);
    const read = await readArt(files, { env: { digest: async b => sha256Hex(b), salt: () => `0x${'0'.repeat(64)}`, thumbnail: async () => null } });
    assert.deepEqual(read.problems, []);
    const commitment = commitArt({ ...read, salts }, 'open');
    assert.equal(commitment.revealRoot, kit.spec.revealRoot);
    assert.equal(commitment.revealListId, kit.spec.revealListId);
    assert.deepEqual(revealList({ ...read, salts }, commitment.packed), kit.revealList);
    // 3. Create's Load settings: the file's models checked and kept, the items read with their models, the spec rebuilt.
    const file = await loading.readSettingsFile(settingsText(kit), async b => sha256Hex(b));
    assert.equal(file.ok, true, file.error);
    assert.equal(file.value.models.length, new Set(rows.map(row => row.model.sha256)).size);
    const setup = await loading.setupOf(file.value, kit.context.listings, async () => null);
    assert.equal(setup.ok, true, setup.error);
    assert.equal(setup.value.info.models, true);
    assert.equal(loading.itemsProblem(setup.value, read, kit.context.listings), null, 'Create rebuilds the identical spec');
    // Without its models the same pictures are refused, never loaded as a 2D box.
    const flat = await readArt(files.filter(f => !f.name.endsWith('.glb')), { env: { digest: async b => sha256Hex(b), salt: () => `0x${'0'.repeat(64)}`, thumbnail: async () => null } });
    assert.equal(loading.itemsProblem(setup.value, flat, kit.context.listings), loading.LOAD_WORDS.modelsNeeded);
  });
}

test('af1: a warm successful kit still refuses missing cwebp and recovers after PATH is restored', async () => {
  const first = settingsText(await buildKit('dragons-hoard'));
  const path = process.env.PATH;
  mkdirSync('.cache/tmp', { recursive: true });
  const bin = resolve(mkdtempSync('.cache/tmp/kits-warm-no-cwebp-'));
  try {
    process.env.PATH = bin;
    await assert.rejects(buildKit('dragons-hoard'), { code: 'ERR_CWEBP_REQUIRED' });
  } finally { process.env.PATH = path; }
  assert.equal(settingsText(await buildKit('dragons-hoard')), first);
});
