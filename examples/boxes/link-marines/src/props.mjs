/**
 * Story symbols for the scenes, the cover and the banners: the floor, the mess table, the mess tin and its heap of
 * coins, the box's own pool, the Square Hole crate, the crate of 420 marines, the chow bell, the footlocker with no
 * key, the raise bar, arrows, signs, the claim button and pointer, a picture frame, an empty tray and the claims jar.
 * Coins and dog tags live in src/coins.mjs. Every prop is drawn with the pen, flat inks with a boot-black outline.
 */
import { C, MIX } from './palette.mjs';
import { r2, group, place, rect, circlePath, ellipsePath, roundRect, poly } from './doc.mjs';
import { shape, holed, flat, line, band, halftone, clipped } from './pen.mjs';
import { coin, tag } from './coins.mjs';
import { lettering, measure } from './type.mjs';

const P = (x, y) => `${r2(x)} ${r2(y)}`;

/** The floor: crate-wood boards from y down to y + h, with a dark top edge and staggered joints. */
export function floor(doc, { x = 0, y, w, h, ow }) {
  const seams = [];
  const rows = 3;
  for (let i = 1; i < rows; i += 1) seams.push(`M${P(x, y + (i * h) / rows)}H${r2(x + w)}`);
  for (let i = 0; i < rows; i += 1) {
    const top = y + (i * h) / rows;
    for (let j = (i % 2) * 130 + 90; j < w; j += 260) seams.push(`M${P(x + j, top + 6)}V${r2(top + h / rows - 6)}`);
  }
  return rect(x, y, w, h, `fill="${C.crate}"`) + line(seams.join(''), MIX.crateDark, ow * 0.6) + rect(x, y - ow / 2, w, ow, `fill="${C.ink}"`)
    + rect(x, y + ow / 2, w, ow * 1.2, `fill="${MIX.crateLight}"`);
}

/**
 * The mess table seen from the front: a thick top, an apron and two legs that stand on the floor at `to`. Draw it
 * after the busts sitting behind it.
 */
export function table(doc, { x, y, w, ow, legs = true, to = y + 300 }) {
  const top = roundRect(x, y, w, 46, 10);
  const apron = rect(x + 30, y + 46, w - 60, 40, `fill="${MIX.crateDark}"`);
  const leg = (lx) => shape(roundRect(lx - 22, y + 60, 44, to - y - 60, 8), MIX.crateDark, ow);
  return (legs ? leg(x + 90) + leg(x + w - 90) : '') + apron + line(`M${P(x + 30, y + 86)}H${r2(x + w - 30)}`, C.ink, ow * 0.8)
    + shape(top, C.crate, ow) + line(`M${P(x + 18, y + 16)}H${r2(x + w - 18)}`, MIX.crateLight, ow * 0.7);
}

/**
 * A heap of `n` coins of radius r resting on y, at most `w` wide: full rows at the bottom, fewer coins above, so it
 * reads as a mound. Back rows are drawn first.
 */
export function coinHeap(cx, y, w, n, r, ow) {
  const rows = [];
  let left = n;
  let width = Math.max(1, Math.floor((w - 2 * r) / (1.55 * r)) + 1);
  while (left > 0) {
    const k = Math.min(width, left);
    rows.push(k);
    left -= k;
    width = Math.max(1, width - 1);
  }
  const out = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const k = rows[i];
    const span = (k - 1) * 1.55 * r;
    for (let j = 0; j < k; j += 1) out.push(coin(cx - span / 2 + j * 1.55 * r, y - r - i * 1.25 * r, r, ow));
  }
  return out.join('');
}

/**
 * The mess tin: a steel kettle with two side handles, its rim at y. `coins` heaps that many coins on top. `sign`
 * hangs a paper sign on its front. The tin is `w` wide; its body is 0.62 w tall.
 */
