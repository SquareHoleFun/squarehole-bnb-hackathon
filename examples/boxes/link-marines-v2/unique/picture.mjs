import { Doc } from '../src/doc.mjs';
import { ground } from '../src/poster.mjs';
import { marine } from '../src/marine.mjs';
import { cloth, placeCard } from '../src/props.mjs';
import { cardLines } from '../src/items.mjs';
import { ration } from '../src/coins.mjs';
import { loadResvg, toPng } from '../src/render.mjs';
import { specFor } from './lib/spec.mjs';

const Resvg = await loadResvg();
export function pictureSvg(row) {
  const d = new Doc(1024, 1024, 'Link Marines - mess night', Object.entries(row.traits).filter(([key]) => key !== 'Squad').map(([k, v]) => `${k}: ${v}`).join('; '));
  d.add(ground(d, { w: 1024, h: 1024, wall: row.traits.Wall.toLowerCase(), panel: 224, top: 0 }));
  d.add(marine(d, specFor(row), { x: 62, y: -16, size: 900, ow: 10 }));
  d.add(cloth(d, { x: -20, y: 830, w: 1064, h: 214, ow: 10 }));
  // Keep the original table layout: the ration clears the rank plate at the left.
  d.add(ration(d, 540, 872, 280, 10));
  d.add(placeCard(d, { cx: 226, y: 846, w: 300, lines: cardLines(row.traits.Rank), ow: 10 }));
  return d.toString();
}
export const picturePng = (row, width = 1024) => toPng(Resvg, pictureSvg(row), width);
