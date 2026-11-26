import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from '../models/lib/raster.mjs';
import { renderModel } from './lib/render.mjs';
import { contactSheet, modelsSheet } from './lib/sheets.mjs';
import { isMain, requireNode, write, sha256 } from './lib/io.mjs';

export function buildSamples(full, out = fileURLToPath(new URL('./', import.meta.url))) {
  requireNode();
  const bytes = readFileSync(join(full, 'manifest.json')), manifest = JSON.parse(bytes);
  const images = new Map(), renders = new Map();
  const rowsFor = ids => ids.map(id => manifest.entries.find(row => row.id === id));
  for (const row of rowsFor(manifest.samples.pictures)) {
    const png = readFileSync(join(full, row.picture.file));
    assert.equal(sha256(png), row.picture.sha256);
    write(join(out, 'samples', row.picture.file), png);
    images.set(row.id, decodePng(png));
  }
  for (const row of rowsFor(manifest.samples.models)) {
    const glb = readFileSync(join(full, row.model.file));
    assert.equal(sha256(glb), row.model.sha256);
    write(join(out, 'samples', row.model.file), glb);
    for (const camera of ['front', 'three-quarter']) {
      const render = renderModel(glb, camera);
      renders.set(`${row.id}/${camera}`, render);
      write(join(out, 'samples', `render-${row.id}-${camera}.png`), encodePng(render));
    }
  }
  write(join(out, 'manifest.json'), bytes);
  write(join(out, 'contact-sheet.png'), encodePng(contactSheet(rowsFor(manifest.samples.pictures), images)));
  write(join(out, 'models-sheet.png'), encodePng(modelsSheet(rowsFor(manifest.samples.models), images, renders)));
  return manifest.samples;
}
if (isMain(import.meta.url)) {
  const [flag, full, extra] = process.argv.slice(2);
  assert.ok(flag === '--from' && full && !extra, 'Usage: node samples.mjs --from <full-build-directory>');
  process.stdout.write(`${JSON.stringify(buildSamples(full))}\n`);
}
