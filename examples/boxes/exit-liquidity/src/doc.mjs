/**
 * A tiny SVG builder. Parts register shared definitions (blurs, gradients, patterns) once by id
 * and return plain markup, so every file is a single self-contained SVG with no external references.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

/** A Gaussian blur filter with a generous region, for glows. */
export function blur(doc, std) {
  const id = `blur-${String(r2(std)).replace('.', '_')}`;
  return doc.def(id, `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${r2(std)}"/></filter>`);
}

/** A soft radial pool of light in one color, used for the glow a sign throws on the wall. */
export function halo(doc, color, strength = 0.3) {
  const id = `halo-${color.slice(1)}-${String(strength).replace('.', '_')}`;
  return doc.def(id, `<radialGradient id="${id}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${color}" stop-opacity="${strength}"/><stop offset="0.55" stop-color="${color}" stop-opacity="${r2(strength * 0.35)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`);
}

/** A lit face: brighter in the middle, the way a light box looks. */
export function litFace(doc, color) {
  const id = `lit-${color.slice(1)}`;
  return doc.def(id, `<radialGradient id="${id}" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.28"/><stop offset="0.6" stop-color="#FFFFFF" stop-opacity="0.06"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`);
}

/** A vertical two-stop gradient. */
export function vgrad(doc, id, top, bottom, topOpacity = 1, bottomOpacity = 1) {
  return doc.def(id, `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}" stop-opacity="${topOpacity}"/><stop offset="1" stop-color="${bottom}" stop-opacity="${bottomOpacity}"/></linearGradient>`);
}

export const rect = (x, y, w, h, attrs = '') => `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${attrs}/>`;
export const circle = (cx, cy, r, attrs = '') => `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" ${attrs}/>`;
export const path = (d, attrs = '') => `<path d="${d}" ${attrs}/>`;
export const group = (attrs, ...inner) => `<g ${attrs}>${inner.filter(Boolean).join('')}</g>`;
