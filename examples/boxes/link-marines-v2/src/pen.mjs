/**
 * The pen: every shape in the art is a flat ink fill with a boot-black outline, a thick stroke with an ink edge, or a
 * patch of halftone dots, like a poster printed in a few inks. Shading is always dots, never a gradient.
 */
import { C } from './palette.mjs';
import { path, rect, r2 } from './doc.mjs';

const join = 'stroke-linejoin="round" stroke-linecap="round"';

/** A closed shape: fill plus ink outline. */
export const shape = (d, fill, ow) => path(d, `fill="${fill}" stroke="${C.ink}" stroke-width="${r2(ow)}" ${join}`);

/** A closed shape with a hole in it (even-odd fill), plus ink outline: a ring, a handle, a glass. */
export const holed = (d, fill, ow) => path(d, `fill="${fill}" fill-rule="evenodd" stroke="${C.ink}" stroke-width="${r2(ow)}" ${join}`);

/** A plain fill with no outline, for shading and light inside a shape. */
export const flat = (d, fill) => path(d, `fill="${fill}"`);

/** A line with no outline, for seams, folds, stitches and creases. */
export const line = (d, color, width, { cap = 'round', dash = null } = {}) =>
  path(d, `fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linejoin="round" stroke-linecap="${cap}"${dash ? ` stroke-dasharray="${dash}"` : ''}`);

/** A thick stroke with an ink edge, for straps, handles, rods and steam. */
export const band = (d, fill, width, ow, cap = 'round') => line(d, C.ink, width + 2 * ow, { cap }) + line(d, fill, width, { cap });

/**
 * A halftone screen: dots of one color on a staggered grid, `pitch` apart, as a pattern registered once per doc.
 * Shapes filled with it read as shade printed in a second pass. Returns the fill value, `url(#...)`.
 */
export function dots(doc, color, pitch = 14, radius = pitch * 0.24) {
  const id = `dots-${color.slice(1)}-${String(r2(pitch)).replace('.', '_')}-${String(r2(radius)).replace('.', '_')}`;
  const h = pitch / 2;
  return doc.def(id, `<pattern id="${id}" width="${r2(pitch)}" height="${r2(pitch)}" patternUnits="userSpaceOnUse">`
    + `<circle cx="${r2(h / 2)}" cy="${r2(h / 2)}" r="${r2(radius)}" fill="${color}"/>`
    + `<circle cx="${r2(h * 1.5)}" cy="${r2(h * 1.5)}" r="${r2(radius)}" fill="${color}"/></pattern>`);
}

/** A shape filled with halftone dots, with no outline. */
export const halftone = (doc, d, color, pitch, radius) => path(d, `fill="${dots(doc, color, pitch, radius)}"`);

/** Clips markup to a path: registers the clip once and wraps the markup. */
export function clipped(doc, d, ...inner) {
  const id = doc.uid('clip');
  doc.def(id, `<clipPath id="${id}"><path d="${d}"/></clipPath>`);
  return `<g clip-path="url(#${id})">${inner.flat(Infinity).filter(Boolean).join('')}</g>`;
}

/**
 * The flannel: a navy-and-cream plaid in three inks, dress navy with flannel slate bands and thin ration-paper lines
 * both ways, as a pattern registered once per doc. Returns the fill value, `url(#...)`. Only the cook wears it, in
 * one picture; check.mjs counts the pictures whose SVG holds a `plaid-` pattern.
 */
export function plaid(doc, pitch = 64) {
  const id = `plaid-${String(r2(pitch)).replace('.', '_')}`;
  const b = pitch * 0.34;
  const t = Math.max(1.5, pitch * 0.06);
  const mid = b + (pitch - b) / 2;
  return doc.def(id, `<pattern id="${id}" width="${r2(pitch)}" height="${r2(pitch)}" patternUnits="userSpaceOnUse">`
    + rect(0, 0, pitch, pitch, `fill="${C.navy}"`) + rect(0, 0, b, pitch, `fill="${C.slate}"`) + rect(0, 0, pitch, b, `fill="${C.slate}"`)
    + rect(mid - t / 2, 0, t, pitch, `fill="${C.paper}"`) + rect(0, mid - t / 2, pitch, t, `fill="${C.paper}"`)
    + rect(b / 2 - t / 4, 0, t / 2, pitch, `fill="${C.navy}"`) + rect(0, b / 2 - t / 4, pitch, t / 2, `fill="${C.navy}"`)
    + '</pattern>');
}
