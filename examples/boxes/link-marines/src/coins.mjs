/**
 * The two story symbols. A plain gold coin is the price coin: no letters, no symbol, no picture, so it copies no
 * coin's logo and fits any community coin. A coin with a bite out of it is a coin the marines have eaten. An orange
 * dog tag is the box's token: a tag with a hole and three stamped lines, never a word or a number.
 */
import { C, MIX } from './palette.mjs';
import { group, circlePath, roundRect, place, r2 } from './doc.mjs';
import { shape, flat, line, clipped } from './pen.mjs';

/** Where two circles cross: [] or two points. */
function crossings([x1, y1, r1], [x2, y2, r2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  if (dist > r1 + r2 || dist < Math.abs(r1 - r2) || dist === 0) return [];
  const a = (r1 * r1 - r2 * r2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = x1 + (a * dx) / dist;
  const my = y1 + (a * dy) / dist;
  return [[mx + (h * -dy) / dist, my + (h * dx) / dist], [mx - (h * -dy) / dist, my - (h * dx) / dist]];
}

const angleOf = ([cx, cy], [x, y]) => Math.atan2(y - cy, x - cx);
const norm = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

/** The SVG arc on circle `c` from p to q that passes the direction `toward` (an angle from the circle's center). */
function arcVia(c, p, q, toward) {
  const [cx, cy, r] = c;
  const a1 = angleOf([cx, cy], p);
  const span = norm(angleOf([cx, cy], q) - a1);
  const passes = norm(toward - a1) < span;
  const sweep = passes ? 1 : 0;
  const length = passes ? span : 2 * Math.PI - span;
  return `A${r2(r)} ${r2(r)} 0 ${length > Math.PI ? 1 : 0} ${sweep} ${r2(q[0])} ${r2(q[1])}`;
}

/**
 * A coin of radius r at (cx, cy) with a bite taken out at angle `at` (degrees, 0 = right, 90 = down): three tooth
 * marks in a row along the rim. Returns path data, so the bitten coin can be outlined like any other shape.
 */
export function bittenPath(cx, cy, r, at = -45, { teeth = 3, size = 0.33, spread = 23 } = {}) {
  const coin = [cx, cy, r];
  const rad = (deg) => (deg * Math.PI) / 180;
  const marks = Array.from({ length: teeth }, (_, i) => {
    const a = rad(at + (i - (teeth - 1) / 2) * spread);
    return [cx + r * 1.02 * Math.cos(a), cy + r * 1.02 * Math.sin(a), r * size];
  });
  const far = (pts, from) => pts.reduce((best, p) => (Math.hypot(p[0] - from[0], p[1] - from[1]) > Math.hypot(best[0] - from[0], best[1] - from[1]) ? p : best));
  const near = (pts) => pts.reduce((best, p) => (Math.hypot(p[0] - cx, p[1] - cy) < Math.hypot(best[0] - cx, best[1] - cy) ? p : best));
  const start = far(crossings(coin, marks[0]), marks[1]);
  const end = far(crossings(coin, marks.at(-1)), marks.at(-2));
  let d = `M${r2(start[0])} ${r2(start[1])}${arcVia(coin, start, end, rad(at + 180))}`;
  let from = end;
  for (let i = marks.length - 1; i > 0; i -= 1) {
    const to = near(crossings(marks[i], marks[i - 1]));
    d += arcVia(marks[i], from, to, angleOf(marks[i], [cx, cy]));
    from = to;
  }
  return `${d}${arcVia(marks[0], from, start, angleOf(marks[0], [cx, cy]))}Z`;
}

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

/** A gold coin with a bite out of it: a coin the marines have eaten. */
export function bitten(doc, cx, cy, r, ow, at = -45) {
  const d = bittenPath(cx, cy, r, at);
  return shape(d, C.gold, ow) + clipped(doc, d, coinFace(cx, cy, r, ow)) + shape(d, 'none', ow);
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
