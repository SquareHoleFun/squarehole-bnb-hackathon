/**
 * The hoard: the pile of coins with the dragon's tail sweeping out from behind it, down its side and around its
 * front, ending in a spade. One drawing, measured in the pile's width, so the logo, the banners and the scenes all
 * show the same hoard at different sizes. Also the holder's pouch, where a share goes.
 */
import { C, MIX } from './palette.mjs';
import { pile, floorShadow } from './coins.mjs';
import { tail } from './scales.mjs';
import { r2, pt, path, ellipse, inked } from './doc.mjs';

/**
 * The tail's path around a pile, in units of the pile's width, from the pile's centre at its base. x grows to the
 * right and y downward. The root starts behind the pile; the tail rises over the right shoulder, comes down past the
 * right side and sweeps along the front to the spade.
 */
const TAIL = Object.freeze({
  curve: [
    [[0.295, -0.176], [0.466, -0.477], [0.75, -0.42], [0.727, -0.114]],
    [[0.727, -0.114], [0.71, 0.148], [0.375, 0.295], [-0.011, 0.227]],
  ],
  w0: 0.239,
  w1: 0.105,
  spade: 0.216,
  frontFrom: 0.3,
});

/** The height of a pile as a share of its width. */
export const PILE_SHAPE = 0.625;

/**
 * Draws the hoard. (cx, base) is the middle of the pile where it meets the floor, `w` the pile's width. `flip`
 * mirrors it, so the tail sweeps around the left side. `h` changes the pile's height; `tail: false` leaves the tail
 * out. `seed` fixes where the coins land.
 */
export function hoard(doc, { cx, base, w, h = null, flip = false, seed = 5, coinR = null, withTail = true, shadow = true }) {
  const ph = h ?? w * PILE_SHAPE;
  const sx = flip ? -1 : 1;
  const P = ([x, y]) => [cx + sx * x * w, base + y * w];
  const t = withTail
    ? tail(doc, { curve: TAIL.curve.map((seg) => seg.map(P)), w0: TAIL.w0 * w, w1: TAIL.w1 * w, spade: TAIL.spade * w, frontFrom: TAIL.frontFrom })
    : { back: '', front: '' };
  return (shadow ? floorShadow(cx, base, w) : '')
    + t.back
    + pile(cx, base, w, ph, { seed, coinR: coinR ?? w * 0.082, spill: false })
    + t.front;
}

/** The outline a pile had before, as a dashed line, for "the pile was bigger". */
export function oldOutline(cx, base, w, h, color = C.gold) {
  const pts = [];
  for (let i = 0; i <= 40; i += 1) {
    const x = cx - w / 2 + (w * i) / 40;
    const u = Math.min(1, Math.abs(x - cx) / (w / 2));
    pts.push(pt(x, base - h * (1 - u ** 2) ** 0.62));
  }
  return path(`M${pts.join('L')}`, `fill="none" stroke="${color}" stroke-opacity="0.6" stroke-width="${r2(Math.max(3, w * 0.012))}" stroke-dasharray="${r2(w * 0.035)} ${r2(w * 0.028)}" stroke-linecap="round"`);
}

/** The holder's pouch: a leather bag tied at the neck, standing on `bottom`, `w` wide. Where a share goes. */
export function pouch({ cx, bottom, w }) {
  const o = Math.max(3, w * 0.035);
  const h = w * 0.92;
  const neckY = bottom - h * 0.78;
  const body = `M${pt(cx - w * 0.2, neckY)}C${pt(cx - w * 0.62, neckY + h * 0.12)} ${pt(cx - w * 0.62, bottom)} ${pt(cx, bottom)}`
    + `C${pt(cx + w * 0.62, bottom)} ${pt(cx + w * 0.62, neckY + h * 0.12)} ${pt(cx + w * 0.2, neckY)}Z`;
  const frill = `M${pt(cx - w * 0.2, neckY)}L${pt(cx - w * 0.34, neckY - h * 0.2)}L${pt(cx - w * 0.12, neckY - h * 0.12)}L${pt(cx, neckY - h * 0.24)}`
    + `L${pt(cx + w * 0.12, neckY - h * 0.12)}L${pt(cx + w * 0.34, neckY - h * 0.2)}L${pt(cx + w * 0.2, neckY)}Z`;
  return ellipse(cx, bottom, w * 0.5, w * 0.06, `fill="${MIX.nightDeep}" fill-opacity="0.75"`)
    + path(frill, inked(MIX.wood, C.ink, o))
    + path(body, inked(MIX.wood, C.ink, o))
    + path(`M${pt(cx + w * 0.14, neckY + h * 0.2)}C${pt(cx + w * 0.4, neckY + h * 0.3)} ${pt(cx + w * 0.42, bottom - h * 0.2)} ${pt(cx + w * 0.2, bottom - h * 0.06)}`, `fill="none" stroke="${MIX.woodDark}" stroke-width="${r2(o * 1.6)}" stroke-linecap="round"`)
    + path(`M${pt(cx - w * 0.26, neckY + h * 0.02)}Q${pt(cx, neckY + h * 0.1)} ${pt(cx + w * 0.26, neckY + h * 0.02)}`, `fill="none" stroke="${C.gold}" stroke-width="${r2(o * 1.5)}" stroke-linecap="round"`)
    + path(`M${pt(cx - w * 0.3, neckY + h * 0.3)}C${pt(cx - w * 0.36, neckY + h * 0.46)} ${pt(cx - w * 0.3, bottom - h * 0.22)} ${pt(cx - w * 0.2, bottom - h * 0.12)}`, `fill="none" stroke="${C.ember}" stroke-opacity="0.35" stroke-width="${r2(o * 1.2)}" stroke-linecap="round"`);
}
