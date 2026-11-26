/**
 * Brand pieces: the logo and X avatar (one mark), the X banner, the link cover and the wide box banner. Each also has
 * a bare version, the same ground with nothing on it, which check.mjs compares with the piece to prove the clear
 * space, the round crop and the calm avatar corner.
 */
import { C } from './palette.mjs';
import { Doc, rect } from './doc.mjs';
import { sky, floor, frame, glints, warmth } from './lair.mjs';
import { coin } from './coins.mjs';
import { token } from './scales.mjs';
import { hoard } from './hoard.mjs';
import { label, gilt, brazier, arrow, sparks } from './props.mjs';

/** The mark is built on a grid of 32 modules. */
export const MARK_GRID = 32;
/** Where the mark sits on its grid: the pile's centre and base, and its width, in modules. */
export const MARK = Object.freeze({ cx: 14.4, base: 23.6, w: 17.6 });
/** The cover line. Pages show the literal line next to it (brand-book.md). */
export const COVER_LINE = Object.freeze(['BUYERS FEED THE PILE.', 'SELLERS FEED THE FIRE.']);

/** The mark's ground: night, with a warm glow where the pile sits. */
function markGround(d, size) {
  const m = size / MARK_GRID;
  return rect(0, 0, size, size, `fill="${C.night}"`) + warmth(d, 16 * m, 19 * m, 15 * m, 12 * m, 0.3);
}

/**
 * The mark: the hoard, a pile of coins with the dragon's scaly tail sweeping around it, under a few gold glints.
 * Clear space is 2 modules on every side, and the whole mark sits inside 95% of a round crop.
 */
function mark(d, size) {
  const m = size / MARK_GRID;
  return markGround(d, size)
    + glints({ x: 5 * m, y: 3.5 * m, w: 22 * m, h: 7 * m, count: 12, seed: 11, rMin: 0.25 * m, rMax: 0.8 * m })
    + hoard(d, { cx: MARK.cx * m, base: MARK.base * m, w: MARK.w * m, seed: 5 });
}

export function logoSvg(size = 1024) {
  const d = new Doc(size, size, "Dragon's Hoard logo", 'A pile of gold coins on a dark blue ground, with a green scaly dragon tail sweeping out from behind it and curling around its front to a spade tip. A few gold glints shine above.');
  return d.add(mark(d, size)).toString();
}

export function avatarSvg() {
  const d = new Doc(400, 400, "Dragon's Hoard X avatar", "The Dragon's Hoard mark, a pile of gold coins with a green scaly dragon tail curled around it, sized for a round crop.");
  return d.add(mark(d, 400)).toString();
}

/** The mark's ground alone, for the clear space and round crop checks. */
export function markBareSvg(size = 1024) {
  const d = new Doc(size, size, 'bare', 'bare');
  return d.add(markGround(d, size)).toString();
}

/** 1500 x 500. The lower left (x below 420, y below 270 from the bottom) stays bare ground for the avatar overlap. */
export const AVATAR_CORNER = Object.freeze({ x: 0, y: 270, w: 420, h: 230 });

function xBannerGround(d, W, H) {
  return sky(d, W, H) + floor(W, H, 400);
}

export function xBannerSvg() {
  const [W, H] = [1500, 500];
  const d = new Doc(W, H, "Dragon's Hoard X banner", "DRAGON'S HOARD in gold letters on a dark blue ground, with the lines BUYERS FEED THE PILE and SELLERS FEED THE FIRE under it. On the right, a pile of gold coins with a green scaly dragon tail curled around it.");
  d.add(xBannerGround(d, W, H));
  d.add(glints({ x: 450, y: 40, w: 1000, h: 330, count: 22, seed: 41, rMin: 3, rMax: 10, keepOut: [[150, 50, 1010, 250]] }));
  d.add(warmth(d, 1215, 330, 260, 170, 0.26));
  d.add(gilt("DRAGON'S HOARD", { x: 655, y: 74, size: 70 }).markup);
  d.add(label(COVER_LINE[0], { x: 655, y: 178, size: 27, color: C.gold }));
  d.add(label(COVER_LINE[1], { x: 655, y: 224, size: 27, color: C.vermilion }));
  d.add(hoard(d, { cx: 1200, base: 382, w: 236, seed: 23 }));
  d.add(frame({ w: W, h: H, inset: 26, r: 30, gap: 10, weight: 4, cut: { x: AVATAR_CORNER.w, y: AVATAR_CORNER.y } }));
  return d.toString();
}

