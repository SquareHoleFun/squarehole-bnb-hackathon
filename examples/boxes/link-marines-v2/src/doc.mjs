/**
 * A small SVG builder. Parts register shared definitions (patterns, masks) once by id and return plain markup,
 * so every file is one self-contained SVG with no outside references, fonts, text elements or images.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Two decimals at most, so the same source always prints the same bytes. */
export const r2 = (v) => {
  const n = Number(Number(v).toFixed(2));
  return Object.is(n, -0) ? 0 : n;
};

/** A point list as SVG path data: M, then L to each point, closed. */
export const poly = (pts) => `M${pts.map(([x, y]) => `${r2(x)} ${r2(y)}`).join('L')}Z`;

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

  /** A fresh id for a definition that belongs to one shape only, such as a mask. */
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
export const ellipse = (cx, cy, rx, ry, attrs = '') => `<ellipse cx="${r2(cx)}" cy="${r2(cy)}" rx="${r2(rx)}" ry="${r2(ry)}" ${attrs}/>`;
export const path = (d, attrs = '') => `<path d="${d}" ${attrs}/>`;
export const group = (attrs, ...inner) => `<g ${attrs}>${inner.flat(Infinity).filter(Boolean).join('')}</g>`;

/** translate, rotate (degrees, about the new origin) and scale, in that order, as one transform attribute. */
export function place(x, y, { rotate = 0, scale = 1 } = {}) {
  const parts = [`translate(${r2(x)} ${r2(y)})`];
  if (rotate) parts.push(`rotate(${r2(rotate)})`);
  if (scale !== 1) parts.push(`scale(${Number(scale.toFixed(4))})`);
  return `transform="${parts.join(' ')}"`;
}

/** A rounded rectangle as path data, so it can be outlined and filled like every other shape. */
export function roundRect(x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  return `M${r2(x + k)} ${r2(y)}H${r2(x + w - k)}A${r2(k)} ${r2(k)} 0 0 1 ${r2(x + w)} ${r2(y + k)}V${r2(y + h - k)}`
    + `A${r2(k)} ${r2(k)} 0 0 1 ${r2(x + w - k)} ${r2(y + h)}H${r2(x + k)}A${r2(k)} ${r2(k)} 0 0 1 ${r2(x)} ${r2(y + h - k)}`
    + `V${r2(y + k)}A${r2(k)} ${r2(k)} 0 0 1 ${r2(x + k)} ${r2(y)}Z`;
}

/** A circle as path data, for shapes that are outlined and filled. */
export function circlePath(cx, cy, r) {
  return `M${r2(cx - r)} ${r2(cy)}A${r2(r)} ${r2(r)} 0 1 0 ${r2(cx + r)} ${r2(cy)}A${r2(r)} ${r2(r)} 0 1 0 ${r2(cx - r)} ${r2(cy)}Z`;
}

/** An ellipse as path data. */
export function ellipsePath(cx, cy, rx, ry) {
  return `M${r2(cx - rx)} ${r2(cy)}A${r2(rx)} ${r2(ry)} 0 1 0 ${r2(cx + rx)} ${r2(cy)}A${r2(rx)} ${r2(ry)} 0 1 0 ${r2(cx - rx)} ${r2(cy)}Z`;
}
