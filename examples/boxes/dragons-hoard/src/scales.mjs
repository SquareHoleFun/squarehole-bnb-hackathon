/**
 * Scales. HOARD in the story is a jade token covered in the dragon's scales, and the dragon shows only as its scaly
 * tail curled around the pile. The dragon itself is never drawn: no head, no face, no eyes, no wings, no claws.
 * The scale pattern is rows of small arches, each row shifted by half an arch, drawn for this kit.
 */
import { C, MIX } from './palette.mjs';
import { r2, pt, path, circle, ellipse, group } from './doc.mjs';

/** Rows of arches covering a w by h box centred on (cx, cy), `cell` wide each, as one stroked path. */
export function archRows(cx, cy, w, h, cell, color, width) {
  const rows = Math.ceil(h / (cell * 0.62)) + 2;
  const cols = Math.ceil(w / cell) + 2;
  const d = [];
  for (let j = 0; j < rows; j += 1) {
    const y = cy - h / 2 - cell * 0.62 + j * cell * 0.62;
    const off = (j % 2) * (cell / 2) - cell;
    for (let i = 0; i < cols; i += 1) {
      const x = cx - w / 2 + off + i * cell;
      d.push(`M${pt(x, y)}A${r2(cell / 2)} ${r2(cell / 2)} 0 0 0 ${pt(x + cell, y)}`);
    }
  }
  return path(d.join(''), `fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linecap="round"`);
}

/**
 * One HOARD token: a jade disc of radius r with its edge showing below, covered in scales inside a rim, with a shine.
 * `ring` adds a vellum ring around it, for "yours" in the story. `fade` draws it dim, for HOARD that is gone.
 */
export function token(doc, cx, cy, r, { ring = false, fade = false } = {}) {
  const o = Math.max(2, r * 0.11);
  const id = doc.uid('scales');
  const clip = doc.def(id, `<clipPath id="${id}"><circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r * 0.78)}"/></clipPath>`);
  const cell = r * (r < 22 ? 0.75 : 0.5);
  const body = (ring ? circle(cx, cy + r * 0.08, r * 1.32, `fill="none" stroke="${C.vellum}" stroke-width="${r2(Math.max(3, r * 0.13))}"`) : '')
    + ellipse(cx, cy + r * 0.16, r, r, `fill="${MIX.jadeDark}" stroke="${C.ink}" stroke-width="${r2(o)}"`)
    + circle(cx, cy, r, `fill="${C.jade}" stroke="${C.ink}" stroke-width="${r2(o)}"`)
    + group(`clip-path="${clip}"`, archRows(cx, cy + r * 0.05, r * 1.7, r * 1.7, cell, MIX.jadeDark, Math.max(1.4, r * 0.085)))
    + circle(cx, cy, r * 0.79, `fill="none" stroke="${MIX.jadeDark}" stroke-width="${r2(r * 0.08)}"`)
    + path(`M${pt(cx - r * 0.5, cy - r * 0.1)}A${r2(r * 0.52)} ${r2(r * 0.52)} 0 0 1 ${pt(cx - r * 0.08, cy - r * 0.52)}`,
      `fill="none" stroke="${MIX.jadeLight}" stroke-width="${r2(r * 0.13)}" stroke-linecap="round"`);
  return fade ? group('opacity="0.38"', body) : body;
}

/** A row of HOARD tokens centred on cx. */
export function tokenRow(doc, cx, cy, count, r, gap = r * 0.5, opts = {}) {
  const step = 2 * r + gap;
  const x0 = cx - ((count - 1) * step) / 2;
  return Array.from({ length: count }, (_, i) => token(doc, x0 + i * step, cy, r, typeof opts === 'function' ? opts(i) : opts)).join('');
}

/** A point on a chain of cubic curves at t from 0 to 1, spread evenly over the curves. */
function bezier(curve, t) {
  const n = curve.length;
  const u = Math.min(n - 1e-9, Math.max(0, t * n));
  const i = Math.floor(u);
  const s = u - i;
  const [p0, p1, p2, p3] = curve[i];
  const k = 1 - s;
  return {
    x: k ** 3 * p0[0] + 3 * k * k * s * p1[0] + 3 * k * s * s * p2[0] + s ** 3 * p3[0],
    y: k ** 3 * p0[1] + 3 * k * k * s * p1[1] + 3 * k * s * s * p2[1] + s ** 3 * p3[1],
  };
}

/** A point, the direction of travel and the tail's width at t, from 0 (the root) to 1 (where the spade starts). */
function along(spec, t) {
  const p = bezier(spec.curve, t);
  const e = 0.0015;
  const a = bezier(spec.curve, Math.max(0, t - e));
  const b = bezier(spec.curve, Math.min(1, t + e));
  let tx = b.x - a.x;
  let ty = b.y - a.y;
  const len = Math.hypot(tx, ty) || 1;
  tx /= len;
  ty /= len;
  return { ...p, tx, ty, nx: -ty, ny: tx, w: spec.w0 + (spec.w1 - spec.w0) * t ** 0.75 };
}

