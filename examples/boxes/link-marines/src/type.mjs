/**
 * The stencil alphabet, drawn for this kit: square-ended strokes on a grid 10 units tall, with thin bridges cut
 * through them like letters sprayed through a crate stencil. All lettering in the art comes from here, so the
 * pictures need no font file. Each glyph is { w, d, cuts }: its width in units, its strokes as path data in units
 * (0 at the cap line, 10 on the baseline), and its bridges as [x, y, w, h] rectangles cut out of the strokes.
 */
import { C, MIX } from './palette.mjs';
import { r2, rect } from './doc.mjs';

/** Cap height, stroke, bridge width, space between letters and between lines (units). */
export const CAP = 10;
export const STROKE = 2.3;
export const BRIDGE = 0.7;
export const TRACK = 1.7;
export const LINE_GAP = 3.4;

const S = STROKE;
const K = BRIDGE;
/** The bridge just right of a left stem, full height: B, D, E, P, R and K are cut this way. */
const STEM = [S, -2, K, 14];

const G = {
  A: { w: 7.6, d: 'M0.9 10.6L3.8 -0.6L6.7 10.6M1.6 7.2H6', cuts: [[3.45, -2, K, 5.2]] },
  B: { w: 7, d: 'M1.15 0V10M1.15 1.15H3.55A1.85 1.85 0 0 1 3.55 4.85H1.15M1.15 4.85H3.8A2 2 0 0 1 3.8 8.85H1.15', cuts: [STEM] },
  C: { w: 6.8, d: 'M6.6 1.15H3.3A2.15 2.15 0 0 0 1.15 3.3V6.7A2.15 2.15 0 0 0 3.3 8.85H6.6', cuts: [] },
  D: { w: 7.2, d: 'M1.15 0V10M1.15 1.15H3.9A2.15 2.15 0 0 1 6.05 3.3V6.7A2.15 2.15 0 0 1 3.9 8.85H1.15', cuts: [STEM] },
  E: { w: 6.4, d: 'M1.15 0V10M1.15 1.15H6.4M1.15 5H5.8M1.15 8.85H6.4', cuts: [STEM] },
  F: { w: 6.4, d: 'M1.15 0V10M1.15 1.15H6.4M1.15 5H5.8', cuts: [[S, -2, K, 9]] },
  G: { w: 7, d: 'M6.6 1.15H3.3A2.15 2.15 0 0 0 1.15 3.3V6.7A2.15 2.15 0 0 0 3.3 8.85H3.7A2.15 2.15 0 0 0 5.85 6.7V5.2H3.7', cuts: [] },
  H: { w: 7.2, d: 'M1.15 0V10M6.05 0V10M1.15 5H6.05', cuts: [[S, 3, K, 4], [7.2 - S - K, 3, K, 4]] },
  I: { w: 2.3, d: 'M1.15 0V10', cuts: [] },
  J: { w: 6, d: 'M4.85 0V6.7A2.15 2.15 0 0 1 2.7 8.85H0.3', cuts: [] },
  K: { w: 7.1, d: 'M1.15 0V10M6.6 -0.5L2.4 5.4M3.6 4.1L7.1 10.5', cuts: [STEM] },
  L: { w: 6.2, d: 'M1.15 0V10M1.15 8.85H6.2', cuts: [[S, 6.4, K, 5]] },
  M: { w: 8.8, d: 'M1.15 0V10M7.65 0V10M1.15 0.2L4.4 7.4L7.65 0.2', cuts: [[S, -2, K, 5.4], [8.8 - S - K, -2, K, 5.4]] },
  N: { w: 7.4, d: 'M1.15 0V10M6.25 0V10M1.15 -0.6L6.25 10.6', cuts: [[S, -2, K, 5.2], [7.4 - S - K, 4.8, K, 7.2]] },
  O: { w: 7.2, d: 'M3.6 1.15H3.9A2.15 2.15 0 0 1 6.05 3.3V6.7A2.15 2.15 0 0 1 3.9 8.85H3.3A2.15 2.15 0 0 1 1.15 6.7V3.3A2.15 2.15 0 0 1 3.3 1.15Z', cuts: [[3.25, -2, K, 5], [3.25, 7, K, 5]] },
  P: { w: 7.1, d: 'M1.15 0V10M1.15 1.15H3.6A2.35 2.35 0 0 1 3.6 5.85H1.15', cuts: [STEM] },
  Q: { w: 7.4, d: 'M3.6 1.15H3.9A2.15 2.15 0 0 1 6.05 3.3V6.7A2.15 2.15 0 0 1 3.9 8.85H3.3A2.15 2.15 0 0 1 1.15 6.7V3.3A2.15 2.15 0 0 1 3.3 1.15ZM4.4 6.7L7.2 10.6', cuts: [[3.25, -2, K, 5]] },
  R: { w: 7.2, d: 'M1.15 0V10M1.15 1.15H3.6A2.35 2.35 0 0 1 3.6 5.85H1.15M3.8 5.85L6.7 10.6', cuts: [STEM] },
  S: { w: 6.7, d: 'M6.2 1.15H3.05A1.9 1.9 0 0 0 3.05 4.95H3.55A1.95 1.95 0 0 1 3.55 8.85H0.4', cuts: [] },
  T: { w: 7.2, d: 'M0 1.15H7.2M3.6 1.15V10', cuts: [[2.3, S, 2.6, K]] },
  U: { w: 7.2, d: 'M1.15 0V6.7A2.15 2.15 0 0 0 3.3 8.85H3.9A2.15 2.15 0 0 0 6.05 6.7V0', cuts: [[3.25, 7, K, 5]] },
  V: { w: 7.6, d: 'M0.9 -0.6L3.8 10.6L6.7 -0.6', cuts: [[3.45, 6.4, K, 6]] },
  W: { w: 10.4, d: 'M0.8 -0.6L2.95 10.6L5.2 1.4L7.45 10.6L9.6 -0.6', cuts: [[2.6, 7.2, K, 5], [7.1, 7.2, K, 5], [4.85, -2, K, 6.2]] },
  X: { w: 7.4, d: 'M0.7 -0.6L6.7 10.6M6.7 -0.6L0.7 10.6', cuts: [[3.35, 3.7, K, 2.6]] },
  Y: { w: 7.4, d: 'M0.7 -0.6L3.7 5.3L6.7 -0.6M3.7 5V10', cuts: [[2.3, 5.7, 2.8, K]] },
  Z: { w: 6.8, d: 'M0.4 1.15H6.3L0.5 8.85H6.4', cuts: [] },
  0: { w: 6.6, d: 'M3.3 1.15H3.3A2.15 2.15 0 0 1 5.45 3.3V6.7A2.15 2.15 0 0 1 3.3 8.85A2.15 2.15 0 0 1 1.15 6.7V3.3A2.15 2.15 0 0 1 3.3 1.15Z', cuts: [[2.95, -2, K, 5], [2.95, 7, K, 5]] },
  1: { w: 4.4, d: 'M3.25 0V10M0.3 3.5L1.9 1.6', cuts: [] },
  2: { w: 6.8, d: 'M1.15 3.7V3.3A2.15 2.15 0 0 1 3.3 1.15H3.5A2.15 2.15 0 0 1 5.65 3.3V3.9L1.15 8.85H6.6', cuts: [[1.9, 7.3, K, 4]] },
  3: { w: 6.9, d: 'M0.6 1.15H3.6A1.85 1.85 0 0 1 3.6 4.85H2.2M2.2 4.85H3.75A2 2 0 0 1 3.75 8.85H0.4', cuts: [] },
  4: { w: 7.2, d: 'M4.9 0V10M4.3 0.2L0.6 6.9H7.2', cuts: [[4.9 - 1.15 - K, -2, K, 6.4]] },
  5: { w: 6.7, d: 'M6.1 1.15H1.7L1.45 5H3.6A1.925 1.925 0 0 1 3.6 8.85H0.4', cuts: [[2.9, -2, K, 4.6]] },
  6: { w: 6.8, d: 'M5.7 1.15H3.3A2.15 2.15 0 0 0 1.15 3.3V6.7A2.15 2.15 0 0 0 3.3 8.85H3.5A2.15 2.15 0 0 0 5.65 6.7V6.4A2.15 2.15 0 0 0 3.5 4.25H1.15', cuts: [[3.05, 7, K, 5]] },
  7: { w: 6.6, d: 'M0.3 1.15H6L2.4 10.6', cuts: [] },
  8: { w: 6.8, d: 'M3.4 1.15H3.6A1.85 1.85 0 0 1 3.6 4.85H3.2A1.85 1.85 0 0 1 3.2 1.15ZM3.4 4.85H3.75A2 2 0 0 1 3.75 8.85H3.05A2 2 0 0 1 3.05 4.85Z', cuts: [[3.05, -2, K, 4.2], [3.05, 7.6, K, 4.4]] },
  9: { w: 6.8, d: 'M1.1 8.85H3.5A2.15 2.15 0 0 0 5.65 6.7V3.3A2.15 2.15 0 0 0 3.5 1.15H3.3A2.15 2.15 0 0 0 1.15 3.3V3.6A2.15 2.15 0 0 0 3.3 5.75H5.65', cuts: [[3.05, -2, K, 4.2]] },
  '.': { w: 2.3, d: 'M1.15 7.7V10', cuts: [] },
  ',': { w: 2.6, d: 'M1.45 7.7V9.6L0.4 11.6', cuts: [], bottom: 11.8 },
  '!': { w: 2.3, d: 'M1.15 0V6.5M1.15 7.7V10', cuts: [] },
  '?': { w: 6.3, d: 'M0.9 3.5V3.3A2.15 2.15 0 0 1 3.05 1.15H3.15A2.15 2.15 0 0 1 5.3 3.3V3.6A2.15 2.15 0 0 1 3.15 5.75H3.1V6.6M3.1 7.7V10', cuts: [] },
  "'": { w: 2.3, d: 'M1.15 0V3.2', cuts: [] },
  '%': { w: 9, d: 'M7.6 -0.4L1.4 10.4M1.15 0V3.8M7.85 6.2V10', cuts: [] },
  '+': { w: 6.4, d: 'M0.4 5H6M3.2 2.2V7.8', cuts: [] },
  '-': { w: 4.2, d: 'M0.3 5H3.9', cuts: [] },
  ':': { w: 2.3, d: 'M1.15 2.3V4.6M1.15 7.7V10', cuts: [] },
  ' ': { w: 3, d: '', cuts: [] },
};

