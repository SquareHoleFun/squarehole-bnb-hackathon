/**
 * The salon alphabet: high-contrast capitals like the lettering on a gallery wall. Upright strokes are thick, level
 * strokes and serifs are hairlines, and curves swell from thin at the top and bottom to thick at the sides. Every
 * word in the art is built from these shapes, so the art needs no font file.
 *
 * Coordinates are grid units: the cap line is y 0 and the baseline y 10, x runs right. A glyph is a function of the
 * stroke weights that returns its parts:
 *   ['V', x, y0, y1, w]                 an upright stem centred on x
 *   ['H', x0, x1, y, w]                 a level bar centred on y
 *   ['D', x0, y0, x1, y1, w, w1]        a slanted stroke cut level at both ends, `w1` its width at the far end
 *   ['Z', [[x, y], ...]]                a filled polygon
 *   ['O', cx, cy, rx, ry, a0, a1, wx, wy, dx, dy]  part of an oval ring from angle a0 to a1 (degrees, clockwise
 *                                       from three o'clock), `wx` thick at the sides and `wy` at the top and bottom;
 *                                       (dx, dy) moves the inner oval
 *   ['P', 'M x y C ...', options]       a curve drawn with an oval pen. Options: `kx` and `ky` scale the pen, `taper`
 *                                       thins the start and the end, `beaks` hang an upright beak on either end
 *   ['B', cx, cy, r]                    a ball
 *   ['S', x, 't'|'b', 'lr'|'l'|'r', w]  a hairline serif on a stem of width w, on the cap line or the baseline
 *   ['K', x, y0, y1, 'l'|'r']           an upright beak at the end of an arm, its outer edge on x, from y0 to y1
 * Widths are numbers of grid units, worked out from T (a stem) and t (a hairline).
 */

/** Cap height in grid units. */
export const CAP = 10;
/** Room between lines in grid units, from one baseline to the next cap line. */
export const LINE_GAP = 4.2;

const DEFAULTS = Object.freeze({ T: 1.8, t: 0.36, e: 1.0 });

const r2 = (v) => {
  const n = Number(Number(v).toFixed(2));
  return Object.is(n, -0) ? 0 : n;
};

/** A point on an oval at an angle in degrees, clockwise from three o'clock. */
const oval = (cx, cy, rx, ry, a) => [cx + rx * Math.cos((a * Math.PI) / 180), cy + ry * Math.sin((a * Math.PI) / 180)];

/** The C and G bowl as one pen stroke from the top right, round the left, to the bottom right. */
const BOWL = 'M7.3 3.05C7.3 1.25 6.15 0.1 4.85 0.1C2.3 0.1 0.95 2.4 0.95 5.0C0.95 7.6 2.3 9.9 4.85 9.9';

/** The S as one pen stroke from its top beak to its bottom beak. */
const S_SPINE = 'M6.95 3.0C6.95 1.15 5.6 0.1 4.15 0.1C2.5 0.1 1.35 1.15 1.35 2.55C1.35 4.15 2.7 4.7 4.25 5.15C6.0 5.65 7.35 6.35 7.35 7.75C7.35 9.15 6.05 9.95 4.35 9.95C2.7 9.95 1.0 9.05 1.0 7.0';

