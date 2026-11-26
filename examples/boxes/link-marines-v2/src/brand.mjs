/**
 * The brand pieces: the mark (logo and X avatar), the X banner, the link cover and the box page banner, plus the bare
 * walls check.mjs compares them with. The mark is a round khaki patch with a stitched edge, holding the Private in a
 * white peaked cap, on the walnut panelled wall of the mess hall.
 */
import { C, MIX } from './palette.mjs';
import { Doc, group, place, circlePath, r2 } from './doc.mjs';
import { shape, line, halftone, clipped } from './pen.mjs';
import { ground } from './poster.mjs';
import { marine } from './marine.mjs';
import { ration } from './coins.mjs';
import { cloth, candle } from './props.mjs';
import { lettering } from './type.mjs';
import { VARIANTS } from './items.mjs';

/** The mark is built on a grid of 32 modules per side and keeps 2 modules of bare wall on every side. */
export const MARK_GRID = 32;
export const MARK_CLEAR = 2;
/** The X banner's bottom-left corner, where the avatar overlaps it: bare wall only. */
export const AVATAR_CORNER = Object.freeze({ x: 0, y: 270, w: 420, h: 230 });
/** The cover line, as it is lettered on the cover and the banners. The brand book quotes it in sentence case. */
export const COVER_LINE = Object.freeze(['THE SAME RATION', 'FOR ALL 420.']);
/** The gaps between the box banner's twelve plates that hold a candle: seven, the kit's one quiet seven. */
const CANDLE_GAPS = Object.freeze([0, 2, 4, 5, 6, 8, 10]);
export const BANNER_CANDLES = CANDLE_GAPS.length;

const MARK = 1024;
const M = MARK / MARK_GRID;
/** The patch: its center, its radius (13 modules) and its outline. */
const PATCH = Object.freeze({ cx: MARK / 2, cy: MARK / 2, r: 13 * M, ow: 0.62 * M });
const seated = (spec) => ({ ...spec, hold: undefined });

/** The wall behind the mark, at 1024 px and scaled to `size`. */
function markWall(d, size) {
  return group(place(0, 0, { scale: size / MARK }), ground(d, { w: MARK, h: MARK, wall: 'walnut', panel: 224 }));
}

/** The mark itself in 1024 px units: the patch, the marine clipped to it, the patch's rim and its stitches. */
function mark(d) {
  const { cx, cy, r, ow } = PATCH;
  const disc = circlePath(cx, cy, r);
  const bust = marine(d, seated(VARIANTS[0].spec), { x: cx - 0.86 * 500, y: 196 - 0.86 * 205, size: 860, ow: 14 });
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
    'A round khaki patch with a stitched edge on a walnut panelled wall. Inside it, a young marine in a white peaked cap with a plain gold coin as its badge grins under the visor, in a dress-navy jacket with a bow tie.');
  d.add(markWall(d, size), group(place(0, 0, { scale: size / MARK }), mark(d)));
  return d.toString();
}

export const logoSvg = () => markSvg(MARK, 'Link Marines, version 2, logo');
export const avatarSvg = () => markSvg(400, 'Link Marines, version 2, X avatar');

/** The bare wall behind the mark at `size`, for the clear-space and round-crop checks. */
export function markBareSvg(size) {
  const d = new Doc(size, size, 'Bare wall', 'The walnut panelled wall alone.');
  d.add(markWall(d, size));
  return d.toString();
}

/** The cover line in stencil letters, coin gold with an ink print shadow. */
function coverLine(d, { x, y, cap, anchor = 'start', oneLine = false }) {
  const lines = oneLine ? [COVER_LINE.join(' ')] : [...COVER_LINE];
  return lettering(d, lines, { x, y, cap, color: C.gold, shadow: C.ink, anchor });
}

/** The box's name in big stencil letters, cap white with an orange print shadow. */
function title(d, lines, { x, y, cap, anchor = 'start' }) {
  return lettering(d, lines, { x, y, cap, color: C.white, shadow: C.orange, anchor, depth: 1.1, name: true });
}

