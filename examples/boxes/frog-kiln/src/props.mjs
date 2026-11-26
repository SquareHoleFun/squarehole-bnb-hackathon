/**
 * Story symbols, drawn in px where they stand: the stoneware crock that is the box, the pond that is the box's own
 * pool, the Square Hole crate, the raise bar, clay tags with carved words, the kiln peel, bowls and dishes, the
 * closing pool's glass jar, and a shelf. Lettering inside them comes from the loop-tool alphabet.
 */
import { C, MIX } from './palette.mjs';
import { ellipsePath, group, path, place, r2, rect, roundRect, smooth } from './doc.mjs';
import { clipped, flat, glazed, line, outline, shape, speckles } from './pen.mjs';
import { frogCoin } from './coins.mjs';
import { wrapped } from './toad.mjs';
import { brushed, carved } from './type.mjs';

/**
 * The box: a big stoneware crock, its top dipped in brown glaze, 420 brushed on its belly in cobalt, as old crocks
 * were marked. When `open`, wrapped toads peek over the rim. (x, y) is the top left of the body; `w` its width.
 */
export function crock(doc, { x, y, w, ow, open = true, label = '420', seed = 'crock' }) {
  const h = w * 1.08;
  const P = (fx, fy) => [x + fx * w, y + fy * h];
  const body = smooth([P(0.14, 0.06), P(0.86, 0.06), P(0.97, 0.3), P(0.99, 0.62), P(0.92, 0.92), P(0.5, 1), P(0.08, 0.92), P(0.01, 0.62), P(0.03, 0.3)], 0.95);
  const dip = `M${r2(x - 10)} ${r2(y - 10)}H${r2(x + w + 10)}V${r2(y + h * 0.3)}Q${r2(x + w * 0.75)} ${r2(y + h * 0.36)} ${r2(x + w * 0.62)} ${r2(y + h * 0.31)}`
    + `Q${r2(x + w * 0.5)} ${r2(y + h * 0.27)} ${r2(x + w * 0.36)} ${r2(y + h * 0.33)}Q${r2(x + w * 0.2)} ${r2(y + h * 0.38)} ${r2(x - 10)} ${r2(y + h * 0.3)}Z`;
  const rim = ellipsePath(x + w / 2, y + h * 0.06, w * 0.37, h * 0.055);
  const lug = (side) => {
    const cx = side < 0 ? x + w * 0.03 : x + w * 0.97;
    return shape(smooth([[cx - side * 6, y + h * 0.17], [cx + side * w * 0.07, y + h * 0.16], [cx + side * w * 0.085, y + h * 0.24], [cx - side * 6, y + h * 0.26]], 0.9), MIX.honeyDark, ow);
  };
  // Wrapped toads inside, their bottoms hidden by the crock's front.
  const rimY = y + h * 0.06;
  const peek = open ? [[0.08, 0.36, 'a', 0.1], [0.5, 0.36, 'c', 0.12], [0.27, 0.42, 'b', 0.24]].map(([fx, fs, k, up]) => {
    const size = w * fs;
    return wrapped(doc, { x: x + w * fx, y: rimY - size * (0.62 + up), size, ow, seed: `${seed}-${k}` });
  }) : [];
  return [
    lug(-1), lug(1),
    ...(open ? [shape(rim, MIX.doorDark, ow)] : []),
    ...peek,
    glazed(doc, body, { base: MIX.oatmeal, shade: MIX.oatmealShade, ow: 0, sx: w * 0.05, sy: w * 0.03,
      inner: [speckles(`${seed}-s`, { x, y, w, h }, Math.round(w / 3), 1.5, 3.5, MIX.speckle), flat(dip, MIX.honeyDark),
        line(`M${r2(x + w * 0.16)} ${r2(y + h * 0.42)}Q${r2(x + w * 0.11)} ${r2(y + h * 0.6)} ${r2(x + w * 0.17)} ${r2(y + h * 0.78)}`, MIX.glint, w * 0.035)] }),
    outline(body, ow),
    shape(open ? `M${r2(x + w * 0.13)} ${r2(y + h * 0.06)}A${r2(w * 0.37)} ${r2(h * 0.055)} 0 0 0 ${r2(x + w * 0.87)} ${r2(y + h * 0.06)}` : rim, MIX.honeyDark, ow),
    brushed(label, { x: x + w / 2, y: y + h * 0.5, cap: h * 0.2, color: MIX.cobalt, width: 2.2, seed: `${seed}-label` }),
  ];
}

