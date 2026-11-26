/**
 * Brand pieces: the logo and X avatar (one mark), the X banner, the link cover and the wide box banner.
 */
import { C } from './palette.mjs';
import { Doc, rect } from './doc.mjs';
import { room, brickedDoor, tinyDoor } from './room.mjs';
import { sign, signs } from './sign.mjs';
import { label } from './props.mjs';

/** Module of the mark: one cell of the heavy 404, 44 px on the 1024 px logo. */
export const MARK_MODULE = 44 / 1024;

/**
 * The mark: a green light box reading 404, hung from a bar, on hallway ink.
 * Built on the module m. Housing 16.4 x 9.4 m. Clear space is 2 m on every side (included in the square).
 */
function mark(d, size) {
  const m = size * MARK_MODULE;
  const cx = size / 2;
  const cy = size * 0.535;
  const s = sign(d, { cx, cy, lines: ['404'], m, style: 'box', color: 'green', heavy: true, glow: 0.42 });
  const barY = s.box.y - 2.6 * m;
  const xs = [s.box.x + s.box.w * 0.22, s.box.x + s.box.w * 0.78];
  const hanger = rect(xs[0] - 0.9 * m, barY, xs[1] - xs[0] + 1.8 * m, 0.5 * m, `rx="${0.25 * m}" fill="${C.rim}"`)
    + xs.map((x) => rect(x - 0.18 * m, barY, 0.36 * m, s.box.y - barY + 0.2 * m, `fill="${C.rim}"`)).join('');
  return rect(0, 0, size, size, `fill="${C.ink}"`) + s.halo + hanger + s.markup;
}

export function logoSvg(size = 1024) {
  const d = new Doc(size, size, 'Exit Liquidity logo', 'A green light-box sign reading 404 in heavy pixel numerals, hanging from a bar on a dark ground.');
  return d.add(mark(d, size)).toString();
}

export function avatarSvg() {
  const d = new Doc(400, 400, 'Exit Liquidity X avatar', 'The Exit Liquidity mark: a green light-box sign reading 404 on a dark ground, sized for a round crop.');
  return d.add(mark(d, 400)).toString();
}

const nameSign = (cx, cy, m, ceilingY) => ({ cx, cy, lines: ['EXIT', 'LIQUIDITY'], m, style: 'led', color: 'green', mount: 'rods', ceilingY });

/** 1500 x 500. The lower left (x below 420, y below 270) stays plain wall for the avatar overlap. */
export function xBannerSvg() {
  const [W, H, CEIL, FLOOR] = [1500, 500, 44, 440];
  const d = new Doc(W, H, 'Exit Liquidity X banner', 'A dark hallway. A green LED sign reads EXIT LIQUIDITY, with a small 404 sign on the left and an amber question mark sign on the right.');
  d.add(room(d, { w: W, h: H, ceilingY: CEIL, floorY: FLOOR, seams: 10, calmX: 420 }));
  d.add(signs(d, [
    nameSign(960, 236, 12, CEIL),
    { cx: 230, cy: 150, lines: ['404'], m: 12, style: 'box', color: 'green', heavy: true, mount: 'rods', ceilingY: CEIL, glow: 0.2 },
    { cx: 1372, cy: 172, lines: ['?'], m: 12, style: 'box', color: 'amber', mount: 'rods', ceilingY: CEIL, glow: 0.24 },
  ]).markup);
  d.add(tinyDoor({ cx: 1372, floorY: FLOOR, w: 40 }));
  return d.toString();
}

/** 1200 x 630 link card. */
export function coverSvg() {
  const [W, H, CEIL, FLOOR] = [1200, 630, 56, 566];
  const d = new Doc(W, H, 'Exit Liquidity cover', 'A green LED sign reads EXIT LIQUIDITY in a dark hallway. Below it: 404 signs. Exit not found.');
  d.add(room(d, { w: W, h: H, ceilingY: CEIL, floorY: FLOOR, seams: 8 }));
  d.add(signs(d, [
    nameSign(600, 282, 15, CEIL),
    { cx: 100, cy: 200, lines: ['404'], m: 7, style: 'box', color: 'green', heavy: true, mount: 'rods', ceilingY: CEIL, glow: 0.2 },
    { cx: 1100, cy: 216, lines: ['?'], m: 9, style: 'box', color: 'amber', mount: 'rods', ceilingY: CEIL, glow: 0.22 },
  ]).markup);
  d.add(label('404 SIGNS. EXIT NOT FOUND.', { x: 600, y: 488, m: 5, color: C.mint }));
  return d.toString();
}

/** 2400 x 600 box-page banner: the name sign with six smaller signs along the hallway. */
export function boxBannerSvg() {
  const [W, H, CEIL, FLOOR] = [2400, 600, 52, 548];
  const d = new Doc(W, H, 'Exit Liquidity box banner', 'A long dark hallway. A green LED sign reads EXIT LIQUIDITY in the middle, with signs saying NO EXIT, NOT FOUND, 404, EXIT?, TRY AGAIN and ERROR on either side.');
  d.add(room(d, { w: W, h: H, ceilingY: CEIL, floorY: FLOOR, seams: 16 }));
  const small = (cx, cy, lines, m, style, color, extra = {}) => ({ cx, cy, lines, m, style, color, mount: 'rods', ceilingY: CEIL, glow: 0.24, ...extra });
  d.add(signs(d, [
    nameSign(1200, 270, 14, CEIL),
    small(180, 236, ['NO EXIT'], 7, 'box', 'red'),
    small(470, 300, ['NOT', 'FOUND'], 6, 'led', 'red'),
    small(690, 226, ['404'], 8, 'box', 'green', { heavy: true }),
    small(1720, 226, ['EXIT?'], 6, 'led', 'green'),
    small(1960, 300, ['TRY', 'AGAIN'], 6, 'box', 'amber'),
    small(2232, 240, ['ERROR'], 6, 'led', 'red', { mount: 'chain', tilt: 8 }),
  ]).markup);
  d.add(brickedDoor(d, { cx: 180, floorY: FLOOR, w: 120, h: 170 }), tinyDoor({ cx: 2232, floorY: FLOOR, w: 40 }));
  return d.toString();
}
