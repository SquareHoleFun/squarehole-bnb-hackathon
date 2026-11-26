/**
 * Faces for the caricature marines, drawn in a bust box 1000 units wide with the face centred on x = 500.
 * A face is the ration-paper color, like the unprinted paper of a poster, with blush on the cheeks and halftone
 * shade on its right side. Every feature is a few bold shapes: a big nose, a big chin, small eyes or none at all.
 * Nobody eats a coin at mess night: the rations wait on the plates, so no mouth holds one.
 */
import { C, MIX } from './palette.mjs';
import { r2, circlePath, ellipsePath, roundRect } from './doc.mjs';
import { shape, flat, line, band, halftone, clipped } from './pen.mjs';

/** Face geometry from a spec: the brow line `by` sits 38% down the head, everything else hangs from it. */
export function geometry(f) {
  const g = { cx: 500, top: 205, w: 400, h: 500, jaw: 340, chin: 160, ...f };
  g.by = g.top + g.h * 0.38;
  // The eyes sit 64 units under the brow line, so they show under a cap's visor.
  g.ey = g.by + 64 + (g.eyeDrop ?? 0);
  g.ny = g.by + 112 + (g.noseDrop ?? 0);
  g.my = g.by + 196 + (g.mouthDrop ?? 0);
  g.chinY = g.top + g.h;
  return g;
}

/** The head as one path: crown, temples, jaw corners and chin, symmetric about cx. */
export function headPath(g) {
  const { cx, top, w, h, jaw, chin } = g;
  const [L, R] = [cx - w / 2, cx + w / 2];
  const yt = top + h * 0.4;
  const yj = top + h * 0.8;
  const yc = top + h;
  const [jl, jr, cl, cr] = [cx - jaw / 2, cx + jaw / 2, cx - chin / 2, cx + chin / 2];
  const p = (x, y) => `${r2(x)} ${r2(y)}`;
  return `M${p(cx, top)}C${p(cx + w * 0.32, top)} ${p(R, top + h * 0.12)} ${p(R, yt)}`
    + `C${p(R, yt + h * 0.2)} ${p(jr, yj - h * 0.14)} ${p(jr, yj)}C${p(jr, yj + h * 0.1)} ${p(cr, yc)} ${p(cx, yc)}`
    + `C${p(cl, yc)} ${p(jl, yj + h * 0.1)} ${p(jl, yj)}C${p(jl, yj - h * 0.14)} ${p(L, yt + h * 0.2)} ${p(L, yt)}`
    + `C${p(L, top + h * 0.12)} ${p(cx - w * 0.32, top)} ${p(cx, top)}Z`;
}

/** Ears, drawn before the head so the head overlaps them. */
export function ears(g, ow, size = 1) {
  const y = g.top + g.h * 0.5;
  return [-1, 1].map((s) => {
    const x = g.cx + s * (g.w / 2 - 4);
    const inner = `M${r2(x + s * 6)} ${r2(y - 26 * size)}C${r2(x + s * 30 * size)} ${r2(y - 20 * size)} ${r2(x + s * 28 * size)} ${r2(y + 22 * size)} ${r2(x + s * 4)} ${r2(y + 24 * size)}`;
    return shape(ellipsePath(x + s * 14 * size, y, 40 * size, 52 * size), C.paper, ow) + line(inner, MIX.paperDot, ow * 0.9);
  }).join('');
}

/** The neck, under the head, with a band of shade below the chin. */
export function neck(doc, g, ow) {
  const d = `M${r2(g.cx - 86)} ${r2(g.chinY - 90)}V${r2(g.chinY + 120)}H${r2(g.cx + 86)}V${r2(g.chinY - 90)}Z`;
  return shape(d, C.paper, ow) + clipped(doc, d, halftone(doc, ellipsePath(g.cx, g.chinY + 6, 120, 52), MIX.paperDot, 13));
}

/** The head with its shade: halftone on the right side, and under the brim when the hat hides the eyes. */
export function head(doc, g, ow, { brimShade = false } = {}) {
  const d = headPath(g);
  const side = halftone(doc, ellipsePath(g.cx + g.w * 0.46, g.top + g.h * 0.64, g.w * 0.3, g.h * 0.6), MIX.paperDot, 13);
  const brim = brimShade ? halftone(doc, `M${r2(g.cx - g.w)} ${r2(g.by - 40)}H${r2(g.cx + g.w)}V${r2(g.by + 34)}Q${r2(g.cx)} ${r2(g.by + 92)} ${r2(g.cx - g.w)} ${r2(g.by + 34)}Z`, MIX.paperDot, 11, 3.4) : '';
  return shape(d, C.paper, ow) + clipped(doc, d, side, brim) + shape(d, 'none', ow);
}

