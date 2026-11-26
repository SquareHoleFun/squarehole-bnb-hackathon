/**
 * The bags. Each kind is drawn in a box (cx, top, w, h) and hangs from the point `hang` = [x, y], the inside of a
 * hook's curl. Every kind returns { art, sil }: its markup and its silhouette for the shadow on the wall. A kind that
 * clips a texture to its own outline also returns `clip` = [id, path data], which src/hang.mjs registers.
 */
import { C, MIX } from './palette.mjs';
import { roundRect, r2, circle, ellipse } from './doc.mjs';
import { shape, flat, line, band } from './pen.mjs';
import { lettering } from './type.mjs';

const SHADE = {
  [C.canvas]: MIX.canvasShade, [MIX.canvasShade]: MIX.canvasDeep, [C.tomato]: MIX.tomatoDark, [C.gold]: MIX.goldDark,
  [C.aqua]: MIX.aquaDark, [C.leaf]: MIX.leafDark, [C.kraft]: MIX.kraftDark, [MIX.kraftLight]: C.kraft,
  [C.steel]: MIX.steelDark, [C.ink]: MIX.nightDeep, [C.plum]: MIX.plumDeep,
};
const LIGHT = {
  [C.canvas]: MIX.white, [C.tomato]: MIX.tomatoLight, [C.gold]: MIX.goldLight, [C.aqua]: MIX.aquaLight,
  [C.leaf]: MIX.leafLight, [C.kraft]: MIX.kraftLight, [MIX.kraftLight]: MIX.canvasShade, [C.steel]: MIX.steelLight,
  [C.ink]: MIX.plumDeep, [C.plum]: MIX.plumLight,
};
export const shadeOf = (color) => SHADE[color] ?? MIX.canvasShade;
export const lightOf = (color) => LIGHT[color] ?? MIX.white;

const P = (x, y) => `${r2(x)} ${r2(y)}`;

/** Straps from points on a bag up to the hang point, meeting in a round top over the hook. */
function straps({ hang, pairs, width, ow, color }) {
  const [hx, hy] = hang;
  const v = ([a, b]) => `M${P(...a)}L${P(hx, hy)}L${P(...b)}`;
  const [front, ...rest] = pairs.map(v);
  return {
    back: rest.map((d) => band(d, shadeOf(color), width, ow)).join(''),
    front: band(front, color, width, ow),
    sil: pairs.map((pair) => [v(pair), width + 2 * ow]),
  };
}

/** Running stitches along a path. */
const stitch = (d, color, ow) => line(d, color, ow * 0.55, `${r2(ow * 1.6)} ${r2(ow * 1.4)}`);

/** A rope or string from a bag up over the hook. */
function cord(points, color, width, ow) {
  const d = `M${points.map(([x, y]) => P(x, y)).join('L')}`;
  return { art: band(d, color, width, ow), sil: [d, width + 2 * ow] };
}

// ------------------------------------------------------------------------------------------------- 01 tote

/** The tote: a canvas bag with two straps, a hem, an optional pocket and an optional print. */
export function tote({ cx, top, w, h, hang, ow, color = C.canvas, pocket = C.tomato, print = null, printColor = C.ink, inPocket = null }) {
  const x = cx - w / 2;
  const hem = h * 0.085;
  const sw = w * 0.065;
  const body = roundRect(x, top, w, h, w * 0.035);
  const s = straps({ hang, width: sw, ow, color, pairs: [
    [[cx - w * 0.25, top + hem], [cx + w * 0.25, top + hem]],
    [[cx - w * 0.31, top + ow], [cx + w * 0.31, top + ow]],
  ] });
  const art = [s.back, shape(body, color, ow)];
  art.push(flat(`M${P(x + w * 0.87, top + hem)}H${r2(x + w - ow / 2)}V${r2(top + h - w * 0.035)}Q${P(x + w - ow / 2, top + h - ow / 2)} ${P(x + w * 0.92, top + h - ow / 2)}H${r2(x + w * 0.87)}Z`, shadeOf(color)));
  art.push(flat(roundRect(x + ow / 2, top + ow / 2, w - ow, hem, w * 0.02), shadeOf(color)));
  art.push(line(`M${P(x, top + hem + ow / 2)}H${r2(x + w)}`, C.ink, ow * 0.7));
  art.push(stitch(`M${P(x + w * 0.05, top + hem * 0.55)}H${r2(x + w * 0.95)}`, shadeOf(shadeOf(color)), ow));
  if (pocket) {
    const pw = w * 0.5;
    const ph = h * 0.33;
    const px = cx - pw / 2;
    const py = top + h * 0.56;
    if (inPocket) art.push(inPocket(cx, py));
    art.push(shape(roundRect(px, py, pw, ph, w * 0.025), pocket, ow));
    art.push(flat(roundRect(px + ow / 2, py + ow / 2, pw - ow, ph * 0.18, w * 0.015), shadeOf(pocket)));
    art.push(stitch(`M${P(px + pw * 0.07, py + ph * 0.32)}V${r2(py + ph * 0.87)}H${r2(px + pw * 0.93)}V${r2(py + ph * 0.32)}`, shadeOf(pocket), ow));
  }
  if (print) art.push(lettering(print, { x: cx, y: top + h * (pocket ? 0.235 : 0.4), cap: w * 0.13, color: printColor, outline: null }));
  art.push(s.front);
  art.push(...[-1, 1].map((k) => shape(roundRect(cx + k * w * 0.25 - sw * 0.75, top + hem * 0.3, sw * 1.5, hem * 1.3, sw * 0.2), shadeOf(color), ow * 0.8)));
  return { art: art.join(''), sil: { fill: [body], stroke: s.sil } };
}

