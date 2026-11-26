import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { variantFor } from '../assign.mjs';
import { deal, SEED, traitKey, validateDeal } from './deal.mjs';
import { pictureSvg } from './picture.mjs';
import { modelGlb } from './model.mjs';
import { checkModel } from '../../rent-free/models/check-models.mjs';
import { readGlb, readAccessor } from '../../rent-free/models/lib/glb.mjs';
import { checkReviewArtifact, verify } from './check.mjs';
import { loadResvg, toPng } from '../src/render.mjs';
import { decodePng } from '../../rent-free/models/lib/raster.mjs';
import { details } from './lib/details.mjs';
import { C, MIX } from '../src/palette.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const spec = JSON.parse(readFileSync(new URL('./traits.json', import.meta.url)));

test('R1-R2: complete IDs, preserved bag kinds, exact counts, unique visible traits', () => {
  const rows = deal();
  assert.equal(BigInt(rows.length), 420n);
  assert.ok(rows.every(({ id, traits }) => traits.kind === variantFor(id)));
  assert.equal(new Set(rows.map(row => traitKey(row.traits))).size, rows.length);
  for (const [field, values] of Object.entries(spec.traits)) {
    assert.equal(values.reduce((sum, v) => sum + BigInt(v.count), 0n), 420n, field);
    for (const { value, count } of values) {
      assert.equal(BigInt(rows.filter(r => r.traits[field] === value).length), BigInt(count), `${field} ${value}`);
    }
  }
  // A concrete proof independent of dealer bookkeeping: all 35 trim/repair pairs per kind.
  for (const { value } of spec.traits.kind) {
    const bags = rows.filter(r => r.traits.kind === value);
    assert.equal(new Set(bags.map(r => `${r.traits.trim}/${r.traits.repair}`)).size, 35);
  }
  assert.deepEqual(deal(), rows);
  assert.notDeepEqual(deal(`${SEED}/test`), rows);
  validateDeal(deal(`${SEED}/test`));
  const duplicate = structuredClone(rows);
  duplicate[12].traits = duplicate[0].traits;
  assert.throws(() => validateDeal(duplicate));
  const wrongKind = structuredClone(rows);
  wrongKind[0].traits.kind = '02';
  assert.throws(() => validateDeal(wrongKind));
});

test('R3-R4: traits alone drive assets; kit-print SVG and actual geometry carry identity', () => {
  const rows = deal();
  const geometry = new Set();
  for (const row of rows) {
    const svg = pictureSvg(row.traits);
    assert.doesNotMatch(svg, /<(?:text|image|script|foreignObject)\b/);
    assert.match(svg, /width="1024" height="1024"/);
    const bytes = modelGlb(row.traits);
    checkModel(bytes);
    const { json, bin } = readGlb(bytes);
    assert.equal(json.nodes[0].name, 'Bag Holders proposal');
    geometry.add(hash(bin));
  }
  assert.equal(geometry.size, rows.length, 'geometry differs, not just GLB names or JSON metadata');
  assert.deepEqual(modelGlb(rows[0].traits), modelGlb(structuredClone(rows[0].traits)));
  assert.throws(() => pictureSvg({ ...rows[0].traits, trim: 'unknown' }));
  assert.throws(() => modelGlb({ ...rows[0].traits, repair: 'unknown' }));
});

// Bounds include at least 16 reference pixels of breathing room around the original ink.
// These are independently measured from all twelve original PNGs, not generator placements.
const PRINT_AREAS = {
  '01': [371, 531, 653, 645], '02': [343, 633, 587, 721],
  '03': [307, 357, 465, 445], '04': [334, 632, 690, 770],
  '11': [382, 458, 643, 566],
};
const printLayers = svg => [...svg.matchAll(/<g transform="[^"]+" fill="none" stroke="[^"]+" stroke-width="[^"]+" stroke-linecap="round" stroke-linejoin="round"><path transform="translate\([\s\S]*?<\/g>/g)].map(m => m[0]);
const crop = (image, [left, top, right, bottom]) => Buffer.concat(Array.from({ length: bottom - top }, (_, y) =>
  image.rgb.subarray(((top + y) * image.width + left) * 3, ((top + y) * image.width + right) * 3)));

test('AF1: every original glyph, transform and colour survives; no new lettering', () => {
  const expected = new Map(spec.traits.kind.map(({ value }) => [value, printLayers(readFileSync(new URL(`../art/items/variant-${value}.svg`, import.meta.url), 'utf8'))]));
  assert.deepEqual([...expected].filter(([, layers]) => layers.length).map(([kind]) => kind), Object.keys(PRINT_AREAS).sort());
  for (const row of deal()) assert.deepEqual(printLayers(pictureSvg(row.traits)), expected.get(row.traits.kind), `original print for ID ${row.id}`);
});