/** Cheeks: two flat blush spots. */
export function cheeks(g, spread = 0.31, r = 36) {
  return [-1, 1].map((s) => flat(circlePath(g.cx + s * g.w * spread, g.ny + 40, r), MIX.blush)).join('');
}

const glint = (x, y, r) => flat(circlePath(x, y, r), MIX.glint);

/** Eyes, in one of a few kinds. Hidden eyes are two glints in the shade of the brim. */
export function eyes(g, kind, ow) {
  const xs = [g.cx - g.w * 0.2, g.cx + g.w * 0.2];
  const y = g.ey;
  const both = (f) => xs.map((x, i) => f(x, i)).join('');
  switch (kind) {
    case 'hidden': return both((x) => glint(x, y - 6, 9));
    case 'dots': return both((x) => flat(ellipsePath(x, y, 15, 20), C.ink) + glint(x - 5, y - 8, 5));
    case 'wide': return both((x) => shape(ellipsePath(x, y, 30, 34), MIX.glint, ow * 0.8) + flat(circlePath(x + 4, y + 4, 13), C.ink) + glint(x, y - 2, 4));
    case 'happy': return both((x) => line(`M${r2(x - 24)} ${r2(y + 8)}Q${r2(x)} ${r2(y - 22)} ${r2(x + 24)} ${r2(y + 8)}`, C.ink, ow * 1.1));
    case 'sleepy': return both((x) => line(`M${r2(x - 24)} ${r2(y)}Q${r2(x)} ${r2(y + 18)} ${r2(x + 24)} ${r2(y)}`, C.ink, ow * 1.1));
    case 'squint': return both((x, i) => line(`M${r2(x - 22)} ${r2(y + (i ? -4 : 4))}L${r2(x + 22)} ${r2(y + (i ? 4 : -4))}`, C.ink, ow * 1.1));
    case 'wink': return flat(ellipsePath(xs[0], y, 15, 20), C.ink) + glint(xs[0] - 5, y - 8, 5)
      + line(`M${r2(xs[1] - 24)} ${r2(y + 2)}Q${r2(xs[1])} ${r2(y - 16)} ${r2(xs[1] + 24)} ${r2(y + 2)}`, C.ink, ow * 1.1);
    default: throw new Error(`no eyes of kind ${kind}`);
  }
}

/**
 * Brows: thick bars. A positive `tilt` turns their inner ends down (cross), a negative one up (worried). `bushy`
 * makes them wide tufts with an ink edge, in `color`, for the oldest marines.
 */
export function brows(g, tilt = 0, lift = 0, { color = C.ink, bushy = false, ow = 10 } = {}) {
  const y = g.ey - 46 - lift;
  return [-1, 1].map((s) => {
    const x = g.cx + s * g.w * 0.2;
    const bar = bushy
      ? shape('M-50 6C-46 -18 -20 -24 0 -20C24 -26 48 -16 54 4C30 -4 12 4 0 -2C-14 6 -34 -2 -50 6Z', color, ow * 0.6)
      : flat(roundRect(-36, -11, 72, 22, 11), color);
    return `<g transform="translate(${r2(x)} ${r2(y)}) rotate(${r2(-s * tilt)})${bushy && s < 0 ? ' scale(-1 1)' : ''}">${bar}</g>`;
  }).join('');
}

/** The nose: a big round nose with a blush tip and a shine. */
export function nose(g, ow, { rx = 50, ry = 44, red = false } = {}) {
  const [x, y] = [g.cx + 4, g.ny];
  return shape(ellipsePath(x, y, rx, ry), red ? MIX.blush : C.paper, ow)
    + flat(ellipsePath(x + rx * 0.25, y + ry * 0.3, rx * 0.5, ry * 0.42), red ? MIX.tongue : MIX.blush)
    + flat(ellipsePath(x - rx * 0.35, y - ry * 0.35, rx * 0.2, ry * 0.15), MIX.glint);
}

