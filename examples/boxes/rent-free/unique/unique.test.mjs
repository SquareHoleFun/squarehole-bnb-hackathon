import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deal, identity, validateDeal, SPEC, SEED } from './deal.mjs';
import { pictureSvg, picturePng } from './picture.mjs';
import { modelGlb } from './model.mjs';
import { checkBuild, checkSamples } from './check.mjs';
import { selectSamples } from './lib/samples.mjs';
import { sha256 } from './lib/io.mjs';
import { makeHouse, NAMES } from '../models/lib/houses.mjs';
import { houseScene } from './lib/scene.mjs';
import { readGlb, encodeGlb } from '../models/lib/glb.mjs';
import { decodePng } from '../models/lib/raster.mjs';
import { renderModel } from './lib/render.mjs';
import { checkModel } from '../models/check-models.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
const rows = deal();

test('SH-ART-UNIQUE-RENT-1/2: exact decks, original house assignment, unique visible combinations', () => {
  assert.equal(SPEC.count, '500');
  assert.equal(rows.length, 500);
  assert.equal(new Set(rows.map(row => identity(row.traits))).size, 500);
  assert.deepEqual(validateDeal(rows), { count: '500', unique: '500', minimumDistance: 2 });
  for (const [index, row] of rows.entries()) {
    assert.equal(row.id, BigInt(index + 1).toString());
    assert.equal(row.traits.house, String(index % 12 + 1).padStart(2, '0'));
  }
  for (const [key, values] of Object.entries(SPEC.traits)) {
    assert.equal(values.reduce((sum, value) => sum + BigInt(value.count), 0n), 500n);
    for (const value of values) assert.equal(BigInt(rows.filter(row => row.traits[key] === value.value).length), BigInt(value.count));
  }
  for (let a = 0; a < rows.length; a++) for (let b = a + 1; b < rows.length; b++) {
    assert.ok(Object.keys(SPEC.traits).filter(key => rows[a].traits[key] !== rows[b].traits[key]).length >= 2);
  }
  assert.deepEqual(deal(SEED), rows);
  assert.notDeepEqual(deal(`${SEED}/alternate`), rows);
});

test('SH-ART-UNIQUE-RENT-2/6: checker refuses duplicates, missing ids, wrong counts and unknown traits', () => {
  const change = fn => { const copy = structuredClone(rows); fn(copy); assert.throws(() => validateDeal(copy)); };
  change(copy => { copy[12].traits = copy[0].traits; });
  change(copy => { copy[0].id = '0'; });
  change(copy => { copy[0].id = '01'; });
  change(copy => { copy[0].traits.house = '02'; });
  change(copy => { copy[0].traits.door = 'unknown'; });
  change(copy => { copy[0].traits.secret = 'invisible'; });
  change(copy => { copy.pop(); });
  change(copy => { copy[0].traits.post = SPEC.traits.post.find(v => v.value !== copy[0].traits.post).value; });
});

test('SH-ART-UNIQUE-RENT-3/4: every trait changes picture pixels and model geometry in every house family', () => {
  for (const house of SPEC.traits.house) {
    const traits = { ...rows[0].traits, house: house.value };
    for (const [key, values] of Object.entries(SPEC.traits).filter(([key]) => key !== 'house')) {
      const pixels = new Set(), geometry = new Set();
      for (const value of values) {
        const look = { ...traits, [key]: value.value };
        const svg = pictureSvg(look), glb = modelGlb(look);
        assert.match(svg, /<svg[^>]+width="1024"[^>]+height="1024"/);
        assert.doesNotMatch(svg, /<text|<image|href=|filter=|gradient|foreignObject/i);
        pixels.add(sha256(picturePng(look, 128)));
        geometry.add(sha256(readGlb(glb).bin));
        checkModel(glb);
      }
      assert.equal(pixels.size, values.length, `${house.value} ${key} picture variation`);
      assert.equal(geometry.size, values.length, `${house.value} ${key} geometry variation`);
    }
  }
  assert.throws(() => pictureSvg({ ...rows[0].traits, post: 'unknown' }));
  assert.throws(() => modelGlb({ ...rows[0].traits, house: '13' }));
  // Identity is carried by visible traits, never an id or GLB node-name salt.
  assert.deepEqual(modelGlb(rows[0].traits), modelGlb({ ...rows[0].traits }));
});

test('SH-ART-UNIQUE-RENT-4: approved base meshes are imported unchanged, with translation only', () => {
  for (let variant = 1; variant <= 12; variant++) {
    const base = makeHouse(variant), house = String(variant).padStart(2, '0');
    assert.deepEqual(encodeGlb(base, NAMES[variant - 1]), readFileSync(new URL(`../models/variant-${house}.glb`, import.meta.url)));
    const scene = houseScene({ ...rows[0].traits, house });
    const offset = base[0].points[0].map((v, axis) => scene[0].points[0][axis] - v);
    assert.equal(offset[1], 0, 'ground and shared scale stay fixed');
    base.forEach((triangle, i) => {
      assert.equal(scene[i].material, triangle.material);
      triangle.points.forEach((p, j) => p.forEach((v, axis) => assert.ok(Math.abs(scene[i].points[j][axis] - v - offset[axis]) < 1e-12)));
    });
  }
});

