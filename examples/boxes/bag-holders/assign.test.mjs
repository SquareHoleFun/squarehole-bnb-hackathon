import { reviewedManifestForPlatform } from '../../../scripts/kits/bag-holders-normal-zero-platform-exception.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assignment, variantFor, VARIANT_NAMES } from './assign.mjs';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const armReviewed = JSON.parse(read('./unique/manifest.json'));
const reviewed = reviewedManifestForPlatform('bag-holders', armReviewed);
const spec = JSON.parse(read('./unique/traits.json'));
const recordedText = read('./assignment.json');
const expectedAssignment = JSON.parse(recordedText);
assert.equal(`${JSON.stringify(expectedAssignment, null, 2)}\n`, recordedText, 'recorded assignment formatting stays exact');
for (const [index, row] of expectedAssignment.items.entries()) {
  assert.equal(row.model.sha256, `0x${armReviewed.items[index].model.sha256}`, 'recorded assignment must still match every ARM model hash');
  row.model.sha256 = `0x${reviewed.items[index].model.sha256}`;
}
const expectedText = `${JSON.stringify(expectedAssignment, null, 2)}\n`;

test('T03-BH: active assignment carries every reviewed picture, model and trait', async () => {
  const actual = await assignment();
  assert.equal(actual.modelPolicy, '3d');
  assert.equal(actual.edition, 'bag-holders');
  assert.equal(actual.firstId, '1');
  assert.equal(actual.count, '420');
  assert.equal(actual.seed, reviewed.seed);
  assert.deepEqual(actual.columns, ['kind', 'trim', 'repair', 'tag', 'stitch']);
  assert.equal(BigInt(actual.items.length), 420n);
  for (const [index, item] of actual.items.entries()) {
    const expected = reviewed.items[index];
    assert.equal(item.id, String(index + 1));
    assert.deepEqual(item.traits, expected.traits);
    assert.equal(item.traits.kind, variantFor(item.id));
    for (const [role, extension] of [['picture', 'png'], ['model', 'glb']]) {
      assert.deepEqual(item[role], {
        path: `${role}-${item.id}.${extension}`,
        sha256: `0x${expected[role].sha256}`,
        bytes: expected[role].bytes,
      });
    }
  }
  for (const role of ['picture', 'model']) {
    assert.equal(new Set(actual.items.map(item => item[role].sha256)).size, actual.items.length);
  }
  for (const [field, values] of Object.entries(spec.traits)) {
    for (const { value, count } of values) {
      assert.equal(BigInt(actual.items.filter(item => item.traits[field] === value).length), BigInt(count));
    }
  }
  assert.equal(expectedText, `${JSON.stringify(actual, null, 2)}\n`);
});

test('T03-BH: CLI regenerates the portable committed assignment exactly', () => {
  const child = spawnSync(process.execPath, [new URL('./assign.mjs', import.meta.url).pathname], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.equal(child.stdout, expectedText);
  const actual = JSON.parse(child.stdout);
  assert.equal(actual.modelPolicy, '3d');
  assert.equal(new Set(actual.items.map(item => item.picture.path)).size, 420);
  assert.ok(actual.items.every(item => item.model && !Object.hasOwn(item, 'image')));
});

test('T03-BH: base family helpers retain canonical IDs and the twelve-family cycle', () => {
  assert.equal(VARIANT_NAMES.length, 12);
  for (let id = 1n; id <= 420n; id++) {
    assert.equal(variantFor(String(id)), String(((id - 1n) % 12n) + 1n).padStart(2, '0'));
  }
  for (const id of ['0', '421', '01', '-1', '1.0', '', ' 1', 4, null]) {
    assert.throws(() => variantFor(id));
  }
});
