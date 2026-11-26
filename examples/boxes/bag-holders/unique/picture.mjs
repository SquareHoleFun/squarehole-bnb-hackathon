import { Doc, r2 } from '../src/doc.mjs';
import { wall, holes } from '../src/wall.mjs';
import { hangBag } from '../src/hang.mjs';
import { shape, line } from '../src/pen.mjs';
import { validateTraits } from './deal.mjs';
import { details, reference } from './lib/details.mjs';

export function pictureSvg(traits) {
  validateTraits(traits);
  const { kind, name, options } = reference(traits);
  const doc = new Doc(1024, 1024, `Bag Holders: ${name}`, `${name}, ${traits.trim} trim, ${traits.repair} repair, ${traits.tag} tag, ${traits.stitch} stitches. Proposal.`);
  const grid = holes(1024, 1024, 64, 38, 32);
  doc.add(wall(doc, { w: 1024, h: 1024, pitch: 64, hole: 8, ox: grid[1], oy: grid[2] }));
  doc.add(hangBag(doc, kind, { cx: 512, hookY: 160, ow: 10, size: 1.3, grid, id: 'bag', ...options }));
  for (const part of details(traits)) {
    const d = `M${part.points.map(p => p.map(r2).join(' ')).join('L')}${part.fill ? 'Z' : ''}`;
    doc.add(part.fill ? shape(d, part.fill, part.width) : line(d, part.color, part.width));
  }
  return doc.toString();
}