/** The box's own pool: a round pond seen from a little above, rimmed with stones, with ripples and reeds. */
export function pond(doc, { x, y, w, ow, reeds = true }) {
  const h = w * 0.38;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const water = ellipsePath(cx, cy, w / 2, h / 2);
  const stones = [];
  for (let i = 0; i < 14; i += 1) {
    const a = (i / 14) * Math.PI * 2;
    stones.push(shape(ellipsePath(cx + Math.cos(a) * w * 0.5, cy + Math.sin(a) * h * 0.5, w * 0.06, h * 0.1), i % 3 ? C.ash : MIX.ashLight, ow * 0.8));
  }
  const reedSet = reeds ? [0, 1, 2].map((i) => {
    const rx = x + w * (0.84 + i * 0.05);
    const top = y - h * (0.5 + (i % 2) * 0.3);
    return line(`M${r2(rx)} ${r2(cy)}Q${r2(rx - 6)} ${r2((cy + top) / 2)} ${r2(rx + 4)} ${r2(top)}`, MIX.celadonDark, ow * 1.3)
      + shape(roundRect(rx - ow * 1.3, top - h * 0.12, ow * 2.8, h * 0.26, ow * 1.4), MIX.woodDark, ow * 0.6);
  }) : [];
  return [
    glazed(doc, water, { base: C.pond, shade: MIX.pondDark, ow: 0, sx: -w * 0.04, sy: -h * 0.12,
      inner: [line(`M${r2(cx - w * 0.22)} ${r2(cy)}q${r2(w * 0.1)} ${r2(-h * 0.1)} ${r2(w * 0.2)} 0`, MIX.pondLight, ow * 0.9),
        line(`M${r2(cx + w * 0.02)} ${r2(cy + h * 0.18)}q${r2(w * 0.08)} ${r2(-h * 0.08)} ${r2(w * 0.16)} 0`, MIX.pondLight, ow * 0.9)] }),
    outline(water, ow),
    ...stones,
    ...reedSet,
  ];
}

/** Square Hole's 3 parts: a small wooden crate with SQUARE HOLE brushed on a paper label. */
export function crate({ x, y, w, ow }) {
  const h = w * 0.72;
  return [
    shape(roundRect(x, y, w, h, w * 0.03), C.wood, ow),
    line(`M${r2(x)} ${r2(y + h / 3)}H${r2(x + w)}M${r2(x)} ${r2(y + (2 * h) / 3)}H${r2(x + w)}`, MIX.woodDark, ow * 0.7),
    shape(roundRect(x + w * 0.1, y + h * 0.2, w * 0.8, h * 0.6, w * 0.03), C.bisque, ow * 0.8),
    brushed(['SQUARE', 'HOLE'], { x: x + w / 2, y: y + h * 0.29, cap: h * 0.15, seed: 'crate' }),
  ];
}

/** A check mark or a cross in a round clay stamp at (x, y). */
export function mark(kind, x, y, r, ow) {
  const sign = kind === 'check'
    ? line(`M${r2(x - r * 0.42)} ${r2(y + r * 0.02)}L${r2(x - r * 0.1)} ${r2(y + r * 0.34)}L${r2(x + r * 0.46)} ${r2(y - r * 0.34)}`, C.bisque, r * 0.26)
    : line(`M${r2(x - r * 0.34)} ${r2(y - r * 0.34)}L${r2(x + r * 0.34)} ${r2(y + r * 0.34)}M${r2(x + r * 0.34)} ${r2(y - r * 0.34)}L${r2(x - r * 0.34)} ${r2(y + r * 0.34)}`, C.bisque, r * 0.26);
  return [shape(ellipsePath(x, y, r, r), kind === 'check' ? C.frog : C.flame, ow), sign];
}