// ------------------------------------------------------------------------------------------------- 02 paper

/** A paper shopping bag: front panel, a side gusset, a folded top and twisted paper handles. */
export function paper({ cx, top, w, h, hang, ow, color = C.kraft }) {
  const fw = w * 0.82;
  const x = cx - w / 2;
  const front = roundRect(x, top, fw, h, w * 0.012);
  const side = `M${P(x + fw, top)}L${P(x + w, top + h * 0.035)}V${r2(top + h - h * 0.02)}L${P(x + fw, top + h)}Z`;
  const sw = w * 0.04;
  const handle = (dx) => [[x + fw * 0.3 + dx, top + h * 0.06], [x + fw * 0.7 + dx, top + h * 0.06]];
  const s = straps({ hang, width: sw, ow, color: C.kraft, pairs: [handle(0), handle(w * 0.07)] });
  const art = [s.back, shape(side, shadeOf(color), ow), shape(front, color, ow)];
  art.push(flat(`M${P(x + ow / 2, top + ow / 2)}H${r2(x + fw - ow / 2)}V${r2(top + h * 0.11)}H${r2(x + ow / 2)}Z`, shadeOf(color)));
  art.push(line(`M${P(x, top + h * 0.11)}H${r2(x + fw)}`, C.ink, ow * 0.6));
  art.push(line(`M${P(x + fw + (w - fw) * 0.5, top + h * 0.03)}V${r2(top + h * 0.6)}L${P(x + fw + (w - fw) * 0.2, top + h * 0.97)}`, MIX.kraftDark, ow * 0.5));
  art.push(line(`M${P(x + fw * 0.06, top + h * 0.86)}H${r2(x + fw * 0.94)}`, shadeOf(color), ow * 0.45));
  art.push(flat(roundRect(x + fw * 0.16, top + h * 0.38, fw * 0.68, h * 0.3, w * 0.03), lightOf(color), 0.55));
  art.push(lettering('PAPER', { x: x + fw / 2, y: top + h * 0.47, cap: w * 0.085, color: MIX.kraftDark, outline: null }));
  art.push(s.front);
  art.push(...[0.3, 0.7].map((f) => circle(x + fw * f, top + h * 0.06, sw * 0.62, `fill="${MIX.kraftDark}" stroke="${C.ink}" stroke-width="${r2(ow * 0.7)}"`)));
  return { art: art.join(''), sil: { fill: [front, side], stroke: s.sil } };
}

// ------------------------------------------------------------------------------------------------- 03 tea

/** A tea bag on its string: the string loops over the hook and its tag hangs on the other side. */
export function tea({ cx, top, w, h, hang, ow, color = C.canvas, tag = C.aqua }) {
  const [hx, hy] = hang;
  const x = cx - w / 2;
  const fold = h * 0.16;
  const body = roundRect(x, top + fold * 0.6, w, h - fold * 0.6, w * 0.06);
  const flap = `M${P(x + w * 0.04, top + fold * 0.6)}L${P(cx, top)}L${P(x + w * 0.96, top + fold * 0.6)}Z`;
  const tw = w * 0.5;
  const th = w * 0.36;
  const tx = hx - w * 0.62;
  const ty = hy + h * 0.12;
  const string = cord([[cx, top + fold * 0.2], [hx, hy], [tx + tw / 2, ty]], C.canvas, ow * 0.55, ow * 0.45);
  const art = [string.art, shape(body, color, ow), shape(flap, shadeOf(color), ow)];
  art.push(flat(roundRect(x + w * 0.1, top + fold + h * 0.06, w * 0.8, h - fold - h * 0.14, w * 0.05), MIX.canvasShade));
  const flecks = [[0.24, 0.32], [0.52, 0.28], [0.76, 0.36], [0.34, 0.5], [0.64, 0.52], [0.22, 0.68], [0.5, 0.7], [0.78, 0.66], [0.38, 0.84], [0.66, 0.85]];
  for (const [fx, fy] of flecks) art.push(flat(roundRect(x + w * fx - w * 0.035, top + h * fy, w * 0.07, w * 0.03, w * 0.015), C.kraft));
  art.push(flat(roundRect(cx - w * 0.06, top + fold * 0.18, w * 0.12, w * 0.05, w * 0.01), C.steel));
  art.push(shape(roundRect(tx, ty, tw, th, w * 0.04), tag, ow));
  art.push(circle(tx + tw / 2, ty + th * 0.18, ow * 0.6, `fill="${MIX.hole}"`));
  art.push(lettering('TEA', { x: tx + tw / 2, y: ty + th * 0.38, cap: th * 0.36, color: C.ink, outline: null }));
  return { art: art.join(''), sil: { fill: [body, flap, roundRect(tx, ty, tw, th, w * 0.04)], stroke: [string.sil] } };
}