export function messTin(doc, { cx, y, w, ow, coins = 0, coinR = w * 0.075, label = 'MESS', sign = null }) {
  const h = w * 0.62;
  const hw = w / 2;
  const body = `M${P(cx - hw, y)}H${r2(cx + hw)}L${P(cx + hw * 0.88, y + h - 26)}Q${P(cx + hw * 0.86, y + h)} ${P(cx + hw * 0.76, y + h)}`
    + `H${r2(cx - hw * 0.76)}Q${P(cx - hw * 0.86, y + h)} ${P(cx - hw * 0.88, y + h - 26)}Z`;
  const handle = (s) => band(`M${P(cx + s * hw * 0.97, y + h * 0.22)}C${P(cx + s * (hw + 70), y + h * 0.2)} ${P(cx + s * (hw + 70), y + h * 0.56)} ${P(cx + s * hw * 0.93, y + h * 0.52)}`,
    C.steel, 20, ow);
  const shine = flat(`M${P(cx - hw * 0.8, y + 30)}L${P(cx - hw * 0.62, y + 30)}L${P(cx - hw * 0.56, y + h - 40)}L${P(cx - hw * 0.7, y + h - 40)}Z`, MIX.steelLight);
  const shade = halftone(doc, `M${P(cx + hw * 0.3, y)}H${r2(cx + hw)}V${r2(y + h)}H${r2(cx + hw * 0.3)}Z`, MIX.steelDark, 13);
  const parts = [handle(-1), handle(1)];
  if (coins > 0) parts.push(coinHeap(cx, y + 10, w * 0.86, coins, coinR, ow * 0.7));
  parts.push(shape(body, C.steel, ow), clipped(doc, body, shine, shade), shape(body, 'none', ow));
  parts.push(shape(roundRect(cx - hw - 14, y - 14, w + 28, 30, 14), MIX.steelDark, ow));
  if (label) parts.push(lettering(doc, label, { x: cx, y: y + h * 0.36, cap: Math.min(64, w * 0.15), color: C.ink }));
  if (sign) parts.push(sign);
  return parts.join('');
}

/** The box's own pool, seen from a little above: a paper deck, sage water with ripples, a steel ladder, a coin and a tag. */
export function pool(doc, { cx, cy, w, ow, floating = true }) {
  const h = w * 0.52;
  const deck = roundRect(cx - w / 2, cy - h / 2, w, h, h * 0.3);
  const water = roundRect(cx - w / 2 + 26, cy - h / 2 + 26, w - 52, h - 52, h * 0.22);
  const ripples = [-0.18, 0.12].map((dy, i) => `M${P(cx - w * 0.3 + i * 30, cy + dy * h)}q${r2(w * 0.05)} -14 ${r2(w * 0.1)} 0t${r2(w * 0.1)} 0t${r2(w * 0.1)} 0`).join('');
  const rx = cx + w / 2 - 80;
  const ladder = band(`M${P(rx - 20, cy - h / 2 + 44)}V${r2(cy - h / 2 - 34)}Q${P(rx - 20, cy - h / 2 - 60)} ${P(rx - 46, cy - h / 2 - 60)}`, C.steel, 12, ow * 0.7)
    + band(`M${P(rx + 20, cy - h / 2 + 44)}V${r2(cy - h / 2 - 34)}Q${P(rx + 20, cy - h / 2 - 60)} ${P(rx - 6, cy - h / 2 - 60)}`, C.steel, 12, ow * 0.7)
    + band(`M${P(rx - 20, cy - h / 2 + 14)}H${r2(rx + 20)}`, C.steel, 8, ow * 0.6, 'butt');
  return shape(deck, C.paper, ow) + shape(water, C.sage, ow) + clipped(doc, water, halftone(doc, water, MIX.sageDark, 13, 2.2))
    + line(ripples, MIX.sageLight, ow * 0.9) + (floating ? coin(cx - w * 0.14, cy + h * 0.02, h * 0.13, ow * 0.7) + tag(cx + w * 0.06, cy + h * 0.06, h * 0.32, ow * 0.7, -14) : '')
    + ladder;
}