/** The characters the alphabet can draw. */
export const CHARS = Object.freeze(Object.keys(G).join(''));

/** Every block of lettering drawn since the last reset, with its outside box in px, for the margin check. */
export const DRAWN = [];

function glyph(ch) {
  const g = G[ch];
  if (!g) throw new Error(`the stencil alphabet has no ${JSON.stringify(ch)}`);
  return g;
}

/** Width of one line in units. */
export function lineUnits(text) {
  const chars = [...text];
  return chars.reduce((sum, ch, i) => sum + glyph(ch).w + (i < chars.length - 1 ? TRACK : 0), 0);
}

/** The outside box of a block of lines, in px, for a cap height `cap`: { w, h, unit }. */
export function measure(lines, cap) {
  const list = Array.isArray(lines) ? lines : [lines];
  const u = cap / CAP;
  return { w: Math.max(...list.map(lineUnits)) * u, h: (list.length * CAP + (list.length - 1) * LINE_GAP) * u, unit: u };
}

/** Strokes, kept boxes and bridges of a block, in unit space; the first line's cap line is y = 0. */
function layout(lines, anchor) {
  const strokes = [];
  const keep = [];
  const cuts = [];
  lines.forEach((text, li) => {
    const lw = lineUnits(text);
    let x = anchor === 'middle' ? -lw / 2 : anchor === 'end' ? -lw : 0;
    const y = li * (CAP + LINE_GAP);
    for (const ch of [...text]) {
      const g = glyph(ch);
      if (g.d) {
        strokes.push(`<path transform="translate(${r2(x)} ${r2(y)})" d="${g.d}"/>`);
        keep.push([x - 1, y, g.w + 2, g.bottom ?? CAP]);
        for (const [cx, cy, cw, chh] of g.cuts) cuts.push([x + cx, y + cy, cw, chh]);
      }
      x += g.w + TRACK;
    }
  });
  return { strokes: strokes.join(''), keep, cuts };
}

