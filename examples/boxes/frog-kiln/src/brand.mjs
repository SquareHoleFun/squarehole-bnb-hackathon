/**
 * The brand pieces: the mark (logo and X avatar), the X banner, the link cover and the box page banner, plus the bare
 * grounds check.mjs compares them with. The mark is the kiln seen from the front, its door full of fire, with a
 * celadon toad sitting in the doorway, on the studio's bisque wall.
 */
import { C, MIX } from './palette.mjs';
import { Doc, archPath, group, place, r2, roundRect } from './doc.mjs';
import { clipped, flat, line, outline, shape } from './pen.mjs';
import { bricks, floor, wall } from './studio.mjs';
import { counter, kiln } from './kiln.mjs';
import { frogCoin } from './coins.mjs';
import { toad } from './toad.mjs';
import { shelf } from './props.mjs';
import { brushed, carved, measure } from './type.mjs';
import { VARIANTS } from './items.mjs';

/** The mark is built on a grid of 32 modules per side and keeps 2 modules of bare wall on every side. */
export const MARK_GRID = 32;
export const MARK_CLEAR = 2;
/** The kiln sits this many modules below the grid's top, so it looks centred in a round crop. */
const MARK_DROP = 0.8;
/** The X banner's bottom-left corner, where the avatar overlaps it: bare ground only. */
export const AVATAR_CORNER = Object.freeze({ x: 0, y: 270, w: 420, h: 230 });
/** The cover line, as it is lettered on the cover and the banners. The brand book quotes it in sentence case. */
export const COVER_LINE = Object.freeze(['EVERY TRADE', 'FIRES THE KILN.']);
/** The literal line that goes next to the cover line wherever it is posted. */
export const LITERAL_LINE = 'In plain words, after graduation the buyers\' share of every fee burns the frog coin, and the sellers\' share buys KILN for the toads.';

const MARK = 1024;
const M = MARK / MARK_GRID;
/** The toad of the brand pieces: the celadon glaze, plain, with its golden eyes. */
const CELADON = { ...VARIANTS[1].spec, pattern: null, eyes: 'bead', mouth: 'smile' };

/**
 * The mark in 1024 px units: a simplified kiln with big bricks, its door on fire, and the toad in the doorway. The
 * kiln is 20 modules wide so its footing's corners stay inside 95% of a round crop.
 */
function mark(d) {
  const ow = 0.5 * M;
  const left = 6 * M;
  const right = 26 * M;
  const foot = 24.2 * M;
  const spring = 14 * M;
  const dome = `M${left} ${foot}V${spring}A${10 * M} ${8.9 * M} 0 0 1 ${right} ${spring}V${foot}Z`;
  const chimney = roundRect(14 * M, 3.2 * M, 4 * M, 4.6 * M, 0.3 * M);
  const door = archPath(16 * M, foot, 9.2 * M, 10.6 * M);
  const ring = archPath(16 * M, foot, 12 * M, 12.5 * M);
  return [
    shape(chimney, C.brick, ow),
    line(`M${14 * M} ${4.7 * M}H${18 * M}`, MIX.mortar, 0.22 * M),
    shape(roundRect(13.4 * M, 2.3 * M, 5.2 * M, 1.4 * M, 0.3 * M), MIX.brickDark, ow),
    bricks(d, dome, { x: left, y: 4 * M, w: 20 * M, h: 21 * M, course: 1.8 * M, seed: 'mark' }),
    outline(dome, ow),
    shape(ring, MIX.brickLight, ow),
    shape(door, C.flame, ow),
    clipped(d, door, flat(archPath(16 * M, foot, 7 * M, 8.8 * M), C.ember), flat(archPath(16 * M, foot, 4.2 * M, 6.6 * M), MIX.fireCore)),
    outline(door, ow),
    shape(roundRect(left, foot - 0.2 * M, right - left, 1.6 * M, 0.6 * M), MIX.brickDark, ow),
    toad(d, { ...CELADON, shadow: MIX.brickDark }, { x: 16 * M - 5.8 * M, y: foot - 10.5 * M, size: 11.6 * M, ow: 0.42 * M }),
  ];
}