/** A wooden crate seen from the front, w wide and h tall, its top at y: planks, corner braces and stencilled words. */
export function crate(doc, { cx, y, w, h, ow, words = [], cap = 54, color = C.ink, open = false }) {
  const x = cx - w / 2;
  const body = rect(x, y, w, h, `fill="${C.crate}" stroke="${C.ink}" stroke-width="${r2(ow)}" stroke-linejoin="round"`);
  const planks = [];
  for (let i = 1; i < 4; i += 1) planks.push(`M${P(x + 6, y + (i * h) / 4)}H${r2(x + w - 6)}`);
  const brace = (bx) => shape(roundRect(bx, y + 2, 40, h - 4, 4), MIX.crateDark, ow * 0.8);
  const nails = [x + 20, x + w - 20].flatMap((nx) => [y + 22, y + h - 22].map((ny) => flat(circlePath(nx, ny, 6), C.ink))).join('');
  const lip = open ? shape(roundRect(x - 10, y - 18, w + 20, 34, 6), MIX.crateLight, ow) : '';
  // The words shrink to fit between the corner braces, never past them.
  const fit = words.length ? Math.min(cap, (cap * (w - 120)) / measure(words, cap).w) : cap;
  const words2 = words.length ? lettering(doc, words, { x: cx, y: y + h / 2 - measure(words, fit).h / 2, cap: fit, color }) : '';
  return body + line(planks.join(''), MIX.crateDark, ow * 0.6) + brace(x) + brace(x + w - 40) + nails + lip + words2;
}

/** A helmet and a pair of eyes peeking over an edge at y: the marines waiting inside the crate. */
export function peeker(cx, y, size, ow, look = 0) {
  const hw = size / 2;
  const dome = `M${P(cx - hw, y + 6)}C${P(cx - hw, y - size * 0.62)} ${P(cx + hw, y - size * 0.62)} ${P(cx + hw, y + 6)}Z`;
  const brim = `M${P(cx - hw - 14, y + 6)}Q${P(cx, y - 18)} ${P(cx + hw + 14, y + 6)}L${P(cx + hw + 12, y + 20)}Q${P(cx, y - 2)} ${P(cx - hw - 12, y + 20)}Z`;
  const face = roundRect(cx - hw * 0.78, y + 8, hw * 1.56, size * 0.4, 18);
  const eye = (ex) => flat(ellipsePath(ex + look, y + size * 0.2, size * 0.055, size * 0.075), C.ink) + flat(circlePath(ex + look - 2, y + size * 0.18, size * 0.02), MIX.white);
  return shape(face, C.paper, ow) + eye(cx - hw * 0.34) + eye(cx + hw * 0.34) + shape(dome, C.olive, ow)
    + flat(`M${P(cx - hw * 0.66, y - 10)}C${P(cx - hw * 0.66, y - size * 0.36)} ${P(cx - hw * 0.2, y - size * 0.46)} ${P(cx, y - size * 0.47)}C${P(cx - hw * 0.4, y - size * 0.38)} ${P(cx - hw * 0.5, y - size * 0.2)} ${P(cx - hw * 0.46, y - 10)}Z`, MIX.oliveLight)
    + shape(brim, C.olive, ow);
}

/** The chow bell: a steel triangle hanging from a cord at (x, y), with its striker. `ring` adds sound marks. */
export function bell(doc, { x, y, size, ow, ring = false, striker = true }) {
  const top = y + 70;
  const tri = `M${P(x, top)}L${P(x + size * 0.5, top + size * 0.86)}L${P(x - size * 0.5 + 18, top + size * 0.86)}L${P(x - 14, top + 24)}`;
  const cord = line(`M${P(x, y)}L${P(x, top)}`, C.ink, ow * 0.9);
  const hook = shape(circlePath(x, y, 12), C.steel, ow * 0.7);
  const rod = striker ? band(`M${P(x - size * 0.24, top + size * 0.34)}L${P(x + size * 0.16, top + size * 0.7)}`, C.steel, 12, ow * 0.7) : '';
  const marks = ring ? line([0, 1, 2].map((i) => `M${P(x + size * 0.56 + i * 22, top + size * 0.3 - i * 16)}Q${P(x + size * 0.66 + i * 30, top + size * 0.5)} ${P(x + size * 0.56 + i * 22, top + size * 0.72 + i * 16)}`).join('')
    + [0, 1, 2].map((i) => `M${P(x - size * 0.56 - i * 22, top + size * 0.3 - i * 16)}Q${P(x - size * 0.66 - i * 30, top + size * 0.5)} ${P(x - size * 0.56 - i * 22, top + size * 0.72 + i * 16)}`).join(''), C.ink, ow * 0.8) : '';
  return cord + hook + band(tri, C.steel, 22, ow) + rod + marks;
}

