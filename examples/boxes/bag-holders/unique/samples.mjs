import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadResvg, toPng } from '../src/render.mjs';
import { canvas, blit, label, encodePng, decodePng, renderGlb } from '../../rent-free/models/lib/raster.mjs';
import { FIELDS, SPEC, values } from './deal.mjs';
import { jsonBytes, sha256, toolchain } from './build.mjs';

const idOrder = (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1;
const keys = e => FIELDS.map(f => `${f}:${e.traits[f]}`);
export function selectSamples(items, perKind) {
  const remaining = [...items].sort(idOrder), chosen = [], covered = new Set(), counts = new Map();
  while (chosen.length < perKind * values('kind').length) {
    const candidates = remaining.filter(e => (counts.get(e.traits.kind) ?? 0) < perKind);
    candidates.sort((a, b) => keys(b).filter(k => !covered.has(k)).length - keys(a).filter(k => !covered.has(k)).length || idOrder(a, b));
    const best = candidates[0];
    assert.ok(best, 'enough samples per kind');
    remaining.splice(remaining.indexOf(best), 1);
    chosen.push(best); keys(best).forEach(k => covered.add(k));
    counts.set(best.traits.kind, (counts.get(best.traits.kind) ?? 0) + 1);
  }
  const uncovered = FIELDS.flatMap(f => values(f).map(v => `${f}:${v}`)).filter(k => !covered.has(k));
  assert.deepEqual(uncovered, [], 'samples cover every trait value');
  return chosen.sort(idOrder);
}

function reduced(Resvg, bytes, width) {
  return decodePng(toPng(Resvg, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}"><image href="data:image/png;base64,${bytes.toString('base64')}" width="${width}" height="${width}"/></svg>`));
}
function lines(e) {
  const kind = SPEC.traits.kind.find(v => v.value === e.traits.kind).name;
  return [`${e.id} - ${kind}`, `${e.traits.trim} trim`, `${e.traits.repair} repair`, `${e.traits.tag} ${e.traits.stitch}`];
}

/** Return every committed review artifact as bytes, so the checker can recreate sheets and renders too. */
export async function reviewArtifacts(directory) {
  toolchain();
  const manifestBytes = readFileSync(join(directory, 'manifest.json'));
  const { items } = JSON.parse(manifestBytes);
  const pictures = selectSamples(items, 4), models = selectSamples(pictures, 2);
  const files = new Map([['manifest.json', manifestBytes]]), Resvg = await loadResvg();
  const contact = canvas(288 * 6, 352 * 8), modelSheet = canvas(608 * 2, 260 * 12);
  for (const [i, e] of pictures.entries()) {
    const bytes = readFileSync(join(directory, `picture-${e.id}.png`));
    assert.equal(sha256(bytes), e.picture.sha256, 'source picture hash');
    files.set(`samples/picture-${e.id}.png`, bytes);
    const x = (i % 6) * 288, y = Math.floor(i / 6) * 352;
    blit(contact, reduced(Resvg, bytes, 256), x + 16, y);
    lines(e).forEach((text, line) => label(contact, text, x + 12, y + 265 + line * 19, 2));
  }
  for (const [i, e] of models.entries()) {
    const bytes = readFileSync(join(directory, `model-${e.id}.glb`));
    assert.equal(sha256(bytes), e.model.sha256, 'source model hash');
    files.set(`samples/model-${e.id}.glb`, bytes);
    const x = (i % 2) * 608, y = Math.floor(i / 2) * 260;
    label(modelSheet, lines(e)[0], x + 16, y + 8, 2);
    const png = files.get(`samples/picture-${e.id}.png`);
    blit(modelSheet, reduced(Resvg, png, 192), x + 16, y + 34);
    for (const [j, camera] of ['front', 'three-quarter'].entries()) {
      const render = encodePng(renderGlb(bytes, camera));
      files.set(`samples/render-${e.id}-${camera}.png`, render);
      blit(modelSheet, reduced(Resvg, render, 192), x + 208 + j * 192, y + 34);
    }
    label(modelSheet, 'PICTURE          FRONT           THREE-QUARTER', x + 32, y + 236, 2);
  }
  files.set('samples.json', jsonBytes({ pictureIds: pictures.map(e => e.id), modelIds: models.map(e => e.id), coverage: 'every value of every trait in both sample sets' }));
  files.set('contact-sheet.png', encodePng(contact));
  files.set('models-sheet.png', encodePng(modelSheet));
  return files;
}

if (import.meta.main) {
  assert.equal(process.argv.length, 3, 'usage: node samples.mjs <full-build-directory>');
  const root = fileURLToPath(new URL('./', import.meta.url));
  mkdirSync(join(root, 'samples'), { recursive: true });
  for (const [name, bytes] of await reviewArtifacts(resolve(process.argv[2]))) writeFileSync(join(root, name), bytes);
  process.stdout.write('48 pictures, 24 models, 48 renders and both sheets written\n');
}