/** Every glyph: [function of the weights (T stem, t hairline) returning parts, left fit, right fit]. */
const G = {
  A: [({ T, t }) => [['D', 1.9, 10, 4.85, 0, t * 1.3, t * 1.3], ['Z', [[4.4, 0], [5.55, 0], [8.6 + T * 0.55, 10], [8.6 - T * 0.55, 10]]], ['H', 3.0, 7.35, 6.6, t * 1.1], ['S', 1.9, 'b', 'lr', t], ['S', 8.6, 'b', 'lr', T]], -0.35, -0.35],
  B: [({ T, t }) => [['V', 1.9, 0, 10, T], ['S', 1.9, 't', 'l', T], ['S', 1.9, 'b', 'l', T], ['O', 4.3, 2.55, 3.2, 2.55, 270, 450, T * 0.92, t], ['H', 1.9, 4.3, t / 2, t], ['H', 1.9, 4.6, 5.1 - t / 2, t], ['O', 4.6, 7.55, 3.75, 2.45, 270, 450, T, t], ['H', 1.9, 4.6, 10 - t / 2, t]], 0, -0.2],
  C: [() => [['P', `${BOWL}C6.15 9.9 7.3 8.8 7.35 7.15`, { taper: [0.24, 0.24], span: 0.1 }]], -0.3, -0.1],
  D: [({ T, t }) => [['V', 1.9, 0, 10, T], ['S', 1.9, 't', 'l', T], ['S', 1.9, 'b', 'l', T], ['H', 1.9, 4.4, t / 2, t], ['H', 1.9, 4.4, 10 - t / 2, t], ['O', 4.4, 5, 4.85, 5, 270, 450, T * 1.05, t]], 0, -0.3],
  E: [({ T, t }) => [['V', 1.9, 0, 10, T], ['S', 1.9, 't', 'l', T], ['S', 1.9, 'b', 'l', T], ['H', 1.9, 7.0, t / 2, t], ['H', 1.9, 6.0, 5.05, t], ['H', 1.9, 7.5, 10 - t / 2, t], ['K', 7.0, 0, 2.6, 'r'], ['V', 6.0 - t * 0.55, 4.0, 6.1, t * 1.1], ['K', 7.5, 10, 7.2, 'r']], 0, 0],
  F: [({ T, t }) => [['V', 1.9, 0, 10, T], ['S', 1.9, 't', 'l', T], ['S', 1.9, 'b', 'lr', T], ['H', 1.9, 7.0, t / 2, t], ['H', 1.9, 6.0, 5.2, t], ['K', 7.0, 0, 2.6, 'r'], ['V', 6.0 - t * 0.55, 4.15, 6.25, t * 1.1]], 0, -0.2],
  G: [({ T, t }) => [['P', `${BOWL}C6.9 9.9 8.15 8.75 8.15 7.0`, { taper: [0.24, 1], span: 0.1 }], ['V', 8.15, 5.95, 7.2, T], ['H', 6.85, 9.45, 5.95 + t / 2, t]], -0.3, 0],
  H: [({ T, t }) => [['V', 1.9, 0, 10, T], ['V', 8.4, 0, 10, T], ['H', 1.9, 8.4, 5.0, t], ['S', 1.9, 't', 'lr', T], ['S', 1.9, 'b', 'lr', T], ['S', 8.4, 't', 'lr', T], ['S', 8.4, 'b', 'lr', T]], 0, 0],
  I: [({ T }) => [['V', 1.9, 0, 10, T], ['S', 1.9, 't', 'lr', T], ['S', 1.9, 'b', 'lr', T]], 0, 0],
  J: [({ T }) => [['V', 5.3, 0, 7.0, T], ['S', 5.3, 't', 'lr', T], ['P', 'M5.3 6.9C5.3 9.3 4.2 10.05 2.9 10.05C1.9 10.05 1.45 9.55 1.55 8.6', { taper: [1, 0.35] }], ['B', 1.55, 8.6, 0.95]], -0.1, 0],
  K: [({ T, t }) => [['V', 1.9, 0, 10, T], ['S', 1.9, 't', 'lr', T], ['S', 1.9, 'b', 'lr', T], ['D', 2.6, 6.1, 7.7, 0, t * 1.15, t * 1.15], ['S', 7.7, 't', 'lr', t], ['Z', [[3.75, 4.55], [5.05, 3.55], [8.6 + T * 0.5, 10], [8.6 - T * 0.5, 10]]], ['S', 8.6, 'b', 'lr', T]], 0, -0.3],
  L: [({ T, t }) => [['V', 1.9, 0, 10, T], ['S', 1.9, 't', 'lr', T], ['S', 1.9, 'b', 'l', T], ['H', 1.9, 7.3, 10 - t / 2, t], ['K', 7.3, 10, 7.0, 'r']], 0, -0.4],
  M: [({ T, t }) => [['V', 1.9, 0.2, 10, t * 1.25], ['S', 1.9, 'b', 'lr', t], ['H', 0.6, 2.6, t / 2, t], ['Z', [[1.75, 0], [3.2, 0], [6.75, 10], [5.55, 10]]], ['D', 6.05, 10, 9.95, 0, t * 1.25, t * 1.25], ['V', 10.15, 0, 10, T], ['S', 10.15, 't', 'r', T], ['S', 10.15, 'b', 'lr', T]], 0, 0],
  N: [({ t }) => [['V', 1.9, 0.2, 10, t * 1.25], ['S', 1.9, 'b', 'lr', t], ['H', 0.6, 2.4, t / 2, t], ['Z', [[1.75, 0], [3.3, 0], [8.75, 10], [7.2, 10]]], ['V', 8.5, 0, 9.9, t * 1.25], ['S', 8.5, 't', 'lr', t]], 0, 0],
  O: [({ T, t }) => [['O', 4.85, 5, 4.6, 5.15, 0, 360, T * 1.05, t]], -0.35, -0.35],
  P: [({ T, t }) => [['V', 1.9, 0, 10, T], ['S', 1.9, 't', 'l', T], ['S', 1.9, 'b', 'lr', T], ['H', 1.9, 4.5, t / 2, t], ['H', 1.9, 4.5, 5.8 - t / 2, t], ['O', 4.5, 2.9, 3.6, 2.9, 270, 450, T, t]], 0, -0.2],
  Q: [({ T, t }) => [['O', 4.85, 5, 4.6, 5.15, 0, 360, T * 1.05, t], ['P', 'M4.2 8.6C5.3 9.4 6.1 10.4 6.9 11.3C7.6 12.05 8.5 12.25 9.4 12.0', { kx: 0.85, taper: [1, 0.4] }]], -0.35, -0.3],
  R: [({ T, t }) => [['V', 1.9, 0, 10, T], ['S', 1.9, 't', 'l', T], ['S', 1.9, 'b', 'lr', T], ['H', 1.9, 4.4, t / 2, t], ['H', 1.9, 4.4, 5.5 - t / 2, t], ['O', 4.4, 2.75, 3.5, 2.75, 270, 450, T, t], ['Z', [[3.75, 5.1], [5.15, 5.1], [8.75 + T * 0.45, 10], [8.75 - T * 0.5, 10]]], ['H', 8.4, 9.9, 10 - t / 2, t]], 0, -0.3],
  S: [() => [['P', S_SPINE, { taper: [0.24, 0.24], span: 0.09 }]], -0.15, -0.15],
  T: [({ T, t }) => [['V', 4.6, 0, 10, T], ['S', 4.6, 'b', 'lr', T], ['H', 0.35, 8.85, t / 2, t], ['K', 0.35, 0, 2.7, 'l'], ['K', 8.85, 0, 2.7, 'r']], -0.25, -0.25],
  U: [({ T, t }) => {
    // The bowl joins a thick left stem to a hairline right stem, so its inner oval sits to the right of the outer.
    const [l, r, il, ir] = [1.9 - T / 2, 8.4 + t * 0.625, 1.9 + T / 2, 8.4 - t * 0.625];
    const [cx, rx, icx, irx] = [(l + r) / 2, (r - l) / 2, (il + ir) / 2, (ir - il) / 2];
    return [['V', 1.9, 0, 6.5, T], ['V', 8.4, 0, 9.95, t * 1.25], ['S', 1.9, 't', 'lr', T], ['S', 8.4, 't', 'lr', t], ['O', cx, 6.5, rx, 3.55, 0, 180, rx - irx, t, icx - cx, 0]];
  }, 0, 0],
  V: [({ T, t }) => [['Z', [[2.0 - T * 0.55, 0], [2.0 + T * 0.55, 0], [5.55, 10.1], [4.6, 10.1]]], ['D', 5.0, 10.1, 8.4, 0, t * 1.3, t * 1.3], ['S', 2.0, 't', 'lr', T], ['S', 8.4, 't', 'lr', t]], -0.35, -0.35],
  W: [({ T, t }) => [['Z', [[2.0 - T * 0.5, 0], [2.0 + T * 0.5, 0], [4.75, 10.1], [3.85, 10.1]]], ['D', 4.25, 10.1, 6.75, 0, t * 1.25, t * 1.25], ['Z', [[6.55 - T * 0.45, 0], [6.55 + T * 0.45, 0], [9.3, 10.1], [8.4, 10.1]]], ['D', 8.8, 10.1, 11.3, 0, t * 1.25, t * 1.25], ['S', 2.0, 't', 'lr', T], ['S', 6.6, 't', 'lr', t], ['S', 11.3, 't', 'lr', t]], -0.35, -0.35],
  X: [({ T, t }) => [['Z', [[2.1 - T * 0.5, 0], [2.1 + T * 0.5, 0], [8.2 + T * 0.5, 10], [8.2 - T * 0.5, 10]]], ['D', 2.0, 10, 8.1, 0, t * 1.25, t * 1.25], ['S', 2.1, 't', 'lr', t], ['S', 8.1, 't', 'lr', t], ['S', 2.0, 'b', 'lr', t], ['S', 8.2, 'b', 'lr', T]], -0.3, -0.3],
  Y: [({ T, t }) => [['Z', [[2.0 - T * 0.5, 0], [2.0 + T * 0.5, 0], [5.45, 5.4], [4.55, 5.4]]], ['D', 5.0, 5.4, 8.3, 0, t * 1.25, t * 1.25], ['V', 5.0, 5.0, 10, T], ['S', 2.0, 't', 'lr', T], ['S', 8.3, 't', 'lr', t], ['S', 5.0, 'b', 'lr', T]], -0.35, -0.35],
  Z: [({ t }) => [['H', 0.9, 8.0, t / 2, t], ['Z', [[6.9, 0], [8.25, 0], [1.95, 10], [0.6, 10]]], ['H', 0.6, 8.3, 10 - t / 2, t], ['K', 0.9, 0, 2.6, 'l'], ['K', 8.3, 10, 7.2, 'r']], -0.1, -0.1],
  0: [({ T, t }) => [['O', 3.85, 5, 3.55, 5.15, 0, 360, T, t]], -0.1, -0.1],
  1: [({ T, t }) => [['V', 3.25, 0.05, 10, T], ['Z', [[2.35, 0.05], [4.15, 0.05], [2.35, 1.6], [0.55, 2.55], [0.45, 2.2]]], ['H', 0.85, 5.65, 10 - t * 0.65, t * 1.3]], 0, 0],
  2: [({ t }) => [['B', 1.7, 2.45, 0.95], ['P', 'M1.7 2.45C1.55 1.0 2.6 0.1 3.75 0.1C5.35 0.1 6.45 1.2 6.45 2.75C6.45 4.6 4.9 5.85 3.5 7.1L0.6 9.95', { taper: [0.35, 1] }], ['H', 0.5, 6.95, 10 - t / 2, t], ['K', 6.95, 10, 7.9, 'r']], 0, 0],
  3: [() => [['B', 1.6, 2.3, 0.9], ['P', 'M1.6 2.3C1.5 0.9 2.5 0.1 3.7 0.1C5.2 0.1 6.2 1.05 6.2 2.45C6.2 3.95 5.0 4.75 3.3 4.8', { taper: [0.35, 1] }], ['P', 'M3.3 4.75C5.45 4.75 6.75 5.85 6.75 7.35C6.75 8.95 5.45 9.95 3.75 9.95C2.4 9.95 1.45 9.3 1.5 7.9', { taper: [1, 0.35] }], ['B', 1.5, 7.9, 0.9]], 0, -0.1],
  4: [({ T, t }) => [['V', 5.2, 0.1, 10, T], ['D', 0.6, 6.95, 5.1, 0.1, t * 1.25, t * 1.25], ['H', 0.55, 7.25, 6.95, t * 1.1], ['S', 5.2, 'b', 'lr', T]], 0, 0],
  5: [({ t }) => [['V', 1.55, 0.05, 4.75, t * 1.4], ['H', 1.55, 6.35, t * 0.75, t * 1.5], ['K', 6.35, 0, 1.9, 'r'], ['P', 'M1.65 4.85C2.35 4.1 3.2 3.75 4.05 3.75C5.75 3.75 6.85 5.0 6.85 6.75C6.85 8.75 5.4 9.95 3.65 9.95C2.35 9.95 1.4 9.3 1.5 8.0', { taper: [1, 0.35] }], ['B', 1.5, 8.0, 0.9]], 0, 0],
  6: [({ T, t }) => [['O', 3.9, 6.65, 3.3, 3.4, 0, 360, T, t], ['P', `M${0.6 + T / 2} 7.0C${0.6 + T / 2} 3.0 2.8 0.1 4.75 0.1C5.45 0.1 5.95 0.5 6.0 1.6`, { taper: [1, 0.35] }], ['B', 6.0, 1.6, 0.85]], -0.1, 0],
  7: [({ t }) => [['H', 0.55, 7.3, t * 0.75, t * 1.5], ['K', 0.55, 0, 2.3, 'l'], ['P', 'M6.7 0.25C5.0 2.75 3.4 6.4 3.3 10.05', {}]], 0, -0.2],
  8: [({ T, t }) => [['O', 3.85, 2.6, 2.95, 2.6, 0, 360, T * 0.9, t], ['O', 3.85, 7.4, 3.4, 2.65, 0, 360, T, t]], -0.1, -0.1],
  9: [({ T, t }) => [['O', 3.6, 3.35, 3.3, 3.4, 0, 360, T, t], ['P', `M${6.9 - T / 2} 3.0C${6.9 - T / 2} 7.0 4.7 9.95 2.75 9.95C2.1 9.95 1.6 9.65 1.6 8.45`, { taper: [1, 0.35] }], ['B', 1.6, 8.45, 0.85]], 0, -0.1],
  '.': [() => [['B', 0.95, 9.05, 0.95]], 0, 0],
  ',': [() => [['B', 0.95, 9.05, 0.95], ['P', 'M0.95 9.05C1.75 9.45 1.65 10.85 0.3 11.9', { kx: 0.6, taper: [1, 0.25] }]], 0, 0],
  "'": [() => [['B', 0.95, 0.95, 0.95], ['P', 'M0.95 0.95C1.75 1.35 1.65 2.75 0.3 3.8', { kx: 0.6, taper: [1, 0.25] }]], 0, 0],
  ':': [() => [['B', 0.95, 3.7, 0.95], ['B', 0.95, 9.05, 0.95]], 0, 0],
  '!': [({ T }) => [['Z', [[0.95 - T * 0.5, 0], [0.95 + T * 0.5, 0], [1.2, 6.9], [0.7, 6.9]]], ['B', 0.95, 9.05, 0.95]], 0, 0],
  '?': [() => [['B', 1.5, 2.4, 0.9], ['P', 'M1.5 2.4C1.4 0.95 2.3 0.1 3.55 0.1C5.1 0.1 6.1 1.1 6.1 2.5C6.1 4.1 4.3 4.6 3.6 5.6C3.35 5.95 3.3 6.35 3.3 6.9', { taper: [0.35, 1] }], ['B', 3.3, 9.05, 0.95]], 0, 0],
  '-': [({ T }) => [['H', 0.2, 3.6, 5.6, T * 0.55]], 0, 0],
  '·': [() => [['B', 0.95, 5.3, 0.95]], 0, 0],
  '/': [({ t }) => [['D', 0.4, 10.2, 4.0, -0.2, t * 1.3, t * 1.3]], 0, 0],
  '+': [({ T, t }) => [['V', 3.1, 2.4, 8.4, T * 0.62], ['H', 0.2, 6.0, 5.4, t * 1.6]], 0, 0],
  '%': [({ T, t }) => [['O', 2.0, 2.4, 1.75, 2.35, 0, 360, T * 0.6, t], ['O', 6.6, 7.6, 1.75, 2.35, 0, 360, T * 0.6, t], ['D', 1.6, 10.1, 7.0, -0.1, t * 1.3, t * 1.3]], 0, 0],
  '↑': [({ T }) => [['V', 2.3, 2.6, 10, T * 0.62], ['Z', [[0, 3.8], [2.3, 0], [4.6, 3.8]]]], 0, 0],
  '↓': [({ T }) => [['V', 2.3, 0, 7.4, T * 0.62], ['Z', [[0, 6.2], [2.3, 10], [4.6, 6.2]]]], 0, 0],
  '→': [({ t }) => [['H', 0, 5.6, 5.3, t * 2.2], ['Z', [[4.6, 2.8], [8.0, 5.3], [4.6, 7.8]]]], 0, 0],
  '←': [({ t }) => [['H', 2.4, 8.0, 5.3, t * 2.2], ['Z', [[3.4, 2.8], [0, 5.3], [3.4, 7.8]]]], 0, 0],
  ' ': [() => [], 0, 0],
};

