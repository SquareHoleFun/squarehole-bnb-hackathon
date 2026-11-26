/**
 * The twelve bag variants. Each one is a single bag on one hook on the same pegboard, 1024 x 1024.
 * The hook's hole sits on the wall's grid, and the bag hangs centred at x 512.
 */
import { Doc } from './doc.mjs';
import { wall, holes } from './wall.mjs';
import { hangBag, hookOffset } from './hang.mjs';
import { VARIANT_NAMES } from '../assign.mjs';

export const ITEM_SIZE = 1024;
const PITCH = 64;
const HOOK_SIZE = 1.3;
const HOOK_Y = 160;
const OW = 10;
/** The grid is shifted so that a hole sits exactly where the centred bag's hook goes. */
const GRID = holes(ITEM_SIZE, ITEM_SIZE, PITCH, (ITEM_SIZE / 2 - hookOffset(HOOK_SIZE)) % PITCH, HOOK_Y % PITCH);

const ART = [
  { n: '01', kind: 'tote', bag: { top: 450, w: 500, h: 450, print: 'TOTE' },
    alt: 'A canvas tote with a red pocket and the word TOTE, hanging from a steel hook on a plum pegboard.' },
  { n: '02', kind: 'paper', bag: { top: 420, w: 520, h: 500 },
    alt: 'A brown paper shopping bag with twisted paper handles, hanging from a steel hook.' },
  { n: '03', kind: 'tea', bag: { top: 470, w: 340, h: 430 },
    alt: 'A tea bag hanging by its string from a steel hook, with a small aqua tag that says TEA.' },
  { n: '04', kind: 'sand', bag: { top: 350, w: 560, h: 560 },
    alt: 'A burlap sandbag tied at the neck and stamped SAND, hanging by a rope loop from a steel hook.' },
  { n: '05', kind: 'beans', bag: { top: 310, w: 640, h: 600 },
    alt: 'A yellow bean bag with a dark carry loop, hanging from a steel hook.' },
  { n: '06', kind: 'punch', bag: { top: 290, w: 360, h: 630 },
    alt: 'A black punching bag with a red band, hanging from four chains on a steel hook.' },
  { n: '07', kind: 'sleep', bag: { top: 360, w: 660, h: 520 },
    alt: 'A green sleeping bag rolled up with two red straps, hanging by its carry strap from a steel hook.' },
  { n: '08', kind: 'gift', bag: { top: 450, w: 470, h: 450 },
    alt: 'A white gift bag with red dots and yellow tissue paper, hanging by red ribbon handles from a steel hook.' },
  { n: '09', kind: 'duffel', bag: { top: 360, w: 690, h: 520 },
    alt: 'A red duffel bag with two white stripes and a zip, hanging by its dark handles from a steel hook.' },
  { n: '10', kind: 'pack', bag: { top: 310, w: 480, h: 610 },
    alt: 'An aqua backpack with a red front pocket, hanging by its top loop from a steel hook.' },
  { n: '11', kind: 'chips', bag: { top: 300, w: 480, h: 620 },
    alt: 'A silver bag of chips with a red label that says CHIPS, hanging by the hole in its top from a steel hook.' },
  { n: '12', kind: 'lemons', bag: { top: 320, w: 520, h: 600 },
    alt: 'A red net bag full of lemons, hanging by its loop from a steel hook.' },
];

if (ART.length !== VARIANT_NAMES.length || ART.some((v, i) => v.n !== String(i + 1).padStart(2, '0'))) {
  throw new Error('src/items.mjs and assign.mjs must list the same variants in the same order');
}

/** The variants with their names from assign.mjs, the single list both files share. */
export const VARIANTS = Object.freeze(ART.map((v, i) => Object.freeze({ ...v, name: VARIANT_NAMES[i] })));

/** One variant as an SVG document. */
export function itemSvg(v) {
  const d = new Doc(ITEM_SIZE, ITEM_SIZE, `Bag Holders bag, variant ${v.n}: ${v.name}`, v.alt);
  d.add(wall(d, { w: ITEM_SIZE, h: ITEM_SIZE, pitch: PITCH, hole: 8, ox: GRID[1], oy: GRID[2] }));
  d.add(hangBag(d, v.kind, { cx: ITEM_SIZE / 2, hookY: HOOK_Y, ow: OW, size: HOOK_SIZE, grid: GRID, id: `v${v.n}`, ...v.bag }));
  return d.toString();
}
