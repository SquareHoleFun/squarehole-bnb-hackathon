import assert from 'node:assert/strict';
import { encodeGlb, readGlb, PALETTE, srgbToLinear } from '../../../rent-free/models/lib/glb.mjs';
import { C } from '../../src/palette.mjs';

/** Reuse the Rent Free mesh writer without mutating its seven fixed material slots.
 * Only replace the JSON material table and generator label; preserve the writer's BIN exactly.
 * Each bag deliberately uses at most seven palette colours, including ink and hardware.
 */
export function exportGlb(triangles) {
  const colors = [...new Set(triangles.map(t => t.color))], slots = Object.keys(PALETTE);
  assert.ok(colors.length <= slots.length, 'at most seven colours per model');
  const bytes = encodeGlb(triangles.map(t => ({ points: t.points, material: slots[colors.indexOf(t.color)] })), 'Bag Holders proposal');
  const { json } = readGlb(bytes);
  json.asset.generator = 'Bag Holders deterministic proposal v1';
  json.materials = slots.map((_, i) => {
    const hex = colors[i] ?? C.ink;
    return { name: hex, pbrMetallicRoughness: {
      baseColorFactor: [...[1, 3, 5].map(at => srgbToLinear(Number.parseInt(hex.slice(at, at + 2), 16) / 255)), 1],
      metallicFactor: 0, roughnessFactor: 0.9,
    } };
  });
  const source = Buffer.from(JSON.stringify(json)), chunk = Buffer.alloc(Math.ceil(source.length / 4) * 4, 32);
  source.copy(chunk);
  const binChunk = bytes.subarray(20 + bytes.readUInt32LE(12)), header = Buffer.from(bytes.subarray(0, 20));
  header.writeUInt32LE(20 + chunk.length + binChunk.length, 8);
  header.writeUInt32LE(chunk.length, 12);
  return Buffer.concat([header, chunk, binChunk]);
}
