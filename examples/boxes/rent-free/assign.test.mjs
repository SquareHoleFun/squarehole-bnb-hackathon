import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assignment, variantFor } from './assign.mjs';

const root = new URL('./', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('unique/manifest.json', root), 'utf8'));
const columns = ['house', 'door', 'window', 'post', 'plant', 'step'];

function checkEdition(edition) {
  assert.equal(edition.modelPolicy, '3d', 'the active edition must carry a model for every house');
  assert.equal(edition.count, '500');
  assert.equal(edition.seed, manifest.seed);
  assert.deepEqual(edition.columns, columns);
  assert.equal(edition.items.length, 500);
  assert.equal(new Set(edition.items.map(item => item.picture.sha256)).size, 500);
  assert.equal(new Set(edition.items.map(item => item.model.sha256)).size, 500);
  assert.equal(Object.hasOwn(edition, 'directory'), false, 'scratch directories must not enter assignment.json');
  for (const [index, item] of edition.items.entries()) {
    const reviewed = manifest.entries[index];
    assert.equal(item.id, BigInt(index + 1).toString());
    assert.equal(item.id, reviewed.id);
    assert.deepEqual(Object.keys(item.traits), columns);
    assert.deepEqual(item.traits, reviewed.traits);
    for (const kind of ['picture', 'model']) {
      assert.deepEqual(item[kind], {
        path: reviewed[kind].file,
        sha256: `0x${reviewed[kind].sha256}`,
        bytes: reviewed[kind].bytes,
      }, `${item.id} ${kind} must identify the reviewed generated asset`);
    }
  }
}

test('T03-RF-1/2: active assignment uses all reviewed unique pictures, traits and models', { timeout: 240_000 }, async () => {
  const edition = await assignment();
  checkEdition(edition);
  assert.equal(`${JSON.stringify(edition, null, 2)}\n`, readFileSync(new URL('assignment.json', root), 'utf8'));
});

test('T03-RF-1: assignment CLI rebuilds identical JSON without an import cycle', { timeout: 240_000 }, () => {
  const json = execFileSync(process.execPath, [fileURLToPath(new URL('assign.mjs', root))], {
    cwd: fileURLToPath(root), encoding: 'utf8', timeout: 240_000, maxBuffer: 2 * 1024 * 1024,
  });
  checkEdition(JSON.parse(json));
  assert.equal(json, readFileSync(new URL('assignment.json', root), 'utf8'));
});

test('T03-RF-1: base family helper keeps its canonical ids and original mapping', () => {
  for (let id = 1n; id <= 500n; id++) {
    assert.equal(variantFor(id.toString()), (((id - 1n) % 12n) + 1n).toString().padStart(2, '0'));
  }
  for (const bad of ['0', '501', '01', '-1', '1.0', '', ' 1', '1e2', 4, 4n, null]) {
    assert.throws(() => variantFor(bad), /token id/);
  }
});
