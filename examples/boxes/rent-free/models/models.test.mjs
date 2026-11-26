import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('./', import.meta.url));
const names = ['Cottage', 'Townhouse', 'Bungalow', 'A-frame', 'Awning', 'Arch roof', 'Clay roof', 'Step gable', 'Lean-to', 'Clay dome', 'Dormer', 'Roof garden'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const file = n => `variant-${String(n).padStart(2, '0')}.glb`;

for (let i = 1; i <= 12; i++) {
  test(`${file(i)}: binary glTF, material, geometry and committed manifest contract`, async () => {
    const bytes = readFileSync(join(root, file(i)));
    const { checkModel } = await import('./check-models.mjs');
    const result = checkModel(bytes);
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.length, 12);
    assert.deepEqual(manifest[i - 1], {
      variant: i, name: names[i - 1], file: file(i), bytes: bytes.length,
      triangles: result.triangles, sha256: hash(bytes),
    });
    assert.ok(result.triangles < 2000, 'the softer triangle target, too');
    assert.ok(result.bounds.max[2] - result.bounds.min[2] > 0.3, 'a house has real depth');
  });
}

test('two isolated builds are byte-identical and reproduce every committed GLB and manifest', () => {
  const scratch = fileURLToPath(new URL('../../../../.cache/tmp/', import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const outputs = [mkdtempSync(join(scratch, 'rent-free-a-')), mkdtempSync(join(scratch, 'rent-free-b-'))];
  for (const out of outputs) {
    const result = spawnSync(process.execPath, [join(root, 'build-models.mjs'), '--out', out], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const name of [...names.map((_, i) => file(i + 1)), 'manifest.json']) {
    assert.deepEqual(readFileSync(join(outputs[0], name)), readFileSync(join(outputs[1], name)), name);
    assert.deepEqual(readFileSync(join(outputs[0], name)), readFileSync(join(root, name)), `committed ${name}`);
  }
});

// Reframe mutated JSON independently of the exporter, so malformed files exercise the checker.
function mutateJson(bytes, mutate) {
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength));
  mutate(json);
  const source = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(source.length / 4) * 4, 32);
  source.copy(padded);
  const tail = bytes.subarray(20 + jsonLength);
  const head = Buffer.from(bytes.subarray(0, 20));
  head.writeUInt32LE(20 + padded.length + tail.length, 8);
  head.writeUInt32LE(padded.length, 12);
  return Buffer.concat([head, padded, tail]);
}

test('checker rejects malformed headers, framing and limits', async () => {
  const { checkModel } = await import('./check-models.mjs');
  const original = readFileSync(join(root, file(1)));
  for (const [offset, value] of [[0, 0], [4, 1], [8, 0], [12, 0xfffffffc], [16, 0]]) {
    const bytes = Buffer.from(original);
    bytes.writeUInt32LE(value, offset);
    assert.throws(() => checkModel(bytes), /GLB|chunk|version|length/i);
  }
  assert.throws(() => checkModel(original.subarray(0, 19)), /GLB|length/i);
  assert.throws(() => checkModel(Buffer.alloc(262145)), /256 KiB/);
});

test('checker rejects external resources, extensions, textures and missing flat materials', async () => {
  const { checkModel } = await import('./check-models.mjs');
  const original = readFileSync(join(root, file(1)));
  for (const mutate of [
    j => { j.asset.version = '1.0'; },
    j => { j.buffers[0].uri = 'other.bin'; },
    j => { j.images = [{ uri: 'other.png' }]; },
    j => { j.images = [{ bufferView: 0, mimeType: 'image/png' }]; },
    j => { j.extensionsUsed = ['KHR_materials_unlit']; },
    j => { j.meshes[0].primitives[0].extensions = { unknown: {} }; },
    j => { j.textures = [{}]; },
    j => { j.meshes[0].primitives[0].material = 999; },
    j => { delete j.materials[0].pbrMetallicRoughness.baseColorFactor; },
    j => { j.materials[0].pbrMetallicRoughness.metallicFactor = 1; },
    j => { j.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 }; },
  ]) assert.throws(() => checkModel(mutateJson(original, mutate)));
});