/** A stencil mask: the kept glyph boxes in white, minus every bridge. `reach` widens each bridge up and left. */
function stencilMask(id, box, keep, cuts, reach = 0) {
  const white = keep.map(([x, y, w, h]) => rect(x, y, w, h, `fill="${MIX.white}"`)).join('');
  const black = cuts.map(([x, y, w, h]) => rect(x - reach, y - reach, w + reach, h + reach, `fill="${MIX.cut}"`)).join('');
  return `<mask id="${id}" maskUnits="userSpaceOnUse" x="${r2(box.x)}" y="${r2(box.y)}" width="${r2(box.w)}" height="${r2(box.h)}">${white}${black}</mask>`;
}

/**
 * Whether lettering is drawn. `withoutWords` turns it off while build-art.mjs --no-words builds the word-free reference
 * pictures: `measure` still sizes every block, so the crates, the footlocker, the signs, the button and the mess tin keep
 * their size and place, but `lettering` draws nothing, adds no stencil mask and records nothing in DRAWN.
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
 * Stencil lettering. (x, y) is the anchor on the first line's cap line (its top); `anchor` is 'start', 'middle' or
 * 'end'. `shadow` adds a second print of the same stencil, `depth` units down and right, like a two-color poster.
 * The art never names the price coin or the project behind it, except LINK inside the box's own name (`name`).
 */
