/**
 * Mess kit and tools a marine can hold, in the bust box: a sleeve with a fist at its end, and the spoon, ladle,
 * bugle, cup, fork, wrench and field glasses. Nothing here is a weapon. The marines carry cutlery and tools.
 */
import { C, MIX } from './palette.mjs';
import { r2, group, place, ellipsePath, roundRect } from './doc.mjs';
import { shape, flat, line, band, halftone, clipped } from './pen.mjs';
import { coin } from './coins.mjs';

const P = (x, y) => `${r2(x)} ${r2(y)}`;

/** A sleeve rising from below the picture to (x, y), ending in a cuff. */
export function sleeve(x1, y1, x2, y2, ow, width = 160) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const [ux, uy] = [(x2 - x1) / len, (y2 - y1) / len];
  const cuff = `M${P(x2 - ux * 40, y2 - uy * 40)}L${P(x2, y2)}`;
  return band(`M${P(x1, y1)}L${P(x2 - ux * 30, y2 - uy * 30)}`, C.olive, width, ow, 'butt') + band(cuff, MIX.oliveDeep, width + 6, ow, 'butt');
}

/** A fist around a handle, centred on (x, y), turned by `turn` degrees; the handle runs up through it. */
export function fist(x, y, ow, turn = 0) {
  const body = shape(roundRect(-76, -60, 152, 120, 44), C.paper, ow);
  const fingers = [-30, 0, 30].map((dy) => line(`M${P(-76, dy)}Q${P(-26, dy + 8)} ${P(10, dy)}`, MIX.paperDot, ow * 0.8)).join('');
  const thumb = shape('M-52 -52C-26 -86 46 -80 64 -44C38 -30 -14 -30 -52 -52Z', C.paper, ow);
  return group(place(x, y, { rotate: turn }), body, fingers, thumb, flat(ellipsePath(40, 14, 26, 34), MIX.blush));
}

/** A steel spoon held upright from (x, y), turned by `turn` degrees, with a coin in its bowl unless `empty`. */
export function spoon(x, y, ow, turn = 0, empty = false) {
  const len = 230;
  const handle = band(`M0 0V${-len}`, C.steel, 22, ow, 'round');
  const bowl = shape(ellipsePath(0, -len - 64, 52, 72), C.steel, ow) + flat(ellipsePath(-16, -len - 86, 14, 26), MIX.steelLight);
  return group(place(x, y, { rotate: turn }), handle, bowl, empty ? '' : coin(4, -len - 58, 38, ow * 0.8));
}

/** A ladle with a deep bowl full of coins. */
export function ladle(x, y, ow, turn = 0) {
  const handle = band('M0 0V-330', C.steel, 26, ow, 'round');
  const bowl = 'M-120 -370Q-120 -270 0 -270Q120 -270 120 -370Z';
  const coins = [[-62, -392], [0, -408], [62, -392], [-30, -366], [32, -368]].map(([cx, cy]) => coin(cx, cy, 40, ow * 0.7)).join('');
  return group(place(x, y, { rotate: turn }), handle, coins, shape(bowl, C.steel, ow), flat('M-94 -358Q-88 -296 -14 -290Q-80 -306 -82 -360Z', MIX.steelLight));
}

/** A bugle held to the mouth at (x, y), pointing right, sounding chow call, with a coin flying out of its bell. */
export function bugle(x, y, ow) {
  const tube = 'M0 0H196Q252 0 252 48Q252 96 196 96H108Q62 96 62 60Q62 26 108 26H240';
  const bell = 'M236 -34C268 -8 300 -6 336 -38V88C300 56 268 58 236 84Z';
  const notes = line('M364 -30Q384 -44 404 -30M370 14H410M364 58Q384 72 404 58', C.paper, 9);
  return group(place(x, y), band(tube, C.steel, 22, ow), shape(bell, C.steel, ow), shape(ellipsePath(336, 25, 20, 62), MIX.steelDark, ow),
    shape(roundRect(-24, -15, 36, 30, 8), MIX.steelDark, ow), line('M120 0V26M170 0V26', MIX.steelDark, ow * 1.4),
    notes, line('M250 -70L282 -98M286 -52L322 -66', C.paper, 8), coin(310, -140, 42, ow * 0.8));
}

/** A tin cup with a handle, a coin peeking over its rim and steam rising. */
export function cup(x, y, ow) {
  const body = 'M-96 -130L-80 70Q-78 94 -54 94H54Q78 94 80 70L96 -130Z';
  const steam = [-40, 6, 50].map((dx, i) => line(`M${P(dx, -176)}Q${P(dx - 26, -216 - i * 6)} ${P(dx, -256)}Q${P(dx + 26, -296)} ${P(dx, -330 - i * 10)}`, C.paper, 15)).join('');
  return group(place(x, y), steam, band('M94 -86Q176 -86 176 -14Q176 52 86 48', C.steel, 22, ow), coin(-14, -136, 52, ow * 0.8),
    shape(body, C.steel, ow), shape(ellipsePath(0, -130, 96, 22), MIX.steelDark, ow), flat('M-70 -96L-60 50Q-58 68 -42 68Q-48 26 -52 -96Z', MIX.steelLight));
}

/** A fork held upright, turned by `turn` degrees, with a coin on its tines unless `empty`. */
export function fork(x, y, ow, turn = 0, empty = false) {
  const tines = [-24, -8, 8, 24].map((dx) => `M${r2(dx)} -230V-300`).join('');
  return group(place(x, y, { rotate: turn }), band('M0 0V-200', C.steel, 20, ow), band('M-26 -200Q-26 -230 0 -232Q26 -230 26 -200', C.steel, 18, ow),
    band(tines, C.steel, 9, ow * 0.8, 'round'), empty ? '' : coin(0, -262, 44, ow * 0.8));
}

/** An open-ended wrench, held by its handle. */
export function wrench(x, y, ow, turn = 0) {
  const head = 'M-56 -330C-70 -280 -40 -238 0 -236C40 -238 70 -280 56 -330L28 -330L22 -292H-22L-28 -330Z';
  return group(place(x, y, { rotate: turn }), band('M0 20V-240', C.steel, 40, ow, 'round'), shape(head, C.steel, ow), flat('M-40 -310C-46 -280 -28 -258 -6 -254C-30 -264 -36 -286 -30 -310Z', MIX.steelLight));
}

/** Field glasses hanging on the chest from a strap around the neck. */
export function glasses(doc, cx, y, ow) {
  const strap = line(`M${P(cx - 70, 760)}Q${P(cx - 110, y - 40)} ${P(cx - 80, y - 20)}M${P(cx + 70, 760)}Q${P(cx + 110, y - 40)} ${P(cx + 80, y - 20)}`, C.ink, 10);
  const barrel = (x) => shape(roundRect(x - 44, y - 50, 88, 120, 26), C.ink, ow) + shape(ellipsePath(x, y + 66, 40, 18), C.steel, ow * 0.8)
    + flat(roundRect(x - 30, y - 38, 14, 70, 7), MIX.oliveDeep);
  return strap + barrel(cx - 54) + barrel(cx + 54) + shape(roundRect(cx - 18, y - 30, 36, 50, 10), C.steel, ow * 0.8)
    + clipped(doc, roundRect(cx - 98, y - 50, 196, 120, 26), halftone(doc, ellipsePath(cx + 90, y + 20, 60, 80), MIX.steelDark, 10));
}

/** Every held thing by name, each placed by the marine. */
export const TOOLS = Object.freeze({ spoon, ladle, bugle, cup, fork, wrench });