/** A row of teeth along the top of a mouth, from x1 to x2, `deep` tall. */
function teeth(x1, x2, y, deep, ow, gap = false) {
  const n = 4;
  const w = (x2 - x1) / n;
  const d = `M${r2(x1)} ${r2(y)}H${r2(x2)}V${r2(y + deep - 6)}Q${r2(x2)} ${r2(y + deep)} ${r2(x2 - 6)} ${r2(y + deep)}H${r2(x1 + 6)}Q${r2(x1)} ${r2(y + deep)} ${r2(x1)} ${r2(y + deep - 6)}Z`;
  const splits = Array.from({ length: n - 1 }, (_, i) => line(`M${r2(x1 + (i + 1) * w)} ${r2(y + 2)}V${r2(y + deep - 3)}`, MIX.paperDot, ow * 0.6)).join('');
  const hole = gap ? flat(roundRect(x1 + w * 1.5, y + 4, w, deep - 4, 4), MIX.mouth) : '';
  return shape(d, MIX.glint, ow * 0.7) + splits + hole;
}

/** Mouths: a grin with teeth, a smile, a chew, an O, a call with the tongue showing, a cheer, or none. */
export function mouth(doc, g, kind, ow, opts = {}) {
  const { cx, my } = g;
  const wide = opts.wide ?? 104;
  switch (kind) {
    case 'call': {
      const open = `M${r2(cx - wide * 0.8)} ${r2(my - 20)}Q${r2(cx)} ${r2(my - 44)} ${r2(cx + wide * 0.8)} ${r2(my - 20)}Q${r2(cx + wide * 0.8)} ${r2(my + 80)} ${r2(cx)} ${r2(my + 84)}Q${r2(cx - wide * 0.8)} ${r2(my + 80)} ${r2(cx - wide * 0.8)} ${r2(my - 20)}Z`;
      const tongue = `M${r2(cx - wide * 0.5)} ${r2(my + 58)}Q${r2(cx)} ${r2(my + 6)} ${r2(cx + wide * 0.5)} ${r2(my + 58)}Q${r2(cx)} ${r2(my + 90)} ${r2(cx - wide * 0.5)} ${r2(my + 58)}Z`;
      return shape(open, MIX.mouth, ow) + clipped(doc, open, flat(tongue, MIX.tongue), teeth(cx - wide * 0.56, cx + wide * 0.56, my - 34, 26, ow)) + shape(open, 'none', ow);
    }
    case 'cheer': {
      const open = `M${r2(cx - wide)} ${r2(my - 10)}Q${r2(cx)} ${r2(my + 4)} ${r2(cx + wide)} ${r2(my - 10)}Q${r2(cx + wide * 0.7)} ${r2(my + 76)} ${r2(cx)} ${r2(my + 80)}Q${r2(cx - wide * 0.7)} ${r2(my + 76)} ${r2(cx - wide)} ${r2(my - 10)}Z`;
      const tongue = `M${r2(cx - wide * 0.46)} ${r2(my + 66)}Q${r2(cx)} ${r2(my + 30)} ${r2(cx + wide * 0.46)} ${r2(my + 66)}Q${r2(cx)} ${r2(my + 86)} ${r2(cx - wide * 0.46)} ${r2(my + 66)}Z`;
      return shape(open, MIX.mouth, ow) + clipped(doc, open, flat(tongue, MIX.tongue), teeth(cx - wide * 0.8, cx + wide * 0.8, my - 14, 30, ow)) + shape(open, 'none', ow);
    }
    case 'grin': {
      const open = `M${r2(cx - wide)} ${r2(my - 16)}Q${r2(cx)} ${r2(my - 4)} ${r2(cx + wide)} ${r2(my - 16)}Q${r2(cx + wide * 0.8)} ${r2(my + 56)} ${r2(cx)} ${r2(my + 60)}Q${r2(cx - wide * 0.8)} ${r2(my + 56)} ${r2(cx - wide)} ${r2(my - 16)}Z`;
      return shape(open, MIX.mouth, ow) + clipped(doc, open, teeth(cx - wide, cx + wide, my - 22, 38, ow, opts.gap)) + shape(open, 'none', ow);
    }
    case 'smile': return line(`M${r2(cx - wide * 0.8)} ${r2(my)}Q${r2(cx)} ${r2(my + 56)} ${r2(cx + wide * 0.8)} ${r2(my)}`, C.ink, ow * 1.2);
    case 'chew': return line(`M${r2(cx - wide * 0.6)} ${r2(my + 14)}Q${r2(cx + 6)} ${r2(my + 34)} ${r2(cx + wide * 0.7)} ${r2(my + 4)}`, C.ink, ow * 1.2);
    case 'o': return shape(ellipsePath(cx, my + 20, 30, 36), MIX.mouth, ow);
    case 'none': return '';
    default: throw new Error(`no mouth of kind ${kind}`);
  }
}