/** Pairs that sit too far apart by their boxes alone, with the room to take away in grid units. */
const KERN = {
  LA: 1.2, LT: 1.4, LY: 1.4, LV: 1.2, TA: 1.0, AT: 1.0, AV: 1.0, VA: 1.0, AY: 1.0, YA: 1.0, AW: 0.8, WA: 0.8,
  PA: 0.7, FA: 0.6, RT: 0.3, RY: 0.5, RV: 0.4, TO: 0.4, OT: 0.4, YO: 0.5, OY: 0.5, VO: 0.4, OV: 0.4, 'T.': 1.2,
  'Y.': 1.2, 'V.': 1.0, 'E.': 0.4, 'L.': 0.6, 'F.': 0.8, 'P.': 0.8, 'R.': 0.3,
};
const SPACE = 3.0;

function glyph(ch) {
  const g = G[ch];
  if (!g) throw new Error(`the salon alphabet has no ${JSON.stringify(ch)}`);
  return g;
}

/** Signed area of a polygon, positive when it runs clockwise on screen (y down). */
const area = (pts) => pts.reduce((sum, [x, y], i) => {
  const [nx, ny] = pts[(i + 1) % pts.length];
  return sum + (x * ny - nx * y);
}, 0) / 2;
const clockwise = (pts) => (area(pts) < 0 ? [...pts].reverse() : pts);

