/**
 * Heat: how anything warm is drawn. A warm thing is a stack of bands, cool on the outside and hot in the middle,
 * always in the order of the heat ramp (violet, magenta, orange, amber, white-hot). Around hot things the air
 * shows faint contour rings, the way a heat camera draws them.
 */
import { C, HEAT, MIX } from './palette.mjs';
import { ellipse, path, group, circle, r2, glowFill, blur } from './doc.mjs';

/**
 * A flame outline with its base centre at (cx, by), `w` wide and `h` tall: a round base and two tongues,
 * the taller one on the right. Two tongues keep it from ever reading as a water drop.
 */
export function flamePath(cx, by, w, h) {
  const p = (x, y) => `${r2(cx + x * w)} ${r2(by - y * h)}`;
  return `M${p(0, 0)}`
    + `C${p(0.55, 0)} ${p(0.62, 0.42)} ${p(0.36, 0.64)}`
    + `C${p(0.26, 0.73)} ${p(0.22, 0.84)} ${p(0.26, 1)}`
    + `C${p(0.08, 0.92)} ${p(-0.02, 0.84)} ${p(-0.1, 0.74)}`
    + `C${p(-0.14, 0.82)} ${p(-0.2, 0.86)} ${p(-0.3, 0.88)}`
    + `C${p(-0.26, 0.78)} ${p(-0.36, 0.66)} ${p(-0.42, 0.56)}`
    + `C${p(-0.66, 0.3)} ${p(-0.5, 0)} ${p(0, 0)}Z`;
}

/**
 * A fire: nested flames from violet outside to a white-hot core. `level` (1 to 5) is how many bands burn.
 * A soft glow sits behind it.
 */
export function fire(doc, { cx, by, w, h, level = 5, glow = 0.45 }) {
  const bands = [];
  for (let i = 0; i < level; i += 1) {
    const k = 1 - i * 0.17;
    bands.push(path(flamePath(cx, by - i * h * 0.035, w * k, h * k), `fill="${HEAT[i]}"`));
  }
  const aura = glow > 0 ? ellipse(cx, by - h * 0.45, w * 1.25, h * 0.85, `fill="${glowFill(doc, C.orange, glow)}"`) : '';
  return aura + group(`filter="${blur(doc, w * 0.06)}" opacity="0.6"`, bands[0]) + bands.join('');
}

/** A soft round pool of heat in one color. */
export function heatGlow(doc, cx, cy, rx, ry, color = C.magenta, strength = 0.35) {
  return ellipse(cx, cy, rx, ry, `fill="${glowFill(doc, color, strength)}"`);
}

/** Faint contour rings around a hot point, like the lines a heat camera draws in warm air. */
export function contours(cx, cy, { r0, step, count, color = C.violet, opacity = 0.16, squash = 1 }) {
  const rings = [];
  for (let i = 0; i < count; i += 1) {
    const r = r0 + i * step;
    const o = r2(opacity * (1 - i / (count + 1)));
    rings.push(ellipse(cx, cy, r, r * squash, `fill="none" stroke="${color}" stroke-opacity="${o}" stroke-width="2.5"`));
  }
  return rings.join('');
}

/** Heat bands in a circle: `level` rings from violet to white-hot, filling radius `r`. */
export function heatDisc(cx, cy, r, level = 5) {
  const out = [];
  for (let i = 0; i < level; i += 1) out.push(circle(cx, cy, r * (1 - i * 0.19), `fill="${HEAT[i]}"`));
  return out.join('');
}

/** What is left of a fire that has gone out: a few dark coals, one faint warm spot and a wisp of smoke. */
export function ember(cx, cy, w) {
  const coals = [[-0.26, 0.02, 0.2], [0.02, -0.04, 0.24], [0.27, 0.03, 0.18], [-0.08, 0.08, 0.16]]
    .map(([dx, dy, k]) => ellipse(cx + dx * w, cy + dy * w, w * k, w * k * 0.62, `fill="${MIX.ember}" stroke="${C.rim}" stroke-width="${r2(w * 0.02)}"`)).join('');
  const smoke = `M${r2(cx + w * 0.02)} ${r2(cy - w * 0.12)}C${r2(cx - w * 0.16)} ${r2(cy - w * 0.4)} ${r2(cx + w * 0.2)} ${r2(cy - w * 0.55)} ${r2(cx + w * 0.02)} ${r2(cy - w * 0.86)}S${r2(cx + w * 0.12)} ${r2(cy - w * 1.2)} ${r2(cx + w * 0.04)} ${r2(cy - w * 1.38)}`;
  return path(smoke, `fill="none" stroke="${C.violet}" stroke-opacity="0.35" stroke-width="${r2(w * 0.05)}" stroke-linecap="round"`)
    + coals
    + ellipse(cx + w * 0.04, cy - w * 0.05, w * 0.07, w * 0.035, `fill="${C.violet}" fill-opacity="0.7"`);
}
