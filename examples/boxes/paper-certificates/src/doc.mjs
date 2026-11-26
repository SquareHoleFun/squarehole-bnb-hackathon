/**
 * A small SVG builder for the kit. A picture is one self-contained SVG: shapes, clip paths and masks only, with no
 * text elements, fonts, images, scripts or outside references. Numbers are rounded to two decimals, so the same
 * source always prints the same bytes.
 */
const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A number with at most two decimals, never -0. */
export function r2(v) {
  const n = Number(Number(v).toFixed(2));
  return Object.is(n, -0) ? 0 : n;
}

export const pt = (x, y) => `${r2(x)} ${r2(y)}`;

/** A point with one decimal, for the long guilloche and tint lines, where a tenth of a pixel is plenty. */
const r1 = (v) => {
  const n = Number(Number(v).toFixed(1));
  return Object.is(n, -0) ? 0 : n;
};
export const p1 = (x, y) => `${r1(x)} ${r1(y)}`;

/** A list of points as a closed path. */
export const poly = (pts) => `M${pts.map(([x, y]) => pt(x, y)).join('L')}Z`;

/** A list of points as an open path. */
export const polyline = (pts) => `M${pts.map(([x, y]) => pt(x, y)).join('L')}`;

/** A smooth curve through the points (Catmull-Rom as cubic Béziers); closed unless `open`. */
export function smooth(pts, { open = false, tension = 1 } = {}) {
  const n = pts.length;
  const at = open ? (i) => pts[Math.max(0, Math.min(n - 1, i))] : (i) => pts[(i + n) % n];
  let d = `M${pt(...pts[0])}`;
  const last = open ? n - 1 : n;
  for (let i = 0; i < last; i += 1) {
    const [a, b, c, e] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [b[0] + ((c[0] - a[0]) / 6) * tension, b[1] + ((c[1] - a[1]) / 6) * tension];
    const c2 = [c[0] - ((e[0] - b[0]) / 6) * tension, c[1] - ((e[1] - b[1]) / 6) * tension];
    d += `C${pt(...c1)} ${pt(...c2)} ${pt(...c)}`;
  }
  return open ? d : `${d}Z`;
}

/** A rounded rectangle as path data. */
export function roundRect(x, y, w, h, r = 0) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  if (k === 0) return `M${pt(x, y)}H${r2(x + w)}V${r2(y + h)}H${r2(x)}Z`;
  return `M${pt(x + k, y)}H${r2(x + w - k)}A${r2(k)} ${r2(k)} 0 0 1 ${pt(x + w, y + k)}V${r2(y + h - k)}`
    + `A${r2(k)} ${r2(k)} 0 0 1 ${pt(x + w - k, y + h)}H${r2(x + k)}A${r2(k)} ${r2(k)} 0 0 1 ${pt(x, y + h - k)}`
    + `V${r2(y + k)}A${r2(k)} ${r2(k)} 0 0 1 ${pt(x + k, y)}Z`;
}

/** A plain rectangle as path data. */
export const box = (x, y, w, h) => `M${pt(x, y)}H${r2(x + w)}V${r2(y + h)}H${r2(x)}Z`;

/** An ellipse as path data (a circle when ry is left out). */
export function ellipse(cx, cy, rx, ry = rx) {
  return `M${pt(cx - rx, cy)}A${r2(rx)} ${r2(ry)} 0 1 0 ${pt(cx + rx, cy)}A${r2(rx)} ${r2(ry)} 0 1 0 ${pt(cx - rx, cy)}Z`;
}

/** An open arc of a circle from angle a0 to a1 (degrees, 0 = right, clockwise on screen). */
export function arc(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M${pt(...p(a0))}A${r2(r)} ${r2(r)} 0 ${large} ${sweep} ${pt(...p(a1))}`;
}

/** translate, then rotate (degrees) and scale, as one transform attribute. */
export function place(x, y, { rotate = 0, scale = 1, sx, sy } = {}) {
  const parts = [`translate(${pt(x, y)})`];
  if (rotate) parts.push(`rotate(${r2(rotate)})`);
  const a = sx ?? scale;
  const b = sy ?? scale;
  if (a !== 1 || b !== 1) parts.push(`scale(${Number(a.toFixed(4))} ${Number(b.toFixed(4))})`);
  return `transform="${parts.join(' ')}"`;
}

export const rect = (x, y, w, h, attrs = '') => `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${attrs}/>`;
export const path = (d, attrs = '') => `<path d="${d}" ${attrs}/>`;
export const group = (attrs, ...inner) => `<g ${attrs}>${inner.flat(Infinity).filter(Boolean).join('')}</g>`;

/** A seeded random source in [0, 1), so tilts, scribbles and grain land the same way on every build. */
export function seeded(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => {
    h = (h + 0x9e3779b9) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 16), 0x85ebca6b);
    t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
}

export class Doc {
  constructor(width, height, title, desc) {
    Object.assign(this, { width, height, title, desc });
    this.defs = new Map();
    this.body = [];
    this.count = 0;
  }

  /** A definition registered once under its id; returns `url(#id)`. */
  def(id, markup) {
    if (!this.defs.has(id)) this.defs.set(id, markup);
    return `url(#${id})`;
  }

  /** A fresh id for a definition used by one shape only. */
  uid(prefix) {
    this.count += 1;
    return `${prefix}${this.count}`;
  }

  /** A clip path made of the given path data; returns the clip-path attribute. */
  clip(d) {
    const id = this.uid('k');
    this.def(id, `<clipPath id="${id}"><path d="${d}"/></clipPath>`);
    return `clip-path="url(#${id})"`;
  }

  add(...markup) {
    this.body.push(...markup.flat(Infinity).filter(Boolean));
    return this;
  }

  toString() {
    const { width: w, height: h } = this;
    const defs = this.defs.size ? `<defs>${[...this.defs.values()].join('')}</defs>` : '';
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">`,
      `<title>${escape(this.title)}</title>`,
      `<desc>${escape(this.desc)}</desc>`,
      defs,
      ...this.body,
      '</svg>',
      '',
    ].filter((line) => line !== '').join('\n').concat('\n');
  }
}
