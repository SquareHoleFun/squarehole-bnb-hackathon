/**
 * The engraver's alphabet, drawn for this kit. Each letter is a skeleton of thin lines on a grid 10 units tall, and
 * it is drawn with one stroke of an oval pen: the pen is three times wider than it is tall and tilted 15 degrees, as
 * a burin cuts a copper plate. Up and down strokes come out thick, crossbars and serifs come out as hairlines, and
 * round letters swell on their sides, so the letters read as an old engraved Roman. The pen is made with the stroke
 * of an SVG path under a stretched transform; the skeleton is pre-squeezed by the inverse, so the letter keeps its
 * shape and only the pen is oval. All lettering in the art comes from here, so the pictures need no font file.
 */
import { C } from './palette.mjs';
import { r2 } from './doc.mjs';

/** Cap height of the grid, in units. */
export const CAP = 10;
/** The pen's tilt in degrees (negative tilts its long axis up to the right, so strokes like \ come out thick). */
export const PEN_TILT = -15;
/** Pen weights: `w` is the pen's short axis in units and `k` how many times longer its long axis is. */
export const WEIGHTS = Object.freeze({
  display: { w: 0.42, k: 3 },
  text: { w: 0.58, k: 2.3 },
  small: { w: 0.78, k: 1.8 },
});