export function lettering(d, text, { x, y, cap, color = C.paper, shadow = null, depth = 0.9, anchor = 'middle', name = false }) {
  const lines = Array.isArray(text) ? text : [text];
  for (const line of lines) {
    if (/CHAIN/.test(line)) throw new Error('the art never writes the name of the project behind the price coin');
    if (/LINK/.test(line) && !name) throw new Error('only the box name may write LINK; the pictures never name the price coin');
  }
  if (!words) return '';
  const u = cap / CAP;
  const { strokes, keep, cuts } = layout(lines, anchor);
  const m = measure(lines, cap);
  const left = anchor === 'middle' ? -m.w / u / 2 : anchor === 'end' ? -m.w / u : 0;
  const box = { x: left - 3, y: -3, w: m.w / u + 6, h: m.h / u + 8 };
  const fillId = d.uid('stencil');
  d.def(fillId, stencilMask(fillId, box, keep, cuts));
  const ink = (stroke, id) => `<g mask="url(#${id})" fill="none" stroke="${stroke}" stroke-width="${STROKE}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="4">${strokes}</g>`;
  let shadowLayer = '';
  if (shadow) {
    // The second print's bridges reach up and left to where the first print's bridges are, so every bridge shows
    // the ground behind the letters, as a real stencil would.
    const shadowId = d.uid('stencil');
    d.def(shadowId, stencilMask(shadowId, box, keep, cuts, depth));
    shadowLayer = `<g transform="translate(${r2(depth)} ${r2(depth)})">${ink(shadow, shadowId)}</g>`;
  }
  const at = `translate(${r2(x)} ${r2(y)}) scale(${Number(u.toFixed(4))})`;
  DRAWN.push({ text: lines.join(' / '), box: { x: x + left * u, y, w: m.w + (shadow ? depth * u : 0), h: m.h + (shadow ? depth * u : 0) } });
  return `<g transform="${at}">${shadowLayer}${ink(color, fillId)}</g>`;
}