// ------------------------------------------------------------------------------------------------- 04 sand

/** A sandbag: a burlap sack tied at the neck, with a rope loop to the hook and a stencilled word. */
export function sand({ cx, top, w, h, hang, ow, color = MIX.kraftLight, id = 'sand' }) {
  const x = cx - w / 2;
  const neck = top + h * 0.2;
  const sack = `M${P(cx - w * 0.14, neck)}C${P(cx - w * 0.3, neck + h * 0.06)} ${P(x, top + h * 0.38)} ${P(x + w * 0.02, top + h * 0.7)}`
    + `C${P(x + w * 0.04, top + h * 0.97)} ${P(cx - w * 0.2, top + h)} ${P(cx, top + h)}C${P(cx + w * 0.2, top + h)} ${P(x + w * 0.96, top + h * 0.97)} ${P(x + w * 0.98, top + h * 0.7)}`
    + `C${P(x + w, top + h * 0.38)} ${P(cx + w * 0.3, neck + h * 0.06)} ${P(cx + w * 0.14, neck)}Z`;
  const flaps = [[-0.13, 0], [-0.17, 0.09], [-0.1, 0.12], [-0.08, 0.05], [-0.02, 0.1], [0.03, 0.03], [0.07, 0.11], [0.12, 0.06], [0.16, 0.1], [0.13, 0]];
  const ruffle = `M${flaps.map(([fx, fy], i) => P(cx + w * fx, fy === 0 ? neck : top + h * (0.2 - fy) + (i % 2) * h * 0.012)).join('L')}Z`;
  const rope = cord([[cx - w * 0.1, neck + h * 0.01], [hang[0], hang[1]], [cx + w * 0.1, neck + h * 0.01]], C.canvas, w * 0.035, ow * 0.8);
  const art = [rope.art, shape(ruffle, color, ow), line(`M${P(cx - w * 0.06, neck - h * 0.01)}L${P(cx - w * 0.08, top + h * 0.1)}M${P(cx + w * 0.05, neck - h * 0.01)}L${P(cx + w * 0.07, top + h * 0.11)}`, shadeOf(color), ow * 0.6), shape(sack, color, ow)];
  const weave = [];
  for (let i = 1; i < 9; i += 1) weave.push(`M${P(x + w * (i / 9), top + h * 0.3)}V${r2(top + h * 0.95)}`);
  for (let j = 0; j < 6; j += 1) weave.push(`M${P(x + w * 0.06, top + h * (0.38 + j * 0.1))}H${r2(x + w * 0.94)}`);
  art.push(`<g clip-path="url(#${id}-clip)">${line(weave.join(''), shadeOf(color), ow * 0.35)}</g>`);
  art.push(lettering('SAND', { x: cx, y: top + h * 0.55, cap: w * 0.15, color: C.ink, outline: null }));
  art.push(band(`M${P(cx - w * 0.16, neck + h * 0.015)}Q${P(cx, neck + h * 0.05)} ${P(cx + w * 0.16, neck + h * 0.015)}`, C.canvas, w * 0.045, ow * 0.8));
  return { art: art.join(''), sil: { fill: [sack, ruffle], stroke: [rope.sil] }, clip: [`${id}-clip`, sack] };
}

// ------------------------------------------------------------------------------------------------- 05 beans

