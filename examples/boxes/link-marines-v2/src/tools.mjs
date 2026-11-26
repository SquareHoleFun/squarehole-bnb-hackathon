/**
 * What a marine holds at mess night, in the bust box: a dress-navy sleeve with a white cuff, a fist, and one piece of
 * the dinner table. Nothing here is a weapon and nothing here is food: every ration is the coin on the plate, the
 * same for every marine, so no marine holds more of it.
 */
import { C, MIX } from './palette.mjs';
import { r2, group, place, circlePath, ellipsePath, roundRect } from './doc.mjs';
import { shape, flat, line, band } from './pen.mjs';
import { coin } from './coins.mjs';

const P = (x, y) => `${r2(x)} ${r2(y)}`;

/** A sleeve rising from below the picture to (x2, y2), ending in a white cuff. */
export function sleeve(x1, y1, x2, y2, ow, width = 160, cloth = C.navy) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const [ux, uy] = [(x2 - x1) / len, (y2 - y1) / len];
  const cuff = `M${P(x2 - ux * 40, y2 - uy * 40)}L${P(x2, y2)}`;
  return band(`M${P(x1, y1)}L${P(x2 - ux * 30, y2 - uy * 30)}`, cloth, width, ow, 'butt') + band(cuff, C.white, width - 10, ow, 'butt');
}

/** A fist around a handle, centred on (x, y), turned by `turn` degrees; the handle runs up through it. */
export function fist(x, y, ow, turn = 0) {
  const body = shape(roundRect(-76, -60, 152, 120, 44), C.paper, ow);
  const fingers = [-30, 0, 30].map((dy) => line(`M${P(-76, dy)}Q${P(-26, dy + 8)} ${P(10, dy)}`, MIX.paperDot, ow * 0.8)).join('');
  const thumb = shape('M-52 -52C-26 -86 46 -80 64 -44C38 -30 -14 -30 -52 -52Z', C.paper, ow);
  return group(place(x, y, { rotate: turn }), body, fingers, thumb, flat(ellipsePath(40, 14, 26, 34), MIX.blush));
}

/** A steel spoon held upright from (x, y). */
export function spoon(x, y, ow, turn = 0) {
  const len = 230;
  const handle = band(`M0 0V${-len}`, C.steel, 22, ow, 'round');
  const bowl = shape(ellipsePath(0, -len - 64, 52, 72), C.steel, ow) + flat(ellipsePath(-16, -len - 86, 14, 26), MIX.steelLight);
  return group(place(x, y, { rotate: turn }), handle, bowl);
}

/** A fork held upright. */
export function fork(x, y, ow, turn = 0) {
  const tines = [-24, -8, 8, 24].map((dx) => `M${r2(dx)} -230V-300`).join('');
  return group(place(x, y, { rotate: turn }), band('M0 0V-200', C.steel, 20, ow), band('M-26 -200Q-26 -230 0 -232Q26 -230 26 -200', C.steel, 18, ow),
    band(tines, C.steel, 9, ow * 0.8, 'round'));
}

/** A teacup on its saucer, held up on the fist, with steam. */
export function teacup(x, y, ow, turn = 0) {
  const saucer = shape(ellipsePath(0, -66, 120, 26), C.white, ow);
  const cupD = 'M-82 -190Q-80 -96 -36 -82H36Q80 -96 82 -190Z';
  const steam = [-26, 24].map((dx, i) => line(`M${P(dx, -214)}Q${P(dx - 22, -246 - i * 6)} ${P(dx, -276)}Q${P(dx + 22, -306)} ${P(dx, -340 - i * 8)}`, C.white, 13)).join('');
  return group(place(x, y, { rotate: turn }), steam, band('M78 -170Q130 -170 130 -132Q130 -96 72 -104', C.white, 18, ow), saucer, shape(cupD, C.white, ow),
    shape(ellipsePath(0, -190, 82, 18), MIX.whiteShade, ow * 0.8), line('M-56 -150Q-50 -110 -30 -100', MIX.whiteDot, ow * 0.8));
}

/** A tin mug of cocoa with steam, held in the fist by its body. */
export function mug(x, y, ow, turn = 0) {
  const body = 'M-96 -150L-84 60Q-82 84 -58 84H58Q82 84 84 60L96 -150Z';
  const steam = [-40, 6, 50].map((dx, i) => line(`M${P(dx, -196)}Q${P(dx - 26, -236 - i * 6)} ${P(dx, -276)}Q${P(dx + 26, -316)} ${P(dx, -350 - i * 10)}`, C.white, 15)).join('');
  return group(place(x, y, { rotate: turn }), steam, band('M94 -106Q176 -106 176 -34Q176 32 86 28', C.steel, 22, ow),
    shape(body, C.steel, ow), shape(ellipsePath(0, -150, 96, 22), MIX.crateDark, ow), flat('M-70 -116L-60 30Q-58 48 -42 48Q-48 6 -52 -116Z', MIX.steelLight));
}

/** A small steel hand bell: the handle up through the fist, the bell hanging below it, ringing. */
export function handBell(x, y, ow, turn = 0) {
  const bell = 'M-30 60C-34 110 -60 150 -96 176H96C60 150 34 110 30 60Z';
  const marks = line('M-120 150Q-140 176 -126 204M-150 132Q-178 172 -158 214M120 150Q140 176 126 204M150 132Q178 172 158 214', C.ink, ow * 0.8);
  return group(place(x, y, { rotate: turn }), band('M0 -90V60', C.crate, 30, ow), shape(ellipsePath(0, -100, 30, 22), C.crate, ow),
    shape(bell, C.steel, ow), shape(ellipsePath(0, 178, 96, 16), MIX.steelDark, ow), shape(circlePath(0, 196, 16), MIX.steelDark, ow * 0.8),
    flat('M-12 70C-16 110 -34 142 -60 164H-36C-16 140 -4 106 -2 70Z', MIX.steelLight), marks);
}

