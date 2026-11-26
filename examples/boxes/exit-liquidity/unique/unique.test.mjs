import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { variantFor } from '../assign.mjs';
import { deal, SEED, vocabulary, traitKey, verifyDeal } from './deal.mjs';
import { pictureSvg, picturePng } from './picture.mjs';
import { modelGlb } from './model.mjs';
import { build, selectSamples, sampleFiles } from './build.mjs';
import { checkBuild, checkSamples } from './check.mjs';
import { sha256, jsonBytes, ROOT } from './lib/io.mjs';
import { checkModel } from '../../rent-free/models/check-models.mjs';
import { readGlb, readAccessor } from '../../rent-free/models/lib/glb.mjs';
import { decodePng } from '../../rent-free/models/lib/raster.mjs';
import { VARIANTS } from '../src/items.mjs';
import { signBox } from '../src/sign.mjs';
import { C } from '../src/palette.mjs';

// Compare with the shipped pictures, not another rendering of the implementation.
// Exclude only the rounded face edge; include all letters, arrows and their clear space.
function facePixels(png, signs) {
  const pixels = [];
  for (const original of signs) {
    const s = { cx: 512, ...original }, b = signBox(s);
    const angle = -(s.tilt ?? 0) * Math.PI / 180;
    const px = b.x + 0.8 * s.m, py = b.y + 0.3 * s.m;
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const dx = x + 0.5 - px, dy = y + 0.5 - py;
      const u = px + dx * Math.cos(angle) - dy * Math.sin(angle);
      const v = py + dx * Math.sin(angle) + dy * Math.cos(angle);
      if (u < b.fx + 12 || u > b.fx + b.fw - 12 || v < b.fy + 12 || v > b.fy + b.fh - 12) continue;
      const at = (y * png.width + x) * 3;
      pixels.push(...png.rgb.subarray(at, at + 3));
    }
  }
  return Buffer.from(pixels);
}

test('AF1: all 404 sign faces retain the original lettering, arrows, colour and clear space', () => {
  for (const variant of VARIANTS) {
    const original = decodePng(readFileSync(new URL(`../art/items/variant-${variant.n}.png`, import.meta.url)));
    const expected = sha256(facePixels(original, variant.signs));
    for (const row of rows.filter(r => r.traits.sign === variant.n)) {
      assert.equal(sha256(facePixels(decodePng(picturePng(row.traits)), variant.signs)), expected,
        `id ${row.id}, base ${variant.n}: original face pixels including lettering and clear space`);
    }
  }
});