test('AF1: every printed picture preserves original pixels and accessory clearance', async () => {
  const Resvg = await loadResvg();
  const expected = new Map(Object.entries(PRINT_AREAS).map(([kind, area]) => [kind,
    crop(decodePng(readFileSync(new URL(`../art/items/variant-${kind}.png`, import.meta.url))), area)]));
  for (const { id, traits } of deal()) {
    const area = PRINT_AREAS[traits.kind];
    if (!area) continue;
    for (const part of details(traits)) {
      const pad = part.width / 2;
      const xs = part.points.map(p => p[0]), ys = part.points.map(p => p[1]);
      assert.ok(Math.max(...xs) + pad < area[0] || Math.min(...xs) - pad > area[2]
        || Math.max(...ys) + pad < area[1] || Math.min(...ys) - pad > area[3], `ID ${id}: accessory crowds the print`);
    }
    const actual = decodePng(toPng(Resvg, pictureSvg(traits)));
    assert.deepEqual(crop(actual, area), expected.get(traits.kind), `ID ${id}: original print pixels and clear space`);
  }
});

// Project the actual exported triangles without lighting. The common hook's top vertex
// recovers the reference coordinates after centring/grounding; no generator internals.
function projectedPrint(bytes, area) {
  const glb = readGlb(bytes), triangles = [];
  for (const p of glb.json.meshes[0].primitives) {
    const positions = readAccessor(glb, p.attributes.POSITION), indices = readAccessor(glb, p.indices).flat();
    for (let i = 0; i < indices.length; i += 3) triangles.push({
      points: indices.slice(i, i + 3).map(n => positions[n]), color: glb.json.materials[p.material].name,
    });
  }
  const points = triangles.flatMap(t => t.points), top = Math.max(...points.map(p => p[1]));
  const hookX = points.find(p => p[1] === top)[0], hookTop = 160 - 21 - 4 / Math.cos(Math.PI / 12);
  const [left, upper, right, bottom] = area, width = right - left, height = bottom - upper;
  const colors = Array(width * height).fill(null), depths = Array(width * height).fill(-Infinity);
  const edge = (a, b, x, y) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  for (const t of triangles) {
    const [a, b, c] = t.points.map(([x, y, z]) => [486 + (x - hookX) * 760, hookTop + (top - y) * 760, z]);
    const cross = edge(a, b, c[0], c[1]);
    if (Math.abs(cross) < 1e-6) continue;
    const x0 = Math.max(left, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(right, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(upper, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(bottom, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const u = edge(b, c, x + 0.5, y + 0.5) / cross, v = edge(c, a, x + 0.5, y + 0.5) / cross, w = 1 - u - v;
      if (Math.min(u, v, w) < -1e-8) continue;
      const z = u * a[2] + v * b[2] + w * c[2], at = (y - upper) * width + x - left;
      if (z > depths[at]) { colors[at] = t.color; depths[at] = z; }
    }
  }
  return colors;
}

test('AF1: the SAND N has no miter spike above the original cap line', () => {
  const { traits } = deal().find(row => row.traits.kind === '04');
  const area = [510, 600, 595, 640];
  assert.equal(projectedPrint(modelGlb(traits), area).filter(color => color === C.ink).length, 0);
});

test('AF1: exported raised print geometry matches the original ink and fill', () => {
  for (const [kind, area] of Object.entries(PRINT_AREAS)) {
    const original = crop(decodePng(readFileSync(new URL(`../art/items/variant-${kind}.png`, import.meta.url))), area);
    const inks = kind === '02' ? [MIX.kraftDark] : kind === '11' ? [C.ink, C.canvas] : [C.ink];
    // Every dealt variation must retain the letters, including the closest tags and largest repairs.
    for (const { id, traits } of deal().filter(row => row.traits.kind === kind)) {
      const projected = projectedPrint(modelGlb(traits), area);
      for (const ink of inks) {
        const rgb = [1, 3, 5].map(i => Number.parseInt(ink.slice(i, i + 2), 16));
        const width = area[2] - area[0], height = area[3] - area[1];
        const mask = projected.map((_, i) => rgb.every((v, k) => Math.abs(original[i * 3 + k] - v) <= 8));
        let expected = 0, actual = 0, overlap = 0, near = 0;
        projected.forEach((color, i) => {
          const match = mask[i];
          if (match) expected++;
          if (color === ink) actual++;
          if (match && color === ink) overlap++;
          // Original edge pixels are antialiased; the mesh has faceted curves. Allow
          // two reference pixels at the boundary, while retaining exact interior recall.
          if (color === ink) {
            const x = i % width, y = Math.floor(i / width);
            let found = false;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
              if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height && mask[(y + dy) * width + x + dx]) found = true;
            }
            if (found) near++;
          }
        });
        assert.ok(overlap / expected > 0.93 && near / actual > 0.98,
          `ID ${id} ${ink}: print recall ${(overlap / expected).toFixed(3)}, boundary precision ${(near / actual).toFixed(3)}`);
      }
    }
  }
});

test('R5-R6: two fresh builds, manifest, all file limits, samples and sheets', async () => {
  const result = await verify();
  assert.equal(result.count, '420');
  assert.equal(result.uniquePictures, '420');
  assert.equal(result.uniqueThumbnails, '420');
  assert.equal(result.pictureSamples, 48);
  assert.equal(result.modelSamples, 24);
});

test('af2: review artifacts accept exactly the listed Intel hashes and reject other changes', () => {
  const committed = readFileSync(new URL('./manifest.json', import.meta.url));
  const reviewed = JSON.parse(committed);
  const list = JSON.parse(readFileSync(new URL('../../../../scripts/kits/bag-holders-intel-normal-zero-hashes.json', import.meta.url)));
  const intel = structuredClone(reviewed);
  for (const row of intel.items) if (Object.hasOwn(list, `model-${row.id}.glb`)) row.model.sha256 = list[`model-${row.id}.glb`];
  const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const compare = (fresh, arch = 'x64') => checkReviewArtifact('manifest.json', committed, fresh, reviewed, arch);
  compare(bytes(intel));
  compare(bytes(intel), 'riscv64');
  compare(committed, 'arm64');
  assert.throws(() => compare(bytes(intel), 'arm64'), /committed artifact freshness/);
  assert.throws(() => compare(committed), /committed artifact freshness/);
  for (const change of [
    m => { m.items[0].model.sha256 = 'a'.repeat(64); },
    m => { m.items.find(row => row.traits.kind === '09').model.sha256 = 'a'.repeat(64); },
    m => { m.items[0].picture.sha256 = 'a'.repeat(64); },
    m => { m.items[0].traits.trim = 'changed'; },
    m => { m.items[0].model.bytes++; },
  ]) {
    const bad = structuredClone(intel); change(bad);
    assert.throws(() => compare(bytes(bad)), /committed artifact freshness/);
  }
  assert.throws(() => compare(Buffer.concat([bytes(intel), Buffer.from(' ')])), /committed artifact freshness/);
  assert.throws(() => checkReviewArtifact('samples.json', Buffer.from('reviewed'), Buffer.from('changed'), reviewed, 'x64'), /committed artifact freshness/);
});

test('af2: sampled GLBs require exact reviewed bytes on arm64 and outside the list', () => {
  const reviewed = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url)));
  const { modelIds } = JSON.parse(readFileSync(new URL('./samples.json', import.meta.url)));
  for (const kind of ['01', '09']) {
    const row = reviewed.items.find(row => row.traits.kind === kind && modelIds.includes(row.id));
    const name = `samples/model-${row.id}.glb`, committed = readFileSync(new URL(name, import.meta.url));
    checkReviewArtifact(name, committed, committed, reviewed, 'arm64');
    const bad = Buffer.from(committed); bad[bad.length - 1] ^= 1;
    assert.throws(() => checkReviewArtifact(name, committed, bad, reviewed, 'arm64'), /committed artifact freshness/);
    if (kind === '01') {
      checkReviewArtifact(name, committed, committed, reviewed, 'x64');
      assert.throws(() => checkReviewArtifact(name, committed, bad, reviewed, 'x64'), /committed artifact freshness/);
    }
  }
});

