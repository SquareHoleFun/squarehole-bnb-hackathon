/**
 * Brand pieces: the logo and X avatar (one mark), the X banner, the link cover, the wide box banner, and the
 * preview sheet of the later GPU items.
 */
import { C, HEAT, MIX } from './palette.mjs';
import { Doc, rect, circle, r2 } from './doc.mjs';
import { fire, flamePath, heatGlow, contours } from './heat.mjs';
import { lettering } from './type.mjs';
import { label, HOT_LAYERS, stockCoin, chip, arrow, hud, TICKER } from './props.mjs';
import { gpu, emptyGpu, slot, gpuParts, cardLength, CARD_H } from './gpu.mjs';

/** Module of the mark: 1/32 of the square. The chip is 16 by 16 modules. */
export const MARK_GRID = 32;

/**
 * The mark: a VRAM chip that runs hot. A dark square chip with four pins on each side and a flame for a heat
 * signature. Built on the module m. Clear space is 2 modules beyond the pins (included in the square).
 */
function mark(d, size) {
  const m = size / MARK_GRID;
  const cx = size / 2;
  const cy = size / 2;
  const half = 8 * m;
  const out = [rect(0, 0, size, size, `fill="${C.night}"`)];
  out.push(contours(cx, cy, { r0: 12.2 * m, step: 1.4 * m, count: 3, opacity: 0.22 }));
  out.push(heatGlow(d, cx, cy, 14 * m, 14 * m, C.magenta, 0.42));
  for (const p of [-5.25, -1.75, 1.75, 5.25]) {
    const along = p * m - 0.65 * m;
    out.push(rect(cx + along, cy - half - 2.2 * m, 1.3 * m, 2.6 * m, `rx="${r2(0.35 * m)}" fill="${C.violet}"`));
    out.push(rect(cx + along, cy + half - 0.4 * m, 1.3 * m, 2.6 * m, `rx="${r2(0.35 * m)}" fill="${C.violet}"`));
    out.push(rect(cx - half - 2.2 * m, cy + along, 2.6 * m, 1.3 * m, `rx="${r2(0.35 * m)}" fill="${C.violet}"`));
    out.push(rect(cx + half - 0.4 * m, cy + along, 2.6 * m, 1.3 * m, `rx="${r2(0.35 * m)}" fill="${C.violet}"`));
  }
  out.push(rect(cx - half, cy - half, 2 * half, 2 * half, `rx="${r2(1.8 * m)}" fill="${MIX.chip}" stroke="${C.rim}" stroke-width="${r2(0.45 * m)}"`));
  out.push(circle(cx - half + 2.1 * m, cy - half + 2.1 * m, 0.75 * m, `fill="${C.rim}"`));
  for (let i = 0; i < 5; i += 1) {
    const k = 1 - i * 0.17;
    out.push(`<path d="${flamePath(cx, cy + 5.6 * m - i * 0.35 * m, 9.6 * m * k, 11.8 * m * k)}" fill="${HEAT[i]}"/>`);
  }
  return out.join('');
}

export function logoSvg(size = 1024) {
  const d = new Doc(size, size, 'GPU Poor logo', 'A dark square VRAM chip with four pins on each side. In its middle burns a flame, violet outside and white-hot inside.');
  return d.add(mark(d, size)).toString();
}

export function avatarSvg() {
  const d = new Doc(400, 400, 'GPU Poor X avatar', 'The GPU Poor mark, a dark VRAM chip with a flame burning in its middle, sized for a round crop.');
  return d.add(mark(d, 400)).toString();
}

/** A night ground with a soft violet haze, for the brand pieces. */
function ground(d, w, h) {
  return rect(0, 0, w, h, `fill="${C.night}"`) + heatGlow(d, w * 0.55, h * 0.45, w * 0.55, h * 0.75, C.violet, 0.12);
}

/**
 * The fee loop in four steps, left to right: stock coins, the pool, VRAM chips, the fire. Under the coins the
 * ticker $NVDA in ice, and under the chips VRAM in orange, `size` px tall, so the stock and the token are named.
 * (x, y) is the left end at the vertical middle; `k` scales it (1 is about 760 px wide, and the names hang about
 * 100 k below the middle).
 */
function feeLoop(d, { x, y, k = 1, fireLevel = 5, size = 28 }) {
  const s = (v) => v * k;
  const out = [];
  out.push(stockCoin(x + s(46), y - s(38), s(34)), stockCoin(x + s(86), y + s(10), s(34)), stockCoin(x + s(30), y + s(52), s(34)));
  out.push(arrow({ x1: x + s(150), y1: y, x2: x + s(250), y2: y, color: C.ice, width: s(11), head: s(32) }));
  out.push(chip({ cx: x + s(330), cy: y - s(34), w: s(96), heat: 2, angle: -8 }), chip({ cx: x + s(350), cy: y + s(44), w: s(96), heat: 3, angle: 6 }));
  out.push(arrow({ x1: x + s(430), y1: y, x2: x + s(530), y2: y, color: C.orange, width: s(11), head: s(32) }));
  out.push(contours(x + s(650), y + s(10), { r0: s(110), step: s(26), count: 3, opacity: 0.18 }));
  out.push(fire(d, { cx: x + s(650), by: y + s(92), w: s(170), h: s(210), level: fireLevel }));
  out.push(chip({ cx: x + s(640), cy: y + s(70), w: s(70), heat: 4, angle: 16 }));
  out.push(label(TICKER, { x: x + s(62), y: y + s(102), size, color: C.ice }), label('VRAM', { x: x + s(340), y: y + s(102), size, color: C.orange }));
  return out.join('');
}