/** Each glyph: its width in units and its skeleton as absolute path data (M, L, H, V, C, Z), cap line 0, baseline 10. */
const SKELETONS = {
  A: [8.2, 'M0.9 10L4.1 0L7.3 10M2.1 6.6H6.1M0 10H2M6.2 10H8.3M3.2 0H4.3'],
  B: [6.8, 'M1.2 0V10M0.1 0H3.9C5.4 0 6.1 1.1 6.1 2.4C6.1 3.8 5.2 4.75 3.9 4.75H1.2M3.9 4.75C5.7 4.75 6.6 5.9 6.6 7.3C6.6 8.9 5.5 10 3.9 10H0.1'],
  C: [7.3, 'M7 2.7C6.4 1 5.3 0 3.9 0C1.9 0 0.6 2.2 0.6 5C0.6 7.8 1.9 10 3.9 10C5.4 10 6.5 9 7.1 7.3M7 0.7V2.2'],
  D: [7.6, 'M1.2 0V10M0.1 0H3.4C5.8 0 7.2 2.2 7.2 5C7.2 7.8 5.8 10 3.4 10H0.1'],
  E: [6.4, 'M1.2 0V10M0.1 0H5.9V1.9M1.2 4.85H4.5M4.5 3.9V5.8M0.1 10H6.1V7.9'],
  F: [6.1, 'M1.2 0V10M0.1 0H5.8V1.9M1.2 4.95H4.4M4.4 4V5.9M0.1 10H2.5'],
  G: [7.9, 'M7 2.7C6.4 1 5.3 0 3.9 0C1.9 0 0.6 2.2 0.6 5C0.6 7.8 1.9 10 3.9 10C5.4 10 6.5 9.4 7.1 8.6V5.7M5.4 5.7H8M7 0.7V2.2'],
  H: [8.1, 'M1.2 0V10M6.9 0V10M1.2 4.9H6.9M0.1 0H2.3M5.8 0H8M0.1 10H2.3M5.8 10H8'],
  I: [2.4, 'M1.2 0V10M0.1 0H2.3M0.1 10H2.3'],
  J: [4.8, 'M3.5 0V7.4C3.5 9 2.7 10 1.7 10C1 10 0.5 9.6 0.3 9M2.4 0H4.6'],
  K: [7.8, 'M1.2 0V10M0.1 0H2.3M0.1 10H2.3M6.6 0L1.4 6M3.3 4.2L7 10M5.5 0H7.7M5.9 10H7.9'],
  L: [6.2, 'M1.2 0V10M0.1 0H2.4M0.1 10H5.9V7.8'],
  M: [9.8, 'M1.3 10V0L4.9 10L8.5 0V10M0.2 10H2.4M7.4 10H9.6M0.3 0H1.3M8.5 0H9.5'],
  N: [8.1, 'M1.2 10V0L6.9 10V0M0.1 10H2.3M0.1 0H1.2M5.8 0H8'],
  O: [8.1, 'M4.05 0C6.25 0 7.65 2.2 7.65 5C7.65 7.8 6.25 10 4.05 10C1.85 10 0.45 7.8 0.45 5C0.45 2.2 1.85 0 4.05 0Z'],
  P: [6.6, 'M1.2 0V10M0.1 0H3.8C5.4 0 6.3 1.2 6.3 2.7C6.3 4.2 5.4 5.4 3.8 5.4H1.2M0.1 10H2.4'],
  Q: [8.2, 'M4.05 0C6.25 0 7.65 2.2 7.65 5C7.65 7.8 6.25 10 4.05 10C1.85 10 0.45 7.8 0.45 5C0.45 2.2 1.85 0 4.05 0ZM4.3 8.7C5.1 10.3 6.3 11.1 8 11.3'],
  R: [7.4, 'M1.2 0V10M0.1 0H3.8C5.4 0 6.2 1.1 6.2 2.5C6.2 3.9 5.3 5 3.8 5H1.2M3.5 5C5 5.2 5.4 6.2 5.6 7.6L6 10H7.2M0.1 10H2.4'],
  S: [6.4, 'M5.5 2C5.1 0.8 4.2 0 3 0C1.6 0 0.7 1 0.7 2.4C0.7 4 2 4.6 3.3 5.1C4.7 5.6 5.7 6.3 5.7 7.6C5.7 9 4.6 10 3.1 10C1.8 10 0.8 9.2 0.4 8M5.6 0.8V2.1M0.4 7.9V9.2'],
  T: [7.8, 'M0.4 1.9V0H7.4V1.9M3.9 0V10M2.8 10H5'],
  U: [8.1, 'M1.2 0V6.6C1.2 8.7 2.4 10 4.2 10C5.9 10 6.9 8.7 6.9 6.8V0M0.1 0H2.3M5.8 0H8'],
  V: [8.2, 'M0.8 0L4.1 10L7.4 0M0 0H2M6.2 0H8.2'],
  W: [11.4, 'M0.6 0L3.1 10L5.7 0.8L8.3 10L10.8 0M0 0H1.9M9.5 0H11.4'],
  X: [7.8, 'M0.8 0L7 10M7 0L0.8 10M0 0H2.1M5.7 0H7.8M0 10H2.1M5.7 10H7.8'],
  Y: [7.8, 'M0.7 0L3.9 5.2L7.1 0M3.9 5.2V10M0 0H1.9M5.9 0H7.8M2.8 10H5'],
  Z: [7, 'M0.9 1.9V0H6.3L0.7 10H6.3V8'],
  0: [6.6, 'M3.3 0C5 0 6.1 2.2 6.1 5C6.1 7.8 5 10 3.3 10C1.6 10 0.5 7.8 0.5 5C0.5 2.2 1.6 0 3.3 0Z'],
  1: [5, 'M1.1 1.9L2.9 0V10M1.5 10H4.3'],
  2: [6.3, 'M0.8 2.4C1 1 2 0 3.3 0C4.7 0 5.6 1 5.6 2.5C5.6 4.3 4 5.6 0.6 10H5.9V8.4'],
  3: [6.3, 'M0.9 1.4C1.5 0.5 2.3 0 3.2 0C4.6 0 5.4 1 5.4 2.4C5.4 3.8 4.4 4.7 2.8 4.7C4.6 4.7 5.7 5.8 5.7 7.3C5.7 8.9 4.6 10 3 10C1.9 10 1 9.4 0.5 8.5'],
  4: [6.7, 'M4.4 10V0L0.4 7H6.5M3.2 10H5.6'],
  5: [6.3, 'M5.3 0H1.3L0.9 4.6C1.6 4.1 2.4 3.9 3.1 3.9C4.7 3.9 5.6 5.1 5.6 6.9C5.6 8.7 4.5 10 2.9 10C1.9 10 1 9.5 0.5 8.6'],
  6: [6.5, 'M5.2 1C4.7 0.3 4 0 3.3 0C1.6 0 0.6 2 0.6 5.3C0.6 8.3 1.6 10 3.3 10C4.9 10 5.8 8.7 5.8 6.9C5.8 5.2 4.8 4.1 3.3 4.1C2.1 4.1 1.1 4.8 0.7 6'],
  7: [6.3, 'M0.6 1.9V0H5.8L2.4 10'],
  8: [6.5, 'M3.2 4.6C1.9 4.6 1 3.7 1 2.4C1 1 1.9 0 3.2 0C4.5 0 5.4 1 5.4 2.4C5.4 3.7 4.5 4.6 3.2 4.6C1.6 4.6 0.6 5.7 0.6 7.3C0.6 8.9 1.7 10 3.2 10C4.7 10 5.8 8.9 5.8 7.3C5.8 5.7 4.8 4.6 3.2 4.6Z'],
  9: [6.5, 'M1.2 9C1.7 9.7 2.4 10 3.1 10C4.8 10 5.8 8 5.8 4.7C5.8 1.7 4.8 0 3.1 0C1.5 0 0.6 1.3 0.6 3.1C0.6 4.8 1.6 5.9 3.1 5.9C4.3 5.9 5.3 5.2 5.7 4'],
  '.': [1.7, 'M0.85 9.2V9.8'],
  ',': [1.9, 'M0.95 9.2V9.8C0.95 10.6 0.65 11.2 0.25 11.6'],
  "'": [1.7, 'M0.85 0V2.4'],
  '&': [8.6, 'M7.8 10L2.3 3.6C1.7 2.9 1.5 2.4 1.5 1.9C1.5 0.8 2.3 0 3.4 0C4.5 0 5.2 0.7 5.2 1.8C5.2 3 4.3 3.8 3 4.8C1.5 5.9 0.7 6.8 0.7 8C0.7 9.2 1.7 10 3.1 10C4.7 10 5.9 9 6.9 7.2L7.6 5.6M6.6 5.6H8.6'],
  '-': [3.8, 'M0.6 5.55H3.2M0.6 5.85H3.2M0.6 6.15H3.2'],
  ':': [1.7, 'M0.85 3.6V4.2M0.85 9.2V9.8'],
  '!': [1.9, 'M0.95 0V6.6M0.95 9.2V9.8'],
  '?': [5.6, 'M0.6 2.2C0.8 0.8 1.8 0 3 0C4.3 0 5 0.9 5 2.2C5 3.7 3 4.3 3 6.4M3 9.2V9.8'],
  '%': [8.2, 'M6.9 0L1.1 10M1.9 0.4C2.7 0.4 3.2 1.2 3.2 2.4C3.2 3.6 2.7 4.4 1.9 4.4C1.1 4.4 0.6 3.6 0.6 2.4C0.6 1.2 1.1 0.4 1.9 0.4ZM6.1 5.6C6.9 5.6 7.4 6.4 7.4 7.6C7.4 8.8 6.9 9.6 6.1 9.6C5.3 9.6 4.8 8.8 4.8 7.6C4.8 6.4 5.3 5.6 6.1 5.6Z'],
  'º': [3.4, 'M1.7 0.3C2.5 0.3 2.9 1.1 2.9 2.2C2.9 3.3 2.5 4.1 1.7 4.1C0.9 4.1 0.5 3.3 0.5 2.2C0.5 1.1 0.9 0.3 1.7 0.3ZM0.5 5.4H2.9'],
  ' ': [3.4, ''],
};

