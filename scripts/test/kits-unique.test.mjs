import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync, renameSync, writeFileSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { UNIQUE_KITS, normalizeUniqueManifest, verifyUniqueSet } from '../kits/unique.mjs';
import { buildKit, settingsText } from '../kits/settings.mjs';

const expected = {
  'rent-free': ['500', '3d', ['house', 'door', 'window', 'post', 'plant', 'step']],
  'bag-holders': ['420', '3d', ['kind', 'trim', 'repair', 'tag', 'stitch']],
  'link-marines-v2': ['420', '2d', ['Rank', 'Squad', 'Face', 'Eyes', 'Grooming', 'Collar', 'Mouth', 'Prop', 'Wall']],
  'exit-liquidity': ['404', '2d', ['sign', 'housing', 'route', 'repair', 'equipment', 'conduit']],
};
const hash = bytes => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const reviewed = id => JSON.parse(readFileSync(`examples/boxes/${id}/unique/manifest.json`, 'utf8'));

test('T02 interface fixes counts, full trait order and model policy; rejects malformed manifests', () => {
  assert.deepEqual(Object.keys(UNIQUE_KITS), Object.keys(expected));
  for (const [id, [count, policy, columns]] of Object.entries(expected)) {
    const manifest = reviewed(id);
    const normalized = normalizeUniqueManifest(id, manifest);
    assert.equal(normalized.count, count);
    assert.equal(normalized.modelPolicy, policy);
    assert.deepEqual(normalized.columns, columns);
    assert.deepEqual(normalized.items.map(i => i.id), Array.from({ length: normalized.items.length }, (_, i) => String(i + 1)));
    for (const item of normalized.items) {
      assert.deepEqual(Object.keys(item.traits), columns);
      assert.match(item.picture.sha256, /^0x[0-9a-f]{64}$/);
      assert.equal(item.picture.file, `picture-${item.id}.png`);
      // Normalization verifies the producer's review model even for a 2D publication.
      assert.equal(item.model.file, `model-${item.id}.glb`);
    }
    const change = fn => {
      const copy = structuredClone(manifest), rows = copy.entries ?? copy.items;
      fn(copy, rows);
      assert.throws(() => normalizeUniqueManifest(id, copy));
    };
    change((_m, rows) => rows.pop());
    change((_m, rows) => rows.reverse());
    change((_m, rows) => { rows[0].id = '01'; });
    change((_m, rows) => { rows[1].id = rows[0].id; });
    change((_m, rows) => { rows[0].traits = {}; });
    change((_m, rows) => { rows[0].traits.extra = 'not reviewed'; });
    change((_m, rows) => { rows[0].picture.sha256 = `0x${rows[0].picture.sha256}`; });
    change((_m, rows) => { rows[0].picture.file = '../picture-1.png'; });
    change((_m, rows) => { rows[0].model.file = 'elsewhere.glb'; });
    change(m => { m.seed = 'a different seed'; });
    change(m => { m.count = '1'; });
  }
  assert.throws(() => normalizeUniqueManifest('../rent-free', reviewed('rent-free')), /supported unique kit/);
});

for (const [id, [count, policy, columns]] of Object.entries(expected)) {
  test(`T02 ${id}: two fresh full builds are byte-identical, reviewed and policy filtered`, { timeout: 600_000 }, async () => {
    // This is the unique kit's one fresh double-build test, including the complete Create download.
    const firstKit = await buildKit(id, {}, { fresh: true });
    const secondKit = await buildKit(id, {}, { fresh: true });
    assert.equal(settingsText(firstKit), settingsText(secondKit));
    const first = verifyUniqueSet(id, dirname(firstKit.items[0].source));
    const second = verifyUniqueSet(id, dirname(secondKit.items[0].source));
    assert.notEqual(first.directory, second.directory);
    assert.equal(first.count, count);
    assert.equal(first.modelPolicy, policy);
    assert.equal(BigInt(first.items.length), BigInt(count));
    assert.equal(new Set(first.items.map(i => i.picture.sha256)).size, first.items.length);
    for (const file of readdirSync(first.directory)) {
      assert.deepEqual(readFileSync(join(first.directory, file)), readFileSync(join(second.directory, file)), file);
    }
    const rows = reviewed(id).entries ?? reviewed(id).items;
    for (const [index, item] of first.items.entries()) {
      assert.deepEqual(item.traits, rows[index].traits);
      assert.deepEqual(Object.keys(item.traits), columns);
      assert.equal(hash(readFileSync(item.picture.path)), item.picture.sha256);
      assert.equal(item.model === null, policy === '2d');
      if (item.model) assert.equal(hash(readFileSync(item.model.path)), item.model.sha256);
    }
    // Damage only retained scratch. No fallback to the twelve variants, reordered ids or stale bytes.
    const manifestPath = join(first.directory, 'manifest.json');
    const original = readFileSync(manifestPath);
    const wrong = JSON.parse(original), entries = wrong.entries ?? wrong.items;
    entries[0].traits[columns[0]] = 'changed';
    writeFileSync(manifestPath, JSON.stringify(wrong));
    assert.throws(() => verifyUniqueSet(id, first.directory), /reviewed manifest/);
    writeFileSync(manifestPath, original);
    for (const name of ['picture-1.png', 'model-1.glb']) {
      const path = join(first.directory, name), saved = readFileSync(path);
      writeFileSync(path, Buffer.alloc(saved.length));
      assert.throws(() => verifyUniqueSet(id, first.directory), /sha256/);
      writeFileSync(path, saved);
      renameSync(path, `${path}.retained`);
      assert.throws(() => verifyUniqueSet(id, first.directory), /ENOENT/);
      symlinkSync(`${name}.retained`, path);
      assert.throws(() => verifyUniqueSet(id, first.directory), /regular generated file/);
      renameSync(path, `${path}.symlink-retained`);
      renameSync(`${path}.retained`, path);
    }
    assert.equal(verifyUniqueSet(id, first.directory).items.length, first.items.length);
  });
}
