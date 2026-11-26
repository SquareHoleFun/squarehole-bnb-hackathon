import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readGlb, readAccessor, cross, sub, dot } from './lib/glb.mjs';

export function checkModel(bytes) {
  assert.ok(bytes.length <= 256 * 1024, 'model exceeds 256 KiB');
  const glb = readGlb(bytes), { json, bin } = glb;
  assert.equal(json.asset?.version, '2.0', 'asset.version');
  function resources(value) {
    if (!value || typeof value !== 'object') return;
    assert.ok(!Object.hasOwn(value, 'uri'), 'no external/data URIs');
    for (const name of [...(value.extensionsUsed ?? []), ...(value.extensionsRequired ?? []), ...Object.keys(value.extensions ?? {})]) {
      assert.equal(name, 'KHR_mesh_quantization', `extension ${name}`);
    }
    for (const child of Object.values(value)) resources(child);
  }
  resources(json);
  assert.ok(!json.images?.length && !json.textures?.length && !json.samplers?.length, 'no images or textures');
  assert.equal(json.buffers?.length, 1, 'one embedded buffer');
  assert.equal(json.buffers[0].byteLength, bin.length, 'buffer length');
  // This generator bakes every vertex: refusing transforms/instances avoids measuring the wrong space.
  assert.equal(json.scene, 0, 'default scene');
  assert.deepEqual(json.scenes, [{ nodes: [0] }], 'one scene');
  assert.equal(json.nodes?.length, 1, 'one baked node');
  assert.equal(json.nodes[0].mesh, 0, 'mesh node');
  for (const key of ['matrix', 'translation', 'rotation', 'scale', 'children', 'skin', 'weights']) {
    assert.equal(json.nodes[0][key], undefined, 'baked geometry only');
  }
  assert.equal(json.meshes?.length, 1, 'one mesh');
  assert.ok(!json.animations?.length && !json.skins?.length, 'static geometry');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  assert.ok(json.meshes[0].primitives.length > 0, 'nonempty mesh');
  for (const p of json.meshes[0].primitives) {
    assert.equal(p.mode ?? 4, 4, 'triangles only');
    assert.ok(!p.targets, 'no morph targets');
    const material = json.materials?.[p.material], color = material?.pbrMetallicRoughness;
    assert.ok(Array.isArray(color?.baseColorFactor) && color.baseColorFactor.length === 4, 'primitive material baseColorFactor');
    assert.ok(color.baseColorFactor.every(v => Number.isFinite(v) && v >= 0 && v <= 1), 'material color range');
    assert.equal(color.baseColorFactor[3], 1, 'opaque color');
    assert.equal(material.alphaMode ?? 'OPAQUE', 'OPAQUE');
    assert.equal(color.metallicFactor, 0, 'nonmetal material');
    assert.ok(color.roughnessFactor >= 0.85 && color.roughnessFactor <= 1, 'matte material');
    assert.ok(!JSON.stringify(material).includes('Texture'), 'no material textures');
    const positions = readAccessor(glb, p.attributes.POSITION), normals = readAccessor(glb, p.attributes.NORMAL);
    assert.equal(json.accessors[p.attributes.POSITION].type, 'VEC3');
    assert.equal(json.accessors[p.attributes.NORMAL].type, 'VEC3');
    assert.equal(positions.length, normals.length, 'normal count');
    assert.ok(normals.every(n => Math.abs(Math.hypot(...n) - 1) < 0.001), 'unit normals');
    const indices = readAccessor(glb, p.indices).flat();
    assert.equal(json.accessors[p.indices].type, 'SCALAR');
    assert.equal(json.accessors[p.indices].componentType, 5123);
    assert.equal(indices.length % 3, 0, 'triangle index count');
    assert.ok(indices.every(n => n < positions.length), 'index out of range');
    triangles += indices.length / 3;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = indices.slice(i, i + 3).map(index => positions[index]);
      assert.ok(dot(cross(sub(b, a), sub(c, a)), normals[indices[i]]) > 1e-12, 'nondegenerate outward winding');
    }
    const local = [Math.min, Math.max].map(fn => [0, 1, 2].map(axis => fn(...positions.map(p => p[axis]))));
    const accessor = json.accessors[p.attributes.POSITION];
    assert.deepEqual(accessor.min, local[0], 'accessor minimum bounds');
    assert.deepEqual(accessor.max, local[1], 'accessor maximum bounds');
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], local[0][axis]); max[axis] = Math.max(max[axis], local[1][axis]);
    }
  }
  assert.ok(triangles <= 4000, 'more than 4000 triangles');
  assert.ok(Math.abs(min[1]) <= 0.001, 'ground y = 0');
  for (const axis of [0, 2]) assert.ok(Math.abs((min[axis] + max[axis]) / 2) <= 0.01, 'centred bounds');
  assert.ok(max[1] - min[1] >= 0.8 && max[1] - min[1] <= 1.2, 'height 0.8 to 1.2');
  return { triangles, bounds: { min, max } };
}

export function checkModels(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.length, 12, 'twelve models');
  for (const [i, entry] of manifest.entries()) {
    assert.equal(entry.variant, i + 1);
    assert.equal(entry.file, `variant-${String(i + 1).padStart(2, '0')}.glb`);
    const bytes = readFileSync(join(directory, entry.file)), result = checkModel(bytes);
    assert.equal(entry.bytes, bytes.length, 'manifest bytes');
    assert.equal(entry.triangles, result.triangles, 'manifest triangles');
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'), 'manifest sha256');
  }
  return manifest;
}

/** Started as a program (through any symlink), not imported: a path that is no file (an `-e` argument) is not this file. */
function isEntry() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isEntry()) {
  checkModels(fileURLToPath(new URL('./', import.meta.url)));
  process.stdout.write('12 models: GLB, materials, geometry limits and manifest hashes pass\n');
}