test('AF1: GLB front surfaces spell every original sign, including blank and burnt cells', () => {
  for (const variant of VARIANTS) {
    const traits = { ...rows[0].traits, sign: variant.n, housing: 'plain', repair: 'clean' };
    const bytes = modelGlb(traits), glb = readGlb(bytes);
    checkModel(bytes);
    const triangles = glb.json.meshes[0].primitives.flatMap(p => {
      const points = readAccessor(glb, p.attributes.POSITION), indices = readAccessor(glb, p.indices).flat();
      const result = [];
      for (let i = 0; i < indices.length; i += 3) result.push({
        points: indices.slice(i, i + 3).map(index => points[index]), color: glb.json.materials[p.material].name,
      });
      return result;
    });
    const surface = (x, y) => {
      let front = -Infinity, color;
      for (const { points: [a, b, c], color: material } of triangles) {
        const det = (b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
        if (Math.abs(det) < 1e-10) continue;
        const u = ((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/det;
        const v = ((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/det;
        if (u < -1e-6 || v < -1e-6 || u+v > 1+1e-6) continue;
        const z = u*a[2]+v*b[2]+(1-u-v)*c[2];
        if (z > front) { front = z; color = material; }
      }
      return color;
    };
    for (const original of variant.signs) {
      const s = { cx: 512, ...original }, b = signBox(s), { block } = b;
      const on = new Set(block.cells.filter(cell => !s.burnt?.(cell))
        .map(({ c, r }) => `${s.mirror ? block.cols-1-c : c},${r}`));
      for (let r = 0; r < block.rows; r++) for (let c = 0; c < block.cols; c++) {
        let x = s.cx + (c + 0.5 - block.cols/2)*s.m, y = s.cy + (r + 0.5 - block.rows/2)*s.m;
        if (s.tilt) {
          const angle = s.tilt*Math.PI/180, px = b.x+0.8*s.m, py = b.y+0.3*s.m;
          [x,y] = [px+(x-px)*Math.cos(angle)-(y-py)*Math.sin(angle), py+(x-px)*Math.sin(angle)+(y-py)*Math.cos(angle)];
        }
        const lit = on.has(`${c},${r}`);
        let expected = s.style === 'box' ? (lit ? C.ink : C[s.color]) : (lit ? C[s.color] : C.ink);
        if (s.flicker?.some(cell => cell.c === c && cell.r === r)) expected = C.red;
        assert.equal(surface((x-512)/800, (908-y)/800), expected, `base ${variant.n}, cell ${c},${r}`);
      }
    }
  }
});

const rows = deal();
test('U1/U2: all 404 original signs, exact independent trait counts, unique physical looks', () => {
  assert.equal(BigInt(rows.length), 404n);
  assert.deepEqual(rows.map(r => r.id), Array.from({ length: 404 }, (_, i) => String(i + 1)));
  for (const row of rows) assert.equal(row.traits.sign, variantFor(row.id));
  for (const layer of vocabulary.layers) {
    assert.equal(layer.values.reduce((n, v) => n + BigInt(v.count), 0n), 404n);
    for (const value of layer.values) {
      assert.equal(BigInt(rows.filter(r => r.traits[layer.key] === value.value).length), BigInt(value.count));
    }
  }
  assert.equal(new Set(rows.map(r => traitKey(r.traits))).size, 404);
  // No identity depends on a background, id, arbitrary noise or invisible hash.
  for (let i = 0; i < rows.length; i++) for (let j = 0; j < i; j++) {
    const distance = vocabulary.layers.filter(l => rows[i].traits[l.key] !== rows[j].traits[l.key]).length;
    assert.ok(distance >= 2, `near twins ${rows[i].id}, ${rows[j].id}`);
  }
  verifyDeal(rows);
  const duplicate = structuredClone(rows);
  duplicate[12].traits = { ...duplicate[0].traits };
  assert.throws(() => verifyDeal(duplicate));
  const wrongBase = structuredClone(rows);
  wrongBase[0].traits.sign = '02';
  assert.throws(() => verifyDeal(wrongBase));
  const unknown = structuredClone(rows);
  unknown[0].traits.hidden = 'noise';
  assert.throws(() => verifyDeal(unknown));
});

test('U2: stable JSON across independent processes; fixed public seed', () => {
  assert.equal(SEED, 'exit-liquidity/404-signs/no-way-out/v1');
  const command = join(ROOT, 'deal.mjs');
  const first = execFileSync(process.execPath, [command]);
  const second = execFileSync(process.execPath, [command]);
  assert.deepEqual(first, second);
  assert.deepEqual(first, jsonBytes(rows));
});

test('U3/U4: every trait has a visible picture and physical model effect', () => {
  for (const layer of vocabulary.layers) {
    const pictures = new Set(), models = new Set(), geometry = new Set();
    for (const value of layer.values) {
      const traits = { ...rows[0].traits, [layer.key]: value.value };
      const svg = pictureSvg(traits);
      assert.doesNotMatch(svg, /<(text|image|script|foreignObject)\b|(?:href|font-family)=/i);
      const png = decodePng(picturePng(traits, 128));
      pictures.add(sha256(png.rgb));
      const glb = modelGlb(traits);
      models.add(sha256(glb));
      geometry.add(sha256(readGlb(glb).bin));
      checkModel(glb);
    }
    assert.equal(pictures.size, layer.values.length, `${layer.key} visible at 128`);
    assert.equal(models.size, layer.values.length, `${layer.key} models`);
    assert.equal(geometry.size, layer.values.length, `${layer.key} geometry`);
  }
});

test('U5: 48 pictures and 24 models cover every trait value and every base sign', () => {
  const samples = selectSamples(rows);
  assert.equal(samples.pictures.length, 48);
  assert.equal(samples.models.length, 24);
  assert.ok(samples.models.includes('404'), 'the final id keeps its original 404 sign in the review');
  for (const ids of [samples.pictures, samples.models]) {
    assert.equal(new Set(ids).size, ids.length);
    for (const layer of vocabulary.layers) for (const value of layer.values) {
      assert.ok(rows.some(r => ids.includes(r.id) && r.traits[layer.key] === value.value), `${layer.key} ${value.value}`);
    }
  }
  assert.ok(samples.models.every(id => samples.pictures.includes(id)));
  for (const sign of vocabulary.layers[0].values) {
    assert.equal(rows.filter(r => samples.models.includes(r.id) && r.traits.sign === sign.value).length, 2);
    assert.equal(rows.filter(r => samples.pictures.includes(r.id) && r.traits.sign === sign.value).length, 4);
  }
});

test('U3–U6: two full disk builds, all limits, all fresh hashes and committed samples', { timeout: 600_000 }, () => {
  mkdirSync('.cache/tmp', { recursive: true });
  const scratch = mkdtempSync('.cache/tmp/unique-exit-test-');
  const a = join(scratch, 'a'), b = join(scratch, 'b');
  const first = build(a), second = build(b);
  assert.deepEqual(first, second);
  for (const row of first.items) for (const file of [`picture-${row.id}.svg`, `picture-${row.id}.png`, `model-${row.id}.glb`]) {
    assert.deepEqual(readFileSync(join(a, file)), readFileSync(join(b, file)), file);
  }
  assert.deepEqual(readFileSync(join(a, 'manifest.json')), readFileSync(join(ROOT, 'manifest.json')));
  checkBuild(a, first);
  checkBuild(b, second);
  checkSamples(ROOT, a, first);
  assert.equal(sampleFiles(first.samples).length, 120);
  const corrupt = structuredClone(first);
  corrupt.items[0].picture.sha256 = '0'.repeat(64);
  assert.throws(() => checkBuild(a, corrupt), /sha256/);
  process.stdout.write(`Two full builds retained: ${scratch}\n`);
});