/** The square mark at `size` px: the wall, then the mark. */
function markSvg(size, title) {
  const d = new Doc(size, size, title,
    'A brick kiln seen from the front on a warm bisque wall, its arched door full of fire. A pale green clay toad with golden eyes sits in the doorway.');
  d.add(wall(size, size, { sweeps: false }), group(place(0, 0, { scale: size / MARK }), group(place(0, MARK_DROP * M), mark(d))));
  return d.toString();
}

export const logoSvg = () => markSvg(MARK, 'Frog Kiln logo');
export const avatarSvg = () => markSvg(400, 'Frog Kiln X avatar');

/** The bare wall behind the mark at `size`, for the clear-space and round-crop checks. */
export function markBareSvg(size) {
  const d = new Doc(size, size, 'Bare wall', 'The bisque wall alone.');
  d.add(wall(size, size, { sweeps: false }));
  return d.toString();
}

/** The name plaque: a dark glazed slab hung on two pegs, FROG KILN carved through it. Returns markup and its box. */
function plaque({ x, y, lines, cap, ow, pad = 0.75 }) {
  const m = measure(lines, cap);
  const w = m.w + 2 * pad * cap;
  const h = m.h + 1.5 * pad * cap;
  return [
    shape(roundRect(x, y, w, h, cap * 0.32), C.slab, ow),
    line(`M${r2(x + cap * 0.3)} ${r2(y + cap * 0.22)}H${r2(x + w - cap * 0.3)}`, MIX.slabLight, ow * 0.9),
    carved(lines, { x: x + w / 2, y: y + pad * cap * 0.78, cap, seed: 'name' }),
  ];
}

/** The size of a plaque, to lay out around it. */
function plaqueSize(lines, cap, pad = 0.75) {
  const m = measure(lines, cap);
  return { w: m.w + 2 * pad * cap, h: m.h + 1.5 * pad * cap };
}

/** The cover line in soot brushwork. */
function coverLine({ x, y, cap, anchor = 'start', oneLine = false }) {
  return brushed(oneLine ? [COVER_LINE.join(' ')] : [...COVER_LINE], { x, y, cap, anchor, seed: 'cover-line' });
}

/** Frog coins tumbling in an arc into the kiln door, the last one already turning to ash. */
function intoTheFire(from, to, r, ow) {
  const [fx, fy] = from;
  const [tx, ty] = to;
  const mid = [(fx + tx) / 2, Math.min(fy, ty) - r * 3.2];
  const at = (t) => [(1 - t) ** 2 * fx + 2 * (1 - t) * t * mid[0] + t ** 2 * tx, (1 - t) ** 2 * fy + 2 * (1 - t) * t * mid[1] + t ** 2 * ty];
  return [
    line(`M${r2(fx)} ${r2(fy)}Q${r2(mid[0])} ${r2(mid[1])} ${r2(tx)} ${r2(ty)}`, MIX.bisqueDark, ow * 1.4, { dash: `${r2(ow * 2.6)} ${r2(ow * 2.6)}` }),
    ...[0.08, 0.36, 0.64].map((t, i) => {
      const [x, y] = at(t);
      return frogCoin(x, y, r * (1 - i * 0.08), ow, { squash: [1, 0.7, 0.45][i], turn: [0, -20, 30][i] });
    }),
  ];
}

/** The X banner, 1500 x 500: the name and the line on the left, a shelf of toads and the firing kiln on the right. */
export function xBannerSvg() {
  const d = new Doc(1500, 500, 'Frog Kiln X banner',
    'FROG KILN carved into a dark clay plaque on a bisque wall, above the brushed line EVERY TRADE FIRES THE KILN. On the right, three clay toads sit on a shelf, and a brick kiln burns with green coins flying into its door.');
  d.add(xBannerGround());
  d.add(plaque({ x: 60, y: 44, lines: ['FROG KILN'], cap: 56, ow: 6 }));
  d.add(coverLine({ x: 66, y: 186, cap: 26 }));
  d.add(shelf({ x: 560, y: 318, w: 440, ow: 6 }));
  [VARIANTS[7], VARIANTS[1], VARIANTS[9]].forEach((v, i) => d.add(toad(d, v.spec, { x: 574 + i * 136, y: 318 - 168 * 0.905, size: 168, ow: 4.2 })));
  d.add(kiln(d, { x: 1100, y: 118, size: 324, state: 'fire', ow: 5 }));
  d.add(intoTheFire([1010, 230], [1262, 400], 22, 4));
  return d.toString();
}

