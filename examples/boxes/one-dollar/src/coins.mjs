/**
 * Small change. Plain silver coins stand for the USDC that moves in the story: the fees and the raise. They carry no
 * letters, no symbol and no picture, so nothing copies any coin's real look. The dollar in the box is the bill
 * (bill.mjs). Light falls from the top left.
 */
import { C, MIX } from './palette.mjs';
import { r2, pt, circle, ellipse, path, group, rgrad } from './doc.mjs';

/** The silver face, lit from the top left. */
const face = (d) => rgrad(d, 'silver-face', [[0, MIX.silverLight], [0.45, C.silver], [1, MIX.silverDark]], 0.32, 0.28);
/** A thin ink line in proportion to a coin of radius r. */
export const coinLine = (r) => r2(Math.max(1.2, r * 0.035));

/** A four-pointed glint: the shine on the glass and on a coin. */
export function glint(x, y, s, opacity = 0.9) {
  const k = s * 0.22;
  return path(`M${pt(x, y - s)}Q${pt(x + k, y - k)} ${pt(x + s, y)}Q${pt(x + k, y + k)} ${pt(x, y + s)}Q${pt(x - k, y + k)} ${pt(x - s, y)}Q${pt(x - k, y - k)} ${pt(x, y - s)}Z`, `fill="${MIX.shine}" fill-opacity="${r2(opacity)}"`);
}

/** The coin's edge, seen a little from the side: a darker disc behind the face, down and to the right. */
function edge(cx, cy, r) {
  return circle(cx + r * 0.05, cy + r * 0.07, r, `fill="${MIX.silverDeep}" stroke="${C.ink}" stroke-width="${coinLine(r)}"`);
}

/** A plain silver coin face-on: USDC in the story. */
export function coin(d, cx, cy, r, { opacity = 1 } = {}) {
  const lw = coinLine(r);
  const body = edge(cx, cy, r)
    + circle(cx, cy, r, `fill="${face(d)}" stroke="${C.ink}" stroke-width="${lw}"`)
    + circle(cx, cy, r * 0.8, `fill="none" stroke="${MIX.silverDark}" stroke-width="${r2(Math.max(1, r * 0.06))}"`)
    + path(`M${pt(cx - r * 0.66, cy - r * 0.22)}A${r2(r * 0.7)} ${r2(r * 0.7)} 0 0 1 ${pt(cx - r * 0.2, cy - r * 0.67)}`, `fill="none" stroke="${MIX.shine}" stroke-opacity="0.7" stroke-width="${r2(Math.max(1, r * 0.08))}" stroke-linecap="round"`);
  return opacity < 1 ? group(`opacity="${r2(opacity)}"`, body) : body;
}

/** A plain coin lying flat, seen from above at a slant: `k` is how flat it looks (1 is face-on). */
export function flatCoin(d, cx, cy, r, k = 0.42) {
  const lw = coinLine(r);
  return ellipse(cx, cy + r * 0.16, r, r * k, `fill="${MIX.silverDeep}" stroke="${C.ink}" stroke-width="${lw}"`)
    + ellipse(cx, cy, r, r * k, `fill="${face(d)}" stroke="${C.ink}" stroke-width="${lw}"`)
    + ellipse(cx, cy, r * 0.78, r * k * 0.78, `fill="none" stroke="${MIX.silverDark}" stroke-width="${r2(Math.max(0.8, r * 0.05))}"`);
}

/** A row of plain coins, centred on cx. */
export function coinRow(d, cx, cy, count, r, gap) {
  const step = 2 * r + gap;
  const x0 = cx - ((count - 1) * step) / 2;
  return Array.from({ length: count }, (_, i) => coin(d, x0 + i * step, cy, r)).join('');
}
