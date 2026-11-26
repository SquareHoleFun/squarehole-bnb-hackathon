/**
 * A small SVG builder. Parts register shared definitions (patterns, clip paths) once by id and return plain markup,
 * so every file is one self-contained SVG with no outside references, fonts, text elements or images.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Two decimals at most, so the same source always prints the same bytes. */
export const r2 = (v) => {
  const n = Number(Number(v).toFixed(2));
  return Object.is(n, -0) ? 0 : n;
};

/** A point list as closed path data. */
export const poly = (pts) => `M${pts.map(([x, y]) => `${r2(x)} ${r2(y)}`).join('L')}Z`;

/** A point list as open path data. */
export const polyline = (pts) => `M${pts.map(([x, y]) => `${r2(x)} ${r2(y)}`).join('L')}`;

/**
 * A smooth closed curve through the points (a Catmull-Rom spline as cubic Béziers). `tension` 1 is the plain spline,
 * smaller values pull the curve tighter to the corners.
 */
export function smooth(pts, tension = 1) {
  const n = pts.length;
  const at = (i) => pts[(i + n) % n];
  let d = `M${r2(pts[0][0])} ${r2(pts[0][1])}`;
  for (let i = 0; i < n; i += 1) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + ((p2[0] - p0[0]) / 6) * tension, p1[1] + ((p2[1] - p0[1]) / 6) * tension];
    const c2 = [p2[0] - ((p3[0] - p1[0]) / 6) * tension, p2[1] - ((p3[1] - p1[1]) / 6) * tension];
    d += `C${r2(c1[0])} ${r2(c1[1])} ${r2(c2[0])} ${r2(c2[1])} ${r2(p2[0])} ${r2(p2[1])}`;
  }
  return `${d}Z`;
}

/** A smooth open curve through the points, for lines such as a mouth or a crack. */
export function smoothOpen(pts, tension = 1) {
  const n = pts.length;
  const at = (i) => pts[Math.max(0, Math.min(n - 1, i))];
  let d = `M${r2(pts[0][0])} ${r2(pts[0][1])}`;
  for (let i = 0; i < n - 1; i += 1) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1 = [p1[0] + ((p2[0] - p0[0]) / 6) * tension, p1[1] + ((p2[1] - p0[1]) / 6) * tension];
    const c2 = [p2[0] - ((p3[0] - p1[0]) / 6) * tension, p2[1] - ((p3[1] - p1[1]) / 6) * tension];
    d += `C${r2(c1[0])} ${r2(c1[1])} ${r2(c2[0])} ${r2(c2[1])} ${r2(p2[0])} ${r2(p2[1])}`;
  }
  return d;
}

export class Doc {
  constructor(width, height, title, desc) {
    this.width = width;
    this.height = height;
    this.title = title;
    this.desc = desc;
    this.defs = new Map();
    this.body = [];
    this.serial = 0;
  }

  /** Registers a definition once and returns `url(#id)`. */
  def(id, markup) {
    if (!this.defs.has(id)) this.defs.set(id, markup);
    return `url(#${id})`;
  }

  /** A fresh id for a definition that belongs to one shape only, such as a clip path. */
  uid(prefix) {
    this.serial += 1;
    return `${prefix}${this.serial}`;
  }

  add(...markup) {
    this.body.push(...markup.flat(Infinity).filter(Boolean));
    return this;
  }

  toString() {
    const { width: w, height: h } = this;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">`,
      `<title>${esc(this.title)}</title>`,
      `<desc>${esc(this.desc)}</desc>`,
      `<defs>${[...this.defs.values()].join('')}</defs>`,
      ...this.body,
      '</svg>',
      '',
    ].join('\n');
  }
}

export const rect = (x, y, w, h, attrs = '') => `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${attrs}/>`;
export const circle = (cx, cy, r, attrs = '') => `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" ${attrs}/>`;
export const path = (d, attrs = '') => `<path d="${d}" ${attrs}/>`;
export const group = (attrs, ...inner) => `<g ${attrs}>${inner.flat(Infinity).filter(Boolean).join('')}</g>`;

/** translate, rotate (degrees, about the new origin) and scale, in that order, as one transform attribute. */
export function place(x, y, { rotate = 0, scale = 1, flip = false } = {}) {
  const parts = [`translate(${r2(x)} ${r2(y)})`];
  if (rotate) parts.push(`rotate(${r2(rotate)})`);
  if (scale !== 1 || flip) parts.push(`scale(${flip ? -Number(scale.toFixed(4)) : Number(scale.toFixed(4))} ${Number(scale.toFixed(4))})`);
  return `transform="${parts.join(' ')}"`;
}

/** A rounded rectangle as path data, so it can be outlined and filled like every other shape. */
export function roundRect(x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  return `M${r2(x + k)} ${r2(y)}H${r2(x + w - k)}A${r2(k)} ${r2(k)} 0 0 1 ${r2(x + w)} ${r2(y + k)}V${r2(y + h - k)}`
    + `A${r2(k)} ${r2(k)} 0 0 1 ${r2(x + w - k)} ${r2(y + h)}H${r2(x + k)}A${r2(k)} ${r2(k)} 0 0 1 ${r2(x)} ${r2(y + h - k)}`
    + `V${r2(y + k)}A${r2(k)} ${r2(k)} 0 0 1 ${r2(x + k)} ${r2(y)}Z`;
}

/** An ellipse as path data; a circle when ry is left out. */
export function ellipsePath(cx, cy, rx, ry = rx) {
  return `M${r2(cx - rx)} ${r2(cy)}A${r2(rx)} ${r2(ry)} 0 1 0 ${r2(cx + rx)} ${r2(cy)}A${r2(rx)} ${r2(ry)} 0 1 0 ${r2(cx - rx)} ${r2(cy)}Z`;
}

/** An arch: straight sides from the floor at `bottom`, a half-ellipse on top. Path data, closed along the floor. */
export function archPath(cx, bottom, w, h) {
  const rx = w / 2;
  const ry = Math.min(rx, h);
  const spring = bottom - (h - ry);
  return `M${r2(cx - rx)} ${r2(bottom)}V${r2(spring)}A${r2(rx)} ${r2(ry)} 0 0 1 ${r2(cx + rx)} ${r2(spring)}V${r2(bottom)}Z`;
}

/** A small deterministic random number source, so the same source always draws the same speckles and tilts. */
export function seeded(seed) {
  let s = 2166136261;
  for (const ch of String(seed)) s = Math.imul(s ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