test('checker measures vertices, rejects lying bounds, bad indices, transforms and triangle overflow', async () => {
  const { checkModel } = await import('./check-models.mjs');
  const original = readFileSync(join(root, file(1)));
  for (const mutate of [
    j => { j.accessors[0].min[1] = -100; },
    j => { j.accessors[0].count = 1000000; },
    j => { j.bufferViews[0].byteLength = 4; },
    j => { j.nodes[0].translation = [0, 2, 0]; },
    j => { j.meshes[0].primitives = Array(100).fill(j.meshes[0].primitives[0]); },
  ]) assert.throws(() => checkModel(mutateJson(original, mutate)));
  const jsonLength = original.readUInt32LE(12);
  const json = JSON.parse(original.subarray(20, 20 + jsonLength));
  const binStart = 20 + jsonLength + 8;
  const position = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
  const offset = binStart + (json.bufferViews[position.bufferView].byteOffset ?? 0) + (position.byteOffset ?? 0);
  const broken = Buffer.from(original);
  broken.writeFloatLE(-10, offset + 4);
  assert.throws(() => checkModel(broken), /bounds|ground|height|winding/i);
  const indices = json.accessors[json.meshes[0].primitives[0].indices];
  const invalidIndex = Buffer.from(original);
  invalidIndex.writeUInt16LE(65535, binStart + (json.bufferViews[indices.bufferView].byteOffset ?? 0));
  assert.throws(() => checkModel(invalidIndex), /index/i);
});

test('checker rejects off-ground, off-centre and wrong-height geometry even with truthful accessor bounds', async () => {
  const { checkModel } = await import('./check-models.mjs');
  const original = readFileSync(join(root, file(1)));
  for (const [axis, scale, shift, reason] of [[1, 1, 0.1, /ground/], [0, 1, 0.1, /centred/], [2, 1, 0.1, /centred/], [1, 0.5, 0, /height/], [1, 2, 0, /height/]]) {
    const bytes = Buffer.from(original);
    const length = bytes.readUInt32LE(12), json = JSON.parse(bytes.subarray(20, 20 + length));
    const bounds = new Map();
    for (const p of json.meshes[0].primitives) {
      const a = json.accessors[p.attributes.POSITION], v = json.bufferViews[a.bufferView];
      const offset = 28 + length + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
      const values = [];
      for (let i = 0; i < a.count; i++) {
        const at = offset + i * (v.byteStride ?? 12) + axis * 4;
        bytes.writeFloatLE(bytes.readFloatLE(at) * scale + shift, at);
        values.push(bytes.readFloatLE(at));
      }
      bounds.set(p.attributes.POSITION, [Math.min(...values), Math.max(...values)]);
    }
    const changed = mutateJson(bytes, j => {
      for (const [index, [min, max]] of bounds) { j.accessors[index].min[axis] = min; j.accessors[index].max[axis] = max; }
    });
    assert.throws(() => checkModel(changed), reason);
  }
});

test('all reference/render pairs and the labelled contact sheet are present as PNGs', async () => {
  const { decodePng } = await import('./lib/raster.mjs');
  for (let i = 1; i <= 12; i++) {
    for (const camera of ['front', 'three-quarter']) {
      const png = decodePng(readFileSync(join(root, 'renders', file(i).replace('.glb', `-${camera}.png`))));
      assert.deepEqual([png.width, png.height], [512, 512]);
      assert.ok(new Set(png.rgb).size > 16, 'not an empty render');
    }
  }
  const sheet = decodePng(readFileSync(join(root, 'renders/contact-sheet.png')));
  assert.deepEqual([sheet.width, sheet.height], [1536, 6720]);
});
