/**
 * The poster ground: the mess hall's tiled wall. Square tiles in one ink, with grout lines printed over them in a
 * second, slightly darker ink. Every picture starts here. The grout grid is the only pattern on the ground, so the
 * art stays calm, and nothing on it radiates from a point.
 */
import { C, MIX } from './palette.mjs';
import { rect, r2 } from './doc.mjs';

/** The wall colors: each tile ink has one grout ink. */
export const WALLS = Object.freeze({
  olive: [C.olive, MIX.oliveGrout],
  orange: [C.orange, MIX.orangeGrout],
  khaki: [C.khaki, MIX.khakiGrout],
  paper: [C.paper, MIX.paperShade],
  night: [C.night, MIX.nightGrout],
});

/**
 * The grout grid as a pattern registered once per doc: one tile cell `tile` px square with a grout line along its top
 * and its left edge. (x0, y0) is where a grout crossing sits, so a layout can put a tile edge exactly where it wants.
 * Returns the fill value, `url(#...)`.
 */
export function grout(doc, name, tile, x0 = 0, y0 = 0) {
  const [, line] = WALLS[name];
  const g = Math.max(2, tile / 16);
  const id = `grout-${name}-${String(r2(tile)).replace('.', '_')}-${String(r2(x0)).replace('.', '_')}-${String(r2(y0)).replace('.', '_')}`;
  return doc.def(id, `<pattern id="${id}" x="${r2(x0 - g / 2)}" y="${r2(y0 - g / 2)}" width="${r2(tile)}" height="${r2(tile)}" patternUnits="userSpaceOnUse">`
    + `${rect(0, 0, tile, g, `fill="${line}"`)}${rect(0, 0, g, tile, `fill="${line}"`)}</pattern>`);
}

/**
 * A whole wall over (x, y, w, h): the flat tile ink, then the grout grid. `wall` names one of WALLS. The grid is
 * centred on `cx` by default, so a picture's middle falls on a grout line and the wall looks the same on both sides.
 */
export function ground(doc, { x = 0, y = 0, w, h, wall = 'olive', tile = 64, cx = x + w / 2, top = y }) {
  const [base] = WALLS[wall];
  return rect(x, y, w, h, `fill="${base}"`) + rect(x, y, w, h, `fill="${grout(doc, wall, tile, cx, top)}"`);
}