/** A bushy mustache under the nose. */
export function mustache(g, ow, color = C.ink) {
  const { cx } = g;
  const y = g.ny + 40;
  const d = `M${r2(cx)} ${r2(y - 14)}C${r2(cx + 40)} ${r2(y - 34)} ${r2(cx + 120)} ${r2(y - 20)} ${r2(cx + 138)} ${r2(y + 26)}C${r2(cx + 112)} ${r2(y + 10)} ${r2(cx + 80)} ${r2(y + 34)} ${r2(cx + 44)} ${r2(y + 24)}`
    + `C${r2(cx + 24)} ${r2(y + 20)} ${r2(cx + 8)} ${r2(y + 12)} ${r2(cx)} ${r2(y + 4)}C${r2(cx - 8)} ${r2(y + 12)} ${r2(cx - 24)} ${r2(y + 20)} ${r2(cx - 44)} ${r2(y + 24)}`
    + `C${r2(cx - 80)} ${r2(y + 34)} ${r2(cx - 112)} ${r2(y + 10)} ${r2(cx - 138)} ${r2(y + 26)}C${r2(cx - 120)} ${r2(y - 20)} ${r2(cx - 40)} ${r2(y - 34)} ${r2(cx)} ${r2(y - 14)}Z`;
  return shape(d, color, ow);
}

/** Stubble: halftone dots over the jaw, clipped to the head. */
export function stubble(doc, g) {
  const jaw = `M${r2(g.cx - g.w)} ${r2(g.ny + 30)}H${r2(g.cx + g.w)}V${r2(g.chinY + 20)}H${r2(g.cx - g.w)}Z`;
  return clipped(doc, headPath(g), halftone(doc, jaw, MIX.khakiDark, 12, 2.2));
}

/** Freckles: a few blush dots on each cheek. */
export function freckles(g) {
  const spots = [[-0.34, 6], [-0.27, 22], [-0.38, 26], [0.34, 6], [0.27, 22], [0.38, 26]];
  return spots.map(([fx, dy]) => flat(circlePath(g.cx + fx * g.w, g.ny + dy, 7), MIX.tongue)).join('');
}

/** A point on the cubic curve p0 p1 p2 p3 at t, and the curve's direction there. */
function cubic([p0, p1, p2, p3], t) {
  const u = 1 - t;
  const at = (i) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i];
  const slope = (i) => 3 * u * u * (p1[i] - p0[i]) + 6 * u * t * (p2[i] - p1[i]) + 3 * t * t * (p3[i] - p2[i]);
  const [dx, dy] = [slope(0), slope(1)];
  const len = Math.hypot(dx, dy) || 1;
  return { x: at(0), y: at(1), ux: dx / len, uy: dy / len };
}

/**
 * A braid of hair, drawn before the ears and the head: it starts under the hat, falls past the side of the face and
 * ends on the shoulder with an orange tie and a tuft. `side` is -1 for the left, 1 for the right.
 */
