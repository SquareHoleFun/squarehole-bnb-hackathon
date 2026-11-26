import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { baseMarines, rankLibrary } from '../ranks.mjs';
import { deal, lookKey, schema, validateDeal } from './deal.mjs';
import { pictureSvg, picturePng } from './picture.mjs';
import { model } from './model.mjs';
import { checkBuild, checkPicture, sampleIds, sha256 } from './check.mjs';
import { readGlb } from '../../rent-free/models/lib/glb.mjs';
import { checkModel } from '../../rent-free/models/check-models.mjs';
import { sampleArtifacts } from './samples.mjs';
import { decodePng } from '../../rent-free/models/lib/raster.mjs';
import { DRAWN } from '../src/type.mjs';
import { cardLines } from '../src/items.mjs';

test('AF1-1/2: all 420 tables match their original rank plate and clear ration spacing', () => {
  const tables = new Map(rankLibrary().map(({ rank, image }) => [rank,
    decodePng(readFileSync(new URL(`../${image}`, import.meta.url))).rgb.subarray(836 * 1024 * 3),
  ]));
  for (const row of deal()) {
    const rank = baseMarines().find(item => item.id === row.id).rank;
    DRAWN.length = 0;
    const png = decodePng(picturePng(row));
    assert.equal(sha256(png.rgb.subarray(836 * 1024 * 3)), sha256(tables.get(rank)),
      `id ${row.id}: original ${rank} plate, stencil, position, colour, size and unobstructed table`);
    assert.deepEqual(DRAWN.map(block => block.text), [cardLines(rank).join(' / ')], 'only the original rank words');
  }
});

test('AF1-3: all twelve ranks have distinct geometry on otherwise identical marines within budget', () => {
  const row = deal()[0], geometries = new Set();
  for (const { rank } of rankLibrary()) {
    const bytes = model({ ...row, traits: { ...row.traits, Rank: rank } });
    checkModel(bytes);
    geometries.add(sha256(readGlb(bytes).bin));
  }
  assert.equal(geometries.size, 12, 'every rank needs its own visible plate lettering, beyond cap grade');
});

test('R1-R2: exact counts, unchanged rank/squad, and unique visible characters', () => {
  const rows = deal();
  validateDeal(rows);
  assert.equal(rows.length, 420);
  assert.equal(new Set(rows.map(lookKey)).size, 420);
  assert.deepEqual(rows.map(({ id, traits }) => ({ id, rank: traits.Rank, squad: traits.Squad })),
    baseMarines().map(({ id, rank, squad }) => ({ id, rank, squad })));
  assert.deepEqual(deal(), rows);
  assert.notDeepEqual(deal('different proposal seed'), rows);
  for (const values of Object.values(schema.traits)) {
    assert.equal(Object.values(values).reduce((a, n) => a + BigInt(n), 0n), 420n);
  }
  const duplicate = structuredClone(rows);
  duplicate[1].traits = { ...duplicate[0].traits, Rank: rows[1].traits.Rank, Squad: rows[1].traits.Squad };
  assert.throws(() => validateDeal(duplicate));
  const badCount = structuredClone(rows);
  badCount[0].traits.Eyes = 'invisible';
  assert.throws(() => validateDeal(badCount));
  assert.throws(() => validateDeal(rows.slice(1)));
  const changedRank = structuredClone(rows);
  changedRank[0].traits.Rank = 'General';
  assert.throws(() => validateDeal(changedRank), /rank unchanged/);
});

test('R3-R4: traits drive both assets, without id-based visual noise or external fonts', async () => {
  const row = deal()[0];
  const svg = pictureSvg(row);
  assert.doesNotMatch(svg, /<(?:text|image|script|foreignObject)\b|(?:linear|radial)Gradient/);
  assert.equal(pictureSvg({ ...row, id: '420' }), svg);
  assert.deepEqual(model({ ...row, id: '420' }), model(row));
  checkPicture(await picturePng(row));
  checkModel(model(row));
  for (const key of Object.keys(schema.traits).filter(k => !['Rank', 'Squad', 'Wall'].includes(k))) {
    for (const value of Object.keys(schema.traits[key]).filter(v => v !== row.traits[key])) {
      const changed = { ...row, traits: { ...row.traits, [key]: value } };
      assert.notEqual(pictureSvg(changed), svg, key);
      assert.notEqual(sha256(readGlb(model(changed)).bin), sha256(readGlb(model(row)).bin), key);
    }
  }
  assert.throws(() => checkPicture(Buffer.from('not a PNG')));
  assert.throws(() => checkPicture(picturePng(row, 128)), /PNG width/);
  assert.throws(() => checkPicture(Buffer.alloc(400 * 1024)), /400 KiB/);
  assert.throws(() => checkModel(model(row).subarray(0, 100)));
});

test('R5-R6: every committed sample, render and labelled sheet matches its generator', () => {
  const base = new URL('./', import.meta.url);
  const files = sampleArtifacts(name => readFileSync(new URL(`samples/${name}`, base)));
  const expected = [...files.keys()].filter(name => name.startsWith('samples/')).map(name => name.slice(8)).sort();
  assert.deepEqual(readdirSync(new URL('samples/', base)).sort(), expected, 'exactly 48 PNGs, 24 GLBs and 48 renders');
  for (const [name, bytes] of files) assert.deepEqual(readFileSync(new URL(name, base)), bytes, name);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'));
  for (const row of manifest.items) for (const kind of ['picture', 'model']) {
    const bytes = files.get(`samples/${row[kind].file}`);
    if (bytes) assert.equal(sha256(bytes), row[kind].sha256, row[kind].file);
  }
});

test('R5: deterministic samples cover all values; models cover all visual values and ranks', () => {
  const rows = deal(), pictures = sampleIds(rows, 48), models = sampleIds(rows, 24, pictures);
  assert.equal(new Set(pictures).size, 48);
  assert.equal(new Set(models).size, 24);
  assert.deepEqual(sampleIds(rows, 48), pictures);
  for (const key of Object.keys(schema.traits)) {
    const seen = ids => new Set(rows.filter(r => ids.includes(r.id)).map(r => r.traits[key]));
    assert.deepEqual(seen(pictures), new Set(Object.keys(schema.traits[key])), key);
    if (key !== 'Squad') assert.deepEqual(seen(models), new Set(Object.keys(schema.traits[key])), key);
  }
});

test('R2-R6: two fresh processes recreate all 420 assets and the committed manifest', { timeout: 600_000 }, () => {
  mkdirSync('.cache/tmp', { recursive: true });
  const root = mkdtempSync('.cache/tmp/unique-marines-test-');
  const dirs = ['a', 'b'].map(name => join(root, name));
  for (const dir of dirs) {
    const run = spawnSync(process.execPath, ['examples/boxes/link-marines-v2/unique/build.mjs', '--out', dir], { encoding: 'utf8', timeout: 240_000 });
    assert.equal(run.status, 0, run.stderr);
  }
  const a = checkBuild(dirs[0]), b = checkBuild(dirs[1]);
  assert.deepEqual(a, b);
  assert.deepEqual(readFileSync(join(dirs[0], 'manifest.json')), readFileSync(join(dirs[1], 'manifest.json')));
  for (const { id } of deal()) for (const ext of ['svg', 'png', 'glb']) {
    const name = `${ext === 'glb' ? 'model' : 'picture'}-${id}.${ext}`;
    assert.deepEqual(readFileSync(join(dirs[0], name)), readFileSync(join(dirs[1], name)), name);
  }
  process.stdout.write(`Retained both full builds: ${root}\n`);
});