/** A bean bag: a soft pear-shaped blob with panel seams and a carry loop. */
export function beans({ cx, top, w, h, hang, ow, color = C.gold }) {
  const x = cx - w / 2;
  const t = top + h * 0.12;
  const blob = `M${P(cx, t)}C${P(cx + w * 0.22, t)} ${P(cx + w * 0.3, t + h * 0.18)} ${P(cx + w * 0.38, t + h * 0.42)}`
    + `C${P(x + w * 1.02, t + h * 0.6)} ${P(x + w, t + h * 0.86)} ${P(cx + w * 0.3, t + h * 0.88)}`
    + `C${P(cx + w * 0.1, top + h * 1.01)} ${P(cx - w * 0.1, top + h * 1.01)} ${P(cx - w * 0.3, t + h * 0.88)}`
    + `C${P(x, t + h * 0.86)} ${P(x - w * 0.02, t + h * 0.6)} ${P(cx - w * 0.38, t + h * 0.42)}`
    + `C${P(cx - w * 0.3, t + h * 0.18)} ${P(cx - w * 0.22, t)} ${P(cx, t)}Z`;
  const loop = straps({ hang, width: w * 0.05, ow, color: C.ink, pairs: [[[cx - w * 0.07, t + h * 0.02], [cx + w * 0.07, t + h * 0.02]]] });
  const art = [shape(blob, color, ow)];
  art.push(flat(`M${P(cx - w * 0.2, t + h * 0.3)}C${P(cx - w * 0.1, t + h * 0.22)} ${P(cx + w * 0.08, t + h * 0.24)} ${P(cx + w * 0.16, t + h * 0.34)}C${P(cx + w * 0.02, t + h * 0.4)} ${P(cx - w * 0.12, t + h * 0.4)} ${P(cx - w * 0.2, t + h * 0.3)}Z`, shadeOf(color)));
  art.push(line(`M${P(cx, t + h * 0.02)}C${P(cx - w * 0.06, t + h * 0.3)} ${P(cx - w * 0.06, t + h * 0.6)} ${P(cx - w * 0.02, top + h * 0.995)}`, shadeOf(color), ow * 0.6));
  art.push(line(`M${P(cx - w * 0.36, t + h * 0.45)}C${P(cx - w * 0.18, t + h * 0.62)} ${P(cx + w * 0.2, t + h * 0.62)} ${P(cx + w * 0.38, t + h * 0.45)}`, shadeOf(color), ow * 0.6));
  art.push(flat(`M${P(cx - w * 0.33, t + h * 0.5)}C${P(cx - w * 0.3, t + h * 0.4)} ${P(cx - w * 0.24, t + h * 0.36)} ${P(cx - w * 0.2, t + h * 0.38)}C${P(cx - w * 0.24, t + h * 0.46)} ${P(cx - w * 0.28, t + h * 0.6)} ${P(cx - w * 0.33, t + h * 0.5)}Z`, lightOf(color)));
  art.push(loop.front);
  return { art: art.join(''), sil: { fill: [blob], stroke: loop.sil } };
}

// ------------------------------------------------------------------------------------------------- 06 punch

/** A steel chain link pair from (x1, y1) to (x2, y2). */
function chain(x1, y1, x2, y2, s, ow) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const n = Math.max(2, Math.round(len / (s * 1.6)));
  const parts = [];
  for (let i = 0; i < n; i += 1) {
    const f = (i + 0.5) / n;
    const px = x1 + (x2 - x1) * f;
    const py = y1 + (y2 - y1) * f;
    const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    const wide = i % 2 === 0;
    parts.push(`<g transform="translate(${P(px, py)}) rotate(${r2(ang)})">${shape(roundRect(-s, -(wide ? s * 0.55 : s * 0.22), s * 2, wide ? s * 1.1 : s * 0.44, s * 0.5), C.steel, ow * 0.6)}</g>`);
  }
  return parts.join('');
}

/** A punching bag: a dark cylinder with a band, hanging from four chains on a ring. */
export function punch({ cx, top, w, h, hang, ow, color = C.ink, bandColor = C.tomato }) {
  const [hx, hy] = hang;
  const x = cx - w / 2;
  const capH = h * 0.07;
  const bodyTop = top + h * 0.3;
  const body = roundRect(x, bodyTop, w, h * 0.7, w * 0.18);
  const ring = circle(hx, hy + w * 0.06, w * 0.07, `fill="none" stroke="${C.ink}" stroke-width="${r2(w * 0.05 + 2 * ow * 0.6)}"`)
    + circle(hx, hy + w * 0.06, w * 0.07, `fill="none" stroke="${C.steel}" stroke-width="${r2(w * 0.05)}"`);
  const ends = [x + w * 0.1, x + w * 0.37, x + w * 0.63, x + w * 0.9];
  const chains = ends.map((ex) => chain(hx, hy + w * 0.12, ex, bodyTop + capH * 0.4, w * 0.035, ow)).join('');
  const art = [chains, ring, shape(body, color, ow)];
  art.push(shape(roundRect(x - w * 0.02, bodyTop - capH * 0.2, w * 1.04, capH, capH * 0.4), MIX.plumDeep, ow));
  art.push(flat(roundRect(x + w * 0.1, bodyTop + capH * 1.3, w * 0.09, h * 0.55, w * 0.045), MIX.plumDeep));
  art.push(shape(`M${P(x, bodyTop + h * 0.3)}H${r2(x + w)}V${r2(bodyTop + h * 0.42)}H${r2(x)}Z`, bandColor, ow));
  art.push(stitch(`M${P(x + w * 0.04, bodyTop + h * 0.33)}H${r2(x + w * 0.96)}M${P(x + w * 0.04, bodyTop + h * 0.39)}H${r2(x + w * 0.96)}`, shadeOf(bandColor), ow));
  art.push(line(`M${P(x + w * 0.5, bodyTop + capH)}V${r2(bodyTop + h * 0.29)}M${P(x + w * 0.5, bodyTop + h * 0.43)}V${r2(top + h - w * 0.06)}`, MIX.nightDeep, ow * 0.6));
  const sil = { fill: [body], stroke: ends.map((ex) => [`M${P(hx, hy)}L${P(ex, bodyTop)}`, w * 0.07]) };
  return { art: art.join(''), sil };
}