/** A white salt shaker with a steel cap, held in the fist. */
export function saltShaker(x, y, ow, turn = 0) {
  const body = roundRect(-46, -210, 92, 250, 30);
  const capD = 'M-44 -206Q-44 -276 0 -276Q44 -276 44 -206Z';
  const holes = [[-14, -240], [10, -248], [0, -226], [20, -228], [-22, -222]].map(([hx, hy]) => flat(circlePath(hx, hy, 4.5), C.ink)).join('');
  return group(place(x, y, { rotate: turn }), shape(body, C.white, ow), flat('M-30 -190V10', MIX.glint), shape(capD, C.steel, ow), holes);
}

/** A tall wooden pepper mill with a steel knob, held in the fist. */
export function pepperMill(x, y, ow, turn = 0) {
  const body = 'M-40 50C-58 -40 -26 -120 -40 -210C-44 -250 44 -250 40 -210C26 -120 58 -40 40 50Z';
  return group(place(x, y, { rotate: turn }), shape(body, C.crate, ow), line('M-18 -190C-6 -120 -30 -40 -16 30', MIX.crateLight, ow),
    shape(roundRect(-46, -262, 92, 34, 12), MIX.crateDark, ow), shape(circlePath(0, -282, 18), C.steel, ow * 0.8));
}

/** A folded menu card held up, with lines of print and a small rule. */
export function menuCard(x, y, ow, turn = 0) {
  const card = 'M-120 -40L-112 -330H112L120 -40Z';
  const print = [-280, -246, -212, -178, -144].map((ly, i) => `M${P(-70 + (i % 2) * 14, ly)}H${r2(70 - (i % 2) * 14)}`).join('');
  return group(place(x, y, { rotate: turn }), shape(card, C.paper, ow), line(print, MIX.paperDot, 12, { cap: 'butt' }),
    line('M-40 -100H40', C.ink, ow * 0.8), flat(circlePath(0, -306, 9), C.gold));
}

/** A water glass on a stem, raised for a toast, with a glint. */
export function waterGlass(x, y, ow, turn = 0) {
  const bowl = 'M-70 -330Q-78 -210 0 -186Q78 -210 70 -330Z';
  const water = 'M-66 -280Q-70 -214 0 -196Q70 -214 66 -280Z';
  // The water is drawn inside the bowl's own outline, so it needs no clip.
  return group(place(x, y, { rotate: turn }), band('M0 -190V30', MIX.steelLight, 18, ow), shape(bowl, MIX.steelLight, ow),
    flat(water, MIX.sageLight), shape(bowl, 'none', ow), line('M-44 -312Q-50 -250 -30 -214', MIX.glint, ow * 1.2),
    shape(ellipsePath(0, 40, 66, 16), MIX.steelLight, ow * 0.8));
}

/** A steel teapot held by its handle, its spout to the left. */
export function teapot(x, y, ow, turn = 0) {
  const pot = 'M-130 -100C-150 -20 -100 40 0 40C100 40 150 -20 130 -100C120 -160 -120 -160 -130 -100Z';
  const spout = 'M-120 -60C-170 -70 -200 -110 -226 -160L-204 -170C-186 -136 -160 -112 -126 -104Z';
  return group(place(x, y, { rotate: turn }), band('M60 -20C120 -20 160 -60 150 -120', C.steel, 24, ow), shape(spout, C.steel, ow), shape(pot, C.steel, ow),
    shape(ellipsePath(0, -132, 70, 16), MIX.steelDark, ow), shape(circlePath(0, -160, 18), MIX.steelDark, ow * 0.8),
    flat('M-96 -90C-104 -40 -80 -4 -40 8C-70 -16 -80 -50 -76 -92Z', MIX.steelLight));
}

/** A steel water jug held by its handle. */
export function jug(x, y, ow, turn = 0) {
  const body = 'M-150 -260L-120 -260C-110 -140 -96 -20 -110 40H110C96 -20 110 -140 120 -260L150 -260Q150 -296 110 -296H-110Q-150 -296 -150 -260Z';
  return group(place(x, y, { rotate: turn }), band('M112 -220C190 -210 190 -40 104 -40', C.steel, 24, ow), shape(body, C.steel, ow),
    shape('M-150 -260L-196 -300L-110 -296Z', C.steel, ow), flat('M-90 -240C-86 -150 -80 -60 -86 10H-60C-58 -60 -62 -150 -66 -240Z', MIX.steelLight));
}

/** A ladle carrying one gold coin: the cook serving one ration. */
export function ladle(x, y, ow, turn = 0) {
  const handle = band('M0 0V-330', C.steel, 26, ow, 'round');
  const bowl = 'M-120 -370Q-120 -270 0 -270Q120 -270 120 -370Z';
  return group(place(x, y, { rotate: turn }), handle, coin(0, -386, 44, ow * 0.8), shape(bowl, C.steel, ow), flat('M-94 -358Q-88 -296 -14 -290Q-80 -306 -82 -360Z', MIX.steelLight));
}

/** Every held thing by name, each placed by the marine. */
export const TOOLS = Object.freeze({ spoon, fork, teacup, mug, handBell, saltShaker, pepperMill, menuCard, waterGlass, teapot, jug, ladle });
