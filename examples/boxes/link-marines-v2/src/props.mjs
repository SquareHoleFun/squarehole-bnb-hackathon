/**
 * Story symbols for the pictures: the floor, the table with its white cloth, place cards, the tureen of rations, coin
 * heaps, the box's own pool and its depth gauge, the Square Hole crate, the crate of 420 marines, white caps peeking
 * over its edge, the raise bar, arrows, signs, the claim button and pointer, the rules plaque, the padlock with no
 * keyhole, the crossed-out key, the closing pool jar and the candles. Coins, plates, cloches and dog tags live in
 * src/coins.mjs. Every prop is drawn with the pen: flat inks with a boot-black outline.
 */
import { C, MIX } from './palette.mjs';
import { r2, group, place, rect, circlePath, ellipsePath, roundRect, poly } from './doc.mjs';
import { shape, holed, flat, line, band, halftone, clipped } from './pen.mjs';
import { coin } from './coins.mjs';
import { lettering, measure, CAP } from './type.mjs';

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
 * A table under a white cloth, seen from the front and a little above: the cloth's top from y down 0.45 of its
 * height, then the front drop with soft folds and halftone shade, and a hem. With `legs`, two crate-wood legs stand
 * below the hem on the floor at `to`. Draw it after the busts sitting behind it.
 */
export function cloth(doc, { x, y, w, h, ow, legs = false, to = y + h + 120 }) {
  const topH = Math.min(84, h * 0.45);
  const drop = `M${P(x, y + topH)}H${r2(x + w)}V${r2(y + h)}H${r2(x)}Z`;
  const folds = [];
  for (let fx = x + 90; fx < x + w - 40; fx += 150) folds.push(`M${P(fx, y + topH + 14)}Q${P(fx + 12, y + topH + (h - topH) * 0.55)} ${P(fx - 4, y + h - 8)}`);
  const leg = (lx) => shape(roundRect(lx - 22, y + h - 10, 44, to - (y + h) + 10, 8), MIX.crateDark, ow);
  return (legs ? leg(x + 90) + leg(x + w - 90) : '')
    + shape(`M${P(x, y)}H${r2(x + w)}V${r2(y + h)}H${r2(x)}Z`, C.white, ow)
    + clipped(doc, drop, halftone(doc, `M${P(x + w * 0.62, y)}H${r2(x + w)}V${r2(y + h)}H${r2(x + w * 0.62)}Z`, MIX.whiteDot, 13),
      line(folds.join(''), MIX.whiteShade, ow * 1.4))
    + line(`M${P(x, y + topH)}H${r2(x + w)}`, C.ink, ow * 0.8) + line(`M${P(x + 10, y + 14)}H${r2(x + w - 10)}`, MIX.glint, ow * 0.7)
    + line(`M${P(x, y + h - 16)}H${r2(x + w)}`, MIX.whiteDot, ow * 0.7, { dash: '16 12' });
}