/** The X banner's ground alone, for the avatar corner check. */
export function xBannerBareSvg() {
  const d = new Doc(1500, 500, 'bare', 'bare');
  return d.add(xBannerGround(d, 1500, 500)).toString();
}

/** 1200 x 630 link card: the name, the cover line split left and right, the hoard between them. */
export function coverSvg() {
  const [W, H] = [1200, 630];
  const d = new Doc(W, H, "Dragon's Hoard cover", "DRAGON'S HOARD in gold letters. Below, on the left, BUYERS FEED THE PILE, with a coin dropping onto a pile of gold coins that has a green scaly dragon tail curled around it. On the right, SELLERS FEED THE FIRE, with a green HOARD token dropping into a fire.");
  d.add(sky(d, W, H), floor(W, H, 470));
  d.add(glints({ x: 60, y: 40, w: 1080, h: 380, count: 26, seed: 29, rMin: 3, rMax: 10, keepOut: [[110, 30, 980, 120], [60, 170, 340, 110], [860, 170, 300, 110]] }));
  d.add(gilt("DRAGON'S HOARD", { x: 600, y: 62, size: 70 }).markup);
  d.add(label(['BUYERS FEED', 'THE PILE.'], { x: 215, y: 186, size: 28, color: C.gold }));
  d.add(label(['SELLERS FEED', 'THE FIRE.'], { x: 985, y: 186, size: 28, color: C.vermilion }));
  d.add(warmth(d, 590, 450, 280, 170, 0.26));
  d.add(coin(215, 345, 36));
  d.add(arrow({ x1: 260, y1: 360, x2: 425, y2: 405, bend: 26, color: C.gold, width: 10, head: 30 }));
  d.add(hoard(d, { cx: 585, base: 505, w: 262, seed: 27 }));
  d.add(token(d, 985, 330, 32));
  d.add(arrow({ x1: 985, y1: 372, x2: 985, y2: 412, color: C.vermilion, width: 8, head: 24, dash: '2 14' }));
  d.add(brazier(d, { cx: 985, bottom: 585, w: 150, flameH: 150 }));
  d.add(sparks(985, 425, 110, 6));
  d.add(frame({ w: W, h: H, inset: 24, r: 30, gap: 10, weight: 4 }));
  return d.toString();
}

/** 2400 x 600 box-page banner: the fire on the left, the name and cover line in the middle, the hoard on the right. */
export function boxBannerSvg() {
  const [W, H] = [2400, 600];
  const d = new Doc(W, H, "Dragon's Hoard box banner", "A long dark blue lair. On the left, green HOARD tokens drop into a fire. In the middle, DRAGON'S HOARD in gold letters with BUYERS FEED THE PILE and SELLERS FEED THE FIRE under it. On the right, a coin drops onto a pile of gold coins with a green scaly dragon tail curled around it.");
  d.add(sky(d, W, H), floor(W, H, 470));
  d.add(glints({ x: 60, y: 40, w: 2280, h: 400, count: 46, seed: 37, rMin: 3, rMax: 11, keepOut: [[540, 100, 1320, 300]] }));
  d.add(gilt("DRAGON'S HOARD", { x: 1200, y: 160, size: 88 }).markup);
  d.add(label(`${COVER_LINE[0]} ${COVER_LINE[1]}`, { x: 1200, y: 330, size: 32, color: C.vellum }));
  d.add(token(d, 330, 170, 34), token(d, 410, 230, 30));
  d.add(arrow({ x1: 370, y1: 268, x2: 370, y2: 320, color: C.vermilion, width: 8, head: 24, dash: '2 14' }));
  d.add(brazier(d, { cx: 370, bottom: 560, w: 200, flameH: 210 }));
  d.add(sparks(370, 330, 150, 7));
  d.add(warmth(d, 2060, 450, 320, 190, 0.26));
  d.add(coin(1905, 200, 34));
  d.add(arrow({ x1: 1940, y1: 224, x2: 1985, y2: 300, bend: 16, color: C.gold, width: 9, head: 26 }));
  d.add(hoard(d, { cx: 2070, base: 466, w: 286, seed: 33 }));
  d.add(frame({ w: W, h: H, inset: 28, r: 34, gap: 11, weight: 5 }));
  return d.toString();
}