/** The X banner, 1500 x 500: the name and the line at the top left, two marines at the table on the right. */
export function xBannerSvg() {
  const d = new Doc(1500, 500, 'Link Marines, version 2, X banner',
    'LINK MARINES in big stencil letters on a walnut panelled wall, above the line THE SAME RATION FOR ALL 420. On the right, two marines in white caps sit at a table with a white cloth, each with a plate holding one gold coin, and a candle between them.');
  d.add(ground(d, { w: 1500, h: 500, wall: 'walnut', panel: 160 }));
  d.add(title(d, ['LINK MARINES'], { x: 64, y: 64, cap: 92 }));
  d.add(coverLine(d, { x: 64, y: 196, cap: 40, oneLine: true }));
  d.add(marine(d, seated(VARIANTS[2].spec), { x: 860, y: 40, size: 370, ow: 6 }));
  d.add(marine(d, seated(VARIANTS[11].spec), { x: 1140, y: 40, size: 370, ow: 6 }));
  d.add(cloth(d, { x: 840, y: 392, w: 700, h: 140, ow: 6 }));
  d.add(candle(d, { cx: 1185, y: 416, h: 120, ow: 6 }));
  d.add(ration(d, 1045, 418, 120, 5), ration(d, 1325, 418, 120, 5));
  return d.toString();
}

/** The bare walnut wall of the X banner, for the avatar corner check. */
export function xBannerBareSvg() {
  const d = new Doc(1500, 500, 'Bare wall', 'The walnut panelled wall alone.');
  d.add(ground(d, { w: 1500, h: 500, wall: 'walnut', panel: 160 }));
  return d.toString();
}

/** The link cover, 1200 x 630: the name and the line on the left, the Private at the table on the right. */
export function coverSvg() {
  const d = new Doc(1200, 630, 'Link Marines, version 2, cover',
    'LINK MARINES in big stencil letters on a walnut panelled wall, above the line THE SAME RATION FOR ALL 420. On the right, a young marine in a white peaked cap and a dress-navy jacket sits at a table with a white cloth, behind a plate with one gold coin, next to a candle.');
  d.add(ground(d, { w: 1200, h: 630, wall: 'walnut', panel: 168 }));
  d.add(title(d, ['LINK', 'MARINES'], { x: 70, y: 80, cap: 118 }));
  d.add(coverLine(d, { x: 70, y: 418, cap: 50 }));
  d.add(marine(d, seated(VARIANTS[0].spec), { x: 660, y: 70, size: 520, ow: 8 }));
  d.add(cloth(d, { x: 620, y: 520, w: 620, h: 140, ow: 8 }));
  d.add(candle(d, { cx: 1124, y: 548, h: 150, ow: 7 }));
  d.add(ration(d, 920, 548, 190, 7));
  return d.toString();
}

/** The box page banner, 2400 x 600: the whole squad of twelve ranks at one long table with seven candles. */
export function boxBannerSvg() {
  const d = new Doc(2400, 600, 'Link Marines, version 2, box banner',
    'LINK MARINES in big stencil letters on a walnut panelled wall, above the line THE SAME RATION FOR ALL 420. Below, all twelve ranks from Private to General sit side by side at one long table with a white cloth, each behind the same plate with one gold coin, with seven candles along the table.');
  d.add(ground(d, { w: 2400, h: 600, wall: 'walnut', panel: 160 }));
  d.add(title(d, ['LINK MARINES'], { x: 1200, y: 48, cap: 96, anchor: 'middle' }));
  d.add(coverLine(d, { x: 1200, y: 186, cap: 40, anchor: 'middle', oneLine: true }));
  const size = 236;
  const step = 196;
  const left = (2400 - step * 11 - size) / 2;
  VARIANTS.forEach((v, i) => d.add(marine(d, seated(v.spec), { x: left + i * step, y: 270, size, ow: 5 })));
  d.add(cloth(d, { x: -20, y: 512, w: 2440, h: 120, ow: 6 }));
  VARIANTS.forEach((_, i) => d.add(ration(d, left + i * step + size / 2, 540, 80, 4)));
  // Seven of the eleven gaps between the plates hold a candle, the same on both sides of the middle one.
  for (const gap of CANDLE_GAPS) d.add(candle(d, { cx: left + size / 2 + (gap + 0.5) * step, y: 534, h: 64, ow: 4 }));
  return d.toString();
}
