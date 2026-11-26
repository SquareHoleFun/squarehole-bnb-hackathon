/**
 * The shop wall: plum pegboard with a grid of holes, a wooden shelf, steel hooks, and the dimmed wall for a quiet
 * night. Every size is in px; the hole pitch sets the rhythm of the wall.
 */
import { C, MIX } from './palette.mjs';
import { rect, circle, path, r2 } from './doc.mjs';

/** The hole grid of a wall: [pitch, x of the first hole column, y of the first hole row]. */
export function holes(w, h, pitch = 64, ox = null, oy = null) {
  return [pitch, ox ?? (w % pitch) / 2 + pitch / 2, oy ?? (h % pitch) / 2 + pitch / 2];
}

/** The pegboard: a plum board with a pattern of holes. `dim` gives the darker wall of the quiet night. */
export function wall(doc, { w, h, pitch = 64, hole = 7, ox = null, oy = null, dim = false }) {
  const [, x0, y0] = holes(w, h, pitch, ox, oy);
  const id = `holes-${pitch}-${Math.round(hole * 10)}-${Math.round(x0)}-${Math.round(y0)}${dim ? '-d' : ''}`;
  const fillHole = dim ? MIX.nightDeep : MIX.hole;
  const lip = dim ? C.night : MIX.wallLight;
  const pattern = doc.def(id, `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${r2(x0 - pitch / 2)}" y="${r2(y0 - pitch / 2)}" width="${pitch}" height="${pitch}">`
    + circle(pitch / 2, pitch / 2 + hole * 0.28, hole, `fill="${lip}"`)
    + circle(pitch / 2, pitch / 2, hole, `fill="${fillHole}"`)
    + '</pattern>');
  return rect(0, 0, w, h, `fill="${dim ? C.night : C.plum}"`) + rect(0, 0, w, h, `fill="${pattern}"`);
}

/** A wooden shelf along the bottom: top face from y, front edge below it, to the bottom of the picture. */
export function shelf({ w, y, h, dim = false }) {
  const top = Math.min(26, (h - y) * 0.3);
  return rect(0, y, w, top, `fill="${dim ? MIX.shelfDark : MIX.shelf}"`)
    + rect(0, y + top, w, h - y - top, `fill="${dim ? MIX.nightDeep : MIX.frame}"`)
    + rect(0, y - 3, w, 6, `fill="${C.ink}"`)
    + rect(0, y + top - 2, w, 4, `fill="${C.ink}" fill-opacity="0.5"`);
}

/**
 * A steel J-hook in a pegboard hole at (x, y): a collar in the hole, a shank down, and a curl that opens upward.
 * Returns `back` (the whole hook), `front` (only the curl, drawn again over a strap so the strap sits inside it)
 * and `hang`, the point where a strap rests in the curl.
 */
export function hook({ x, y, len = 70, r = 18, w = 11, ow = 6 }) {
  const by = y + len;
  const whole = `M${r2(x)} ${r2(y)}V${r2(by)}A${r2(r)} ${r2(r)} 0 0 0 ${r2(x + 2 * r)} ${r2(by)}V${r2(by - r * 0.9)}`;
  const curl = `M${r2(x + r)} ${r2(by + r)}A${r2(r)} ${r2(r)} 0 0 0 ${r2(x + 2 * r)} ${r2(by)}V${r2(by - r * 0.9)}`;
  const stroke = (d, color, width) => path(d, `fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linecap="round" stroke-linejoin="round"`);
  const collar = circle(x, y, w * 0.95, `fill="${C.steel}" stroke="${C.ink}" stroke-width="${r2(ow)}"`)
    + circle(x - w * 0.25, y - w * 0.25, w * 0.3, `fill="${MIX.steelLight}"`);
  const shine = path(`M${r2(x - w * 0.18)} ${r2(y + w)}V${r2(by - r * 0.3)}`, `fill="none" stroke="${MIX.steelLight}" stroke-width="${r2(w * 0.28)}" stroke-linecap="round"`);
  return {
    back: stroke(whole, C.ink, w + 2 * ow) + stroke(whole, C.steel, w) + shine + collar,
    front: stroke(curl, C.ink, w + 2 * ow) + stroke(curl, C.steel, w),
    hang: [x + r, by + r - w * 0.2],
  };
}