/** A padlock with no keyhole: nobody can open it. */
export function padlock(cx, cy, size, ow) {
  const body = roundRect(cx - size / 2, cy - size * 0.3, size, size * 0.8, size * 0.16);
  const shackle = `M${P(cx - size * 0.3, cy - size * 0.28)}V${r2(cy - size * 0.52)}A${r2(size * 0.3)} ${r2(size * 0.3)} 0 0 1 ${P(cx + size * 0.3, cy - size * 0.52)}V${r2(cy - size * 0.28)}`;
  return band(shackle, C.steel, size * 0.14, ow) + shape(body, C.gold, ow) + flat(roundRect(cx - size * 0.36, cy - size * 0.18, size * 0.12, size * 0.5, size * 0.06), MIX.goldLight)
    + line(`M${P(cx - size * 0.3, cy + size * 0.36)}H${r2(cx + size * 0.3)}`, MIX.goldDark, ow * 0.7);
}

/** A steel key crossed out with an orange X: there is no key. */
export function noKey(cx, cy, size, ow) {
  const key = group(place(cx, cy, { rotate: -30 }),
    holed(`${circlePath(-size * 0.32, 0, size * 0.2)}${circlePath(-size * 0.32, 0, size * 0.09)}`, C.steel, ow * 0.8),
    band(`M${P(-size * 0.12, 0)}H${r2(size * 0.42)}M${P(size * 0.3, 0)}V${r2(size * 0.12)}M${P(size * 0.4, 0)}V${r2(size * 0.14)}`, C.steel, size * 0.08, ow * 0.7, 'butt'));
  const cross = band(`M${P(cx - size * 0.42, cy - size * 0.42)}L${P(cx + size * 0.42, cy + size * 0.42)}M${P(cx + size * 0.42, cy - size * 0.42)}L${P(cx - size * 0.42, cy + size * 0.42)}`, C.orange, size * 0.12, ow);
  return key + cross;
}

/**
 * The footlocker: a steel trunk with a lid, corner caps, side handles, a slot in the lid for coins and a padlock with
 * no keyhole on its hasp. `words` are stencilled on its front. Its lid top is at y.
 */
export function footlocker(doc, { cx, y, w, ow, words = [], cap = 46 }) {
  const h = w * 0.6;
  const x = cx - w / 2;
  const lidH = h * 0.3;
  const lid = roundRect(x, y, w, lidH, 16);
  const box = roundRect(x + 6, y + lidH, w - 12, h - lidH, 12);
  const caps = [[x, y], [x + w - 46, y], [x + 6, y + h - 46], [x + w - 52, y + h - 46]].map(([kx, ky]) => shape(roundRect(kx, ky, 46, 46, 10), MIX.steelDark, ow * 0.7)).join('');
  const handle = (s) => band(`M${P(cx + s * (w / 2 - 4), y + h * 0.5)}h${r2(s * 30)}v${r2(h * 0.18)}h${r2(-s * 30)}`, C.ink, 12, 0, 'butt');
  const slot = shape(roundRect(cx - w * 0.22, y + lidH * 0.3, w * 0.44, lidH * 0.3, lidH * 0.15), C.ink, ow * 0.6);
  const side = (top, bottom) => `M${P(cx + w * 0.18, top)}H${r2(x + w)}V${r2(bottom)}H${r2(cx + w * 0.18)}Z`;
  const hasp = shape(roundRect(cx - 30, y + lidH - 18, 60, 64, 10), MIX.steelDark, ow * 0.8);
  const lockSize = w * 0.13;
  const lockY = y + lidH + 46 + lockSize * 0.3;
  const front = words.length ? lettering(doc, words, { x: cx, y: lockY + lockSize * 0.62, cap: Math.min(cap, (h - lidH) * 0.2), color: C.ink }) : '';
  return handle(-1) + handle(1) + shape(box, C.steel, ow) + clipped(doc, box, halftone(doc, side(y, y + h), MIX.steelDark, 13)) + shape(box, 'none', ow)
    + shape(lid, C.steel, ow) + clipped(doc, lid, halftone(doc, side(y, y + lidH), MIX.steelDark, 13)) + shape(lid, 'none', ow)
    + flat(roundRect(x + 30, y + 12, w * 0.16, 10, 5), MIX.steelLight) + caps + slot + hasp + front + padlock(cx, lockY, lockSize, ow);
}