/** The X banner's ground alone: the wall and the floor. */
function xBannerGround() {
  return [wall(1500, 500, { seed: 'x-banner' }), floor(1500, 500, 452, 6)];
}

/** The X banner's bare ground, for the avatar corner check. */
export function xBannerBareSvg() {
  const d = new Doc(1500, 500, 'Bare ground', 'The wall and floor alone.');
  d.add(xBannerGround());
  return d.toString();
}

/** The link cover, 1200 x 630: the name plaque and the line on the left, the firing kiln and a toad on the right. */
export function coverSvg() {
  const d = new Doc(1200, 630, 'Frog Kiln cover',
    'FROG KILN carved into a dark clay plaque on a bisque wall, above the brushed line EVERY TRADE FIRES THE KILN. On the right, a brick kiln burns with green coins tumbling into its door and smoke rising from its chimney. A pale green clay toad sits in front of it.');
  d.add(wall(1200, 630, { seed: 'cover' }), floor(1200, 630, 568, 7));
  d.add(plaque({ x: 56, y: 52, lines: ['FROG', 'KILN'], cap: 104, ow: 7 }));
  const p = plaqueSize(['FROG', 'KILN'], 104);
  d.add(coverLine({ x: 60, y: 52 + p.h + 34, cap: 40 }));
  d.add(kiln(d, { x: 760, y: 104, size: 396, state: 'fire', ow: 6 }));
  d.add(intoTheFire([560, 300], [930, 470], 30, 5));
  d.add(toad(d, { ...CELADON, shadow: MIX.woodDark }, { x: 556, y: 590 - 300 * 0.905, size: 300, ow: 6.5 }));
  d.add(counter({ x: 1032, y: 470, w: 130, ow: 4.5 }));
  return d.toString();
}

/** A standing ware rack: two posts on the floor and a plank shelf at each height in `shelves`. */
function wareRack({ x, w, top, shelves, floor: ground }, ow) {
  const post = (px) => shape(roundRect(px, top, 26, ground - top + 8, 6), MIX.woodDark, ow);
  return [
    post(x), post(x + w - 26),
    ...shelves.map((y) => [shape(roundRect(x - 14, y, w + 28, 30, 6), C.wood, ow), line(`M${x - 6} ${y + 9}H${x + w + 6}`, MIX.woodLight, 6)]),
  ];
}

/** The box page banner, 2400 x 600: the name and line on the left, all twelve toads on a two-shelf rack. */
export function boxBannerSvg() {
  const d = new Doc(2400, 600, 'Frog Kiln box banner',
    'FROG KILN carved into a dark clay plaque on a bisque wall, with the brushed line EVERY TRADE FIRES THE KILN under it. To the right, all twelve clay toads sit on two wooden shelves, six on each, from bare terracotta to the three cracked toads.');
  d.add(wall(2400, 600, { seed: 'box-banner' }), floor(2400, 600, 574, 7));
  d.add(plaque({ x: 120, y: 92, lines: ['FROG KILN'], cap: 100, ow: 7 }));
  const p = plaqueSize(['FROG KILN'], 100);
  d.add(coverLine({ x: 120 + p.w / 2, y: 92 + p.h + 42, cap: 44, anchor: 'middle', oneLine: true }));
  const rack = { x: 1040, w: 1270, top: 120, shelves: [282, 520], floor: 574 };
  d.add(wareRack(rack, 6));
  VARIANTS.forEach((v, i) => {
    const size = 214;
    const top = rack.shelves[Math.floor(i / 6)];
    d.add(toad(d, v.spec, { x: rack.x + 46 + (i % 6) * 196, y: top - size * 0.905, size, ow: 4.6 }));
  });
  return d.toString();
}

