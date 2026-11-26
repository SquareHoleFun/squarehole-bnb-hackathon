/**
 * The story's two money symbols. The frog coin is a plain green coin: a rim, an inner ring and a shine, no letters,
 * no face and no symbol, so it names and copies nobody. KILN, the box's token, is a small square tile of terracotta
 * with the kiln's arch pressed into it.
 */
import { C, MIX } from './palette.mjs';
import { archPath, ellipsePath, group, place, r2, roundRect } from './doc.mjs';
import { flat, line, shape } from './pen.mjs';

/** A frog coin of radius r at (x, y), seen face on or tilted (`squash` < 1 makes it an ellipse). */
export function frogCoin(x, y, r, ow, { squash = 1, turn = 0 } = {}) {
  const ry = r * squash;
  return group(place(x, y, { rotate: turn }), [
    shape(ellipsePath(0, r * 0.09, r, ry), MIX.frogDark, ow),
    shape(ellipsePath(0, 0, r, ry), C.frog, ow),
    line(ellipsePath(0, 0, r * 0.7, ry * 0.7), MIX.frogDark, Math.max(1, r * 0.08)),
    line(`M${r2(-r * 0.52)} ${r2(-ry * 0.22)}A${r2(r * 0.56)} ${r2(ry * 0.56)} 0 0 1 ${r2(-r * 0.14)} ${r2(-ry * 0.56)}`, MIX.frogLight, Math.max(1, r * 0.12)),
  ]);
}

/** A KILN tile of side s centred at (x, y), turned by `turn` degrees. */
export function kilnTile(x, y, s, ow, { turn = 0 } = {}) {
  const h = s / 2;
  return group(place(x, y, { rotate: turn }), [
    shape(roundRect(-h, -h + s * 0.08, s, s, s * 0.16), MIX.clayDark, ow),
    shape(roundRect(-h, -h, s, s, s * 0.16), C.clay, ow),
    flat(archPath(0, h * 0.62, s * 0.42, s * 0.56), MIX.clayDark),
    flat(archPath(s * 0.03, h * 0.62, s * 0.3, s * 0.44), MIX.doorDark),
    line(`M${r2(-h * 0.7)} ${r2(-h * 0.62)}H${r2(-h * 0.2)}`, MIX.clayLight, Math.max(1, s * 0.07)),
  ]);
}

/** A burned frog coin: a grey flake of ash with a broken edge, drifting up. */
export function ashFlake(x, y, r, ow, { turn = 0 } = {}) {
  const d = `M${r2(-r)} 0L${r2(-r * 0.6)} ${r2(-r * 0.55)}L${r2(-r * 0.1)} ${r2(-r * 0.45)}L${r2(r * 0.35)} ${r2(-r * 0.75)}L${r2(r)} ${r2(-r * 0.15)}`
    + `L${r2(r * 0.7)} ${r2(r * 0.5)}L${r2(0)} ${r2(r * 0.62)}L${r2(-r * 0.7)} ${r2(r * 0.45)}Z`;
  return group(place(x, y, { rotate: turn }), [shape(d, C.ash, ow), line(`M${r2(-r * 0.4)} ${r2(-r * 0.1)}L${r2(r * 0.3)} ${r2(r * 0.2)}`, MIX.ashDark, Math.max(1, ow * 0.6))]);
}
