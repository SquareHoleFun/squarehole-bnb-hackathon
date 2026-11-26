/**
 * The brand pieces: the mark (logo and X avatar), the X banner, the link cover and the box page banner, plus the bare
 * walls check.mjs compares them with. The mark is a round canvas patch with a stitched edge, holding the helmeted
 * marine biting a coin, on the olive tile wall.
 */
import { C, MIX } from './palette.mjs';
import { Doc, group, place, circlePath, r2 } from './doc.mjs';
import { shape, line, halftone, clipped } from './pen.mjs';
import { ground } from './poster.mjs';
import { marine } from './marine.mjs';
import { bitten, coin } from './coins.mjs';
import { table, coinHeap } from './props.mjs';
import { lettering } from './type.mjs';
import { VARIANTS } from './items.mjs';

/** The mark is built on a grid of 32 modules per side and keeps 2 modules of bare wall on every side. */
export const MARK_GRID = 32;
export const MARK_CLEAR = 2;
/** The X banner's bottom-left corner, where the avatar overlaps it: bare wall only. */
export const AVATAR_CORNER = Object.freeze({ x: 0, y: 270, w: 420, h: 230 });
/** The cover line, as it is lettered on the cover and the banners. The brand book quotes it in sentence case. */
export const COVER_LINE = Object.freeze(['420 MARINES', 'EAT THE FEES.']);

const MARK = 1024;
const M = MARK / MARK_GRID;
/** The patch: its center, its radius (13 modules) and its outline. */
const PATCH = Object.freeze({ cx: MARK / 2, cy: MARK / 2, r: 13 * M, ow: 0.62 * M });

/** The wall behind the mark, at 1024 px and scaled to `size`. */
function markWall(d, size) {
  return group(place(0, 0, { scale: size / MARK }), ground(d, { w: MARK, h: MARK, wall: 'olive', tile: 128 }));
}

/** The mark itself in 1024 px units: the patch, the marine clipped to it, the patch's rim and its stitches. */
function mark(d) {
  const { cx, cy, r, ow } = PATCH;
  const disc = circlePath(cx, cy, r);
  const bust = marine(d, VARIANTS[0].spec, { x: cx - 0.89 * 500, y: 150 - 0.89 * 155, size: 890, ow: 14 });
  const shade = halftone(d, `M${r2(cx + r * 0.3)} ${r2(cy - r)}H${r2(cx + r)}V${r2(cy + r)}H${r2(cx + r * 0.3)}Z`, MIX.khakiDark, 18, 3.6);
  return [
    shape(disc, C.khaki, ow), clipped(d, disc, shade, bust),
    line(circlePath(cx, cy, r - 1.1 * M), MIX.khakiDark, 0.22 * M, { cap: 'butt', dash: `${r2(0.7 * M)} ${r2(0.45 * M)}` }),
    shape(disc, 'none', ow),
  ];
}

/** The square mark at `size` px: the wall, then the patch. */
function markSvg(size, title) {
  const d = new Doc(size, size, title,
    'A round khaki patch with a stitched edge on an olive tile wall. Inside it, a marine in a steel helmet pulled down over the eyes bites a gold coin.');
  d.add(markWall(d, size), group(place(0, 0, { scale: size / MARK }), mark(d)));
  return d.toString();
}

export const logoSvg = () => markSvg(MARK, 'Link Marines logo');
export const avatarSvg = () => markSvg(400, 'Link Marines X avatar');

/** The bare wall behind the mark at `size`, for the clear-space and round-crop checks. */
export function markBareSvg(size) {
  const d = new Doc(size, size, 'Bare wall', 'The olive tile wall alone.');
  d.add(markWall(d, size));
  return d.toString();
}

/** The cover line in stencil letters, paper with an orange print shadow. */
function coverLine(d, { x, y, cap, anchor = 'start', oneLine = false }) {
  const lines = oneLine ? [COVER_LINE.join(' ')] : [...COVER_LINE];
  return lettering(d, lines, { x, y, cap, color: C.paper, shadow: C.orange, anchor });
}

