import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deal, SEED, SPEC } from './deal.mjs';
import { pictureSvg, picturePng } from './picture.mjs';
import { modelGlb } from './model.mjs';
import { checkModel } from '../models/check-models.mjs';
import { selectSamples } from './lib/samples.mjs';
import { isMain, requireNode, jsonBytes, sha256, write } from './lib/io.mjs';

// Full output is deliberately explicit and must be empty; committed samples have a separate command.
export function build(out) {
  requireNode();
  assert.ok(out, 'output directory required');
  assert.ok(!existsSync(out) || readdirSync(out).length === 0, 'build output must be empty; choose a fresh directory');
  mkdirSync(out, { recursive: true });
  const rows = deal(), entries = [];
  for (const row of rows) {
    const svg = Buffer.from(pictureSvg(row.traits)), png = picturePng(row.traits), glb = modelGlb(row.traits);
    const { triangles } = checkModel(glb);
    assert.ok(png.length < 400 * 1024, `picture ${row.id} exceeds 400 KiB`);
    const file = (kind, extension) => `${kind}-${row.id}.${extension}`;
    write(join(out, file('picture', 'svg')), svg);
    write(join(out, file('picture', 'png')), png);
    write(join(out, file('model', 'glb')), glb);
    entries.push({ ...row,
      picture: { file: file('picture', 'png'), sha256: sha256(png), bytes: png.length, width: 1024, height: 1024 },
      svg: { file: file('picture', 'svg'), sha256: sha256(svg), bytes: svg.length },
      model: { file: file('model', 'glb'), sha256: sha256(glb), bytes: glb.length, triangles },
    });
  }
  const manifest = { format: 'rent-free/unique-manifest/v1', proposal: true, seed: SEED, count: SPEC.count,
    toolchain: { node: '24.22.1', resvg: '2.6.2' }, samples: selectSamples(rows), entries };
  write(join(out, 'manifest.json'), jsonBytes(manifest));
  return manifest;
}
if (isMain(import.meta.url)) {
  const [flag, out, extra] = process.argv.slice(2);
  assert.ok(flag === '--out' && out && !extra, 'Usage: node build.mjs --out <fresh-directory>');
  const manifest = build(out);
  process.stdout.write(`Built ${manifest.count} SVGs, PNGs and GLBs from the fixed seed\n`);
}
