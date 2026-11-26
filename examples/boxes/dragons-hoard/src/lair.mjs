/**
 * The lair: the ground every picture stands on. A deep lapis sky that darkens toward the floor, gold glints in the
 * air, a floor with its edge, and the page frame: two gold rules with inward-curved corners, like the border of an
 * old ledger page.
 */
import { C, MIX } from './palette.mjs';
import { r2, pt, rect, circle, path, vgrad, seeded, glowFill, ellipse } from './doc.mjs';

/** A four-pointed glint, `r` from its centre to each point. */
export function glint(cx, cy, r, opacity = 1, color = C.gold) {
  const k = r * 0.2;
  const d = `M${pt(cx, cy - r)}Q${pt(cx + k, cy - k)} ${pt(cx + r, cy)}Q${pt(cx + k, cy + k)} ${pt(cx, cy + r)}Q${pt(cx - k, cy + k)} ${pt(cx - r, cy)}Q${pt(cx - k, cy - k)} ${pt(cx, cy - r)}Z`;
  return path(d, `fill="${color}"${opacity < 1 ? ` fill-opacity="${r2(opacity)}"` : ''}`);
}

/**
 * Glints scattered over a box, at fixed places for a given seed. Places inside any of the `keepOut` boxes
 * ([x, y, w, h]) are skipped, so glints never sit on letters or in the avatar corner.
 */
export function glints({ x, y, w, h, count, seed = 3, rMin = 3, rMax = 11, keepOut = [] }) {
  const rnd = seeded(seed);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const gx = x + rnd() * w;
    const gy = y + rnd() * h;
    const k = rnd();
    const r = rMin + (rMax - rMin) * k * k;
    const blocked = keepOut.some(([kx, ky, kw, kh]) => gx > kx - r && gx < kx + kw + r && gy > ky - r && gy < ky + kh + r);
    if (!blocked) out.push(glint(gx, gy, r, 0.25 + 0.55 * k));
  }
  return out.join('');
}

/** The sky: lapis, a little lighter at the top, darkest at the bottom. */
export function sky(doc, w, h) {
  const fill = vgrad(doc, `sky-${w}-${h}`, [[0, MIX.nightHigh], [0.62, C.night], [1, MIX.nightDeep]]);
  return rect(0, 0, w, h, `fill="${fill}"`);
}

/** The floor from `floorY` down, with a thin lapis edge where it meets the wall. */
export function floor(w, h, floorY) {
  return rect(0, floorY, w, h - floorY, `fill="${MIX.nightDeep}"`)
    + rect(0, floorY, w, Math.max(3, h * 0.004), `fill="${C.lapis}"`);
}

/** A warm pool of light behind something gold. */
export function warmth(doc, cx, cy, rx, ry, strength = 0.22) {
  return ellipse(cx, cy, rx, ry, `fill="${glowFill(doc, C.gold, strength)}"`);
}

/**
 * The outline of a rectangle with inward-curved corners of radius `r`. With `cut` ({ x, y }), the bottom-left corner
 * is left out: the line starts on the left side at y and ends on the bottom side at x.
 */
function notched(x, y, w, h, r, cut = null) {
  const top = `V${r2(y + r)}A${r2(r)} ${r2(r)} 0 0 0 ${pt(x + r, y)}H${r2(x + w - r)}A${r2(r)} ${r2(r)} 0 0 0 ${pt(x + w, y + r)}`
    + `V${r2(y + h - r)}A${r2(r)} ${r2(r)} 0 0 0 ${pt(x + w - r, y + h)}`;
  if (cut) return `M${pt(x, Math.max(y + r, cut.y))}${top}H${r2(Math.min(x + w - r, cut.x))}`;
  return `M${pt(x, y + h - r)}${top}H${r2(x + r)}A${r2(r)} ${r2(r)} 0 0 0 ${pt(x, y + h - r)}Z`;
}

/**
 * The page frame: two gold rules `inset` from the edges, with inward-curved corners and a gold dot in each corner.
 * `cut` ({ x, y }) leaves the bottom-left corner out, from y down and from x left, for the X avatar.
 */
export function frame({ w, h, inset = 28, r = 34, gap = 11, weight = 4, cut = null }) {
  const outer = notched(inset, inset, w - 2 * inset, h - 2 * inset, r, cut);
  const inner = notched(inset + gap, inset + gap, w - 2 * (inset + gap), h - 2 * (inset + gap), Math.max(4, r - gap), cut);
  const corners = [[inset, inset], [w - inset, inset], [w - inset, h - inset]];
  if (!cut) corners.push([inset, h - inset]);
  const dots = corners.map(([x, y]) => circle(x, y, weight * 1.6, `fill="${C.gold}" fill-opacity="0.8"`)).join('');
  return path(outer, `fill="none" stroke="${C.gold}" stroke-opacity="0.7" stroke-width="${r2(weight)}"`)
    + path(inner, `fill="none" stroke="${C.gold}" stroke-opacity="0.32" stroke-width="${r2(weight * 0.5)}"`)
    + dots;
}
