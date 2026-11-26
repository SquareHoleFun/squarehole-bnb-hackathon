// Dependency-free RGB PNG codec and orthographic z-buffer rasterizer. No browser, fonts or network.
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { readGlb, readAccessor, cross, sub, dot, unit, linearToSrgb } from './glb.mjs';

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}
export function encodePng({ width, height, rgb }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const stride = width * 3, scan = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(scan, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(scan, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
export function decodePng(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  const data = [];
  let header;
  for (let cursor = 8; cursor < bytes.length;) {
    const length = bytes.readUInt32BE(cursor), type = bytes.toString('ascii', cursor + 4, cursor + 8);
    assert.ok(cursor + 12 + length <= bytes.length, 'PNG chunk length');
    assert.equal(crc32(bytes.subarray(cursor + 4, cursor + 8 + length)), bytes.readUInt32BE(cursor + 8 + length), 'PNG CRC');
    const body = bytes.subarray(cursor + 8, cursor + 8 + length);
    if (type === 'IHDR') header = body;
    if (type === 'IDAT') data.push(body);
    cursor += 12 + length;
    if (type === 'IEND') { assert.equal(cursor, bytes.length); break; }
  }
  assert.ok(header && header[8] === 8 && [2, 6].includes(header[9]) && header[10] === 0 && header[11] === 0 && header[12] === 0, '8-bit noninterlaced RGB/RGBA PNG');
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), channels = header[9] === 6 ? 4 : 3;
  const stride = width * channels, raw = inflateSync(Buffer.concat(data)), rgb = Buffer.alloc(width * height * 3);
  assert.equal(raw.length, (stride + 1) * height, 'PNG scanline length');
  let prev = Buffer.alloc(stride), line = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4, 'PNG filter');
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0, b = prev[x], c = x >= channels ? prev[x - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const prediction = [0, a, b, Math.floor((a + b) / 2), pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      line[x] = (raw[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
    for (let x = 0; x < width; x++) line.copy(rgb, (y * width + x) * 3, x * channels, x * channels + 3);
    [prev, line] = [line, prev];
  }
  return { width, height, rgb };
}
export function canvas(width, height, color = [255, 247, 230]) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < rgb.length; i += 3) for (let c = 0; c < 3; c++) rgb[i + c] = color[c];
  return { width, height, rgb };
}
export function blit(target, source, x, y) {
  for (let row = 0; row < source.height; row++) source.rgb.copy(target.rgb, ((y + row) * target.width + x) * 3, row * source.width * 3, (row + 1) * source.width * 3);
}
export const CAMERAS = {
  front: { view: [0, 0, 1], target: [0, 0.5, 0], pixelsPerUnit: 340 },
  'three-quarter': { view: [-0.55, 0.28, 0.8], target: [0, 0.5, 0], pixelsPerUnit: 340 },
};
export function renderGlb(bytes, camera = 'front') {
  const glb = readGlb(bytes), { json } = glb, config = CAMERAS[camera];
  assert.ok(config, 'known camera');
  const view = unit(config.view), right = unit(cross([0, 1, 0], view)), up = cross(view, right);
  const light = unit([-0.4, 0.7, 1]);
  const aa = 2, size = 512 * aa, scale = config.pixelsPerUnit * aa;
  const image = canvas(size, size), depth = new Float64Array(size * size).fill(-Infinity);
  const project = p => {
    const q = sub(p, config.target);
    return [size / 2 + dot(q, right) * scale, size / 2 - dot(q, up) * scale, dot(q, view)];
  };
  const edge = (a, b, x, y) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  for (const primitive of json.meshes[0].primitives) {
    const positions = readAccessor(glb, primitive.attributes.POSITION), indices = readAccessor(glb, primitive.indices).flat();
    const base = json.materials[primitive.material].pbrMetallicRoughness.baseColorFactor;
    for (let i = 0; i < indices.length; i += 3) {
      const points = indices.slice(i, i + 3).map(index => positions[index]);
      const normal = unit(cross(sub(points[1], points[0]), sub(points[2], points[0])));
      if (dot(normal, view) <= 0) continue;
      const shade = 0.78 + 0.22 * Math.max(0, dot(normal, light));
      const color = base.slice(0, 3).map(c => Math.round(255 * linearToSrgb(c * shade)));
      const [a, b, c] = points.map(project), area = edge(a, b, c[0], c[1]);
      if (Math.abs(area) < 1e-8) continue;
      const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const u = edge(b, c, x + 0.5, y + 0.5) / area, v = edge(c, a, x + 0.5, y + 0.5) / area, w = 1 - u - v;
        if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
        const z = u * a[2] + v * b[2] + w * c[2], at = y * size + x;
        if (z <= depth[at]) continue;
        depth[at] = z;
        for (let channel = 0; channel < 3; channel++) image.rgb[at * 3 + channel] = color[channel];
      }
    }
  }
  const out = canvas(512, 512);
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) for (let c = 0; c < 3; c++) {
    let sum = 0;
    for (let dy = 0; dy < aa; dy++) for (let dx = 0; dx < aa; dx++) sum += image.rgb[((y * aa + dy) * size + x * aa + dx) * 3 + c];
    out.rgb[(y * 512 + x) * 3 + c] = Math.round(sum / (aa * aa));
  }
  return out;
}

