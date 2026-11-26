import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { deal, schema, validateDeal, LOOK } from './deal.mjs';
import { picturePng, pictureSvg } from './picture.mjs';
import { C, MIX } from '../src/palette.mjs';
import { readGlb } from '../../rent-free/models/lib/glb.mjs';
import { decodePng } from '../../rent-free/models/lib/raster.mjs';
import { checkModel } from '../../rent-free/models/check-models.mjs';
import { rankLibrary } from '../ranks.mjs';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function checkPicture(bytes) {
  assert.ok(bytes.length < 400*1024, 'PNG below 400 KiB');
  const decoded=decodePng(bytes);
  assert.equal(decoded.width,1024,'PNG width'); assert.equal(decoded.height,1024,'PNG height');
  return decoded;
}
/** Stable greedy cover, then max-min character distance; ids break ties in original numeric order. */
export function sampleIds(rows, count, allowed = rows.map(r=>r.id)) {
  const candidates=rows.filter(r=>allowed.includes(r.id)),picked=[],seen=new Set();
  assert.ok(count<=candidates.length);
  while(picked.length<count) {
    let winner,score=-Infinity;
    for(const r of candidates.filter(r=>!picked.includes(r))) {
      const unseen=Object.entries(r.traits).reduce((n,[k,v])=>n+(seen.has(`${k}:${v}`)?0:k==='Squad'?1:100),0);
      const distance=picked.length?Math.min(...picked.map(p=>LOOK.reduce((n,k)=>n+(p.traits[k]===r.traits[k]?0:1),0))):0;
      const value=unseen*100+distance;
      if(value>score) { score=value; winner=r; }
    }
    picked.push(winner); for(const [k,v] of Object.entries(winner.traits)) seen.add(`${k}:${v}`);
  }
  return picked.map(r=>r.id).sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
}
export function checkBuild(directory, { committed = true } = {}) {
  const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
  assert.equal(manifest.format,'link-marines-v2/unique-manifest/1');
  assert.equal(manifest.seed,schema.seed); assert.equal(manifest.count,schema.count);
  validateDeal(manifest.items);
  assert.deepEqual(manifest.items.map(({id,traits})=>({id,traits})),deal(),'fresh trait deal');
  const pictures=new Set(),pixels=new Set(),models=new Set(),small=new Set();
  const palette=new Set([...Object.values(C),...Object.values(MIX)].map(x=>x.toUpperCase()));
  const tables=new Map(rankLibrary().map(({rank,image})=>[rank,
    sha256(decodePng(readFileSync(new URL(`../${image}`,import.meta.url))).rgb.subarray(836*1024*3)),
  ]));
  for(const row of manifest.items) {
    const bytes={};
    for(const kind of ['picture','svg','model']) {
      const a=row[kind],ext={picture:'png',svg:'svg',model:'glb'}[kind];
      assert.equal(a.file,`${kind==='model'?'model':'picture'}-${row.id}.${ext}`);
      bytes[kind]=readFileSync(join(directory,a.file));
      assert.equal(a.bytes,bytes[kind].length); assert.equal(a.sha256,sha256(bytes[kind]),`${row.id} ${kind} hash`);
    }
    const decoded=checkPicture(bytes.picture),geometry=checkModel(bytes.model);
    assert.equal(sha256(decoded.rgb.subarray(836*1024*3)),tables.get(row.traits.Rank),`${row.id}: original rank plate and table clearance`);
    assert.equal(row.model.triangles,geometry.triangles);
    assert.equal(bytes.svg.toString(),pictureSvg(row));
    assert.doesNotMatch(bytes.svg.toString(),/<(?:text|image|script|foreignObject)\b|(?:linear|radial)Gradient/);
    for(const hex of bytes.svg.toString().match(/#[0-9a-f]{6}\b/gi)??[]) assert.ok(palette.has(hex.toUpperCase()),`palette ${hex}`);
    pictures.add(sha256(bytes.picture)); pixels.add(sha256(decoded.rgb));
    models.add(sha256(readGlb(bytes.model).bin));
    small.add(sha256(decodePng(picturePng(row,128)).rgb));
  }
  for(const set of [pictures,pixels,models,small]) assert.equal(set.size,manifest.items.length,'unique encoded assets, pixels, geometry and 128px pictures');
  if(committed) assert.deepEqual(readFileSync(join(directory,'manifest.json')),readFileSync(new URL('./manifest.json',import.meta.url)),'committed manifest equals fresh build');
  return manifest;
}
if(import.meta.main) {
  let dir;
  if(process.argv.length===4&&process.argv[2]==='--dir') dir=process.argv[3];
  else {
    assert.equal(process.argv.length,2,'Usage: check.mjs [--dir <full-build>]');
    mkdirSync('.cache/tmp',{recursive:true}); dir=mkdtempSync('.cache/tmp/unique-marines-check-');
    const {build}=await import('./build.mjs'); build(dir,message => process.stdout.write(`${message}\n`));
  }
  const m=checkBuild(dir);
  process.stdout.write(`${m.count} marines: exact traits, unique pixels at 1024/128, unique model geometry, PNG/GLB limits and committed hashes pass (${dir})\n`);
}
