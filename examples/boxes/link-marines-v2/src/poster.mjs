/**
 * The poster ground: the mess hall's panelled wall. Tall panels in one ink, each framed by a sunk moulding (a dark
 * edge below and right, a light edge above and left) and parted from its neighbours by a thin groove. Every picture
 * starts here. The panel grid is the only pattern on the ground, so the art stays calm, and nothing on it radiates from
 * a point. No wall is ever blue: the walls are walnut, khaki, crate wood and ration paper.
 */
import { C, MIX } from './palette.mjs';
import { rect, r2 } from './doc.mjs';

/** The wall colors: each panel ink has a groove ink and a light ink. */
export const WALLS = Object.freeze({
  walnut: [C.walnut, MIX.walnutDark, MIX.walnutLight],
  khaki: [C.khaki, MIX.khakiDark, MIX.khakiLight],
  crate: [C.crate, MIX.crateDark, MIX.crateLight],
  paper: [C.paper, MIX.paperShade, C.white],
});

const id2 = (v) => String(r2(v)).replace('.', '_');

/**
 * The panel grid as a pattern registered once per doc: one panel `w` px wide and 1.25 w tall, with its groove along
 * its top and left edge and its moulding inset by 0.14 w. (x0, y0) is where a groove crossing sits, so a layout can
 * put a panel edge exactly where it wants. Returns the fill value, `url(#...)`.
 */
export function panels(doc, name, w, x0 = 0, y0 = 0) {
  const [, groove, light] = WALLS[name];
  const h = w * 1.25;
  const g = Math.max(2, w / 32);
  const m = w * 0.14;
  const t = Math.max(2, w / 36);
  const id = `panels-${name}-${id2(w)}-${id2(x0)}-${id2(y0)}`;
  const frame = `M${r2(m)} ${r2(m)}H${r2(w - m)}V${r2(h - m)}H${r2(m)}Z`;
  const lit = `M${r2(m + t)} ${r2(h - m - t)}V${r2(m + t)}H${r2(w - m - t)}`;
  return doc.def(id, `<pattern id="${id}" x="${r2(x0 - g / 2)}" y="${r2(y0 - g / 2)}" width="${r2(w)}" height="${r2(h)}" patternUnits="userSpaceOnUse">`
    + `${rect(0, 0, w, g, `fill="${groove}"`)}${rect(0, 0, g, h, `fill="${groove}"`)}`
    + `<path d="${frame}" fill="none" stroke="${groove}" stroke-width="${r2(t)}" stroke-linejoin="miter"/>`
    + `<path d="${lit}" fill="none" stroke="${light}" stroke-width="${r2(t)}" stroke-linejoin="miter" stroke-linecap="butt"/></pattern>`);
}

/**
 * A whole wall over (x, y, w, h): the flat panel ink, then the panel grid. `wall` names one of WALLS. The grid is
 * centred on `cx` by default, so a picture's middle falls on a groove and the wall looks the same on both sides.
 */
export function ground(doc, { x = 0, y = 0, w, h, wall = 'walnut', panel = 128, cx = x + w / 2, top = y }) {
  const [base] = WALLS[wall];
  return rect(x, y, w, h, `fill="${base}"`) + rect(x, y, w, h, `fill="${panels(doc, wall, panel, cx, top)}"`);
}
