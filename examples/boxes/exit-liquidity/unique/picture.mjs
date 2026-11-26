import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Doc, halo, r2 } from '../src/doc.mjs';
import { room } from '../src/room.mjs';
import { sign } from '../src/sign.mjs';
import { toPng } from '../src/render.mjs';
import { scene } from './lib/scene.mjs';
import { deal } from './deal.mjs';
import { requireNode } from './lib/io.mjs';

const require = createRequire(new URL('../../../../packages/cards/package.json', import.meta.url));
const { Resvg } = require('@resvg/resvg-js');
const polygon = (points, fill) => `<polygon points="${points.map(p=>p.map(r2).join(',')).join(' ')}" fill="${fill}"/>`;
export function pictureSvg(traits) {
  const built=scene(traits);
  const d=new Doc(1024,1024,`Exit Liquidity - ${built.variant.name}`,`${built.variant.alt} ${Object.entries(traits).map(([k,v])=>`${k}: ${v}`).join('; ')}. Cosmetic traits only.`);
  d.add(room(d,{w:1024,h:1024,ceilingY:120,floorY:908}));
  for(const [i,part] of built.parts.entries()) {
    // Both Loop halos precede both faces, as in the original kit.
    if(i===built.lamps[0].at)for(const lamp of built.lamps)d.add(`<ellipse cx="${lamp.cx}" cy="${lamp.cy}" rx="${r2(lamp.w*0.95)}" ry="${r2(lamp.h*1.7)}" fill="${halo(d,lamp.color,0.32)}"/>`);
    if(part.modelOnly)continue;
    if(part.face) {
      // Delegate lettering, LED pitch/radius/glow, block paths, mirror and tilt to the kit.
      d.add(sign(d,{...part.face,mount:'none',glow:0}).markup);
    } else d.add(polygon(part.points,part.color));
  }
  return d.toString();
}
export const picturePng = (traits, width=1024) => toPng(Resvg,pictureSvg(traits),width);
if(import.meta.main) {
  requireNode();
  const [id,out]=process.argv.slice(2), row=deal().find(r=>r.id===id);
  if(!row || !out || process.argv.length!==4)throw new Error('Usage: node picture.mjs <id> <output-directory>');
  mkdirSync(out,{recursive:true});
  writeFileSync(join(out,`picture-${id}.svg`),pictureSvg(row.traits));
  writeFileSync(join(out,`picture-${id}.png`),picturePng(row.traits));
}