/** The raise: a clay trough filling with frog coins, with a check when full or a cross when the box failed. */
export function raiseBar(doc, { x, y, w, h, fill, state, ow }) {
  const trough = roundRect(x, y, w, h, h / 2);
  const level = roundRect(x, y, Math.max(h, w * fill), h, h / 2);
  const coins = [];
  for (let cx = x + h * 0.55; cx < x + w * fill - h * 0.4; cx += h * 0.62) coins.push(line(`M${r2(cx)} ${r2(y + h * 0.28)}V${r2(y + h * 0.72)}`, MIX.frogDark, ow * 0.6));
  return [
    shape(trough, MIX.bisqueDark, ow),
    clipped(doc, trough, flat(level, C.frog), ...coins, line(`M${r2(x + h * 0.4)} ${r2(y + h * 0.26)}H${r2(x + w * fill - h * 0.3)}`, MIX.frogLight, h * 0.12)),
    outline(trough, ow),
    state === 'full' ? mark('check', x + w + h * 0.95, y + h / 2, h * 0.82, ow) : '',
    state === 'failed' ? mark('cross', x + w * fill + h * 0.95, y + h / 2, h * 0.82, ow) : '',
  ];
}

/** A clay tag hung from a nail by a cord, with words carved through its dark glaze. (x, y) is the nail. */
export function tag({ x, y, words, cap, ow, drop = 40, seed = 'tag' }) {
  const lines = Array.isArray(words) ? words : [words];
  const u = cap / 10;
  const widest = Math.max(...lines.map((l) => [...l].length));
  const w = Math.max(cap * 2.2, widest * cap * 0.82 + cap * 1.4);
  const h = lines.length * cap + (lines.length - 1) * 3.6 * u + cap * 1.3;
  const top = y + drop;
  return [
    line(`M${r2(x - w * 0.32)} ${r2(top + 8)}L${r2(x)} ${r2(y)}L${r2(x + w * 0.32)} ${r2(top + 8)}`, MIX.woodDark, ow * 0.7),
    shape(ellipsePath(x, y, ow * 1.3, ow * 1.3), C.ash, ow * 0.6),
    shape(roundRect(x - w / 2, top, w, h, cap * 0.35), C.slab, ow),
    carved(lines, { x, y: top + cap * 0.65, cap, seed }),
  ];
}

/** The kiln peel: a long wooden paddle, its blade at (x, y), its handle running back along `angle` degrees. */
export function peel({ x, y, len, angle, ow }) {
  const blade = roundRect(-len * 0.24, -len * 0.09, len * 0.3, len * 0.18, len * 0.06);
  return group(place(x, y, { rotate: angle }), [
    line(`M${r2(len * 0.04)} 0H${r2(len)}`, C.soot, len * 0.035 + ow * 2),
    line(`M${r2(len * 0.04)} 0H${r2(len)}`, MIX.woodLight, len * 0.035),
    shape(blade, MIX.woodLight, ow),
    line(`M${r2(-len * 0.2)} ${r2(-len * 0.04)}H${r2(len * 0.02)}`, C.wood, ow * 0.7),
  ]);
}