/** Points along a centreline written with M, L and C commands, in grid units. */
function sample(d) {
  const tokens = d.match(/[MLC]|-?\d*\.?\d+/g) ?? [];
  const pts = [];
  let i = 0;
  let cur = [0, 0];
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') {
      cur = [num(), num()];
      pts.push(cur);
    } else if (cmd === 'L') {
      const next = [num(), num()];
      for (let k = 1; k <= 8; k += 1) pts.push([cur[0] + ((next[0] - cur[0]) * k) / 8, cur[1] + ((next[1] - cur[1]) * k) / 8]);
      cur = next;
    } else if (cmd === 'C') {
      const [c1, c2, end] = [[num(), num()], [num(), num()], [num(), num()]];
      for (let k = 1; k <= 64; k += 1) {
        const u = k / 64;
        const a = (1 - u) ** 3;
        const b = 3 * (1 - u) ** 2 * u;
        const c = 3 * (1 - u) * u ** 2;
        const e = u ** 3;
        pts.push([a * cur[0] + b * c1[0] + c * c2[0] + e * end[0], a * cur[1] + b * c1[1] + c * c2[1] + e * end[1]]);
      }
      cur = end;
    } else throw new Error(`unknown centreline command ${cmd}`);
  }
  return pts;
}

/**
 * A curve drawn with an oval pen `a` wide and `b` tall (half sizes): at every point the outline sits where the
 * pen's edge faces away from the line, so level runs come out thin and upright runs thick. `taper` scales the pen
 * at the start and at the end, easing back to full size over the first and the last `span` of the curve. Returns the
 * outline and the two outline points at each end.
 */