// ------------------------------------------------------------------------------------------------- 07 sleep

/** A rolled sleeping bag: a cylinder lying down, the lining's spiral at one end, two straps and a carry strap. */
export function sleep({ cx, top, w, h, hang, ow, color = C.leaf, lining = C.canvas, strap = C.tomato }) {
  const rh = h * 0.56;
  const y = top + h - rh;
  const x = cx - w / 2;
  const roll = roundRect(x, y, w, rh, rh / 2);
  const ex = x + w - rh / 2;
  const ey = y + rh / 2;
  const sx = [x + w * 0.27, x + w * 0.62];
  const carry = straps({ hang, width: w * 0.045, ow, color: strap, pairs: [[[sx[0], y + ow], [sx[1], y + ow]]] });
  const art = [shape(roll, color, ow)];
  art.push(flat(roundRect(x + w * 0.05, y + rh * 0.14, w * 0.6, rh * 0.12, rh * 0.06), lightOf(color)));
  art.push(shape(`M${P(ex, y)}A${r2(rh / 2)} ${r2(rh / 2)} 0 0 1 ${P(ex, y + rh)}A${r2(rh * 0.42)} ${r2(rh / 2)} 0 0 1 ${P(ex, y)}Z`, shadeOf(color), ow));
  art.push(ellipse(ex + rh * 0.09, ey, rh * 0.36, rh * 0.42, `fill="${lining}" stroke="${C.ink}" stroke-width="${r2(ow)}"`));
  const spiral = [];
  for (let i = 0; i < 3; i += 1) spiral.push(`M${P(ex + rh * 0.09 - rh * (0.27 - i * 0.08), ey)}A${r2(rh * (0.27 - i * 0.08))} ${r2(rh * (0.32 - i * 0.09))} 0 1 1 ${P(ex + rh * 0.09 + rh * (0.27 - i * 0.08), ey)}`);
  art.push(line(spiral.join(''), shadeOf(color), ow * 0.8));
  art.push(...sx.map((s) => shape(roundRect(s - w * 0.035, y - ow * 0.5, w * 0.07, rh + ow, w * 0.012), strap, ow)));
  art.push(...sx.map((s) => shape(roundRect(s - w * 0.045, ey - w * 0.04, w * 0.09, w * 0.08, w * 0.012), C.steel, ow * 0.7)));
  art.push(carry.front);
  return { art: art.join(''), sil: { fill: [roll], stroke: carry.sil } };
}

// ------------------------------------------------------------------------------------------------- 08 gift

