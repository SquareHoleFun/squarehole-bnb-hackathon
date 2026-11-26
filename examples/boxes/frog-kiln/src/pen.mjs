/**
 * The pen: every shape in the art is a flat glaze with a soot outline. Shade is the same shape moved up and left,
 * so a crescent of a darker glaze shows on the lower right, never a gradient. Light is a flat shine on the upper
 * left. Iron speckles are small dots scattered by a seeded random source, so every build draws the same dots.
 */
import { C } from './palette.mjs';
import { circle, group, path, r2, seeded } from './doc.mjs';


const join = 'stroke-linejoin="round" stroke-linecap="round"';

/** A closed shape: fill plus soot outline. */
export const shape = (d, fill, ow) => path(d, `fill="${fill}" stroke="${C.soot}" stroke-width="${r2(ow)}" ${join}`);

/** An outline alone, drawn last over a shape that was filled in parts. */
export const outline = (d, ow, color = C.soot) => path(d, `fill="none" stroke="${color}" stroke-width="${r2(ow)}" ${join}`);

/** A plain fill with no outline. */
export const flat = (d, fill) => path(d, `fill="${fill}"`);

/** A line with no outline, for creases, seams, carving and smoke. */
export const line = (d, color, width, { cap = 'round', dash = null } = {}) =>
  path(d, `fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linejoin="round" stroke-linecap="${cap}"${dash ? ` stroke-dasharray="${dash}"` : ''}`);

/** A thick stroke with a soot edge, for arrows, handles, cords and the peel's handle. */
export const band = (d, fill, width, ow, cap = 'round') => line(d, C.soot, width + 2 * ow, { cap }) + line(d, fill, width, { cap });

/** Clips markup to a path: registers the clip once and wraps the markup. */
export function clipped(doc, d, ...inner) {
  const id = doc.uid('clip');
  doc.def(id, `<clipPath id="${id}"><path d="${d}"/></clipPath>`);
  return `<g clip-path="url(#${id})">${inner.flat(Infinity).filter(Boolean).join('')}</g>`;
}

/**
 * A glazed form: the shape in its shade color, the same shape in its base color moved (-sx, -sy), both clipped to the
 * shape, so a crescent of shade stays on the lower right. Then the outline. `inner` is drawn inside the clip, over
 * the glaze (speckles, shine, drips). Pass `ow` 0 to leave the outline to the caller.
 */
export function glazed(doc, d, { base, shade, ow, sx = 0, sy = 0, inner = [] }) {
  const body = [];
  if (shade && (sx || sy)) {
    body.push(flat(d, shade), group(`transform="translate(${r2(-sx)} ${r2(-sy)})"`, flat(d, base)));
  } else {
    body.push(flat(d, base));
  }
  return [clipped(doc, d, body, inner), ow ? outline(d, ow) : ''];
}

/**
 * Iron speckles: `count` dots of one color scattered over a box, radius between rmin and rmax. Clip them to a shape
 * with `clipped`. The same seed always gives the same dots.
 */
export function speckles(seed, { x, y, w, h }, count, rmin, rmax, color) {
  const rand = seeded(seed);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(circle(x + rand() * w, y + rand() * h, rmin + rand() * (rmax - rmin), `fill="${color}"`));
  }
  return out.join('');
}

/**
 * A curved arrow from `from` to the tip `to`, bending toward the control point `via` (a quadratic curve). The band
 * stops where the head begins, so the head's point stays sharp.
 */
export function arrow(from, via, to, { fill = C.ember, width = 22, ow = 6 } = {}) {
  const k = width * 1.2;
  const len = Math.hypot(to[0] - via[0], to[1] - via[1]) || 1;
  const ux = (to[0] - via[0]) / len;
  const uy = (to[1] - via[1]) / len;
  const base = [to[0] - ux * k * 1.35, to[1] - uy * k * 1.35];
  const d = `M${r2(from[0])} ${r2(from[1])}Q${r2(via[0])} ${r2(via[1])} ${r2(base[0])} ${r2(base[1])}`;
  const left = [base[0] - uy * k, base[1] + ux * k];
  const right = [base[0] + uy * k, base[1] - ux * k];
  const headD = `M${r2(to[0])} ${r2(to[1])}L${r2(left[0])} ${r2(left[1])}L${r2(right[0])} ${r2(right[1])}Z`;
  return [band(d, fill, width, ow, 'butt'), shape(headD, fill, ow)];
}
