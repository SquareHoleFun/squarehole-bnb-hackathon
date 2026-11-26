/**
 * A small SVG builder. Parts register shared definitions (gradients, clips, blurs) once by id and return plain
 * markup, so every file is one self-contained SVG: no fonts, images, scripts or outside references.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Rounds to two decimals, so the same drawing always prints the same numbers. */
export const r2 = (v) => {
  const n = Number(Number(v).toFixed(2));
  return Object.is(n, -0) ? 0 : n;
};

/** A point as "x y" with two decimals. */
export const pt = (x, y) => `${r2(x)} ${r2(y)}`;

export class Doc {
  constructor(width, height, title, desc) {
    this.width = width;
    this.height = height;
    this.title = title;
    this.desc = desc;
    this.defs = new Map();
    this.body = [];
    this.ids = 0;
  }

  /** A fresh id for a definition that belongs to one spot, such as a clip path. Counts per document. */
  uid(prefix) {
    this.ids += 1;
    return `${prefix}-${this.ids}`;
  }

  /** Registers a definition once and returns `url(#id)`. */
  def(id, markup) {
    if (!this.defs.has(id)) this.defs.set(id, markup);
    return `url(#${id})`;
  }

  add(...markup) {
    this.body.push(...markup.flat().filter(Boolean));
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

const key = (v) => String(r2(v)).replace('.', '_').replace('-', 'm');

/** A Gaussian blur with a generous region, for glows and soft light. */
export function blur(doc, std) {
  const id = `blur-${key(std)}`;
  return doc.def(id, `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${r2(std)}"/></filter>`);
}

/** A soft round glow in one color, strongest in the middle and gone at the edge. */
export function glowFill(doc, color, strength = 0.35) {
  const id = `glow-${color.slice(1)}-${key(strength)}`;
  return doc.def(id, `<radialGradient id="${id}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${color}" stop-opacity="${r2(strength)}"/><stop offset="0.5" stop-color="${color}" stop-opacity="${r2(strength * 0.42)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`);
}

/** A vertical gradient, top to bottom, through [offset, color, opacity] stops. */
export function vgrad(doc, id, stops) {
  const s = stops.map(([o, c, a = 1]) => `<stop offset="${r2(o)}" stop-color="${c}" stop-opacity="${r2(a)}"/>`).join('');
  return doc.def(id, `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${s}</linearGradient>`);
}

/** A horizontal gradient, left to right, through [offset, color, opacity] stops. */
export function hgrad(doc, id, stops) {
  const s = stops.map(([o, c, a = 1]) => `<stop offset="${r2(o)}" stop-color="${c}" stop-opacity="${r2(a)}"/>`).join('');
  return doc.def(id, `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${s}</linearGradient>`);
}

/** A radial gradient lit from (fx, fy), both in the shape's own 0 to 1 box, through [offset, color, opacity] stops. */
export function rgrad(doc, id, stops, fx = 0.35, fy = 0.3) {
  const s = stops.map(([o, c, a = 1]) => `<stop offset="${r2(o)}" stop-color="${c}" stop-opacity="${r2(a)}"/>`).join('');
  return doc.def(id, `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.62" fx="${r2(fx)}" fy="${r2(fy)}">${s}</radialGradient>`);
}

/** A clip path made of one path, returned as a `clip-path` attribute value. Ids count per document. */
export function clip(doc, d) {
  const id = doc.uid('clip');
  return doc.def(id, `<clipPath id="${id}"><path d="${d}"/></clipPath>`);
}

export const rect = (x, y, w, h, attrs = '') => `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${attrs}/>`;
export const circle = (cx, cy, r, attrs = '') => `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" ${attrs}/>`;
export const ellipse = (cx, cy, rx, ry, attrs = '') => `<ellipse cx="${r2(cx)}" cy="${r2(cy)}" rx="${r2(rx)}" ry="${r2(ry)}" ${attrs}/>`;
export const path = (d, attrs = '') => `<path d="${d}" ${attrs}/>`;
export const group = (attrs, ...inner) => `<g ${attrs}>${inner.flat().filter(Boolean).join('')}</g>`;

/** Fill and a thin ink line for a closed shape, as attributes. */
export const inked = (fill, outline, width) => `fill="${fill}" stroke="${outline}" stroke-width="${r2(width)}" stroke-linejoin="round"`;

/** A plain line between two points. */
export const line = (x1, y1, x2, y2, attrs = '') => `<path d="M${pt(x1, y1)}L${pt(x2, y2)}" ${attrs}/>`;

/** A closed polygon through points [[x, y], ...]. */
export const poly = (points) => `M${points.map(([x, y]) => pt(x, y)).join('L')}Z`;

/** A rounded rectangle as path data, corner radius `r`. */
export function roundRect(x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  return `M${pt(x + k, y)}L${pt(x + w - k, y)}A${r2(k)} ${r2(k)} 0 0 1 ${pt(x + w, y + k)}L${pt(x + w, y + h - k)}A${r2(k)} ${r2(k)} 0 0 1 ${pt(x + w - k, y + h)}`
    + `L${pt(x + k, y + h)}A${r2(k)} ${r2(k)} 0 0 1 ${pt(x, y + h - k)}L${pt(x, y + k)}A${r2(k)} ${r2(k)} 0 0 1 ${pt(x + k, y)}Z`;
}

/** A pie wedge of a circle from angle a0 to a1 in degrees, measured clockwise from twelve o'clock. */
export function wedge(cx, cy, r, a0, a1) {
  const at = (a) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)];
  const [x0, y0] = at(a0);
  const [x1, y1] = at(a1);
  return `M${pt(cx, cy)}L${pt(x0, y0)}A${r2(r)} ${r2(r)} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(x1, y1)}Z`;
}

/**
 * A fixed pseudo-random sequence (mulberry32). The same seed always gives the same numbers, so scattered things
 * land in the same place on every build.
 */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
