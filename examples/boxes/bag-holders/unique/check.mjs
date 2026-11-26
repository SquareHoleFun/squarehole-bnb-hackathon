import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadResvg, toPng } from '../src/render.mjs';
import { C, MIX } from '../src/palette.mjs';
import { checkModel } from '../../rent-free/models/check-models.mjs';
import { readGlb, srgbToLinear } from '../../rent-free/models/lib/glb.mjs';
import { decodePng } from '../../rent-free/models/lib/raster.mjs';
import { deal, validateDeal } from './deal.mjs';
import { sha256, jsonBytes, toolchain } from './build.mjs';
import { reviewArtifacts } from './samples.mjs';
import { reviewedJsonForPlatform, reviewedModelBytesForPlatform } from '../../../../scripts/kits/bag-holders-normal-zero-platform-exception.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** Compare one recreated artifact with its committed review bytes. */
export function checkReviewArtifact(name, committed, fresh, reviewed, arch = process.arch) {
  if (name === 'manifest.json') {
    const source = committed.toString('utf8'), platform = reviewedJsonForPlatform(source, reviewed, arch);
    if (platform !== source) committed = Buffer.from(platform);
  }
  else if (/^samples\/model-[1-9][0-9]*\.glb$/.test(name)) fresh = reviewedModelBytesForPlatform(name.slice(8), fresh, reviewed, arch);
  assert.deepEqual(committed, fresh, `committed artifact freshness: ${name}`);
}

export async function checkDirectory(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json')));
  assert.equal(manifest.proposal, true);
  assert.equal(manifest.pixelsPerUnit, 760, 'shared reference scale');
  assert.deepEqual(manifest.items.map(({ id, traits }) => ({ id, traits })), deal(), 'manifest assignments');
  validateDeal(manifest.items);
  const Resvg = await loadResvg(), pictures = new Set(), thumbnails = new Set(), models = new Set();
  const colors = [...Object.values(C), ...Object.values(MIX)].map(hex => [1, 3, 5].map(i => srgbToLinear(Number.parseInt(hex.slice(i, i + 2), 16) / 255)));
  const metrics = { pictureBytes: [], modelBytes: [], triangles: [], heights: [] };
  for (const e of manifest.items) {
    const svg = readFileSync(join(directory, `picture-${e.id}.svg`));
    const png = readFileSync(join(directory, `picture-${e.id}.png`));
    const glb = readFileSync(join(directory, `model-${e.id}.glb`));
    for (const [kind, bytes] of [['svg', svg], ['picture', png], ['model', glb]]) {
      assert.equal(sha256(bytes), e[kind].sha256, `${e.id}/${kind} hash`);
      assert.equal(bytes.length, e[kind].bytes, `${e.id}/${kind} bytes`);
    }
    assert.ok(png.length < 400 * 1024);
    const decoded = decodePng(png);
    assert.equal(decoded.width, 1024); assert.equal(decoded.height, 1024);
    pictures.add(sha256(decoded.rgb));
    thumbnails.add(sha256(decodePng(toPng(Resvg, svg, 128)).rgb));
    const checked = checkModel(glb), { json, bin } = readGlb(glb);
    for (const material of json.materials) assert.ok(colors.some(c => c.every((v, i) => Math.abs(v - material.pbrMetallicRoughness.baseColorFactor[i]) < 1e-12)), 'kit palette');
    assert.equal(checked.triangles, e.model.triangles);
    // Ignore names/labels: no identity-by-JSON trick can satisfy this check.
    models.add(sha256(Buffer.concat([bin, jsonBytes(json.materials)])));
    metrics.pictureBytes.push(png.length); metrics.modelBytes.push(glb.length);
    metrics.triangles.push(checked.triangles); metrics.heights.push(checked.bounds.max[1]);
  }
  for (const [name, set] of [['picture pixels', pictures], ['128 px thumbnails', thumbnails], ['model content', models]]) assert.equal(BigInt(set.size), 420n, `unique ${name}`);
  for (const kind of ['svg', 'picture', 'model']) assert.equal(manifest.totals[`${kind}Bytes`], manifest.items.reduce((sum, e) => sum + e[kind].bytes, 0));
  return { count: '420', uniquePictures: pictures.size.toString(), uniqueThumbnails: thumbnails.size.toString(), uniqueModels: models.size.toString(), totals: manifest.totals, ranges: Object.fromEntries(Object.entries(metrics).map(([key, list]) => [key, [Math.min(...list), Math.max(...list)]])) };
}

/** Independent processes and fresh directories: compare all outputs, then all committed review artifacts. */
export async function verify() {
  toolchain();
  const cache = join(root, '.cache/tmp');
  mkdirSync(cache, { recursive: true });
  const temp = mkdtempSync(join(cache, 'bag-holders-unique-'));
  const first = join(temp, 'first'), second = join(temp, 'second');
  for (const directory of [first, second]) {
    const child = spawnSync(process.execPath, [join(here, 'build.mjs'), '--out', directory], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(child.status, 0, child.stderr || child.error?.message || 'fresh build failed');
  }
  const names = readdirSync(first).sort();
  assert.deepEqual(names, readdirSync(second).sort(), 'same full-build inventory');
  for (const name of names) assert.deepEqual(readFileSync(join(first, name)), readFileSync(join(second, name)), `two builds: ${name}`);
  const result = await checkDirectory(first), review = await reviewArtifacts(first);
  const reviewed = JSON.parse(readFileSync(join(here, 'manifest.json')));
  for (const [name, bytes] of review) checkReviewArtifact(name, readFileSync(join(here, name)), bytes, reviewed);
  assert.deepEqual(readdirSync(join(here, 'samples')).sort(), [...review.keys()].filter(p => p.startsWith('samples/')).map(p => p.slice(8)).sort(), 'exact sample inventory');
  return { ...result, pictureSamples: 48, modelSamples: 24, renderSamples: 48, comparedFiles: names.length, retainedBuilds: relative(root, temp) };
}

if (import.meta.main) process.stdout.write(`${JSON.stringify(await verify(), null, 2)}\n`);