/** A table of t against distance along the tail, so marks can be spaced evenly. */
function lengthTable(spec, steps = 400) {
  const table = [[0, 0]];
  let prev = bezier(spec.curve, 0);
  let sum = 0;
  for (let i = 1; i <= steps; i += 1) {
    const p = bezier(spec.curve, i / steps);
    sum += Math.hypot(p.x - prev.x, p.y - prev.y);
    table.push([i / steps, sum]);
    prev = p;
  }
  return table;
}

/** The t at a distance along the tail. */
function tAt(table, dist) {
  if (dist <= 0) return 0;
  const total = table[table.length - 1][1];
  if (dist >= total) return 1;
  let lo = 0;
  let hi = table.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid][1] < dist) lo = mid; else hi = mid;
  }
  const [t0, d0] = table[lo];
  const [t1, d1] = table[hi];
  return t0 + ((t1 - t0) * (dist - d0)) / (d1 - d0 || 1);
}

/** The distance along the tail at t. */
function distAt(table, t) {
  const i = Math.min(table.length - 2, Math.floor(t * (table.length - 1)));
  const [t0, d0] = table[i];
  const [t1, d1] = table[i + 1];
  return d0 + ((d1 - d0) * (t - t0)) / (t1 - t0 || 1);
}

/** The two side edges of the tail between t0 and t1, as point lists. */
function edges(spec, t0, t1, steps) {
  const left = [];
  const right = [];
  for (let i = 0; i <= steps; i += 1) {
    const p = along(spec, t0 + ((t1 - t0) * i) / steps);
    left.push(pt(p.x + (p.nx * p.w) / 2, p.y + (p.ny * p.w) / 2));
    right.push(pt(p.x - (p.nx * p.w) / 2, p.y - (p.ny * p.w) / 2));
  }
  return { left, right };
}

/** Light falls from the top left. How much the tail's +normal side faces it, from -1 to 1. */
const LIGHT = [-0.5, -0.87];
const facing = (p) => p.nx * LIGHT[0] + p.ny * LIGHT[1];

/**
 * The tail's shaded underside and its shine, between t0 and t1. The shade sits on the edge that faces away from the
 * light and thins to nothing where the tail turns, so it never jumps from one edge to the other.
 */
function shading(spec, t0, t1, steps) {
  const runs = [];
  let run = null;
  const shine = [];
  for (let i = 0; i <= steps; i += 1) {
    const p = along(spec, t0 + ((t1 - t0) * i) / steps);
    const k = facing(p);
    const side = k >= 0 ? -1 : 1;
    const depth = p.w * 0.4 * Math.min(1, Math.abs(k) * 1.8);
    if (!run || run.side !== side) {
      run = { side, outer: [], inner: [] };
      runs.push(run);
    }
    run.outer.push(pt(p.x + side * p.nx * p.w * 0.5, p.y + side * p.ny * p.w * 0.5));
    run.inner.push(pt(p.x + side * p.nx * (p.w * 0.5 - depth), p.y + side * p.ny * (p.w * 0.5 - depth)));
    const off = p.w * 0.3 * Math.max(-1, Math.min(1, k * 1.8));
    shine.push(pt(p.x + p.nx * off, p.y + p.ny * off));
  }
  const shade = runs.filter((r) => r.outer.length > 1)
    .map((r) => `M${r.outer.join('L')}L${[...r.inner].reverse().join('L')}Z`).join('');
  return (shade ? path(shade, `fill="${MIX.jadeDark}" fill-opacity="0.62"`) : '')
    + path(`M${shine.join('L')}`, `fill="none" stroke="${MIX.jadeLight}" stroke-opacity="0.55" stroke-width="${r2(spec.w1 * 0.12)}" stroke-linecap="round"`);
}

/** Spikes along the tail's back, on its upper edge, between t0 and t1. Drawn under the tail, so only points show. */
function spikes(spec, t0, t1) {
  const out = [];
  const gap = spec.w0 * 1.05;
  for (let dist = distAt(spec.table, t0) + gap * 0.5; dist < distAt(spec.table, t1); dist += gap) {
    const p = along(spec, tAt(spec.table, dist));
    const sgn = facing(p) >= 0 ? 1 : -1;
    const hgt = p.w * 0.72;
    const half = p.w * 0.38;
    const bx = p.x + sgn * p.nx * p.w * 0.3;
    const by = p.y + sgn * p.ny * p.w * 0.3;
    const d = `M${pt(bx - p.tx * half, by - p.ty * half)}L${pt(bx + sgn * p.nx * hgt + p.tx * half * 0.35, by + sgn * p.ny * hgt + p.ty * half * 0.35)}L${pt(bx + p.tx * half, by + p.ty * half)}Z`;
    out.push(path(d, `fill="${MIX.jadeDark}" stroke="${C.ink}" stroke-width="${r2(spec.outline * 0.85)}" stroke-linejoin="round"`));
  }
  return out.join('');
}

