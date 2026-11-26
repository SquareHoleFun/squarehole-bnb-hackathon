import { encodeGlb, readGlb, srgbToLinear } from '../../../rent-free/models/lib/glb.mjs';
import { C } from '../../src/palette.mjs';

/** Convex prisms, faceted ellipsoids and tubes. Ink is an inverted outer shell, never a shader. */
export class Mesh {
  triangles = [];
  tri(a, b, c, material, invert = false) {
    this.triangles.push({ points: invert ? [a, c, b] : [a, b, c], material });
  }
  prism(points, back, front, color, edge = 0.006) {
    let p = points;
    if (p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0) < 0) p = [...p].reverse();
    const center = [0, 1].map(axis => p.reduce((s, a) => s + a[axis], 0) / p.length);
    const raw = (poly, z0, z1, material, invert) => {
      for (const [i, a] of poly.entries()) {
        const b = poly[(i + 1) % poly.length];
        this.tri([...center, z1], [...a, z1], [...b, z1], material, invert);
        this.tri([...center, z0], [...b, z0], [...a, z0], material, invert);
        this.tri([...a, z0], [...b, z0], [...b, z1], material, invert);
        this.tri([...a, z0], [...b, z1], [...a, z1], material, invert);
      }
    };
    raw(p, back, front, color, false);
    if (edge) raw(p.map(a => {
      const d = Math.hypot(a[0] - center[0], a[1] - center[1]);
      return a.map((v, i) => v + (v - center[i]) / d * edge);
    }), back - edge, front + edge, C.ink, true);
  }
  box(x, y, z, w, h, d, color, edge = 0.006) {
    this.prism([[x-w/2,y-h/2],[x+w/2,y-h/2],[x+w/2,y+h/2],[x-w/2,y+h/2]],z-d/2,z+d/2,color,edge);
  }
  oval(x, y, z, rx, ry, depth, color, edge = 0.005, n = 12) {
    this.prism(Array.from({length:n}, (_, i) => [x + rx*Math.cos(i*2*Math.PI/n), y + ry*Math.sin(i*2*Math.PI/n)]), z-depth/2,z+depth/2,color,edge);
  }
  ball(center, radius, color, edge = 0.005, n = 10, rings = 4) {
    const raw = (r, material, invert) => {
      const point = (j,i) => {
        const a = j*Math.PI/rings, b = i*2*Math.PI/n;
        return [center[0]+r[0]*Math.sin(a)*Math.cos(b), center[1]+r[1]*Math.cos(a), center[2]+r[2]*Math.sin(a)*Math.sin(b)];
      };
      for (let j=0;j<rings;j++) for(let i=0;i<n;i++) {
        if(j>0) this.tri(point(j,i),point(j,i+1),point(j+1,i),material,invert);
        if(j<rings-1) this.tri(point(j,i+1),point(j+1,i+1),point(j+1,i),material,invert);
      }
    };
    raw(radius,color,false);
    if(edge) raw(radius.map(r=>r+edge),C.ink,true);
  }
  line(points, width, color, depth = 0.008) {
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i],len=Math.hypot(b[0]-a[0],b[1]-a[1]);
      const dx=-(b[1]-a[1])/len*width/2,dy=(b[0]-a[0])/len*width/2;
      this.prism([[a[0]+dx,a[1]+dy],[a[0]-dx,a[1]-dy],[b[0]-dx,b[1]-dy],[b[0]+dx,b[1]+dy]],a[2],a[2]+depth,color,0);
    }
  }
  finish() {
    const points=this.triangles.flatMap(t=>t.points);
    const min=[0,1,2].map(a=>Math.min(...points.map(p=>p[a]))),max=[0,1,2].map(a=>Math.max(...points.map(p=>p[a])));
    const offset=[(min[0]+max[0])/2,min[1],(min[2]+max[2])/2];
    return this.triangles.map(t=>({...t,points:t.points.map(p=>p.map((v,a)=>v-offset[a]))}));
  }
}

/**
 * Reuse the Rent Free geometry encoder unchanged. It has a fixed house palette, so encode a single slot,
 * then partition its contiguous index stream into marine material ranges. Positions/normals/BIN stay untouched.
 */
export function marineGlb(triangles) {
  const colors = [...new Set(triangles.map(t => t.material))].sort();
  const groups = colors.map(c => triangles.filter(t => t.material === c));
  const encoded = encodeGlb(groups.flat().map(t => ({ ...t, material: 'forest' })), 'Link Marine');
  const { json, bin } = readGlb(encoded);
  const original = json.meshes[0].primitives[0], index = json.accessors[original.indices];
  json.asset.generator = 'Link Marines deterministic proposal; Rent Free mesh encoder';
  json.materials = colors.map(hex => ({ name: hex, pbrMetallicRoughness: {
    baseColorFactor: [...[1,3,5].map(i => srgbToLinear(Number.parseInt(hex.slice(i,i+2),16)/255)), 1], metallicFactor: 0, roughnessFactor: 0.9,
  } }));
  json.accessors = json.accessors.slice(0, original.indices);
  let offset = 0;
  json.meshes[0].primitives = groups.map((group, material) => {
    const indices = json.accessors.length, count = group.length*3;
    json.accessors.push({ ...index, byteOffset: offset, count });
    offset += count*2;
    return { ...original, indices, material };
  });
  const source = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(source.length/4)*4, 32); source.copy(padded);
  const head = Buffer.from(encoded.subarray(0,20));
  head.writeUInt32LE(28+padded.length+bin.length,8); head.writeUInt32LE(padded.length,12);
  const binHead = Buffer.alloc(8); binHead.writeUInt32LE(bin.length); binHead.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([head,padded,binHead,bin]);
}
