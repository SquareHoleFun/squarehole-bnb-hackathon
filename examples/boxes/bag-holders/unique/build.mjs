import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { loadResvg, toPng } from '../src/render.mjs';
import { checkModel } from '../../rent-free/models/check-models.mjs';
import { deal, SEED, SPEC } from './deal.mjs';
import { pictureSvg } from './picture.mjs';
import { modelGlb } from './model.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export function toolchain() {
  assert.equal(process.versions.node, '24.22.1', 'use Node 24.22.1');
  const require = createRequire(new URL('../../../../packages/cards/package.json', import.meta.url));
  assert.equal(require('@resvg/resvg-js/package.json').version, '2.6.2', 'use pinned resvg');
  return { node: '24.22.1', resvg: '2.6.2' };
}

/** A full build writes only to the explicitly supplied directory. It never updates committed evidence. */
export async function build(directory) {
  const versions = toolchain(), Resvg = await loadResvg();
  mkdirSync(directory, { recursive: true });
  const items = [];
  for (const { id, traits } of deal()) {
    const svg = Buffer.from(pictureSvg(traits)), png = toPng(Resvg, svg), glb = modelGlb(traits);
    const { triangles } = checkModel(glb);
    assert.ok(png.length < 400 * 1024, `picture ${id} exceeds 400 KiB`);
    writeFileSync(join(directory, `picture-${id}.svg`), svg);
    writeFileSync(join(directory, `picture-${id}.png`), png);
    writeFileSync(join(directory, `model-${id}.glb`), glb);
    items.push({ id, traits, svg: { sha256: sha256(svg), bytes: svg.length }, picture: { sha256: sha256(png), bytes: png.length }, model: { sha256: sha256(glb), bytes: glb.length, triangles } });
  }
  const totals = Object.fromEntries(['svg', 'picture', 'model'].map(kind => [`${kind}Bytes`, items.reduce((sum, e) => sum + e[kind].bytes, 0)]));
  const manifest = { format: 'bag-holders-unique-v1', proposal: true, count: SPEC.count, seed: SEED, toolchain: versions, pixelsPerUnit: 760, totals, items };
  writeFileSync(join(directory, 'manifest.json'), jsonBytes(manifest));
  return manifest;
}

if (import.meta.main) {
  assert.ok(process.argv.length === 4 && process.argv[2] === '--out', 'usage: node build.mjs --out <directory>');
  const manifest = await build(resolve(process.argv[3]));
  process.stdout.write(`${JSON.stringify({ count: manifest.count, ...manifest.totals })}\n`);
}