function penOutline(pts, a, b, taper = [1, 1], span = 0.3) {
  const left = [];
  const right = [];
  const n = pts.length - 1;
  pts.forEach(([x, y], i) => {
    const [px, py] = pts[Math.max(0, i - 1)];
    const [qx, qy] = pts[Math.min(n, i + 1)];
    const len = Math.hypot(qx - px, qy - py) || 1;
    const nx = -(qy - py) / len;
    const ny = (qx - px) / len;
    const u = i / n;
    const ease = (k, f) => k + (1 - k) * Math.min(1, f / span) ** 0.8;
    const scale = Math.min(ease(taper[0], u), ease(taper[1], 1 - u));
    const k = Math.sqrt(a * a * nx * nx + b * b * ny * ny) || 1;
    const sx = ((a * a * nx) / k) * scale;
    const sy = ((b * b * ny) / k) * scale;
    left.push([x + sx, y + sy]);
    right.push([x - sx, y - sy]);
  });
  return { outline: clockwise([...left, ...right.slice().reverse()]), ends: [[left[0], right[0]], [left[n], right[n]]] };
}

/** An upright beak with its outer edge on x, from y0 (where it joins) to y1 (its point): a slim unbracketed wedge. */
function beak(x, y0, y1, side, w) {
  const inward = side === 'r' ? -1 : 1;
  return [{ poly: clockwise([[x, y0], [x + inward * w.t * 1.9, y0], [x + inward * w.t * 0.45, y1], [x, y1]]) }];
}