export function braid(g, ow, side = 1, hair = MIX.hair) {
  const s = side;
  const pts = [
    [g.cx + s * (g.w / 2 - 50), g.by - 10],
    [g.cx + s * (g.w / 2 + 40), g.by + 120],
    [g.cx + s * (g.w / 2 + 50), g.chinY - 40],
    [g.cx + s * (g.w / 2 + 6), 900],
  ];
  const P = (x, y) => `${r2(x)} ${r2(y)}`;
  const d = `M${P(...pts[0])}C${P(...pts[1])} ${P(...pts[2])} ${P(...pts[3])}`;
  const width = 64;
  const marks = [];
  for (let i = 1; i < 9; i += 1) {
    const { x, y, ux, uy } = cubic(pts, 0.25 + i * 0.075);
    const [nx, ny] = [-uy, ux];
    // One plait: a short chevron across the braid, pointing down the braid.
    marks.push(`M${P(x - nx * width * 0.42 - ux * 12, y - ny * width * 0.42 - uy * 12)}L${P(x, y)}L${P(x + nx * width * 0.42 - ux * 12, y + ny * width * 0.42 - uy * 12)}`);
  }
  const end = cubic(pts, 1);
  const tie = `M${P(end.x - 34, end.y - 6)}L${P(end.x + 34, end.y - 6)}`;
  const tuft = `M${P(end.x - 30, end.y + 4)}Q${P(end.x - 26, end.y + 60)} ${P(end.x - 4, end.y + 74)}Q${P(end.x + 2, end.y + 40)} ${P(end.x + 8, end.y + 76)}`
    + `Q${P(end.x + 30, end.y + 56)} ${P(end.x + 30, end.y + 4)}Z`;
  return band(d, hair, width, ow) + line(marks.join(''), C.ink, ow * 0.6) + shape(tuft, hair, ow) + band(tie, C.orange, 20, ow * 0.8, 'butt');
}

/** A curled mustache with its ends turned up, in `color`. */
export function handlebar(g, ow, color = C.ink) {
  const { cx } = g;
  const y = g.ny + 44;
  const half = (s) => `M${r2(cx)} ${r2(y - 12)}C${r2(cx + s * 50)} ${r2(y - 30)} ${r2(cx + s * 100)} ${r2(y - 6)} ${r2(cx + s * 128)} ${r2(y - 30)}`
    + `C${r2(cx + s * 150)} ${r2(y - 50)} ${r2(cx + s * 170)} ${r2(y - 34)} ${r2(cx + s * 160)} ${r2(y - 12)}C${r2(cx + s * 150)} ${r2(y + 10)} ${r2(cx + s * 110)} ${r2(y + 26)} ${r2(cx + s * 60)} ${r2(y + 20)}`
    + `C${r2(cx + s * 30)} ${r2(y + 16)} ${r2(cx + s * 10)} ${r2(y + 10)} ${r2(cx)} ${r2(y + 4)}Z`;
  return shape(half(1), color, ow) + shape(half(-1), color, ow);
}

/** Round spectacles over the eyes: two steel rims with glass shine and a bridge, with arms back to the ears. */
export function spectacles(g, ow) {
  const xs = [g.cx - g.w * 0.2, g.cx + g.w * 0.2];
  const y = g.ey;
  const r = 52;
  const lens = (x) => `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r}" fill="none" stroke="${C.ink}" stroke-width="${r2(ow * 1.9)}"/>`
    + `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r}" fill="none" stroke="${C.steel}" stroke-width="${r2(ow * 0.9)}"/>`
    + line(`M${r2(x - 30)} ${r2(y - 18)}Q${r2(x - 20)} ${r2(y - 34)} ${r2(x - 2)} ${r2(y - 36)}`, MIX.glint, ow * 0.8);
  const bridge = line(`M${r2(xs[0] + r)} ${r2(y - 6)}Q${r2(g.cx)} ${r2(y - 22)} ${r2(xs[1] - r)} ${r2(y - 6)}`, C.ink, ow * 1.1);
  const arms = line(`M${r2(xs[0] - r)} ${r2(y - 4)}L${r2(g.cx - g.w / 2 + 6)} ${r2(y - 14)}M${r2(xs[1] + r)} ${r2(y - 4)}L${r2(g.cx + g.w / 2 - 6)} ${r2(y - 14)}`, C.ink, ow * 0.9);
  return arms + lens(xs[0]) + lens(xs[1]) + bridge;
}

/** Sideburns down both cheeks, in `color`, clipped to the head. */
export function sideburns(doc, g, ow, color = MIX.hair) {
  const d = [-1, 1].map((s) => {
    const x = g.cx + s * g.w / 2;
    return `M${r2(x)} ${r2(g.by - 30)}L${r2(x - s * 58)} ${r2(g.by - 20)}L${r2(x - s * 64)} ${r2(g.ny + 40)}Q${r2(x - s * 40)} ${r2(g.ny + 70)} ${r2(x - s * 8)} ${r2(g.ny + 60)}Z`;
  }).join('');
  return clipped(doc, headPath(g), flat(d, color), line(d, C.ink, ow * 0.6));
}
