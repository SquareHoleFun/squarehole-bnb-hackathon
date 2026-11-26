/**
 * A tiny SVG builder. Parts register shared definitions (blurs, gradients) once by id and return plain markup,
 * so every file is one self-contained SVG with no outside references.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Rounds to two decimals, so the same drawing always prints the same numbers. */
export const r2 = (v) => Number(Number(v).toFixed(2));

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
    this.body.push(...markup.filter(Boolean));
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

/** A Gaussian blur filter with a generous region, for glows. */
export function blur(doc, std) {
  const id = `blur-${key(std)}`;
  return doc.def(id, `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${r2(std)}"/></filter>`);
}

/** A soft radial pool of heat in one color, fading to nothing at the edge. */
export function glowFill(doc, color, strength = 0.35) {
  const id = `glow-${color.slice(1)}-${key(strength)}`;
  return doc.def(id, `<radialGradient id="${id}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${color}" stop-opacity="${r2(strength)}"/><stop offset="0.5" stop-color="${color}" stop-opacity="${r2(strength * 0.4)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`);
}

/** A vertical gradient, top to bottom, through any number of [offset, color, opacity] stops. */
export function vgrad(doc, id, stops) {
  const s = stops.map(([o, c, a = 1]) => `<stop offset="${r2(o)}" stop-color="${c}" stop-opacity="${r2(a)}"/>`).join('');
  return doc.def(id, `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${s}</linearGradient>`);
}

/** A horizontal gradient through any number of [offset, color, opacity] stops. */
export function hgrad(doc, id, stops) {
  const s = stops.map(([o, c, a = 1]) => `<stop offset="${r2(o)}" stop-color="${c}" stop-opacity="${r2(a)}"/>`).join('');
  return doc.def(id, `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${s}</linearGradient>`);
}

export const rect = (x, y, w, h, attrs = '') => `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${attrs}/>`;
export const circle = (cx, cy, r, attrs = '') => `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" ${attrs}/>`;
export const ellipse = (cx, cy, rx, ry, attrs = '') => `<ellipse cx="${r2(cx)}" cy="${r2(cy)}" rx="${r2(rx)}" ry="${r2(ry)}" ${attrs}/>`;
export const path = (d, attrs = '') => `<path d="${d}" ${attrs}/>`;
export const group = (attrs, ...inner) => `<g ${attrs}>${inner.filter(Boolean).join('')}</g>`;
