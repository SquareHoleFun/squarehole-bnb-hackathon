import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { assignment, variantFor } from './assign.mjs';

const reviewed = JSON.parse(readFileSync(new URL('./unique/manifest.json', import.meta.url), 'utf8'));
const vocabulary = JSON.parse(readFileSync(new URL('./unique/traits.json', import.meta.url), 'utf8'));
const columns = ['sign', 'housing', 'route', 'repair', 'equipment', 'conduit'];

test('T03-EL: active assignment exposes 404 reviewed pictures, all traits and no models', { timeout: 180_000 }, async () => {
  const set = await assignment();
  assert.equal(set.modelPolicy, '2d', 'Exit Liquidity must explicitly publish 2D');
  assert.equal(set.count, '404');
  assert.equal(set.seed, 'exit-liquidity/404-signs/no-way-out/v1');
  assert.deepEqual(set.columns, columns);
  assert.equal(set.items.length, 404);
  const hashes = new Set();
  for (const [index, item] of set.items.entries()) {
    const expected = reviewed.items[index];
    assert.equal(item.id, (BigInt(index) + 1n).toString());
    assert.deepEqual(item.traits, expected.traits, `id ${item.id}: full reviewed traits`);
    assert.deepEqual(Object.keys(item.traits), columns);
    assert.equal(item.traits.sign, variantFor(item.id));
    assert.equal(item.picture.path, join(set.directory, `picture-${item.id}.png`));
    const bytes = readFileSync(item.picture.path);
    assert.equal(bytes.length, expected.picture.bytes);
    assert.equal(item.picture.bytes, bytes.length);
    assert.equal(item.picture.sha256, `0x${expected.picture.sha256}`);
    assert.equal(item.picture.sha256, `0x${createHash('sha256').update(bytes).digest('hex')}`);
    hashes.add(item.picture.sha256);
    assert.equal(item.model, null, `id ${item.id}: review GLB must not become an assigned model`);
    assert.ok(readFileSync(join(set.directory, `model-${item.id}.glb`)).length > 0);
  }
  assert.equal(hashes.size, 404);
  assert.notEqual(set.items[0].picture.sha256, set.items[12].picture.sha256, 'base sign repeats; picture does not');
  for (const layer of vocabulary.layers) for (const value of layer.values) {
    assert.equal(BigInt(set.items.filter(item => item.traits[layer.key] === value.value).length), BigInt(value.count));
  }
  for (const id of reviewed.samples.pictures) {
    assert.deepEqual(readFileSync(join(set.directory, `picture-${id}.png`)),
      readFileSync(new URL(`./unique/samples/picture-${id}.png`, import.meta.url)));
  }
});

test('T03-EL: assignment CLI is portable, deterministic and exactly the committed assignment', { timeout: 180_000 }, () => {
  const output = execFileSync(process.execPath, [new URL('./assign.mjs', import.meta.url).pathname], { maxBuffer: 2_000_000 });
  const set = JSON.parse(output);
  assert.equal(set.modelPolicy, '2d');
  assert.equal(set.count, reviewed.count);
  assert.equal(set.seed, reviewed.seed);
  assert.deepEqual(set.columns, columns);
  assert.equal(set.directory, undefined, 'fresh scratch directory must not enter committed data');
  assert.equal(set.items.length, 404);
  for (const [index, item] of set.items.entries()) {
    const expected = reviewed.items[index];
    assert.deepEqual(item, {
      id: expected.id, traits: expected.traits,
      picture: { path: `picture-${expected.id}.png`, sha256: `0x${expected.picture.sha256}`, bytes: expected.picture.bytes },
      model: null,
    });
  }
  assert.deepEqual(output, readFileSync(new URL('./assignment.json', import.meta.url)));
});