test('SH-ART-UNIQUE-RENT-3/4: panel inserts leave the original door knobs unobstructed', () => {
  for (const variant of [2, 5, 6]) {
    const base = makeHouse(variant), material = variant === 2 ? 'forest' : 'butter';
    const front = Math.max(...base.filter(t => t.material === material).flatMap(t => t.points.map(p => p[2])));
    const knobIndices = base.flatMap((t, i) => t.material === material && t.points.every(p => Math.abs(p[2] - front) < 1e-9) ? [i] : []);
    assert.ok(knobIndices.length > 0);
    for (const door of ['Plain panel', 'Twin panels', 'Stable panel']) {
      const scene = houseScene({ ...rows[0].traits, house: String(variant).padStart(2, '0'), door });
      const knob = knobIndices.flatMap(i => scene[i].points);
      const low = [0, 1].map(axis => Math.min(...knob.map(p => p[axis])) - 2 / 350);
      const high = [0, 1].map(axis => Math.max(...knob.map(p => p[axis])) + 2 / 350);
      for (const triangle of scene.slice(base.length)) {
        const overlaps = [0, 1].every(axis => Math.max(...triangle.points.map(p => p[axis])) > low[axis] && Math.min(...triangle.points.map(p => p[axis])) < high[axis]);
        assert.ok(!overlaps, `house ${variant} ${door} touches the knob`);
      }
    }
  }
});

test('SH-ART-UNIQUE-RENT-3: SVG visibility agrees with exported front geometry, including the curved dome', () => {
  for (const house of SPEC.traits.house) {
    const traits = { ...rows[0].traits, house: house.value };
    const actual = decodePng(picturePng(traits, 512));
    const expected = renderModel(modelGlb(traits), 'front');
    const forest = (img, x, y) => {
      const at = (y * 512 + x) * 3;
      return img.rgb[at] < 40 && img.rgb[at + 1] < 80 && img.rgb[at + 2] < 70;
    };
    let mismatches = 0, compared = 0;
    for (let y = 4; y < 508; y += 3) for (let x = 4; x < 508; x += 3) {
      const wanted = forest(expected, x, y);
      // Exclude antialiased boundaries; compare solid regions, not two rasterizers' edge rules.
      if ([-2, 0, 2].some(dx => [-2, 0, 2].some(dy => forest(expected, x + dx, y + dy) !== wanted))) continue;
      compared++;
      if (forest(actual, x, y) !== wanted) mismatches++;
    }
    assert.ok(mismatches / compared < 0.001, `${house.label}: ${mismatches}/${compared} incorrect interior pixels`);
  }
});

test('SH-ART-UNIQUE-RENT-5: review samples cover all values, four pictures and two models per house', () => {
  const selected = selectSamples(rows);
  assert.equal(selected.pictures.length, 48);
  assert.equal(selected.models.length, 24);
  assert.equal(new Set(selected.pictures).size, 48);
  assert.equal(new Set(selected.models).size, 24);
  assert.ok(selected.models.every(id => selected.pictures.includes(id)));
  for (const [key, values] of Object.entries(SPEC.traits)) {
    const shown = new Set(selected.pictures.map(id => rows.find(row => row.id === id).traits[key]));
    assert.deepEqual(shown, new Set(values.map(value => value.value)));
  }
  for (const house of SPEC.traits.house) {
    for (const [set, count] of [['pictures', 4], ['models', 2]]) {
      assert.equal(selected[set].filter(id => rows.find(row => row.id === id).traits.house === house.value).length, count);
    }
  }
});

test('SH-ART-UNIQUE-RENT-5/6: two separate full builds match all committed hashes and samples', { timeout: 600_000 }, () => {
  mkdirSync('.cache/tmp', { recursive: true });
  const work = mkdtempSync('.cache/tmp/rent-unique-test-');
  const a = join(work, 'a'), b = join(work, 'b');
  for (const out of [a, b]) execFileSync(process.execPath, [join(root, 'build.mjs'), '--out', out], { timeout: 240_000, stdio: 'pipe' });
  assert.deepEqual(readFileSync(join(a, 'manifest.json')), readFileSync(join(b, 'manifest.json')));
  assert.deepEqual(readFileSync(join(a, 'manifest.json')), readFileSync(join(root, 'manifest.json')));
  for (const file of readdirSync(a)) assert.deepEqual(readFileSync(join(a, file)), readFileSync(join(b, file)), file);
  const report = checkBuild(a);
  assert.equal(report.count, '500');
  assert.equal(report.distinctPictures, '500');
  assert.equal(report.distinctModels, '500');
  checkSamples(a, root);
  process.stdout.write(`Full builds retained at ${work}\n${JSON.stringify(report)}\n`);
});