/** The raise bar: a rounded bar filled with gold to `frac` (a decimal 0 to 1), with a check or a cross beside it. */
export function raiseBar(doc, { x, y, w, h, frac, ow, mark = null, label = 'RAISE', cap = 40 }) {
  const outer = roundRect(x, y, w, h, h / 2);
  const fill = rect(x, y, w * frac, h, `fill="${C.gold}"`);
  const ticks = line([0.25, 0.5, 0.75].map((t) => `M${P(x + w * t, y + 8)}V${r2(y + h - 8)}`).join(''), MIX.paperDot, ow * 0.6);
  const parts = [shape(outer, C.paper, ow), clipped(doc, outer, fill, ticks), shape(outer, 'none', ow)];
  if (label) parts.push(lettering(doc, label, { x, y: y - cap - 18, cap, color: C.ink, anchor: 'start' }));
  const mx = x + w + h * 0.9;
  const my = y + h / 2;
  if (mark === 'check') parts.push(shape(circlePath(mx, my, h * 0.75), C.olive, ow), band(`M${P(mx - h * 0.34, my)}L${P(mx - h * 0.08, my + h * 0.28)}L${P(mx + h * 0.38, my - h * 0.3)}`, C.paper, h * 0.16, 0));
  if (mark === 'cross') parts.push(shape(circlePath(mx, my, h * 0.75), C.orange, ow), band(`M${P(mx - h * 0.3, my - h * 0.3)}L${P(mx + h * 0.3, my + h * 0.3)}M${P(mx + h * 0.3, my - h * 0.3)}L${P(mx - h * 0.3, my + h * 0.3)}`, C.ink, h * 0.16, 0));
  return parts.join('');
}

/**
 * An arrow from (x1, y1) to (x2, y2), bent sideways by `bend` px, as a thick band with an ink edge and a head that
 * follows the curve.
 */
export function arrow(x1, y1, x2, y2, { bend = 0, color = C.ink, width = 16, ow = 6, head = 1 } = {}) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const [nx, ny] = [-(y2 - y1) / len, (x2 - x1) / len];
  const [qx, qy] = [mx + nx * bend, my + ny * bend];
  const tl = Math.hypot(x2 - qx, y2 - qy) || 1;
  const [ux, uy] = [(x2 - qx) / tl, (y2 - qy) / tl];
  const hl = width * 2.4 * head;
  const hw = width * 1.6 * head;
  const [bx, by] = [x2 - ux * hl, y2 - uy * hl];
  const shaft = band(`M${P(x1, y1)}Q${P(qx, qy)} ${P(bx + ux * 4, by + uy * 4)}`, color, width, ow, 'butt');
  const tip = shape(poly([[x2, y2], [bx - uy * hw, by + ux * hw], [bx + uy * hw, by - ux * hw]]), color, ow);
  return shaft + tip;
}

/** A paper sign with an ink border and stencilled lines, centred on (cx, cy), optionally hanging on two cords. */
export function sign(doc, { cx, cy, w, h, lines, cap, ow, color = C.ink, paper = C.paper, cords = null }) {
  const board = roundRect(cx - w / 2, cy - h / 2, w, h, 12);
  const list = Array.isArray(lines) ? lines : [lines];
  const blockH = list.length * cap + (list.length - 1) * cap * 0.34;
  const hang = cords === null ? '' : line(`M${P(cx - w * 0.3, cy - h / 2)}L${P(cx, cords)}L${P(cx + w * 0.3, cy - h / 2)}`, C.ink, ow * 0.7);
  return hang + shape(board, paper, ow) + (list.length ? lettering(doc, list, { x: cx, y: cy - blockH / 2, cap, color }) : '');
}

/** The claim button: an olive pill with stencilled CLAIM in paper. */
export function button(doc, { cx, cy, w, h, ow, label = 'CLAIM' }) {
  return shape(roundRect(cx - w / 2, cy - h / 2 + 8, w, h, h / 2), MIX.oliveDeep, ow) + shape(roundRect(cx - w / 2, cy - h / 2, w, h, h / 2), C.olive, ow)
    + lettering(doc, label, { x: cx, y: cy - h * 0.22, cap: h * 0.44, color: C.paper });
}