/** A gift bag: a glossy dotted bag with tissue paper sticking out and ribbon handles. */
export function gift({ cx, top, w, h, hang, ow, color = C.canvas, dots = C.tomato, tissue = C.gold }) {
  const x = cx - w / 2;
  const body = roundRect(x, top, w, h, w * 0.02);
  const tw = w * 0.88;
  const tx = cx - tw / 2;
  const tissueD = `M${P(tx, top + h * 0.05)}L${P(tx + tw * 0.08, top - h * 0.12)}L${P(tx + tw * 0.24, top - h * 0.02)}L${P(tx + tw * 0.38, top - h * 0.2)}`
    + `L${P(tx + tw * 0.52, top - h * 0.05)}L${P(tx + tw * 0.68, top - h * 0.18)}L${P(tx + tw * 0.8, top - h * 0.03)}L${P(tx + tw * 0.95, top - h * 0.13)}L${P(tx + tw, top + h * 0.05)}Z`;
  const s = straps({ hang, width: w * 0.035, ow, color: dots, pairs: [
    [[cx - w * 0.2, top + h * 0.07], [cx + w * 0.2, top + h * 0.07]],
    [[cx - w * 0.27, top + ow], [cx + w * 0.27, top + ow]],
  ] });
  const art = [s.back, shape(tissueD, tissue, ow)];
  art.push(line(`M${P(tx + tw * 0.38, top - h * 0.16)}L${P(tx + tw * 0.46, top + h * 0.02)}M${P(tx + tw * 0.68, top - h * 0.14)}L${P(tx + tw * 0.62, top + h * 0.02)}`, shadeOf(tissue), ow * 0.6));
  art.push(shape(body, color, ow));
  const dotList = [];
  for (let r = 0; r < 5; r += 1) for (let c = 0; c < 4; c += 1) {
    const dx = x + w * (0.16 + c * 0.23 + (r % 2) * 0.115);
    if (dx > x + w * 0.9) continue;
    dotList.push(circle(dx, top + h * (0.22 + r * 0.17), w * 0.045, `fill="${dots}"`));
  }
  art.push(dotList.join(''));
  art.push(flat(`M${P(x + w * 0.78, top + ow)}H${r2(x + w - ow / 2)}V${r2(top + h - ow / 2)}H${r2(x + w * 0.86)}Z`, MIX.white, 0.35));
  art.push(line(`M${P(x, top + h * 0.12)}H${r2(x + w)}`, shadeOf(color), ow * 0.5));
  art.push(s.front);
  return { art: art.join(''), sil: { fill: [body, tissueD], stroke: s.sil } };
}

// ------------------------------------------------------------------------------------------------- 09 duffel

/** A duffel bag: a lying capsule with a zip, end caps, two stripes and two handles. */
export function duffel({ cx, top, w, h, hang, ow, color = C.tomato, stripe = C.canvas }) {
  const bh = h * 0.6;
  const y = top + h - bh;
  const x = cx - w / 2;
  const body = roundRect(x, y, w, bh, bh * 0.42);
  const s = straps({ hang, width: w * 0.05, ow, color: C.ink, pairs: [
    [[cx - w * 0.2, y + bh * 0.12], [cx + w * 0.2, y + bh * 0.12]],
    [[cx - w * 0.26, y + ow], [cx + w * 0.26, y + ow]],
  ] });
  const art = [s.back, shape(body, color, ow)];
  for (const sx of [-0.12, 0.12]) art.push(flat(`M${P(cx + w * sx - w * 0.035, y + ow / 2)}H${r2(cx + w * sx + w * 0.035)}V${r2(y + bh - ow / 2)}H${r2(cx + w * sx - w * 0.035)}Z`, stripe));
  art.push(...[x + bh * 0.08, x + w - bh * 0.62].map((ex) => shape(roundRect(ex, y + bh * 0.12, bh * 0.54, bh * 0.76, bh * 0.27), shadeOf(color), ow * 0.8)));
  art.push(line(`M${P(x + bh * 0.45, y + bh * 0.2)}H${r2(x + w - bh * 0.45)}`, C.ink, ow * 1.3));
  art.push(line(`M${P(x + bh * 0.45, y + bh * 0.2)}H${r2(x + w - bh * 0.45)}`, C.steel, ow * 0.55, `${r2(ow * 0.6)} ${r2(ow * 0.6)}`));
  art.push(shape(roundRect(cx + w * 0.22, y + bh * 0.16, w * 0.05, bh * 0.16, w * 0.012), C.steel, ow * 0.6));
  art.push(flat(roundRect(x + w * 0.18, y + bh * 0.66, w * 0.64, bh * 0.08, bh * 0.04), lightOf(color), 0.6));
  art.push(s.front);
  return { art: art.join(''), sil: { fill: [body], stroke: s.sil } };
}

// ------------------------------------------------------------------------------------------------- 10 pack