/** The words under the fee loop, said the same way in every description. */
const LOOP_DESC = `ice-blue coins over the word ${TICKER} become chips over the word VRAM, and the chips burn in a fire`;

/** 1500 x 500. The lower left (x below 420, y below 270) stays plain for the avatar overlap. */
export function xBannerSvg() {
  const [W, H] = [1500, 500];
  const d = new Doc(W, H, 'GPU Poor X banner', `GPU POOR in hot glowing letters on a dark ground. Top left, the dashed outline of a missing GPU over an empty slot. Below the name, ${LOOP_DESC}.`);
  d.add(ground(d, W, H));
  d.add(emptyGpu({ x: 92, y: 74, u: 8.4, fans: 2 }), slot({ x: 98, y: 182, len: 226, u: 8.4 }));
  const name = lettering('GPU POOR', { x: 900, y: 78, size: 92, sw: 0.7, layers: HOT_LAYERS });
  d.add(heatGlow(d, 900, 128, 520, 120, C.magenta, 0.22), name.markup);
  d.add(feeLoop(d, { x: 579, y: 318, k: 0.86, size: 26 }));
  d.add(hud(d, { w: W, h: H, inset: 26, len: 46, weight: 5, level: 0.86, scaleH: 260, skip: ['bottom-left'] }));
  return d.toString();
}

/** 1200 x 630 link card: the name, the founder's headline and the fee loop with the stock and the token named. */
export function coverSvg() {
  const [W, H] = [1200, 630];
  const d = new Doc(W, H, 'GPU Poor cover', `GPU POOR in hot glowing letters, with the line SELL A STOCK TO PROP UP A MEMECOIN under it. Below, ${LOOP_DESC}.`);
  d.add(ground(d, W, H));
  const name = lettering('GPU POOR', { x: 585, y: 62, size: 96, sw: 0.7, layers: HOT_LAYERS });
  d.add(heatGlow(d, 585, 110, 520, 120, C.magenta, 0.22), name.markup);
  d.add(label(['SELL A STOCK', 'TO PROP UP A MEMECOIN.'], { x: 585, y: 218, size: 34, color: C.white }));
  d.add(feeLoop(d, { x: 249, y: 436, k: 0.9, size: 28 }));
  d.add(hud(d, { w: W, h: H, inset: 26, len: 50, weight: 5, level: 0.86, scaleH: 300 }));
  return d.toString();
}

/** 2400 x 600 box-page banner: empty slots on the left, the name in the middle, the fee loop on the right. */
export function boxBannerSvg() {
  const [W, H] = [2400, 600];
  const d = new Doc(W, H, 'GPU Poor box banner', `A long dark ground. On the left, two dashed outlines of missing GPUs over empty slots. In the middle, GPU POOR in hot glowing letters. On the right, ${LOOP_DESC}.`);
  d.add(ground(d, W, H));
  [[96, 118, 2], [120, 330, 1]].forEach(([x, y, fans]) => {
    const u = 9;
    d.add(emptyGpu({ x, y, u, fans }), slot({ x: x + 6, y: y + (CARD_H + 1.4) * u, len: cardLength(fans) * u - 12, u }));
  });
  const name = lettering('GPU POOR', { x: 935, y: 246, size: 108, sw: 0.7, layers: HOT_LAYERS });
  d.add(heatGlow(d, 935, 300, 600, 140, C.magenta, 0.22), name.markup);
  d.add(feeLoop(d, { x: 1565, y: 290, k: 0.9, size: 30 }));
  d.add(hud(d, { w: W, h: H, inset: 30, len: 56, weight: 6, level: 0.86, scaleH: 320 }));
  return d.toString();
}

/** The ids shown on the preview sheet of the later GPU items. */
/** Picked so that every choice of every part shows exactly three times on the sheet. */
export const PREVIEW_IDS = Object.freeze([1, 92, 144, 224, 265, 533, 624, 676, 737, 779, 857, 910]);

/** 1800 x 1200: twelve of the later GPU items, built from the same parts by `gpuParts(id)`. */
export function previewSvg() {
  const [W, H] = [1800, 1200];
  const d = new Doc(W, H, 'GPU Poor later GPUs, preview', 'A sheet of twelve different GPU cards on a dark ground, each with its number below it. They have one, two or three fans or a blower, dark, steel, white or bare shrouds, fans glowing from violet to white-hot, and fixes such as tape, zip ties or a missing fan.');
  d.add(rect(0, 0, W, H, `fill="${C.night}"`));
  const u = 11;
  PREVIEW_IDS.forEach((id, i) => {
    const cx = 300 + (i % 3) * 600;
    const cy = 150 + Math.floor(i / 3) * 300;
    const p = gpuParts(id);
    const L = cardLength(p.fans) * u;
    const g = gpu(d, { x: cx - L / 2 + 0.85 * u, y: cy - (CARD_H * u) / 2 - 18, u, fans: p.fans, shroud: p.shroud, heat: p.heat, fix: p.fix, accent: p.accent, glow: 0.22 });
    d.add(g.markup, label(`#${id}`, { x: cx, y: cy + 92, size: 22, color: C.violet }));
  });
  d.add(hud(d, { w: W, h: H, inset: 26, len: 50, weight: 5, scale: false }));
  return d.toString();
}
