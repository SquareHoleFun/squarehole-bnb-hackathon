import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deal, SEED, vocabulary } from './deal.mjs';
import { pictureSvg, picturePng } from './picture.mjs';
import { modelGlb } from './model.mjs';
import { sha256, jsonBytes, requireNode } from './lib/io.mjs';
import { checkModel } from '../../rent-free/models/check-models.mjs';
import { canvas, label, blit, decodePng, encodePng, renderGlb } from '../../rent-free/models/lib/raster.mjs';

const coverage = row => vocabulary.layers.map(l=>`${l.key}=${row.traits[l.key]}`);
export function selectSamples(rows) {
  const missing=new Set(vocabulary.layers.flatMap(l=>l.values.map(v=>`${l.key}=${v.value}`)));
  const chosen=['404'],perSign=new Map([['08',1]]),frequency=new Map();
  const record = row => coverage(row).forEach(key=>{missing.delete(key);frequency.set(key,(frequency.get(key)??0)+1);});
  record(rows.find(r=>r.id==='404'));
  // Two of each original sign. Maximize remaining value coverage, then stable id order.
  while(chosen.length<24) {
    let best=null,score=-1;
    for(const row of rows) {
      if(chosen.includes(row.id)||(perSign.get(row.traits.sign)??0)>=2)continue;
      const values=coverage(row);
      const gain=values.filter(key=>missing.has(key)).length*10000 + values.reduce((n,key)=>n+Math.floor(1000/(1+(frequency.get(key)??0))),0);
      if(gain>score){best=row;score=gain;}
    }
    assert.ok(best,'model sample capacity');
    chosen.push(best.id);perSign.set(best.traits.sign,(perSign.get(best.traits.sign)??0)+1);
    record(best);
  }
  assert.equal(missing.size,0,'model samples cover every value');
  const models=[...chosen];
  // Expand to four of each base, preferring the most different remaining within that sign.
  while(chosen.length<48) {
    let best=null,score=-1;
    for(const row of rows) {
      if(chosen.includes(row.id)||(perSign.get(row.traits.sign)??0)>=4)continue;
      const near=rows.filter(r=>chosen.includes(r.id)&&r.traits.sign===row.traits.sign);
      const gain=Math.min(...near.map(r=>vocabulary.layers.filter(l=>r.traits[l.key]!==row.traits[l.key]).length));
      if(gain>score){best=row;score=gain;}
    }
    assert.ok(best,'picture sample capacity');
    chosen.push(best.id);perSign.set(best.traits.sign,(perSign.get(best.traits.sign)??0)+1);
  }
  const sort=ids=>ids.sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
  return {pictures:sort(chosen),models:sort(models)};
}

export const sampleFiles = samples => [
  ...samples.pictures.map(id=>`picture-${id}.png`),
  ...samples.models.flatMap(id=>[`model-${id}.glb`,`render-${id}-front.png`,`render-${id}-three-quarter.png`]),
];

export function build(out) {
  requireNode();
  mkdirSync(out,{recursive:true});
  const rows=deal(),items=[];
  for(const row of rows) {
    const svg=pictureSvg(row.traits),picture=picturePng(row.traits),model=modelGlb(row.traits);
    const result=checkModel(model);
    writeFileSync(join(out,`picture-${row.id}.svg`),svg);
    writeFileSync(join(out,`picture-${row.id}.png`),picture);
    writeFileSync(join(out,`model-${row.id}.glb`),model);
    items.push({...row,picture:{sha256:sha256(picture),bytes:picture.length},model:{sha256:sha256(model),bytes:model.length,triangles:result.triangles}});
  }
  const manifest={format:'exit-liquidity/unique-manifest/v1',seed:SEED,count:'404',toolchain:{node:'24.22.1',resvg:'2.6.2'},samples:selectSamples(rows),items};
  writeFileSync(join(out,'manifest.json'),jsonBytes(manifest));
  return manifest;
}