/** A backpack hanging by its grab loop: a rounded body, a front pocket with a zip, and shoulder straps behind. */
export function pack({ cx, top, w, h, hang, ow, color = C.aqua, pocket = C.tomato }) {
  const x = cx - w / 2;
  const t = top + h * 0.08;
  const body = `M${P(x, t + w * 0.4)}A${r2(w / 2)} ${r2(w * 0.4)} 0 0 1 ${P(x + w, t + w * 0.4)}V${r2(top + h - w * 0.08)}Q${P(x + w, top + h)} ${P(x + w * 0.9, top + h)}H${r2(x + w * 0.1)}Q${P(x, top + h)} ${P(x, top + h - w * 0.08)}Z`;
  const loop = straps({ hang, width: w * 0.06, ow, color: C.ink, pairs: [[[cx - w * 0.08, t + ow], [cx + w * 0.08, t + ow]]] });
  const shoulders = [-1, 1].map((k) => band(`M${P(cx + k * w * 0.3, t + w * 0.14)}C${P(cx + k * w * 0.62, t + w * 0.3)} ${P(cx + k * w * 0.62, top + h * 0.7)} ${P(cx + k * w * 0.44, top + h * 0.9)}`, shadeOf(color), w * 0.08, ow)).join('');
  const art = [shoulders, shape(body, color, ow)];
  art.push(line(`M${P(x + w * 0.12, t + w * 0.42)}A${r2(w * 0.38)} ${r2(w * 0.3)} 0 0 1 ${P(x + w * 0.88, t + w * 0.42)}`, shadeOf(color), ow * 0.9));
  const py = top + h * 0.52;
  const pocketD = `M${P(x + w * 0.16, py + w * 0.1)}A${r2(w * 0.34)} ${r2(w * 0.12)} 0 0 1 ${P(x + w * 0.84, py + w * 0.1)}V${r2(top + h * 0.9)}Q${P(x + w * 0.84, top + h * 0.95)} ${P(x + w * 0.78, top + h * 0.95)}H${r2(x + w * 0.22)}Q${P(x + w * 0.16, top + h * 0.95)} ${P(x + w * 0.16, top + h * 0.9)}Z`;
  art.push(shape(pocketD, pocket, ow));
  art.push(line(`M${P(x + w * 0.2, py + w * 0.11)}A${r2(w * 0.3)} ${r2(w * 0.1)} 0 0 1 ${P(x + w * 0.8, py + w * 0.11)}`, C.steel, ow * 0.55, `${r2(ow * 0.6)} ${r2(ow * 0.5)}`));
  art.push(shape(roundRect(x + w * 0.68, py + w * 0.08, w * 0.05, w * 0.12, w * 0.01), C.steel, ow * 0.6));
  art.push(flat(roundRect(x + w * 0.08, t + w * 0.45, w * 0.06, h * 0.32, w * 0.03), lightOf(color), 0.7));
  art.push(loop.front);
  return { art: art.join(''), sil: { fill: [body], stroke: loop.sil } };
}

// ------------------------------------------------------------------------------------------------- 11 chips

/** A bag of chips hanging by the hole in its crimped top, the way snacks hang in a shop. Its top follows the hook. */
export function chips({ cx, w, h, hang, ow, color = C.steel, label = C.tomato }) {
  const [hx, hy] = hang;
  const x = cx - w / 2;
  const t = hy - h * 0.06;
  const teeth = 10;
  const zig = (y, dir) => Array.from({ length: teeth + 1 }, (_, i) => P(x + (w * i) / teeth, y + (i % 2 === 0 ? 0 : dir * h * 0.025))).join('L');
  const crimpH = h * 0.11;
  const pouch = `M${zig(t, -1)}L${P(x + w * 0.97, t + crimpH)}C${P(x + w * 1.04, t + h * 0.4)} ${P(x + w * 1.04, t + h * 0.62)} ${P(x + w * 0.97, t + h - crimpH)}`
    + `L${zig(t + h, 1).split('L').reverse().join('L')}L${P(x + w * 0.03, t + h - crimpH)}C${P(x - w * 0.04, t + h * 0.62)} ${P(x - w * 0.04, t + h * 0.4)} ${P(x + w * 0.03, t + crimpH)}Z`;
  const art = [shape(pouch, color, ow)];
  art.push(flat(`M${P(x + ow, t + ow)}H${r2(x + w - ow)}V${r2(t + crimpH)}H${r2(x + ow)}Z`, shadeOf(color)));
  art.push(flat(`M${P(x + ow, t + h - crimpH)}H${r2(x + w - ow)}V${r2(t + h - ow)}H${r2(x + ow)}Z`, shadeOf(color)));
  art.push(line(`M${P(x, t + crimpH)}H${r2(x + w)}M${P(x, t + h - crimpH)}H${r2(x + w)}`, C.ink, ow * 0.6));
  art.push(flat(`M${P(x + w * 0.1, t + h * 0.2)}L${P(x + w * 0.26, t + h * 0.2)}L${P(x + w * 0.16, t + h * 0.82)}L${P(x + w * 0.06, t + h * 0.82)}Z`, lightOf(color), 0.8));
  art.push(flat(`M${P(x + w * 0.32, t + h * 0.2)}L${P(x + w * 0.38, t + h * 0.2)}L${P(x + w * 0.28, t + h * 0.82)}L${P(x + w * 0.22, t + h * 0.82)}Z`, lightOf(color), 0.6));
  const ly = t + h * 0.28;
  art.push(shape(`M${P(cx - w * 0.3, ly + h * 0.08)}Q${P(cx, ly - h * 0.02)} ${P(cx + w * 0.3, ly + h * 0.08)}V${r2(ly + h * 0.28)}Q${P(cx, ly + h * 0.36)} ${P(cx - w * 0.3, ly + h * 0.28)}Z`, label, ow));
  art.push(lettering('CHIPS', { x: cx, y: ly + h * 0.11, cap: w * 0.11, color: C.canvas, outline: C.ink }));
  const chip = (px, py, s, rot) => `<g transform="translate(${P(px, py)}) rotate(${rot})">${shape(`M${P(-s, 0)}C${P(-s * 0.6, -s * 0.8)} ${P(s * 0.6, -s * 0.9)} ${P(s, -s * 0.1)}C${P(s * 0.8, s * 0.6)} ${P(-s * 0.4, s * 0.8)} ${P(-s, 0)}Z`, C.gold, ow * 0.8)}</g>`;
  art.push(chip(cx - w * 0.14, t + h * 0.74, w * 0.13, -12), chip(cx + w * 0.14, t + h * 0.76, w * 0.12, 18));
  art.push(ellipse(hx, hy + h * 0.005, w * 0.07, h * 0.025, `fill="${MIX.hole}" stroke="${C.ink}" stroke-width="${r2(ow * 0.6)}"`));
  return { art: art.join(''), sil: { fill: [pouch] } };
}