/** A clay bowl, front view, with its rim at y and a heap of frog coins in it when `coins` > 0. */
export function bowl(doc, { x, y, w, ow, coins = 0, seed = 'bowl' }) {
  const h = w * 0.42;
  const body = `M${r2(x)} ${r2(y)}Q${r2(x + w * 0.04)} ${r2(y + h)} ${r2(x + w / 2)} ${r2(y + h)}Q${r2(x + w * 0.96)} ${r2(y + h)} ${r2(x + w)} ${r2(y)}Z`;
  const heap = [];
  const r = w * 0.11;
  for (let i = 0; i < coins; i += 1) {
    const row = i < 4 ? 0 : i < 7 ? 1 : 2;
    const inRow = row === 0 ? i : row === 1 ? i - 4 : i - 7;
    const n = row === 0 ? 4 : row === 1 ? 3 : 2;
    heap.push(frogCoin(x + w / 2 + (inRow - (n - 1) / 2) * r * 1.7, y - r * 0.3 - row * r * 0.9, r, ow * 0.8, { squash: 0.55 }));
  }
  return [
    ...heap,
    glazed(doc, body, { base: C.clay, shade: MIX.clayDark, ow: 0, sx: w * 0.05, sy: 0,
      inner: [line(`M${r2(x + w * 0.14)} ${r2(y + h * 0.3)}Q${r2(x + w * 0.2)} ${r2(y + h * 0.65)} ${r2(x + w * 0.34)} ${r2(y + h * 0.8)}`, MIX.clayLight, ow * 1.2),
        speckles(seed, { x, y, w, h }, 20, 1.5, 3, MIX.clayDark)] }),
    outline(body, ow),
    shape(ellipsePath(x + w / 2, y, w / 2, h * 0.12), MIX.clayDark, ow),
  ];
}

/** A small clay dish, the place in front of a toad where its KILN waits. */
export function dish({ x, y, w, ow }) {
  const h = w * 0.3;
  return [
    shape(`M${r2(x)} ${r2(y)}Q${r2(x + w / 2)} ${r2(y + h * 1.6)} ${r2(x + w)} ${r2(y)}Z`, C.clay, ow),
    shape(ellipsePath(x + w / 2, y, w / 2, h * 0.3), MIX.clayDark, ow),
  ];
}

/** The closing pool: a glass jar with a steel lid and a carved tag, coins inside. (x, y) is the top left of the glass. */
export function glassJar(doc, { x, y, w, ow, coins = 6 }) {
  const h = w * 1.15;
  const glass = roundRect(x, y, w, h, w * 0.2);
  const inside = [];
  const r = w * 0.12;
  for (let i = 0; i < coins; i += 1) {
    const row = Math.floor(i / 3);
    inside.push(frogCoin(x + w * (0.27 + (i % 3) * 0.23), y + h - r * 1.1 - row * r * 1.1, r, ow * 0.7, { squash: 0.55 }));
  }
  return [
    shape(glass, MIX.celadonLight, ow),
    clipped(doc, glass, inside, line(`M${r2(x + w * 0.16)} ${r2(y + h * 0.18)}V${r2(y + h * 0.7)}`, MIX.glint, w * 0.06)),
    outline(glass, ow),
    shape(roundRect(x - w * 0.04, y - h * 0.1, w * 1.08, h * 0.12, w * 0.04), C.ash, ow),
  ];
}

/** A short shelf on two brackets, its top at y. */
export function shelf({ x, y, w, ow }) {
  return [
    shape(`M${r2(x + w * 0.12)} ${r2(y + 30)}V${r2(y + 120)}L${r2(x + w * 0.12 + 46)} ${r2(y + 30)}Z`, MIX.woodDark, ow * 0.8),
    shape(`M${r2(x + w * 0.88)} ${r2(y + 30)}V${r2(y + 120)}L${r2(x + w * 0.88 - 46)} ${r2(y + 30)}Z`, MIX.woodDark, ow * 0.8),
    shape(roundRect(x, y, w, 32, 6), C.wood, ow),
    rect(x + ow, y + ow / 2, w - 2 * ow, 8, `fill="${MIX.woodLight}"`),
  ];
}

/** A small sparkle of heat or light. */
export function spark(x, y, r, color = MIX.fireCore) {
  return path(`M${r2(x)} ${r2(y - r)}Q${r2(x + r * 0.15)} ${r2(y - r * 0.15)} ${r2(x + r)} ${r2(y)}Q${r2(x + r * 0.15)} ${r2(y + r * 0.15)} ${r2(x)} ${r2(y + r)}`
    + `Q${r2(x - r * 0.15)} ${r2(y + r * 0.15)} ${r2(x - r)} ${r2(y)}Q${r2(x - r * 0.15)} ${r2(y - r * 0.15)} ${r2(x)} ${r2(y - r)}Z`, `fill="${color}"`);
}

