/**
 * A tiny SVG builder. Parts register shared definitions (clip paths, patterns) once by id and return plain
 * markup, so every file is one self-contained SVG with no outside references, fonts or images.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Two decimals at most, so the same source always prints the same bytes. */
export const r2 = (v) => {
  const n = Number(Number(v).toFixed(2));
  return Object.is(n, -0) ? 0 : n;
};

export class Doc {
  constructor(width, height, title, desc) {
    this.width = width;
    this.height = height;
    this.title = title;
    this.desc = desc;
    this.defs = new Map();
    this.body = [];
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

export const rect = (x, y, w, h, attrs = '') => `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${attrs}/>`;
export const circle = (cx, cy, r, attrs = '') => `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" ${attrs}/>`;
export const ellipse = (cx, cy, rx, ry, attrs = '') => `<ellipse cx="${r2(cx)}" cy="${r2(cy)}" rx="${r2(rx)}" ry="${r2(ry)}" ${attrs}/>`;
export const path = (d, attrs = '') => `<path d="${d}" ${attrs}/>`;
export const group = (attrs, ...inner) => `<g ${attrs}>${inner.flat().filter(Boolean).join('')}</g>`;

/** A rounded rectangle as path data, so it can be outlined and filled like every other shape. */
export function roundRect(x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  return `M${r2(x + k)} ${r2(y)}H${r2(x + w - k)}A${r2(k)} ${r2(k)} 0 0 1 ${r2(x + w)} ${r2(y + k)}V${r2(y + h - k)}`
    + `A${r2(k)} ${r2(k)} 0 0 1 ${r2(x + w - k)} ${r2(y + h)}H${r2(x + k)}A${r2(k)} ${r2(k)} 0 0 1 ${r2(x)} ${r2(y + h - k)}`
    + `V${r2(y + k)}A${r2(k)} ${r2(k)} 0 0 1 ${r2(x + k)} ${r2(y)}Z`;
}