/** One part as shapes in grid units: { poly } or { ring } or { ball }. */
function shapes(part, w) {
  const [kind, ...v] = part;
  if (kind === 'V') {
    const [x, y0, y1, sw = w.T] = v;
    const h = sw / 2;
    return [{ poly: [[x - h, y0], [x + h, y0], [x + h, y1], [x - h, y1]] }];
  }
  if (kind === 'H') {
    const [x0, x1, y, sw = w.t] = v;
    const h = sw / 2;
    return [{ poly: [[x0, y - h], [x1, y - h], [x1, y + h], [x0, y + h]] }];
  }
  if (kind === 'D') {
    const [x0, y0, x1, y1, sw = w.t, sw1 = sw] = v;
    const k = Math.hypot(x1 - x0, y1 - y0) / Math.abs(y1 - y0);
    const h0 = (sw / 2) * k;
    const h1 = (sw1 / 2) * k;
    return [{ poly: clockwise([[x0 - h0, y0], [x0 + h0, y0], [x1 + h1, y1], [x1 - h1, y1]]) }];
  }
  if (kind === 'Z') return [{ poly: clockwise(v[0]) }];
  if (kind === 'O') {
    const [cx, cy, rx, ry, a0, a1, wx = w.T, wy = w.t, dx = 0, dy = 0] = v;
    return [{ ring: { cx, cy, rx, ry, a0, a1, icx: cx + dx, icy: cy + dy, irx: rx - wx, iry: ry - wy } }];
  }
  if (kind === 'P') {
    const [d, { kx = 1, ky = 1, taper = [1, 1], span = 0.3, beaks = [] } = {}] = v;
    const { outline, ends } = penOutline(sample(d), (w.T / 2) * kx, (w.t / 2) * ky, taper, span);
    const out = [{ poly: outline }];
    for (const { end, side, to } of beaks) {
      const [p, q] = ends[end];
      const [bx, by] = side === 'r' ? (p[0] > q[0] ? p : q) : (p[0] < q[0] ? p : q);
      const from = by - Math.sign(to - by) * 0.25;
      out.push(...beak(bx + (side === 'r' ? 0.04 : -0.04), from, to, side, w));
    }
    return out;
  }
  if (kind === 'B') {
    const [cx, cy, r] = v;
    return [{ ball: { cx, cy, r: r * w.ball } }];
  }
  if (kind === 'S') {
    const [x, where, sides, sw = w.T] = v;
    const h = sw / 2;
    const x0 = sides.includes('l') ? x - h - w.e : x;
    const x1 = sides.includes('r') ? x + h + w.e : x;
    const y0 = where === 't' ? 0 : 10 - w.t;
    return [{ poly: [[x0, y0], [x1, y0], [x1, y0 + w.t], [x0, y0 + w.t]] }];
  }
  if (kind === 'K') {
    const [x, y0, y1, side] = v;
    return beak(x, y0, y1, side, w);
  }
  throw new Error(`unknown glyph part ${kind}`);
}

