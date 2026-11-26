/** SH-197-af1 platform exception, founder OK 2026-11-11 ("ok": Mac bytes stay the reference, listed exception elsewhere).
 * Intel and Apple Silicon differ only in four normal-component zero signs for kind 09.
 * Never change the producer or its reviewed manifest. arm64 ignores this list entirely.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function reviewedManifestForPlatform(id, reviewed, arch = process.arch) {
  if (id !== 'bag-holders' || arch === 'arm64') return reviewed;
  const list = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'bag-holders-intel-normal-zero-hashes.json'), 'utf8'));
  const expected = structuredClone(reviewed);
  const affected = expected.items.filter(row => row.traits.kind === '09');
  assert.equal(affected.length, 35, 'platform exception is exactly the 35 kind-09 models');
  assert.deepEqual(Object.keys(list).sort(), affected.map(row => `model-${row.id}.glb`).sort(), 'exact platform exception filenames');
  for (const row of affected) {
    const hash = list[`model-${row.id}.glb`];
    assert.match(hash, /^[0-9a-f]{64}$/, 'Intel normal-zero SHA-256');
    assert.notEqual(hash, row.model.sha256, 'exception must differ from the reviewed ARM hash');
    row.model.sha256 = hash;
  }
  return expected;
}

/** Keep the recorded JSON formatting exact; translate only model hashes anchored to the ARM manifest.
 * Assignment hashes use 0x; producer manifest hashes are bare. arm64 does not consult the list.
 */
export function reviewedJsonForPlatform(source, reviewed, arch = process.arch, hashPrefix = '') {
  const platform = reviewedManifestForPlatform('bag-holders', reviewed, arch);
  if (platform === reviewed) return source;
  assert.ok(hashPrefix === '' || hashPrefix === '0x');
  const recorded = JSON.parse(source), json = value => `${JSON.stringify(value, null, 2)}\n`;
  assert.equal(json(recorded), source, 'recorded JSON formatting stays exact');
  assert.deepEqual(recorded.items.map(row => row.id), reviewed.items.map(row => row.id), 'recorded model IDs');
  for (const [index, row] of recorded.items.entries()) {
    assert.equal(row.model.sha256, `${hashPrefix}${reviewed.items[index].model.sha256}`, 'recorded model must match reviewed ARM hash');
    row.model.sha256 = `${hashPrefix}${platform.items[index].model.sha256}`;
  }
  return json(recorded);
}

/** Reverse exactly the four known Intel normal zero signs in a copy. Never rewrite generated files. */
export function restoreReviewedNormalZeros(bytes) {
  const restored = Buffer.from(bytes), size = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + size));
  const primitive = gltf.meshes[0].primitives.find(p => p.material === 3);
  const accessor = gltf.accessors[primitive.attributes.NORMAL];
  assert.equal(accessor.type, 'VEC3');
  assert.equal(accessor.componentType, 5126);
  const base = 28 + size + gltf.bufferViews[accessor.bufferView].byteOffset + (accessor.byteOffset ?? 0);
  for (const [index, intel, arm] of [[63, 0x80000000, 0], [69, 0, 0x80000000], [351, 0x80000000, 0], [357, 0, 0x80000000]]) {
    assert.ok(index < accessor.count * 3);
    assert.equal(bytes.readUInt32LE(base + index * 4), intel, 'only the known normal zero signs');
    restored.writeUInt32LE(arm, base + index * 4);
  }
  return restored;
}

/** Only a listed model with the exact Intel hash may be restored for byte comparison with an ARM sample. */
export function reviewedModelBytesForPlatform(name, bytes, reviewed, arch = process.arch) {
  const platform = reviewedManifestForPlatform('bag-holders', reviewed, arch);
  if (platform === reviewed) return bytes;
  const index = reviewed.items.findIndex(row => name === `model-${row.id}.glb`);
  if (index < 0 || platform.items[index].model.sha256 === reviewed.items[index].model.sha256) return bytes;
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(bytes.length, reviewed.items[index].model.bytes, `${name} length`);
  assert.equal(hash(bytes), platform.items[index].model.sha256, `listed Intel model hash: ${name}`);
  const restored = restoreReviewedNormalZeros(bytes);
  assert.equal(hash(restored), reviewed.items[index].model.sha256, `four normal zero signs recover reviewed ${name}`);
  return restored;
}