/** Path data as a list of segments with numbers, H and V turned into L, so any linear map can be applied to it. */
function parse(d) {
  const tokens = d.match(/[MLHVCZ]|-?\d*\.?\d+/g) ?? [];
  const segs = [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/^[MLHVCZ]$/.test(tokens[i])) {
      cmd = tokens[i++];
      if (cmd === 'Z') segs.push({ c: 'Z', p: [] });
      continue;
    }
    if (cmd === 'M' || cmd === 'L') { x = num(); y = num(); segs.push({ c: cmd, p: [[x, y]] }); cmd = 'L'; }
    else if (cmd === 'H') { x = num(); segs.push({ c: 'L', p: [[x, y]] }); }
    else if (cmd === 'V') { y = num(); segs.push({ c: 'L', p: [[x, y]] }); }
    else if (cmd === 'C') {
      const p = [[num(), num()], [num(), num()], [num(), num()]];
      [x, y] = p[2];
      segs.push({ c: 'C', p });
    } else throw new Error(`glyph path has an unknown command: ${d}`);
  }
  return segs;
}

const GLYPHS = Object.fromEntries(Object.entries(SKELETONS).map(([ch, [w, d]]) => [ch, { w, segs: parse(d) }]));

/** The characters the alphabet can draw. */
export const CHARSET = Object.freeze(Object.keys(GLYPHS).join(''));

const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]];