/** The horizontal extent of a shape in grid units. */
function extent(s) {
  if (s.poly) return [Math.min(...s.poly.map((p) => p[0])), Math.max(...s.poly.map((p) => p[0]))];
  if (s.ball) return [s.ball.cx - s.ball.r, s.ball.cx + s.ball.r];
  const { cx, rx, a0, a1 } = s.ring;
  const xs = [];
  for (let a = a0; a <= a1; a += 3) xs.push(oval(cx, 0, rx, 0, a)[0]);
  xs.push(oval(cx, 0, rx, 0, a1)[0]);
  return [Math.min(...xs), Math.max(...xs)];
}

/** Path data for one shape, moved and scaled: every point (x, y) becomes (ox + x * s, oy + y * s). */
function shapePath(sh, s, ox, oy) {
  const P = (x, y) => `${r2(ox + x * s)} ${r2(oy + y * s)}`;
  if (sh.poly) return `M${sh.poly.map(([x, y]) => P(x, y)).join('L')}Z`;
  if (sh.ball) {
    const { cx, cy, r } = sh.ball;
    return `M${P(cx + r, cy)}A${r2(r * s)} ${r2(r * s)} 0 1 1 ${P(cx - r, cy)}A${r2(r * s)} ${r2(r * s)} 0 1 1 ${P(cx + r, cy)}Z`;
  }
  const { cx, cy, rx, ry, a0, a1, icx, icy, irx, iry } = sh.ring;
  const R = (k) => `${r2(k * s)}`;
  if (a1 - a0 >= 360) {
    const o = (a) => P(...oval(cx, cy, rx, ry, a));
    const i = (a) => P(...oval(icx, icy, irx, iry, a));
    return `M${o(0)}A${R(rx)} ${R(ry)} 0 1 1 ${o(180)}A${R(rx)} ${R(ry)} 0 1 1 ${o(0)}Z`
      + `M${i(0)}A${R(irx)} ${R(iry)} 0 1 0 ${i(180)}A${R(irx)} ${R(iry)} 0 1 0 ${i(0)}Z`;
  }
  const large = a1 - a0 > 180 ? 1 : 0;
  const [ox0, oy0] = oval(cx, cy, rx, ry, a0);
  const [ox1, oy1] = oval(cx, cy, rx, ry, a1);
  const [ix0, iy0] = oval(icx, icy, irx, iry, a0);
  const [ix1, iy1] = oval(icx, icy, irx, iry, a1);
  return `M${P(ox0, oy0)}A${R(rx)} ${R(ry)} 0 ${large} 1 ${P(ox1, oy1)}L${P(ix1, iy1)}A${R(irx)} ${R(iry)} 0 ${large} 0 ${P(ix0, iy0)}Z`;
}

/** The stroke weights for a lettering call: `weight` scales the stems, `hair` sets the hairline as a share of a stem. */
function weights(weight = 1, hair = 0.2) {
  const T = DEFAULTS.T * weight;
  return { T, t: Math.max(DEFAULTS.t * 0.6, T * hair), e: DEFAULTS.e, ball: 0.8 + 0.2 * weight };
}

/** The shapes of one character and its ink extent in grid units. */
function build(ch, w) {
  const [make, fitL, fitR] = glyph(ch);
  const all = make(w).flatMap((p) => shapes(p, w));
  if (ch === ' ') return { shapes: all, x0: 0, x1: SPACE, fitL: 0, fitR: 0 };
  const xs = all.map(extent);
  return { shapes: all, x0: Math.min(...xs.map((e) => e[0])), x1: Math.max(...xs.map((e) => e[1])), fitL, fitR };
}

/** The room between two letters in grid units. */
const gap = (w, tracking) => 1.25 + w.T * 0.15 + tracking;

/** Lays out one line: each character's shapes with its x offset in grid units, and the line's width. */
function layout(text, w, tracking) {
  const placed = [];
  let x = 0;
  let prev = null;
  for (const ch of [...text]) {
    const g = build(ch, w);
    if (prev !== null) {
      const kern = KERN[`${prev.ch}${ch}`] ?? 0;
      x += gap(w, tracking) + (ch === ' ' || prev.ch === ' ' ? 0 : prev.g.fitR + g.fitL) - kern;
    }
    placed.push({ ch, g, x: x - g.x0 });
    x += g.x1 - g.x0;
    prev = { ch, g };
  }
  return { placed, width: x };
}