// A tiny original 5x7 bitmap alphabet keeps the contact sheet portable without system fonts.
const FONT = {
  A: '01110/10001/10001/11111/10001/10001/10001', B: '11110/10001/10001/11110/10001/10001/11110',
  C: '01111/10000/10000/10000/10000/10000/01111', D: '11110/10001/10001/10001/10001/10001/11110',
  E: '11111/10000/10000/11110/10000/10000/11111', F: '11111/10000/10000/11110/10000/10000/10000',
  G: '01111/10000/10000/10111/10001/10001/01111', H: '10001/10001/10001/11111/10001/10001/10001',
  I: '11111/00100/00100/00100/00100/00100/11111', J: '00111/00010/00010/00010/10010/10010/01100',
  K: '10001/10010/10100/11000/10100/10010/10001', L: '10000/10000/10000/10000/10000/10000/11111',
  M: '10001/11011/10101/10101/10001/10001/10001', N: '10001/11001/10101/10011/10001/10001/10001',
  O: '01110/10001/10001/10001/10001/10001/01110', P: '11110/10001/10001/11110/10000/10000/10000',
  Q: '01110/10001/10001/10001/10101/10010/01101', R: '11110/10001/10001/11110/10100/10010/10001',
  S: '01111/10000/10000/01110/00001/00001/11110', T: '11111/00100/00100/00100/00100/00100/00100',
  U: '10001/10001/10001/10001/10001/10001/01110', V: '10001/10001/10001/10001/10001/01010/00100',
  W: '10001/10001/10001/10101/10101/10101/01010', X: '10001/10001/01010/00100/01010/10001/10001',
  Y: '10001/10001/01010/00100/00100/00100/00100', Z: '11111/00001/00010/00100/01000/10000/11111',
  0: '01110/10001/10011/10101/11001/10001/01110', 1: '00100/01100/00100/00100/00100/00100/01110',
  2: '01110/10001/00001/00010/00100/01000/11111', 3: '11110/00001/00001/01110/00001/00001/11110',
  4: '00010/00110/01010/10010/11111/00010/00010', 5: '11111/10000/10000/11110/00001/00001/11110',
  6: '01110/10000/10000/11110/10001/10001/01110', 7: '11111/00001/00010/00100/01000/01000/01000',
  8: '01110/10001/10001/01110/10001/10001/01110', 9: '01110/10001/10001/01111/00001/00001/01110',
  '-': '00000/00000/00000/11111/00000/00000/00000', ' ': '00000/00000/00000/00000/00000/00000/00000',
};
export function label(image, text, x, y, scale = 2) {
  for (const [i, char] of [...text.toUpperCase()].entries()) {
    const rows = FONT[char];
    assert.ok(rows, `font glyph ${char}`);
    rows.split('/').forEach((row, j) => [...row].forEach((bit, k) => {
      if (bit === '0') return;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const at = ((y + j * scale + dy) * image.width + x + (i * 6 + k) * scale + dx) * 3;
        image.rgb[at] = 23; image.rgb[at + 1] = 61; image.rgb[at + 2] = 50;
      }
    }));
  }
}