/** The pen as a pair of 2 x 2 maps: `ctm` stretches the drawing space, `inv` pre-squeezes the skeleton. */
function pen(k) {
  const a = (PEN_TILT * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const rot = [c, -s, s, c];
  const back = [c, s, -s, c];
  return { ctm: mul(mul(rot, [k, 0, 0, 1]), back), inv: mul(mul(rot, [1 / k, 0, 0, 1]), back) };
}

/** How far the oval pen reaches past the skeleton, in units: [across, up and down]. */
export function penReach(weight) {
  const { w, k } = WEIGHTS[weight];
  const a = (PEN_TILT * Math.PI) / 180;
  const [major, minor] = [(w * k) / 2, w / 2];
  return [Math.hypot(major * Math.cos(a), minor * Math.sin(a)), Math.hypot(major * Math.sin(a), minor * Math.cos(a))];
}

function glyph(ch) {
  const g = GLYPHS[ch];
  if (!g) throw new Error(`the engraver's alphabet has no ${JSON.stringify(ch)}`);
  return g;
}

/** Width of one line in units, from the first skeleton's left edge to the last one's right edge. */
export function lineUnits(text, { track = 1.2, wide = 1 } = {}) {
  const chars = [...text];
  return chars.reduce((sum, ch, i) => sum + glyph(ch).w * wide + (i < chars.length - 1 ? track : 0), 0);
}

/** The outside box of a block of lines in px for a cap height: { w, h, unit }. */
export function measure(lines, cap, { track = 1.2, wide = 1, gap = 4.2 } = {}) {
  const list = Array.isArray(lines) ? lines : [lines];
  const u = cap / CAP;
  return { w: Math.max(...list.map((l) => lineUnits(l, { track, wide }))) * u, h: (list.length * CAP + (list.length - 1) * gap) * u, unit: u };
}

/** Every block of lettering drawn since the last reset, with its outside box in px, for the margin check. */
export const DRAWN = [];

const fmt = (v) => String(Number(v.toFixed(3)));

/**
 * Whether lettering is drawn. `withoutWords` turns it off while build-art.mjs --no-words builds the word-free reference
 * pictures: `measure` still sizes every block, so the tags, plates and frames keep their size and place, but `letter`
 * and `shadowed` draw nothing and record nothing in DRAWN.
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
 * Engraved lettering. (x, y) is the anchor on the first line's cap line; `anchor` is 'start', 'middle' or 'end'.
 * `weight` picks the pen (display, text or small), `wide` stretches the letters, `track` is the space between
 * letters and `gap` between lines, both in units. Returns one group of stroked paths in `color`.
 */
export function letter(text, { x, y, cap, anchor = 'middle', color = C.ink, weight = 'text', wide = 1, track = 1.2, gap = 4.2 }) {
  const lines = Array.isArray(text) ? text : [text];
  for (const line of lines) if (typeof line !== 'string' || line.trim().length === 0) throw new Error('lettering needs text');
  if (!words) return '';
  const { w, k } = WEIGHTS[weight];
  const { ctm, inv } = pen(k);
  const u = cap / CAP;
  const apply = ([px, py]) => `${fmt(inv[0] * px + inv[1] * py)} ${fmt(inv[2] * px + inv[3] * py)}`;
  const paths = [];
  lines.forEach((line, li) => {
    const lw = lineUnits(line, { track, wide });
    let cx = anchor === 'middle' ? -lw / 2 : anchor === 'end' ? -lw : 0;
    const top = li * (CAP + gap);
    for (const ch of [...line]) {
      const g = glyph(ch);
      if (g.segs.length) {
        const d = g.segs.map(({ c, p }) => (c === 'Z' ? 'Z' : `${c}${p.map(([px, py]) => apply([cx + px * wide, top + py])).join(' ')}`)).join('');
        paths.push(`<path d="${d}"/>`);
      }
      cx += g.w * wide + track;
    }
  });
  const m = measure(lines, cap, { track, wide, gap });
  const [across, upDown] = penReach(weight);
  const left = anchor === 'middle' ? x - m.w / 2 : anchor === 'end' ? x - m.w : x;
  const descent = lines.at(-1).includes(',') || lines.at(-1).includes('Q') ? 1.6 * u : 0;
  DRAWN.push({ text: lines.join(' / '), box: { x: left - across * u, y: y - upDown * u, w: m.w + 2 * across * u, h: m.h + descent + 2 * upDown * u } });
  const transform = `translate(${r2(x)} ${r2(y)}) scale(${fmt(u)}) matrix(${ctm.map(fmt).join(' ')} 0 0)`;
  return `<g transform="${transform}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${paths.join('')}</g>`;
}

/** Lettering with a drop shadow in a second color, set down and right by `drop` units. */
export function shadowed(text, opts) {
  const { shadow = C.gold, drop = 0.55, ...rest } = opts;
  if (!words) return [letter(text, rest), ''];
  const u = rest.cap / CAP;
  const back = letter(text, { ...rest, x: rest.x + drop * u, y: rest.y + drop * u, color: shadow });
  DRAWN.pop();
  const front = letter(text, rest);
  const { box } = DRAWN.at(-1);
  box.w += drop * u;
  box.h += drop * u;
  return [back, front];
}

/**
 * Moves the records of lettering drawn since `from` into picture coordinates, for lettering drawn inside a group that
 * is moved by (dx, dy) and scaled by `k`, such as a vignette.
 */
export function placeDrawn(from, dx, dy, k = 1) {
  for (const { box } of DRAWN.slice(from)) {
    box.x = dx + box.x * k;
    box.y = dy + box.y * k;
    box.w *= k;
    box.h *= k;
  }
}