test('af2: listed Intel GLB samples differ only by the four approved normal zero signs', { skip: process.arch === 'arm64' }, () => {
  const reviewed = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url)));
  const { modelIds } = JSON.parse(readFileSync(new URL('./samples.json', import.meta.url)));
  const rows = reviewed.items.filter(row => row.traits.kind === '09' && modelIds.includes(row.id));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const name = `samples/model-${row.id}.glb`, committed = readFileSync(new URL(name, import.meta.url));
    const fresh = modelGlb(row.traits), before = Buffer.from(fresh);
    assert.notDeepEqual(committed, fresh);
    checkReviewArtifact(name, committed, fresh, reviewed, 'x64');
    assert.deepEqual(fresh, before, 'sample validation never mutates generated bytes');
    assert.throws(() => checkReviewArtifact(name, committed, fresh, reviewed, 'arm64'), /committed artifact freshness/);
    const bad = Buffer.from(fresh); bad[bad.length - 1] ^= 1;
    assert.throws(() => checkReviewArtifact(name, committed, bad, reviewed, 'x64'), /listed Intel model hash/);
    const badCommitted = Buffer.from(committed); badCommitted[badCommitted.length - 1] ^= 1;
    assert.throws(() => checkReviewArtifact(name, badCommitted, fresh, reviewed, 'x64'), /committed artifact freshness/);
  }
});