/** Width of one line in grid units. */
export function lineUnits(text, { weight = 1, hair = 0.2, tracking = 0 } = {}) {
  return layout(text, weights(weight, hair), tracking).width;
}

/**
 * Whether lettering is drawn. `withoutWords` turns it off while build-art.mjs --no-words builds the word-free reference
 * pictures: every call still lays out its letters and measures its box, so placards, plaques and the bill keep their
 * size and place, but no letter is drawn and nothing goes into DRAWN.
 */
let words = true;

/** Runs `build` with every letter left out and hands back its result. */
export function withoutWords(build) {
  const was = words;
  words = false;
  try {
    return build();
  } finally {
    words = was;
  }
}

/**
 * Lettering. `size` is the cap height in pixels and (x, y) the anchor on the cap line of the first line. `weight`
 * scales the stems and `hair` sets the hairlines as a share of a stem: small labels use thicker hairlines so they
 * still read. `layers` draws the letters several times, as [color, outline width in pixels, dx, dy, opacity]; with
 * an outline the letters are also stroked, which the label look uses for its ink edge. A layer whose color is null
 * paints each character in `colorAt(line, index)` or `color`, so one word can stand out. Returns the markup and the
 * box the letters cover, outline included. `measure: true` only measures.
 */
export function lettering(text, { x, y, size, color, anchor = 'middle', weight = 1, hair = 0.2, tracking = 0, layers = null, lineGap = LINE_GAP, colorAt = null, measure = false }) {
  const lines = Array.isArray(text) ? text : [text];
  const s = size / CAP;
  const w = weights(weight, hair);
  const laid = lines.map((t) => layout(t, w, tracking));
  const wMax = Math.max(...laid.map((l) => l.width)) * s;
  // Path data per color: every character goes to the color `colorAt` gives it, or to `color`.
  const byColor = new Map();
  laid.forEach((l, li) => {
    const lw = l.width * s;
    const left = anchor === 'middle' ? x - lw / 2 : anchor === 'end' ? x - lw : x;
    const top = y + li * (CAP + lineGap) * s;
    l.placed.forEach(({ g, x: gx }, ci) => {
      const c = (colorAt && colorAt(li, ci)) || color;
      byColor.set(c, (byColor.get(c) ?? '') + g.shapes.map((sh) => shapePath(sh, s, left + gx * s, top)).join(''));
    });
  });
  const all = [...byColor.values()].join('');
  const use = layers ?? [[null, 0, 0, 0, 1]];
  const one = (d, c, outline, dx, dy, o) => `<path d="${d}"${dx || dy ? ` transform="translate(${r2(dx)} ${r2(dy)})"` : ''} fill="${c}"${outline > 0 ? ` stroke="${c}" stroke-width="${r2(outline * 2)}" stroke-linejoin="round"` : ''}${o < 1 ? ` opacity="${o}"` : ''}/>`;
  const markup = use.map(([c, outline = 0, dx = 0, dy = 0, o = 1]) => (c === null
    ? [...byColor.entries()].map(([fill, d]) => one(d, fill, outline, dx, dy, o)).join('')
    : one(all, c, outline, dx, dy, o))).join('');
  const reach = Math.max(...use.map(([, outline = 0, dx = 0, dy = 0]) => outline + Math.max(Math.abs(dx), Math.abs(dy))));
  // The comma and the Q hang below the baseline. No glyph reaches above the cap line.
  const ascent = 0;
  const descent = lines.some((t) => /[Q,]/.test(t)) ? 2.2 * s : 0;
  const h = (lines.length * CAP + (lines.length - 1) * lineGap) * s + descent + ascent;
  const left = anchor === 'middle' ? x - wMax / 2 : anchor === 'end' ? x - wMax : x;
  const box = { x: left - reach, y: y - ascent - reach - 0.2 * s, w: wMax + 2 * reach, h: h + 2 * reach + 0.4 * s };
  if (!measure && words) DRAWN.push({ text: lines.join(' / '), box });
  return { markup: words ? markup : '', box, s };
}

/**
 * Every box that `lettering()` has drawn, with its words, in drawing order. It changes nothing in the art: check.mjs
 * empties it, builds a piece and reads it back, to prove that words stay clear of the edges.
 */
export const DRAWN = [];

/** Every character the alphabet can draw. */
export const CHARSET = Object.freeze(Object.keys(G));
