import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assignment, squadFor, variantFor, VARIANT_NAMES } from './assign.mjs';

test('T03-LM: active assignment is the reviewed unique 2D edition and regenerates exactly', { timeout: 240_000 }, async () => {
  const actual = await assignment();
  const reviewed = JSON.parse(readFileSync(new URL('./unique/manifest.json', import.meta.url), 'utf8'));
  assert.equal(actual.modelPolicy, '2d', 'review GLBs must never opt this edition into models');
  assert.equal(actual.count, '420');
  assert.equal(actual.seed, reviewed.seed);
  assert.deepEqual(actual.columns, ['Rank', 'Squad', 'Face', 'Eyes', 'Grooming', 'Collar', 'Mouth', 'Prop', 'Wall']);
  assert.equal(actual.items.length, reviewed.items.length);
  assert.equal(new Set(actual.items.map(row => row.picture.sha256)).size, 420);
  for (const [index, row] of actual.items.entries()) {
    const expected = reviewed.items[index];
    assert.equal(row.id, String(index + 1), 'canonical ordered IDs');
    assert.deepEqual(row.traits, expected.traits, `all traits of id ${row.id}`);
    assert.deepEqual(Object.keys(row.traits), actual.columns);
    assert.deepEqual(row.picture, { file: expected.picture.file, sha256: `0x${expected.picture.sha256}`, bytes: expected.picture.bytes });
    assert.equal(row.model, null, `id ${row.id} has no model`);
    assert.equal(row.traits.Squad, squadFor(row.id));
    assert.equal(row.traits.Rank, VARIANT_NAMES[Number(variantFor(row.id)) - 1]);
    assert.equal(Object.hasOwn(row, 'image'), false, 'no old rank-library image assignment');
  }
  const bytes = `${JSON.stringify(actual, null, 2)}\n`;
  assert.equal(readFileSync(new URL('./assignment.json', import.meta.url), 'utf8'), bytes);
  const cli = spawnSync(process.execPath, ['examples/boxes/link-marines-v2/assign.mjs'], {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout, bytes, 'a fresh CLI build produces exactly the same assignment');
});
