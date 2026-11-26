/**
 * The story symbols. A plain gold coin is the price coin: no letters, no symbol, no picture, so it copies no coin's
 * logo and fits any community coin. A white plate with one gold coin on it is one marine's ration, the same on every
 * plate. A steel cloche covers a ration that waits for its owner. An orange dog tag is the box's token: a tag with a
 * hole and three stamped lines, never a word or a number.
 */
import { C, MIX } from './palette.mjs';
import { group, circlePath, ellipsePath, roundRect, place, r2 } from './doc.mjs';
import { shape, flat, line, halftone, clipped } from './pen.mjs';

/** The face of a coin inside its outline: a darker rim below, a stamped inner ring and a shine. */
function coinFace(cx, cy, r, ow) {
  return [
    flat(`M${r2(cx - r)} ${r2(cy)}A${r2(r)} ${r2(r)} 0 0 0 ${r2(cx + r)} ${r2(cy)}A${r2(r)} ${r2(r * 0.86)} 0 0 1 ${r2(cx - r)} ${r2(cy)}Z`, MIX.goldDark),
    line(circlePath(cx, cy, r * 0.7), MIX.goldDark, Math.max(1, ow * 0.7)),
    flat(`M${r2(cx - r * 0.55)} ${r2(cy - r * 0.2)}A${r2(r * 0.58)} ${r2(r * 0.58)} 0 0 1 ${r2(cx - r * 0.12)} ${r2(cy - r * 0.6)}A${r2(r * 0.7)} ${r2(r * 0.7)} 0 0 0 ${r2(cx - r * 0.55)} ${r2(cy - r * 0.2)}Z`, MIX.goldLight),
  ].join('');
}

/** A plain gold coin, the price coin. */
export function coin(cx, cy, r, ow) {
  return shape(circlePath(cx, cy, r), C.gold, ow) + coinFace(cx, cy, r, ow);
}

/** A row of `n` coins centred on cx. */
export function coinRow(cx, cy, n, r, gap, ow) {
  return Array.from({ length: n }, (_, i) => coin(cx + (i - (n - 1) / 2) * (2 * r + gap), cy, r, ow)).join('');
}

/** The box's token: an orange dog tag, `w` wide, at (cx, cy), turned by `turn` degrees. */
export function tag(cx, cy, w, ow, turn = 0) {
  const h = w * 0.6;
  const body = shape(roundRect(-w / 2, -h / 2, w, h, h * 0.42), C.orange, ow);
  const rim = line(roundRect(-w / 2 + h * 0.13, -h / 2 + h * 0.13, w - h * 0.26, h * 0.74, h * 0.3), MIX.orangeDark, Math.max(1, ow * 0.55));
  const hole = shape(circlePath(-w / 2 + h * 0.36, 0, h * 0.11), C.ink, Math.max(1, ow * 0.4));
  const stamp = [-0.2, 0, 0.2].map((dy, i) => line(`M${r2(-w * 0.12)} ${r2(dy * h)}H${r2(w * (i === 1 ? 0.3 : 0.24))}`, MIX.orangeLight, Math.max(1.2, h * 0.09))).join('');
  return group(place(cx, cy, { rotate: turn }), body, rim, hole, stamp);
}

/**
 * A white dinner plate seen from a little above, centred on (cx, cy), `w` wide: the rim, the well and a shine, with
 * halftone shade on the right.
 */
export function plate(doc, cx, cy, w, ow) {
  const rx = w / 2;
  const ry = w * 0.22;
  const rim = ellipsePath(cx, cy, rx, ry);
  const well = ellipsePath(cx, cy + ry * 0.06, rx * 0.66, ry * 0.58);
  return shape(rim, C.white, ow) + clipped(doc, rim, halftone(doc, ellipsePath(cx + rx * 0.9, cy, rx * 0.5, ry * 1.2), MIX.whiteDot, 11, 2.4))
    + shape(rim, 'none', ow) + shape(well, MIX.whiteShade, ow * 0.6)
    + line(`M${r2(cx - rx * 0.8)} ${r2(cy - ry * 0.28)}Q${r2(cx - rx * 0.5)} ${r2(cy - ry * 0.86)} ${r2(cx - rx * 0.1)} ${r2(cy - ry * 0.9)}`, MIX.glint, ow * 0.9);
}

/** The radius of the coin a plate `w` wide holds. */
export const rationR = (w) => w * 0.19;

/** One marine's ration: a plate `w` wide with one gold coin standing on it, the same on every plate. */
export function ration(doc, cx, cy, w, ow) {
  const r = rationR(w);
  return plate(doc, cx, cy, w, ow) + coin(cx, cy - r * 0.62, r, ow * 0.85);
}

/**
 * A steel cloche over a plate: the dome resting on the plate at (cx, baseY), `w` wide, with a knob, a rim band, a
 * shine and halftone shade. `lift` raises it by that many px and tips it back, so the ration under it shows.
 */
export function cloche(doc, cx, baseY, w, ow, lift = 0) {
  const rw = w / 2;
  const h = w * 0.62;
  const dome = `M${r2(-rw)} 0C${r2(-rw)} ${r2(-h * 0.92)} ${r2(-rw * 0.5)} ${r2(-h)} 0 ${r2(-h)}C${r2(rw * 0.5)} ${r2(-h)} ${r2(rw)} ${r2(-h * 0.92)} ${r2(rw)} 0Z`;
  const shine = `M${r2(-rw * 0.7)} ${r2(-h * 0.2)}C${r2(-rw * 0.72)} ${r2(-h * 0.62)} ${r2(-rw * 0.44)} ${r2(-h * 0.86)} ${r2(-rw * 0.16)} ${r2(-h * 0.9)}C${r2(-rw * 0.4)} ${r2(-h * 0.74)} ${r2(-rw * 0.54)} ${r2(-h * 0.5)} ${r2(-rw * 0.52)} ${r2(-h * 0.2)}Z`;
  const body = shape(dome, C.steel, ow) + clipped(doc, dome, halftone(doc, ellipsePath(rw * 0.8, -h * 0.4, rw * 0.5, h), MIX.steelDark, 12), flat(shine, MIX.steelLight))
    + shape(dome, 'none', ow) + shape(roundRect(-rw - 8, -16, w + 16, 22, 10), MIX.steelDark, ow)
    + shape(ellipsePath(0, -h - 14, w * 0.09, w * 0.06), MIX.steelDark, ow) + shape(roundRect(-w * 0.03, -h - 8, w * 0.06, 12, 3), MIX.steelDark, ow * 0.7);
  return group(place(cx + (lift ? rw * 0.3 : 0), baseY - lift, { rotate: lift ? -14 : 0 }), body);
}