// Exact area downsampling keeps contact sheets legible without a second image dependency.
export function thumbnail(source,size) {
  assert.equal(source.width,source.height,'square thumbnail source');
  assert.equal(source.width%size,0,'integral downsample');
  const out=canvas(size,size),factor=source.width/size;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++)for(let c=0;c<3;c++) {
    let sum=0;
    for(let dy=0;dy<factor;dy++)for(let dx=0;dx<factor;dx++)sum+=source.rgb[((y*factor+dy)*source.width+x*factor+dx)*3+c];
    out.rgb[(y*size+x)*3+c]=Math.round(sum/(factor*factor));
  }
  return out;
}

export function sheetBytes(full,manifest,renderDirectory) {
  const contact=canvas(1536,3072),models=canvas(1536,3456);
  const byId=new Map(manifest.items.map(r=>[r.id,r]));
  manifest.samples.pictures.forEach((id,i)=>{
    const x=i%6*256,y=Math.floor(i/6)*384,row=byId.get(id),t=row.traits;
    const png=readFileSync(join(full,`picture-${id}.png`));
    blit(contact,thumbnail(decodePng(png),256),x,y);
    label(contact,`ID ${id} - SIGN ${t.sign}`,x+8,y+266,2);
    label(contact,`HOUSING ${t.housing}`,x+8,y+292,2);
    label(contact,`ROUTE ${t.route}`,x+8,y+310,2);
    label(contact,`REPAIR ${t.repair}`,x+8,y+328,2);
    label(contact,`EQUIPMENT ${t.equipment}`,x+8,y+346,2);
    label(contact,`CONDUIT ${t.conduit}`,x+8,y+364,2);
  });
  manifest.samples.models.forEach((id,i)=>{
    const x=i%2*768,y=Math.floor(i/2)*288,row=byId.get(id);
    const images=[readFileSync(join(full,`picture-${id}.png`)),...['front','three-quarter'].map(view=>readFileSync(join(renderDirectory,`render-${id}-${view}.png`)))];
    images.forEach((bytes,j)=>blit(models,thumbnail(decodePng(bytes),256),x+j*256,y));
    label(models,`ID ${id} SIGN ${row.traits.sign} - PICTURE - FRONT - THREE QUARTER`,x+8,y+266,2);
  });
  return {'contact-sheet.png':encodePng(contact),'models-sheet.png':encodePng(models)};
}

export function writeSamples(full,destination,manifest) {
  const directory=join(destination,'samples');mkdirSync(directory,{recursive:true});
  for(const id of manifest.samples.pictures)copyFileSync(join(full,`picture-${id}.png`),join(directory,`picture-${id}.png`));
  for(const id of manifest.samples.models) {
    const bytes=readFileSync(join(full,`model-${id}.glb`));
    writeFileSync(join(directory,`model-${id}.glb`),bytes);
    for(const camera of ['front','three-quarter'])writeFileSync(join(directory,`render-${id}-${camera}.png`),encodePng(renderGlb(bytes,camera)));
  }
  for(const [name,bytes] of Object.entries(sheetBytes(full,manifest,directory)))writeFileSync(join(destination,name),bytes);
  writeFileSync(join(destination,'manifest.json'),jsonBytes(manifest));
}

if(import.meta.main) {
  const [flag,out,sampleFlag,destination]=process.argv.slice(2);
  if(flag!=='--out'||!out||(sampleFlag!==undefined&&(sampleFlag!=='--samples'||!destination))||process.argv.length>6) {
    throw new Error('Usage: node build.mjs --out <full-build-directory> [--samples <proposal-directory>]');
  }
  const manifest=build(out);
  if(destination)writeSamples(out,destination,manifest);
  const pictureBytes=manifest.items.reduce((n,r)=>n+r.picture.bytes,0),modelBytes=manifest.items.reduce((n,r)=>n+r.model.bytes,0);
  process.stdout.write(`${manifest.items.length} unique signs: ${pictureBytes} PNG bytes, ${modelBytes} GLB bytes\n`);
}