/** The box's name in big stencil letters, paper with an orange print shadow. */
function title(d, lines, { x, y, cap, anchor = 'start' }) {
  return lettering(d, lines, { x, y, cap, color: C.paper, shadow: C.orange, anchor, depth: 1.1, name: true });
}

/** The X banner, 1500 x 500: the name and the line at the top left, two marines eating at the table on the right. */
export function xBannerSvg() {
  const d = new Doc(1500, 500, 'Link Marines X banner',
    'LINK MARINES in big stencil letters on an olive tile wall, above the line 420 MARINES EAT THE FEES. On the right, two marines at a mess table bite gold coins, with a small heap of coins between them.');
  d.add(ground(d, { w: 1500, h: 500, wall: 'olive', tile: 100 }));
  d.add(title(d, ['LINK MARINES'], { x: 64, y: 64, cap: 92 }));
  d.add(coverLine(d, { x: 64, y: 196, cap: 40, oneLine: true }));
  d.add(marine(d, VARIANTS[6].spec, { x: 880, y: 70, size: 370, ow: 6 }));
  d.add(marine(d, VARIANTS[4].spec, { x: 1150, y: 70, size: 370, ow: 6 }));
  d.add(table(d, { x: 860, y: 404, w: 680, ow: 6, to: 520 }));
  d.add(coinHeap(1196, 408, 120, 6, 18, 4.5));
  return d.toString();
}

/** The bare olive wall of the X banner, for the avatar corner check. */
export function xBannerBareSvg() {
  const d = new Doc(1500, 500, 'Bare wall', 'The olive tile wall alone.');
  d.add(ground(d, { w: 1500, h: 500, wall: 'olive', tile: 100 }));
  return d.toString();
}

/** The link cover, 1200 x 630: the name and the line on the left, a marine biting a coin at the table on the right. */
export function coverSvg() {
  const d = new Doc(1200, 630, 'Link Marines cover',
    'LINK MARINES in big stencil letters on an olive tile wall, above the line 420 MARINES EAT THE FEES. On the right, a marine in a steel helmet sits at a mess table and bites a gold coin, with two bitten coins on the table.');
  d.add(ground(d, { w: 1200, h: 630, wall: 'olive', tile: 105 }));
  d.add(title(d, ['LINK', 'MARINES'], { x: 70, y: 80, cap: 118 }));
  d.add(coverLine(d, { x: 70, y: 418, cap: 50 }));
  d.add(marine(d, VARIANTS[0].spec, { x: 650, y: 96, size: 540, ow: 8 }));
  d.add(table(d, { x: 600, y: 540, w: 640, ow: 8, to: 700 }));
  d.add(bitten(d, 700, 520, 34, 6, 200), bitten(d, 1120, 524, 30, 6, -60), coin(1060, 528, 26, 6));
  return d.toString();
}

/** The box page banner, 2400 x 600: the whole squad of twelve at one long mess table, under the name and the line. */
export function boxBannerSvg() {
  const d = new Doc(2400, 600, 'Link Marines box banner',
    'LINK MARINES in big stencil letters on an olive tile wall, above the line 420 MARINES EAT THE FEES. Below, all twelve kinds of marine sit side by side at one long mess table, each with a gold coin.');
  d.add(ground(d, { w: 2400, h: 600, wall: 'olive', tile: 100 }));
  d.add(title(d, ['LINK MARINES'], { x: 1200, y: 56, cap: 96, anchor: 'middle' }));
  d.add(coverLine(d, { x: 1200, y: 194, cap: 40, anchor: 'middle', oneLine: true }));
  const size = 240;
  const step = 196;
  const left = (2400 - step * 11 - size) / 2;
  VARIANTS.forEach((v, i) => d.add(marine(d, v.spec, { x: left + i * step, y: 290, size, ow: 5 })));
  d.add(table(d, { x: -20, y: 516, w: 2440, ow: 6, legs: false }));
  return d.toString();
}