// ------------------------------------------------------------------------------------------------- 12 lemons

/** A net bag of lemons, tied at the top, hanging by its loop. */
export function lemons({ cx, top, w, h, hang, ow, net = C.tomato, fruit = C.gold, id = 'net' }) {
  const x = cx - w / 2;
  const knot = top + h * 0.12;
  const bagD = `M${P(cx - w * 0.06, knot)}C${P(x + w * 0.12, top + h * 0.3)} ${P(x - w * 0.02, top + h * 0.6)} ${P(x + w * 0.1, top + h * 0.86)}`
    + `C${P(x + w * 0.22, top + h * 1.02)} ${P(x + w * 0.78, top + h * 1.02)} ${P(x + w * 0.9, top + h * 0.86)}`
    + `C${P(x + w * 1.02, top + h * 0.6)} ${P(x + w * 0.88, top + h * 0.3)} ${P(cx + w * 0.06, knot)}Z`;
  const lemon = (px, py, rx, ry, rot) => `<g transform="translate(${P(px, py)}) rotate(${rot})">`
    + shape(`M${P(-rx * 1.12, 0)}Q${P(-rx * 0.9, -ry)} ${P(0, -ry)}Q${P(rx * 0.9, -ry)} ${P(rx * 1.12, 0)}Q${P(rx * 0.9, ry)} ${P(0, ry)}Q${P(-rx * 0.9, ry)} ${P(-rx * 1.12, 0)}Z`, fruit, ow * 0.85)
    + ellipse(-rx * 0.3, -ry * 0.4, rx * 0.28, ry * 0.18, `fill="${MIX.goldLight}"`)
    + '</g>';
  const lr = w * 0.19;
  const fruits = [
    [cx - w * 0.2, top + h * 0.8, -8], [cx + w * 0.18, top + h * 0.8, 10], [cx, top + h * 0.62, 4],
    [cx - w * 0.25, top + h * 0.52, -20], [cx + w * 0.24, top + h * 0.54, 16], [cx - w * 0.02, top + h * 0.38, -6],
  ];
  const loop = straps({ hang, width: w * 0.035, ow, color: net, pairs: [[[cx - w * 0.04, knot + ow], [cx + w * 0.04, knot + ow]]] });
  const mesh = [];
  for (let i = -6; i <= 6; i += 1) {
    mesh.push(`M${P(cx + i * w * 0.16 - h * 0.5, top + h * 1.05)}L${P(cx + i * w * 0.16 + h * 0.5, top + h * 0.05)}`);
    mesh.push(`M${P(cx + i * w * 0.16 + h * 0.5, top + h * 1.05)}L${P(cx + i * w * 0.16 - h * 0.5, top + h * 0.05)}`);
  }
  const clipId = `${id}-clip`;
  const art = [
    fruits.map(([px, py, rot]) => lemon(px, py, lr, lr * 0.78, rot)).join(''),
    `<g clip-path="url(#${clipId})">${line(mesh.join(''), C.ink, ow * 0.95)}${line(mesh.join(''), net, ow * 0.45)}</g>`,
    loop.front,
    shape(roundRect(cx - w * 0.07, knot - h * 0.025, w * 0.14, h * 0.06, w * 0.03), net, ow),
  ];
  return { art: art.join(''), sil: { fill: [bagD], stroke: loop.sil }, clip: [clipId, bagD] };
}

/** Every kind, by name. */
export const KINDS = Object.freeze({ tote, paper, tea, sand, beans, punch, sleep, gift, duffel, pack, chips, lemons });
