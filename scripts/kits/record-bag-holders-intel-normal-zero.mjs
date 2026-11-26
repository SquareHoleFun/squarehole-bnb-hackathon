/** Reproduce the proposed exception list. Writes only the supplied new fixture path.
 * Reversing four zero signs must recover each reviewed hash; every other model must match as-is.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { restoreReviewedNormalZeros } from './bag-holders-normal-zero-platform-exception.mjs';
import { modelGlb } from '../../examples/boxes/bag-holders/unique/model.mjs';

export function intelNormalZeroHashes(reviewed, model = modelGlb) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const result = {};
  for (const row of reviewed.items) {
    const bytes = model(row.traits);
    assert.equal(bytes.length, row.model.bytes, `model-${row.id}.glb length`);
    if (row.traits.kind !== '09') {
      assert.equal(hash(bytes), row.model.sha256, `unlisted model-${row.id}.glb`);
      continue;
    }
    const restored = restoreReviewedNormalZeros(bytes);
    assert.equal(hash(restored), row.model.sha256, `four normal zero signs recover reviewed model-${row.id}.glb`);
    result[`model-${row.id}.glb`] = hash(bytes);
  }
  assert.equal(Object.keys(result).length, 35);
  return result;
}

if (import.meta.main) {
  assert.notEqual(process.arch, 'arm64', 'run on Intel; ARM must use the reviewed manifest');
  assert.equal(process.argv.length, 3, 'usage: record-bag-holders-intel-normal-zero.mjs NEW_FIXTURE_JSON');
  const reviewed = JSON.parse(readFileSync(new URL('../../examples/boxes/bag-holders/unique/manifest.json', import.meta.url), 'utf8'));
  const list = intelNormalZeroHashes(reviewed);
  writeFileSync(process.argv[2], `${JSON.stringify(list, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write('35 Intel model hashes; reversing only four normal zero signs recovers every reviewed hash; 385 other models unchanged\n');
}