/** A folded place card standing on the table, its fold at y: the rank in stencil capitals, one or two lines. */
export function placeCard(doc, { cx, y, w, lines, ow, cap = 26 }) {
  const list = Array.isArray(lines) ? lines : [lines];
  const blockH = measure(list, cap).h;
  const h = blockH + cap * 1.4;
  const front = `M${P(cx - w / 2, y)}H${r2(cx + w / 2)}L${P(cx + w / 2 + 8, y + h)}H${r2(cx - w / 2 - 8)}Z`;
  const fit = Math.min(cap, (cap * (w - 40)) / measure(list, cap).w);
  return shape(`M${P(cx - w / 2 + 6, y - 10)}H${r2(cx + w / 2 - 6)}L${P(cx + w / 2, y)}H${r2(cx - w / 2)}Z`, MIX.paperShade, ow * 0.6)
    + shape(front, C.paper, ow * 0.8) + line(`M${P(cx - w / 2 + 14, y + 10)}H${r2(cx + w / 2 - 14)}`, C.khaki, ow * 0.6)
    + lettering(doc, list, { x: cx, y: y + (h - measure(list, fit).h) / 2 + 2, cap: fit, color: C.ink });
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
 * The tureen of rations: a round steel serving dish on a foot, its lid tipped open, coins heaped inside and a word
 * stencilled on its front. Its rim is at y, `w` wide.
 */
export function tureen(doc, { cx, y, w, ow, coins = 0, label = 'RATIONS' }) {
  const hw = w / 2;
  const h = w * 0.5;
  const body = `M${P(cx - hw, y)}H${r2(cx + hw)}C${P(cx + hw, y + h * 0.8)} ${P(cx + hw * 0.6, y + h)} ${P(cx, y + h)}C${P(cx - hw * 0.6, y + h)} ${P(cx - hw, y + h * 0.8)} ${P(cx - hw, y)}Z`;
  const foot = `M${P(cx - hw * 0.34, y + h - 6)}H${r2(cx + hw * 0.34)}L${P(cx + hw * 0.44, y + h + 40)}H${r2(cx - hw * 0.44)}Z`;
  const handle = (s) => band(`M${P(cx + s * hw * 0.96, y + h * 0.18)}C${P(cx + s * (hw + 60), y + h * 0.14)} ${P(cx + s * (hw + 60), y + h * 0.5)} ${P(cx + s * hw * 0.86, y + h * 0.52)}`, C.steel, 18, ow);
  const lid = group(place(cx + hw * 0.72, y - 18, { rotate: 24 }),
    shape(`M${P(-hw * 0.9, 0)}C${P(-hw * 0.9, -h * 0.62)} ${P(hw * 0.9, -h * 0.62)} ${P(hw * 0.9, 0)}Z`, C.steel, ow), shape(circlePath(0, -h * 0.5, 16), MIX.steelDark, ow * 0.7));
  const parts = [handle(-1), handle(1), shape(foot, MIX.steelDark, ow)];
  if (coins > 0) parts.push(coinHeap(cx - hw * 0.08, y + 12, w * 0.78, coins, w * 0.07, ow * 0.7));
  // The light crescent hugs the bowl's left side, so it stays clear of the word on the front.
  parts.push(shape(body, C.steel, ow), clipped(doc, body, halftone(doc, `M${P(cx + hw * 0.3, y)}H${r2(cx + hw)}V${r2(y + h)}H${r2(cx + hw * 0.3)}Z`, MIX.steelDark, 13),
    flat(`M${P(cx - hw * 0.9, y + 26)}C${P(cx - hw * 0.9, y + h * 0.62)} ${P(cx - hw * 0.66, y + h * 0.9)} ${P(cx - hw * 0.36, y + h * 0.95)}C${P(cx - hw * 0.6, y + h * 0.86)} ${P(cx - hw * 0.78, y + h * 0.7)} ${P(cx - hw * 0.78, y + 26)}Z`, MIX.steelLight)),
  shape(body, 'none', ow), shape(roundRect(cx - hw - 12, y - 12, w + 24, 26, 12), MIX.steelDark, ow), lid);
  if (label) parts.push(lettering(doc, label, { x: cx, y: y + h * 0.3, cap: Math.min(52, w * 0.12), color: C.ink }));
  return parts.join('');
}

/**
 * The box's own pool, seen from a little above: a paper deck, sage water with ripples and a steel ladder. `gauge`
 * adds a depth post with marks, filled to `level` (0 to 1), and an arrow up when `rising`.
 */
export function pool(doc, { cx, cy, w, ow, gauge = false, level = 0.4, rising = false }) {
  const h = w * 0.52;
  const deck = roundRect(cx - w / 2, cy - h / 2, w, h, h * 0.3);
  const water = roundRect(cx - w / 2 + 26, cy - h / 2 + 26, w - 52, h - 52, h * 0.22);
  const ripples = [-0.18, 0.12].map((dy, i) => `M${P(cx - w * 0.3 + i * 30, cy + dy * h)}q${r2(w * 0.05)} -14 ${r2(w * 0.1)} 0t${r2(w * 0.1)} 0t${r2(w * 0.1)} 0`).join('');
  const rx = cx + w / 2 - 80;
  const ladder = band(`M${P(rx - 20, cy - h / 2 + 44)}V${r2(cy - h / 2 - 34)}Q${P(rx - 20, cy - h / 2 - 60)} ${P(rx - 46, cy - h / 2 - 60)}`, C.steel, 12, ow * 0.7)
    + band(`M${P(rx + 20, cy - h / 2 + 44)}V${r2(cy - h / 2 - 34)}Q${P(rx + 20, cy - h / 2 - 60)} ${P(rx - 6, cy - h / 2 - 60)}`, C.steel, 12, ow * 0.7)
    + band(`M${P(rx - 20, cy - h / 2 + 14)}H${r2(rx + 20)}`, C.steel, 8, ow * 0.6, 'butt');
  const parts = [shape(deck, C.paper, ow), shape(water, C.sage, ow), clipped(doc, water, halftone(doc, water, MIX.sageDark, 13, 2.2)), line(ripples, MIX.sageLight, ow * 0.9), ladder];
  if (gauge) {
    const gx = cx - w / 2 + 70;
    const gTop = cy - h / 2 - 150;
    const gBottom = cy + h / 2 - 50;
    const post = roundRect(gx - 22, gTop, 44, gBottom - gTop, 10);
    const fillTop = gBottom - (gBottom - gTop) * level;
    const marks = [0.2, 0.4, 0.6, 0.8].map((t) => `M${P(gx - 22, gBottom - (gBottom - gTop) * t)}h16`).join('');
    parts.push(shape(post, C.paper, ow), clipped(doc, post, rect(gx - 30, fillTop, 60, gBottom - fillTop + 10, `fill="${C.sage}"`)), shape(post, 'none', ow), line(marks, C.ink, ow * 0.7, { cap: 'butt' }));
    if (rising) parts.push(arrow(gx + 64, fillTop + 70, gx + 64, fillTop - 40, { color: C.sage, ow, width: 14 }));
  }
  return parts.join('');
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
  // The words shrink to fit between the corner braces, never past them. A stencil stroke may reach one unit (a tenth
  // of the cap height) past its letter's box, as the 4's corner does, so the fit keeps that unit free on each side.
  const fit = words.length ? Math.min(cap, (cap * (w - 120)) / (measure(words, cap).w + (2 * cap) / CAP)) : cap;
  const words2 = words.length ? lettering(doc, words, { x: cx, y: y + h / 2 - measure(words, fit).h / 2, cap: fit, color }) : '';
  return body + line(planks.join(''), MIX.crateDark, ow * 0.6) + brace(x) + brace(x + w - 40) + nails + lip + words2;
}

/** A white peaked cap and a pair of eyes peeking over an edge at y: a marine waiting inside the crate. */
export function peeker(cx, y, size, ow, look = 0) {
  const hw = size / 2;
  const face = roundRect(cx - hw * 0.74, y + 4, hw * 1.48, size * 0.42, 18);
  const crown = `M${P(cx - hw * 0.8, y - 2)}C${P(cx - hw * 1.18, y - size * 0.18)} ${P(cx - hw * 1.1, y - size * 0.5)} ${P(cx, y - size * 0.52)}C${P(cx + hw * 1.1, y - size * 0.5)} ${P(cx + hw * 1.18, y - size * 0.18)} ${P(cx + hw * 0.8, y - 2)}Z`;
  const bandD = roundRect(cx - hw * 0.8, y - size * 0.16, hw * 1.6, size * 0.15, size * 0.05);
  const visor = `M${P(cx - hw * 0.82, y)}Q${P(cx, y - size * 0.06)} ${P(cx + hw * 0.82, y)}Q${P(cx + hw * 0.6, y + size * 0.12)} ${P(cx, y + size * 0.13)}Q${P(cx - hw * 0.6, y + size * 0.12)} ${P(cx - hw * 0.82, y)}Z`;
  const eye = (ex) => flat(ellipsePath(ex + look, y + size * 0.26, size * 0.055, size * 0.075), C.ink) + flat(circlePath(ex + look - 2, y + size * 0.24, size * 0.02), MIX.glint);
  return shape(face, C.paper, ow) + eye(cx - hw * 0.34) + eye(cx + hw * 0.34) + shape(crown, C.white, ow) + shape(bandD, C.navy, ow * 0.8)
    + shape(visor, C.ink, ow * 0.8) + coin(cx, y - size * 0.28, size * 0.08, ow * 0.6);
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
  if (mark === 'check') parts.push(shape(circlePath(mx, my, h * 0.75), C.walnut, ow), band(`M${P(mx - h * 0.34, my)}L${P(mx - h * 0.08, my + h * 0.28)}L${P(mx + h * 0.38, my - h * 0.3)}`, C.white, h * 0.16, 0));
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

/** The space a sign or a speech bubble keeps between its edge and its words, on each side. */
const SIGN_PAD = 30;
/** The cap height that fits `list` into a board `w` wide with SIGN_PAD to spare on each side, at most `cap`. */
const signFit = (list, cap, w) => Math.min(cap, (cap * (w - 2 * SIGN_PAD)) / measure(list, cap).w);

/** A paper sign with an ink border and stencilled lines, centred on (cx, cy), optionally hanging on two cords. */
export function sign(doc, { cx, cy, w, h, lines, cap, ow, color = C.ink, paper = C.paper, cords = null }) {
  const board = roundRect(cx - w / 2, cy - h / 2, w, h, 12);
  const list = Array.isArray(lines) ? lines : [lines];
  // The words shrink to fit inside the board with SIGN_PAD to spare on each side, never past its edge.
  const fit = list.length ? signFit(list, cap, w) : cap;
  const blockH = list.length ? measure(list, fit).h : 0;
  const hang = cords === null ? '' : line(`M${P(cx - w * 0.3, cy - h / 2)}L${P(cx, cords)}L${P(cx + w * 0.3, cy - h / 2)}`, C.ink, ow * 0.7);
  return hang + shape(board, paper, ow) + (list.length ? lettering(doc, list, { x: cx, y: cy - blockH / 2, cap: fit, color }) : '');
}

/** A speech bubble with stencilled words, its tail pointing to (tx, ty). Its words fit like a sign's. */
export function bubble(doc, { cx, cy, w, h, lines, cap, ow, tx, ty }) {
  const body = roundRect(cx - w / 2, cy - h / 2, w, h, h * 0.4);
  const tail = poly([[cx - w * 0.12, cy + h / 2 - 4], [tx, ty], [cx + w * 0.06, cy + h / 2 - 4]]);
  const list = Array.isArray(lines) ? lines : [lines];
  const fit = signFit(list, cap, w);
  const blockH = measure(list, fit).h;
  return shape(tail, C.white, ow) + shape(body, C.white, ow) + flat(roundRect(cx - w / 2 + ow, cy + h / 2 - ow * 3, w * 0.3, ow * 2, ow), C.white)
    + lettering(doc, list, { x: cx, y: cy - blockH / 2, cap: fit, color: C.ink });
}

/** The claim button: a walnut pill with stencilled CLAIM in cap white. */
export function button(doc, { cx, cy, w, h, ow, label = 'CLAIM' }) {
  return shape(roundRect(cx - w / 2, cy - h / 2 + 8, w, h, h / 2), MIX.walnutDark, ow) + shape(roundRect(cx - w / 2, cy - h / 2, w, h, h / 2), C.walnut, ow)
    + lettering(doc, label, { x: cx, y: cy - h * 0.22, cap: h * 0.44, color: C.white });
}

/** A paper pointer arrow, its tip at (x, y). */
export function pointer(x, y, size, ow) {
  const s = size / 100;
  const d = poly([[0, 0], [0, 78], [20, 60], [34, 92], [50, 85], [36, 54], [62, 54]].map(([px, py]) => [x + px * s, y + py * s]));
  return shape(d, C.paper, ow);
}

/** The rules plaque: a steel plate held by four bolts, with stencilled lines. */
export function plaque(doc, { cx, cy, w, h, lines, cap, ow }) {
  const plate = roundRect(cx - w / 2, cy - h / 2, w, h, 18);
  const bolts = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => {
    const bx = cx + sx * (w / 2 - 34);
    const by = cy + sy * (h / 2 - 30);
    return shape(circlePath(bx, by, 14), MIX.steelDark, ow * 0.7) + line(`M${P(bx - 8, by)}H${r2(bx + 8)}`, C.ink, ow * 0.6);
  }).join('');
  const list = Array.isArray(lines) ? lines : [lines];
  const blockH = measure(list, cap).h;
  return shape(roundRect(cx - w / 2 + 10, cy - h / 2 + 12, w, h, 18), MIX.steelDark, ow) + shape(plate, C.steel, ow)
    + clipped(doc, plate, halftone(doc, `M${P(cx + w * 0.25, cy - h)}H${r2(cx + w)}V${r2(cy + h)}H${r2(cx + w * 0.25)}Z`, MIX.steelDark, 13))
    + shape(plate, 'none', ow) + bolts + lettering(doc, list, { x: cx, y: cy - blockH / 2, cap, color: C.ink });
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

/** The closing pool jar: a glass jar with a lid, holding coins, where holders hand in the box's token for their part. */
export function jar(doc, { cx, y, w, ow, coins = 8, label = null }) {
  const h = w * 1.2;
  const glass = `M${P(cx - w * 0.38, y + 40)}Q${P(cx - w / 2, y + 60)} ${P(cx - w / 2, y + 140)}V${r2(y + h - 40)}Q${P(cx - w / 2, y + h)} ${P(cx - w / 2 + 40, y + h)}`
    + `H${r2(cx + w / 2 - 40)}Q${P(cx + w / 2, y + h)} ${P(cx + w / 2, y + h - 40)}V${r2(y + 140)}Q${P(cx + w / 2, y + 60)} ${P(cx + w * 0.38, y + 40)}Z`;
  const heap = coinHeap(cx, y + h - 12, w * 0.84, coins, w * 0.09, ow * 0.7);
  // The shine runs close to the glass's left side and stops above the coins, clear of the words and of anything
  // that goes into the jar low on its left.
  const shine = flat(`M${P(cx - w * 0.46, y + 150)}V${r2(y + h - 140)}H${r2(cx - w * 0.4)}V${r2(y + 150)}Z`, MIX.glint);
  const lid = shape(roundRect(cx - w * 0.42, y, w * 0.84, 46, 10), C.steel, ow);
  const words = label ? lettering(doc, label, { x: cx, y: y + h * 0.36, cap: w * 0.13, color: C.ink }) : '';
  return shape(glass, MIX.steelLight, ow) + clipped(doc, glass, heap, shine) + shape(glass, 'none', ow) + lid + words;
}

/** Every candle drawn since the last reset, by picture: the kit has one quiet seven, and check.mjs counts them. */
export const CANDLES = [];

/**
 * A white candle in a steel holder standing on the table at y, `h` tall, with a still gold flame: flat inks, no glow.
 * Each candle records its picture's title in CANDLES.
 */
export function candle(doc, { cx, y, h, ow }) {
  CANDLES.push(doc.title);
  const w = h * 0.2;
  const holder = `M${P(cx - w * 1.6, y)}Q${P(cx, y - w * 0.8)} ${P(cx + w * 1.6, y)}Q${P(cx + w * 1.2, y + w * 0.5)} ${P(cx, y + w * 0.5)}Q${P(cx - w * 1.2, y + w * 0.5)} ${P(cx - w * 1.6, y)}Z`;
  const stick = roundRect(cx - w / 2, y - h, w, h - w * 0.2, w * 0.2);
  const flame = `M${P(cx, y - h - w * 2.3)}C${P(cx + w * 0.9, y - h - w * 1.1)} ${P(cx + w * 0.6, y - h - w * 0.1)} ${P(cx, y - h - w * 0.1)}C${P(cx - w * 0.6, y - h - w * 0.1)} ${P(cx - w * 0.9, y - h - w * 1.1)} ${P(cx, y - h - w * 2.3)}Z`;
  return shape(stick, C.white, ow * 0.8) + flat(roundRect(cx + w * 0.1, y - h + w * 0.3, w * 0.28, h - w * 0.8, w * 0.14), MIX.whiteShade)
    + line(`M${P(cx, y - h)}V${r2(y - h - w * 0.5)}`, C.ink, ow * 0.6) + shape(flame, C.gold, ow * 0.7)
    + flat(ellipsePath(cx, y - h - w * 0.75, w * 0.24, w * 0.5), MIX.goldLight) + shape(holder, C.steel, ow * 0.8);
}
