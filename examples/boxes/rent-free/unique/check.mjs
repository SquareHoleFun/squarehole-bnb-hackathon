import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deal, validateDeal, SPEC, SEED } from './deal.mjs';
import { build } from './build.mjs';
import { selectSamples } from './lib/samples.mjs';
import { sha256, isMain, requireNode } from './lib/io.mjs';
import { checkModel } from '../models/check-models.mjs';
import { readGlb, readAccessor, dot, sub, cross, unit } from '../models/lib/glb.mjs';
import { decodePng, encodePng } from '../models/lib/raster.mjs';
import { renderModel, REVIEW_CAMERAS } from './lib/render.mjs';
import { contactSheet, modelsSheet } from './lib/sheets.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
export function checkBuild(directory, proposal = root) {
  const manifestBytes = readFileSync(join(directory, 'manifest.json'));
  assert.deepEqual(manifestBytes, readFileSync(join(proposal, 'manifest.json')), 'manifest equals fresh build');
  const manifest = JSON.parse(manifestBytes), rows = deal();
  assert.equal(manifest.seed, SEED); assert.equal(manifest.count, SPEC.count); assert.equal(manifest.proposal, true);
  assert.equal(manifest.format, 'rent-free/unique-manifest/v1');
  assert.deepEqual(manifest.toolchain, { node: '24.22.1', resvg: '2.6.2' });
  assert.deepEqual(manifest.entries.map(({ id, traits }) => ({ id, traits })), rows, 'fixed deal');
  validateDeal(rows);
  assert.deepEqual(manifest.samples, selectSamples(rows));
  const pictureHashes = new Set(), modelHashes = new Set(), pixelHashes = new Set(), geometryHashes = new Set();
  const totals = { pictureBytes: 0, svgBytes: 0, modelBytes: 0 };
  let maxPngBytes = 0, maxGlbBytes = 0, maxTriangles = 0, minTriangles = Infinity, minHeight = Infinity, maxHeight = 0;
  const expectedFiles = ['manifest.json'];
  for (const row of manifest.entries) {
    for (const [kind, filename] of [['picture', `picture-${row.id}.png`], ['svg', `picture-${row.id}.svg`], ['model', `model-${row.id}.glb`]]) {
      assert.equal(row[kind].file, filename);
      expectedFiles.push(filename);
      const bytes = readFileSync(join(directory, filename));
      assert.equal(row[kind].sha256, sha256(bytes), `${filename} sha256`);
      assert.equal(row[kind].bytes, bytes.length, `${filename} bytes`);
      totals[`${kind}Bytes`] += bytes.length;
    }
    const png = readFileSync(join(directory, row.picture.file)), glb = readFileSync(join(directory, row.model.file));
    const image = decodePng(png);
    assert.equal(image.width, 1024); assert.equal(image.height, 1024);
    assert.equal(row.picture.width, 1024); assert.equal(row.picture.height, 1024);
    assert.ok(png.length < 400 * 1024, `PNG ${row.id} below 400 KiB`);
    // A 32 px clear border catches cropping, including non-front curved roof faces.
    const cream = [255, 247, 230];
    for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
      if (x >= 32 && x < 992 && y >= 32 && y < 992) continue;
      const offset = (y * 1024 + x) * 3;
      for (let c = 0; c < 3; c++) assert.equal(image.rgb[offset + c], cream[c], `picture ${row.id} clear margin`);
    }
    const checked = checkModel(glb), { max } = checked.bounds;
    assert.equal(row.model.triangles, checked.triangles);
    // Project actual exported vertices, not empty bounding-box corners. No per-model zoom.
    const parsed = readGlb(glb), vertices = parsed.json.meshes[0].primitives.flatMap(p => readAccessor(parsed, p.attributes.POSITION));
    for (const camera of Object.values(REVIEW_CAMERAS)) {
      const view = unit(camera.view), right = unit(cross([0, 1, 0], view)), up = cross(view, right);
      for (const [x, y, z] of vertices) {
        const q = sub([x, y, z], camera.target);
        const px = 256 + dot(q, right) * camera.pixelsPerUnit, py = 256 - dot(q, up) * camera.pixelsPerUnit;
        assert.ok(px > 4 && px < 508 && py > 4 && py < 508, `model ${row.id} camera margin`);
      }
    }
    const svg = readFileSync(join(directory, row.svg.file), 'utf8');
    assert.doesNotMatch(svg, /<text|<image|href=|filter=|gradient|foreignObject/i);
    pictureHashes.add(sha256(png)); pixelHashes.add(sha256(image.rgb));
    modelHashes.add(sha256(glb)); geometryHashes.add(sha256(readGlb(glb).bin));
    maxPngBytes = Math.max(maxPngBytes, png.length); maxGlbBytes = Math.max(maxGlbBytes, glb.length);
    maxTriangles = Math.max(maxTriangles, checked.triangles); minTriangles = Math.min(minTriangles, checked.triangles);
    minHeight = Math.min(minHeight, max[1]); maxHeight = Math.max(maxHeight, max[1]);
  }
  for (const set of [pictureHashes, modelHashes, pixelHashes, geometryHashes]) assert.equal(BigInt(set.size), BigInt(SPEC.count), 'visible asset uniqueness');
  assert.deepEqual(readdirSync(directory).sort(), expectedFiles.sort(), 'full build file set');
  return { count: SPEC.count, distinctPictures: BigInt(pixelHashes.size).toString(), distinctModels: BigInt(geometryHashes.size).toString(),
    ...totals, manifestBytes: manifestBytes.length, totalBytes: Object.values(totals).reduce((sum, n) => sum + n, manifestBytes.length),
    maxPngBytes, maxGlbBytes, minTriangles, maxTriangles, minHeight, maxHeight };
}
export function checkSamples(full, proposal = root) {
  const manifest = readJson(join(full, 'manifest.json')), images = new Map(), renders = new Map(), files = [];
  const rowsFor = ids => ids.map(id => manifest.entries.find(row => row.id === id));
  for (const row of rowsFor(manifest.samples.pictures)) {
    const png = readFileSync(join(full, row.picture.file));
    assert.deepEqual(readFileSync(join(proposal, 'samples', row.picture.file)), png, `sample ${row.id}`);
    images.set(row.id, decodePng(png)); files.push(row.picture.file);
  }
  for (const row of rowsFor(manifest.samples.models)) {
    const glb = readFileSync(join(full, row.model.file));
    assert.deepEqual(readFileSync(join(proposal, 'samples', row.model.file)), glb);
    files.push(row.model.file);
    for (const camera of ['front', 'three-quarter']) {
      const render = renderModel(glb, camera), file = `render-${row.id}-${camera}.png`;
      renders.set(`${row.id}/${camera}`, render); files.push(file);
      assert.deepEqual(readFileSync(join(proposal, 'samples', file)), encodePng(render), file);
    }
  }
  assert.deepEqual(readdirSync(join(proposal, 'samples')).sort(), files.sort(), 'only selected samples committed');
  assert.deepEqual(readFileSync(join(proposal, 'contact-sheet.png')), encodePng(contactSheet(rowsFor(manifest.samples.pictures), images)));
  assert.deepEqual(readFileSync(join(proposal, 'models-sheet.png')), encodePng(modelsSheet(rowsFor(manifest.samples.models), images, renders)));
}
if (isMain(import.meta.url)) {
  requireNode();
  const [flag, path, extra] = process.argv.slice(2);
  assert.ok((!flag || flag === '--from' && path) && !extra, 'Usage: node check.mjs [--from <full-build-directory>]');
  let directory = path;
  if (!directory) {
    mkdirSync('.cache/tmp', { recursive: true });
    directory = mkdtempSync('.cache/tmp/rent-unique-check-');
    build(directory);
  }
  const report = checkBuild(directory);
  checkSamples(directory);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\nAll assets, counts, hashes, samples and sheets pass\n`);
}