/** The scale arches along one stretch of the tail, each arch bulging toward the tip, rows shifted by half an arch. */
function tailArches(spec, t0, t1) {
  const d = [];
  let row = 0;
  for (let dist = distAt(spec.table, t0); dist < distAt(spec.table, t1); row += 1) {
    const p = along(spec, tAt(spec.table, dist));
    const cell = p.w / 1.9;
    for (let c = -2; c <= 2; c += 1) {
      const k = c * cell + (row % 2) * (cell / 2);
      const ax = p.x + p.nx * (k + cell / 2);
      const ay = p.y + p.ny * (k + cell / 2);
      const bx = p.x + p.nx * (k - cell / 2);
      const by = p.y + p.ny * (k - cell / 2);
      d.push(`M${pt(ax, ay)}A${r2(cell / 2)} ${r2(cell / 2)} 0 0 0 ${pt(bx, by)}`);
    }
    dist += cell * 0.6;
  }
  return path(d.join(''), `fill="none" stroke="${MIX.jadeDark}" stroke-width="${r2(Math.max(1.6, spec.w0 * 0.07))}" stroke-linecap="round"`);
}

/**
 * The spade at the tip: two round shoulders and a point, with a darker half and a midrib. It points along the tail
 * and is `spec.spade` long.
 */
function spade(spec) {
  const p = along(spec, 1);
  const L = spec.spade;
  const hw = p.w / 2;
  const at = (u, v) => pt(p.x + p.tx * u + p.nx * v, p.y + p.ty * u + p.ny * v);
  const d = `M${at(-0.04 * L, hw)}C${at(0.06 * L, 0.42 * L)} ${at(-0.1 * L, 0.6 * L)} ${at(0.16 * L, 0.6 * L)}`
    + `C${at(0.44 * L, 0.6 * L)} ${at(0.8 * L, 0.3 * L)} ${at(L, 0)}`
    + `C${at(0.8 * L, -0.3 * L)} ${at(0.44 * L, -0.6 * L)} ${at(0.16 * L, -0.6 * L)}`
    + `C${at(-0.1 * L, -0.6 * L)} ${at(0.06 * L, -0.42 * L)} ${at(-0.04 * L, -hw)}Z`;
  const shade = `M${at(0.05 * L, 0)}L${at(0.05 * L, -0.5 * L)}C${at(0.3 * L, -0.58 * L)} ${at(0.72 * L, -0.34 * L)} ${at(0.97 * L, 0)}Z`;
  const o = spec.outline;
  return path(d, `fill="${C.jade}"`)
    + path(shade, `fill="${MIX.jadeDark}"`)
    + path(`M${at(0.04 * L, 0)}L${at(0.86 * L, 0)}`, `fill="none" stroke="${C.ink}" stroke-opacity="0.5" stroke-width="${r2(o * 0.7)}" stroke-linecap="round"`)
    + path(`M${at(0.16 * L, 0.42 * L)}C${at(0.36 * L, 0.44 * L)} ${at(0.62 * L, 0.26 * L)} ${at(0.76 * L, 0.12 * L)}`, `fill="none" stroke="${MIX.jadeLight}" stroke-opacity="0.7" stroke-width="${r2(o * 0.7)}" stroke-linecap="round"`)
    + path(d, `fill="none" stroke="${C.ink}" stroke-width="${r2(o)}" stroke-linejoin="round"`);
}

/** One stretch of the tail: spikes, body, scales, shading and its two side edges. */
function stretch(doc, spec, t0, t1) {
  const { left, right } = edges(spec, t0, t1, 72);
  const body = `M${left.join('L')}L${[...right].reverse().join('L')}Z`;
  const id = doc.uid('tail');
  const clip = doc.def(id, `<clipPath id="${id}"><path d="${body}"/></clipPath>`);
  return spikes(spec, t0, t1)
    + path(body, `fill="${C.jade}"`)
    + group(`clip-path="${clip}"`, tailArches(spec, t0, t1), shading(spec, t0, t1, 72))
    + path(`M${left.join('L')}M${right.join('L')}`, `fill="none" stroke="${C.ink}" stroke-width="${r2(spec.outline)}" stroke-linejoin="round" stroke-linecap="round"`);
}

/**
 * The dragon's tail. `curve` is a chain of cubic curves ([[x, y] x 4] each) from the root, which sits behind the
 * pile, to the start of the spade. The tail narrows from w0 at the root to w1 at the spade, which is `spade` long.
 * The stretch before `frontFrom` (0 to 1) lies behind the pile. Returns `back` and `front`: draw `back` before the
 * pile and `front` after it.
 */
export function tail(doc, { curve, w0, w1, spade: sp = null, frontFrom = 0.3, outline = null }) {
  const spec = { curve, w0, w1, spade: sp ?? w0 * 1.5, outline: outline ?? Math.max(2.5, w0 * 0.1) };
  spec.table = lengthTable(spec);
  const cut = Math.min(1, Math.max(0, frontFrom));
  const back = cut > 0 ? stretch(doc, spec, 0, Math.min(1, cut + 0.004)) : '';
  const front = (cut < 1 ? stretch(doc, spec, cut, 1) : '') + spade(spec);
  return { back, front };
}
