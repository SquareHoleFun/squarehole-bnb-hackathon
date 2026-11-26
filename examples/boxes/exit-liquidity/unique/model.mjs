import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeGlb, readGlb, PALETTE, srgbToLinear } from '../../rent-free/models/lib/glb.mjs';
import { scene, FLOOR, PIXELS_PER_UNIT } from './lib/scene.mjs';
import { deal } from './deal.mjs';
import { requireNode } from './lib/io.mjs';

// Reuse the Rent Free writer unchanged. Its seven material slots are rebound locally;
// the shared palette object is never modified and the embedded mesh bytes stay intact.
function encodeExitGlb(triangles) {
  const colors=[...new Set(triangles.map(t=>t.material))].sort(), slots=Object.keys(PALETTE);
  assert.ok(colors.length<=slots.length,'Rent Free material slot capacity');
  const bytes=encodeGlb(triangles.map(t=>({...t,material:slots[colors.indexOf(t.material)]})),'Exit Liquidity sign');
  const {json}=readGlb(bytes);
  json.asset.generator='Exit Liquidity unique proposal v1 - Rent Free GLB writer';
  json.materials=json.materials.slice(0,colors.length).map((m,i)=>({ ...m,name:colors[i],pbrMetallicRoughness:{...m.pbrMetallicRoughness,
    baseColorFactor:[...[1,3,5].map(at=>srgbToLinear(parseInt(colors[i].slice(at,at+2),16)/255)),1]}}));
  const source=Buffer.from(JSON.stringify(json)), padded=Buffer.alloc(Math.ceil(source.length/4)*4,32);
  source.copy(padded);
  const oldJsonLength=bytes.readUInt32LE(12), binChunk=bytes.subarray(20+oldJsonLength);
  const header=Buffer.from(bytes.subarray(0,20));
  header.writeUInt32LE(20+padded.length+binChunk.length,8); header.writeUInt32LE(padded.length,12);
  return Buffer.concat([header,padded,binChunk]);
}

export function modelGlb(traits) {
  const {parts}=scene(traits), triangles=[];
  // All primitives are convex. Cap fans and side quads form closed solid geometry.
  for(const part of parts) {
    let p=part.points.map(([x,y])=>[x,FLOOR-y]);
    const area=p.reduce((n,a,i)=>{const b=p[(i+1)%p.length];return n+a[0]*b[1]-b[0]*a[1];},0);
    if(area<0)p=p.toReversed();
    const vertex=(i,z)=>[p[i][0],p[i][1],z];
    const tri=(a,b,c)=>triangles.push({points:[a,b,c],material:part.color});
    if(part.dome) {
      // A closed, shallow six-sided raised LED: ten triangles including its buried base.
      const center=[p.reduce((n,v)=>n+v[0],0)/p.length,p.reduce((n,v)=>n+v[1],0)/p.length,part.front];
      for(let i=0;i<p.length;i++)tri(center,vertex(i,part.back),vertex((i+1)%p.length,part.back));
      for(let i=1;i<p.length-1;i++)tri(vertex(0,part.back),vertex(i+1,part.back),vertex(i,part.back));
      continue;
    }
    for(let i=1;i<p.length-1;i++) {
      tri(vertex(0,part.front),vertex(i,part.front),vertex(i+1,part.front));
      tri(vertex(0,part.back),vertex(i+1,part.back),vertex(i,part.back));
    }
    for(let i=0;i<p.length;i++) {
      const j=(i+1)%p.length;
      tri(vertex(i,part.front),vertex(i,part.back),vertex(j,part.back));
      tri(vertex(i,part.front),vertex(j,part.back),vertex(j,part.front));
    }
  }
  const bounds=[Math.min,Math.max].map(fn=>[0,1,2].map(axis=>fn(...triangles.flatMap(t=>t.points.map(p=>p[axis])))));
  const center=[(bounds[0][0]+bounds[1][0])/2,0,(bounds[0][2]+bounds[1][2])/2];
  for(const tri of triangles)tri.points=tri.points.map(p=>p.map((v,i)=>(v-center[i])/PIXELS_PER_UNIT));
  return encodeExitGlb(triangles);
}
if(import.meta.main) {
  requireNode();
  const [id,out]=process.argv.slice(2),row=deal().find(r=>r.id===id);
  if(!row || !out || process.argv.length!==4)throw new Error('Usage: node model.mjs <id> <output-directory>');
  mkdirSync(out,{recursive:true}); writeFileSync(join(out,`model-${id}.glb`),modelGlb(row.traits));
}
