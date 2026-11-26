// Small binary glTF writer/reader for this asset set's baked, indexed triangle meshes.
import assert from 'node:assert/strict';

export const PALETTE = {
  forest: '#173D32', green: '#73B98C', roof: '#3A6D51', butter: '#F3CA66', clay: '#DA795B',
  gable: '#569B70', leaf: '#6BA361', // Flat approximations of the cottage gable and roof-garden fills.
};
export const srgbToLinear = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
export const linearToSrgb = c => c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
export const unit = a => a.map(v => v / Math.hypot(...a));

export function encodeGlb(triangles, name) {
  const json = {
    asset: { version: '2.0', generator: 'Rent Free deterministic model study' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0 }], meshes: [{ primitives: [] }],
    materials: Object.entries(PALETTE).map(([name, hex]) => ({
      name, pbrMetallicRoughness: {
        baseColorFactor: [...[1, 3, 5].map(i => srgbToLinear(Number.parseInt(hex.slice(i, i + 2), 16) / 255)), 1],
        metallicFactor: 0, roughnessFactor: 0.9,
      },
    })), buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [],
  };
  const buffers = [];
  let byteOffset = 0;
  const append = (buffer, target, accessor) => {
    const bufferView = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset, byteLength: buffer.length, target });
    buffers.push(buffer);
    const padding = (4 - buffer.length % 4) % 4;
    buffers.push(Buffer.alloc(padding));
    byteOffset += buffer.length + padding;
    json.accessors.push({ bufferView, ...accessor });
    return json.accessors.length - 1;
  };
  for (const [material, materialName] of Object.keys(PALETTE).entries()) {
    const positions = [], normals = [], indices = [], vertices = new Map();
    for (const triangle of triangles.filter(t => t.material === materialName)) {
      const [a, b, c] = triangle.points;
      const n = unit(cross(sub(b, a), sub(c, a))).map(Math.fround);
      for (const point of triangle.points) {
        const p = point.map(Math.fround);
        const key = [...p, ...n].join(',');
        if (!vertices.has(key)) {
          vertices.set(key, positions.length / 3);
          positions.push(...p); normals.push(...n);
        }
        indices.push(vertices.get(key));
      }
    }
    if (!indices.length) continue;
    assert.ok(vertices.size < 65536, 'uint16 vertices');
    const floats = array => {
      const b = Buffer.alloc(array.length * 4);
      array.forEach((v, i) => b.writeFloatLE(v, i * 4));
      return b;
    };
    const bounds = [Math.min, Math.max].map(fn => [0, 1, 2].map(axis => fn(...positions.filter((_, i) => i % 3 === axis))));
    const POSITION = append(floats(positions), 34962, { componentType: 5126, count: positions.length / 3, type: 'VEC3', min: bounds[0], max: bounds[1] });
    const NORMAL = append(floats(normals), 34962, { componentType: 5126, count: normals.length / 3, type: 'VEC3' });
    const ib = Buffer.alloc(indices.length * 2);
    indices.forEach((v, i) => ib.writeUInt16LE(v, i * 2));
    const index = append(ib, 34963, { componentType: 5123, count: indices.length, type: 'SCALAR' });
    json.meshes[0].primitives.push({ attributes: { POSITION, NORMAL }, indices: index, material, mode: 4 });
  }
  json.buffers[0].byteLength = byteOffset;
  const source = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.alloc(Math.ceil(source.length / 4) * 4, 32);
  source.copy(jsonChunk);
  const bin = Buffer.concat(buffers);
  const head = Buffer.alloc(20), binHead = Buffer.alloc(8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(28 + jsonChunk.length + bin.length, 8);
  head.writeUInt32LE(jsonChunk.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  binHead.writeUInt32LE(bin.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jsonChunk, binHead, bin]);
}

export function readGlb(bytes) {
  assert.ok(bytes.length >= 28, 'GLB header length');
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'GLB magic');
  assert.equal(bytes.readUInt32LE(4), 2, 'GLB version');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB total length');
  const chunks = [];
  for (let cursor = 12; cursor < bytes.length;) {
    assert.ok(cursor + 8 <= bytes.length, 'chunk header length');
    const size = bytes.readUInt32LE(cursor), type = bytes.readUInt32LE(cursor + 4);
    assert.ok(size % 4 === 0 && cursor + 8 + size <= bytes.length, 'chunk length');
    chunks.push({ type, body: bytes.subarray(cursor + 8, cursor + 8 + size) });
    cursor += 8 + size;
  }
  assert.equal(chunks.length, 2, 'JSON and BIN chunks only');
  assert.equal(chunks[0].type, 0x4e4f534a, 'JSON chunk');
  assert.equal(chunks[1].type, 0x004e4942, 'BIN chunk');
  const json = JSON.parse(chunks[0].body.toString('utf8'));
  return { json, bin: chunks[1].body };
}

export function readAccessor({ json, bin }, index) {
  const a = json.accessors?.[index];
  assert.ok(a && !a.sparse && !a.normalized, 'supported accessor');
  const view = json.bufferViews?.[a.bufferView];
  assert.ok(view && view.buffer === 0, 'accessor buffer view');
  const width = { SCALAR: 1, VEC3: 3 }[a.type];
  const bytes = { 5123: 2, 5126: 4 }[a.componentType];
  assert.ok(width && bytes, 'accessor type');
  assert.ok(Number.isInteger(a.count) && a.count > 0, 'accessor count');
  const stride = view.byteStride ?? width * bytes;
  const offset = a.byteOffset ?? 0, start = view.byteOffset ?? 0;
  assert.ok(Number.isInteger(start) && start >= 0 && start % 4 === 0, 'buffer alignment');
  assert.ok(Number.isInteger(offset) && offset >= 0 && offset % bytes === 0, 'accessor alignment');
  assert.ok(Number.isInteger(stride) && stride >= width * bytes && stride % bytes === 0, 'accessor stride');
  assert.ok(Number.isInteger(view.byteLength) && offset + (a.count - 1) * stride + width * bytes <= view.byteLength && start + view.byteLength <= bin.length, 'accessor bounds');
  return Array.from({ length: a.count }, (_, i) => Array.from({ length: width }, (_, axis) => {
    const at = start + offset + i * stride + axis * bytes;
    const value = bytes === 4 ? bin.readFloatLE(at) : bin.readUInt16LE(at);
    assert.ok(Number.isFinite(value), 'finite accessor');
    return value;
  }));
}