/** A paper pointer arrow, its tip at (x, y). */
export function pointer(x, y, size, ow) {
  const s = size / 100;
  const d = poly([[0, 0], [0, 78], [20, 60], [34, 92], [50, 85], [36, 54], [62, 54]].map(([px, py]) => [x + px * s, y + py * s]));
  return shape(d, C.paper, ow);
}

/** A crate-wood picture frame with a paper mat, centred on (cx, cy); `inner` is drawn inside the mat's window. */
export function frame(doc, { cx, cy, size, ow, inner = '' }) {
  const outer = roundRect(cx - size / 2, cy - size / 2, size, size, 10);
  const win = rect(cx - size * 0.38, cy - size * 0.38, size * 0.76, size * 0.76, `fill="none" stroke="${C.ink}" stroke-width="${r2(ow * 0.7)}"`);
  const winD = `M${P(cx - size * 0.38, cy - size * 0.38)}H${r2(cx + size * 0.38)}V${r2(cy + size * 0.38)}H${r2(cx - size * 0.38)}Z`;
  return shape(outer, C.crate, ow) + shape(roundRect(cx - size * 0.44, cy - size * 0.44, size * 0.88, size * 0.88, 4), C.paper, ow * 0.7)
    + clipped(doc, winD, inner) + win
    + line(`M${P(cx - size / 2 + 14, cy - size / 2 + 14)}H${r2(cx + size / 2 - 14)}`, MIX.crateLight, ow * 0.6);
}

/** An empty steel mess tray with three compartments, seen from a little above. */
export function tray(doc, { cx, cy, w, ow }) {
  const h = w * 0.62;
  const outer = roundRect(cx - w / 2, cy - h / 2, w, h, 26);
  const cell = (x, y, cw, ch) => shape(roundRect(x, y, cw, ch, 16), MIX.steelDark, ow * 0.7) + flat(roundRect(x + 8, y + ch - 22, cw - 16, 12, 6), MIX.steelLight);
  return shape(outer, C.steel, ow) + clipped(doc, outer, halftone(doc, `M${P(cx + w * 0.2, cy - h)}H${r2(cx + w)}V${r2(cy + h)}H${r2(cx + w * 0.2)}Z`, MIX.steelDark, 13))
    + shape(outer, 'none', ow) + cell(cx - w / 2 + 26, cy - h / 2 + 26, w * 0.52, h * 0.42) + cell(cx + w * 0.06, cy - h / 2 + 26, w * 0.38, h * 0.42)
    + cell(cx - w / 2 + 26, cy + 6, w - 52, h * 0.36);
}

/** The claims jar: a glass jar with a lid, holding coins, where holders hand in the box's token for their part. */
export function jar(doc, { cx, y, w, ow, coins = 8, label = null }) {
  const h = w * 1.2;
  const glass = `M${P(cx - w * 0.38, y + 40)}Q${P(cx - w / 2, y + 60)} ${P(cx - w / 2, y + 140)}V${r2(y + h - 40)}Q${P(cx - w / 2, y + h)} ${P(cx - w / 2 + 40, y + h)}`
    + `H${r2(cx + w / 2 - 40)}Q${P(cx + w / 2, y + h)} ${P(cx + w / 2, y + h - 40)}V${r2(y + 140)}Q${P(cx + w / 2, y + 60)} ${P(cx + w * 0.38, y + 40)}Z`;
  const heap = coinHeap(cx, y + h - 12, w * 0.84, coins, w * 0.09, ow * 0.7);
  const shine = flat(`M${P(cx - w * 0.36, y + 150)}V${r2(y + h - 70)}H${r2(cx - w * 0.28)}V${r2(y + 150)}Z`, MIX.white);
  const lid = shape(roundRect(cx - w * 0.42, y, w * 0.84, 46, 10), C.steel, ow);
  const words = label ? lettering(doc, label, { x: cx, y: y + h * 0.36, cap: w * 0.13, color: C.ink }) : '';
  return shape(glass, MIX.steelLight, ow) + clipped(doc, glass, heap, shine) + shape(glass, 'none', ow) + lid + words;
}
