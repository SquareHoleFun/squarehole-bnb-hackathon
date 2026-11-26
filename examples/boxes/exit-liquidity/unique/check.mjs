import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { verifyDeal, deal, SEED, vocabulary } from './deal.mjs';
import { build, selectSamples, sampleFiles, sheetBytes } from './build.mjs';
import { picturePng, pictureSvg } from './picture.mjs';
import { sha256, ROOT, requireNode } from './lib/io.mjs';
import { checkModel } from '../../rent-free/models/check-models.mjs';
import { readGlb } from '../../rent-free/models/lib/glb.mjs';
import { decodePng, renderGlb, encodePng } from '../../rent-free/models/lib/raster.mjs';

export function checkBuild(directory,manifest) {
  assert.equal(manifest.format,'exit-liquidity/unique-manifest/v1');
  assert.equal(manifest.seed,SEED);assert.equal(manifest.count,'404');
  assert.deepEqual(manifest.toolchain,{node:'24.22.1',resvg:'2.6.2'});
  verifyDeal(manifest.items);
  assert.deepEqual(manifest.items.map(({id,traits})=>({id,traits})),deal(),'fresh deal');
  assert.deepEqual(manifest.samples,selectSamples(manifest.items));
  const pictures=new Set(),models=new Set(),geometry=new Set(),smallPictures=new Set();
  for(const row of manifest.items) {
    const png=readFileSync(join(directory,`picture-${row.id}.png`)),model=readFileSync(join(directory,`model-${row.id}.glb`));
    const svg=readFileSync(join(directory,`picture-${row.id}.svg`),'utf8');
    assert.equal(svg,pictureSvg(row.traits),'fresh SVG');
    assert.doesNotMatch(svg,/<(?:text|image|script|foreignObject)\b|(?:href|font-family)=/i);
    const decoded=decodePng(png);
    assert.equal(decoded.width,1024,'PNG width');assert.equal(decoded.height,1024,'PNG height');
    assert.ok(png.length<400*1024,'PNG under 400 KiB');
    assert.equal(row.picture.bytes,png.length,'picture bytes');assert.equal(row.picture.sha256,sha256(png),'picture sha256');
    const result=checkModel(model);
    assert.equal(row.model.bytes,model.length,'model bytes');assert.equal(row.model.triangles,result.triangles,'model triangles');
    assert.equal(row.model.sha256,sha256(model),'model sha256');
    pictures.add(sha256(decoded.rgb));models.add(row.model.sha256);
    geometry.add(sha256(readGlb(model).bin));
    smallPictures.add(sha256(decodePng(picturePng(row.traits,128)).rgb));
  }
  assert.equal(pictures.size,404,'unique decoded pictures');assert.equal(models.size,404,'unique models');
  assert.equal(geometry.size,404,'unique physical mesh buffers');
  assert.equal(smallPictures.size,404,'unique decoded 128 px pictures');
  return {pictures:pictures.size,models:models.size};
}

export function checkSamples(proposal,full,manifest) {
  const directory=join(proposal,'samples');
  assert.deepEqual(readdirSync(directory).sort(),sampleFiles(manifest.samples).sort(),'exact sample file set');
  for(const layer of vocabulary.layers)for(const value of layer.values)for(const type of ['pictures','models']) {
    assert.ok(manifest.items.some(r=>manifest.samples[type].includes(r.id)&&r.traits[layer.key]===value.value),`sample coverage ${type} ${layer.key} ${value.value}`);
  }
  for(const id of manifest.samples.pictures)assert.deepEqual(readFileSync(join(directory,`picture-${id}.png`)),readFileSync(join(full,`picture-${id}.png`)),`sample picture ${id}`);
  for(const id of manifest.samples.models) {
    const bytes=readFileSync(join(full,`model-${id}.glb`));
    assert.deepEqual(readFileSync(join(directory,`model-${id}.glb`)),bytes,`sample model ${id}`);
    for(const camera of ['front','three-quarter'])assert.deepEqual(readFileSync(join(directory,`render-${id}-${camera}.png`)),encodePng(renderGlb(bytes,camera)),`fresh render ${id} ${camera}`);
  }
  for(const [name,bytes] of Object.entries(sheetBytes(full,manifest,directory)))assert.deepEqual(readFileSync(join(proposal,name)),bytes,`fresh ${name}`);
}

if(import.meta.main) {
  requireNode();
  if(process.argv.length!==2)throw new Error('Usage: node check.mjs');
  mkdirSync('.cache/tmp',{recursive:true});const directory=mkdtempSync('.cache/tmp/unique-exit-check-');
  const fresh=build(directory),committed=JSON.parse(readFileSync(join(ROOT,'manifest.json'),'utf8'));
  assert.deepEqual(fresh,committed,'manifest equals fresh build');
  const result=checkBuild(directory,fresh);checkSamples(ROOT,directory,fresh);
  process.stdout.write(`PASS: ${result.pictures} unique pictures, ${result.models} checked models, exact counts, all sample values, fresh manifest and sheets. Build retained: ${directory}\n`);
}
