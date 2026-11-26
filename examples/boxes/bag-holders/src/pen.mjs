/**
 * The pen: every shape in the art is a flat fill with an ink outline, or a thick stroke with an ink edge.
 * Each part also gives its silhouette, so a hanging thing can throw one flat shadow on the wall.
 */
import { C } from './palette.mjs';
import { path, r2 } from './doc.mjs';

const join = 'stroke-linejoin="round" stroke-linecap="round"';

/** A closed shape: fill plus ink outline. */
export const shape = (d, fill, ow) => path(d, `fill="${fill}" stroke="${C.ink}" stroke-width="${r2(ow)}" ${join}`);

/** A plain fill with no outline, for shading inside a shape. */
export const flat = (d, fill, opacity = 1) => path(d, `fill="${fill}"${opacity === 1 ? '' : ` fill-opacity="${opacity}"`}`);

/** A line with no outline, for seams, folds and stitches. */
export const line = (d, color, width, dash = null) => path(d, `fill="none" stroke="${color}" stroke-width="${r2(width)}" ${join}${dash ? ` stroke-dasharray="${dash}"` : ''}`);

/** A thick stroke with an ink edge, for straps, strings and rods. */
export const band = (d, fill, width, ow) => line(d, C.ink, width + 2 * ow) + line(d, fill, width);

/** Silhouette parts: `{ fill: [pathData] , stroke: [[pathData, width]] }`, painted in one color for a shadow. */
export function silhouette(sil, color) {
  return [
    ...(sil.fill ?? []).map((d) => path(d, `fill="${color}"`)),
    ...(sil.stroke ?? []).map(([d, width]) => line(d, color, width)),
  ].join('');
}
