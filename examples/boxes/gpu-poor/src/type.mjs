/**
 * The tube alphabet: rounded single-stroke letters drawn for this kit, like bent glass tubes or a heat trace.
 * Each letter is a path on a grid 6 units tall (the cap height), drawn with round ends and round corners.
 * Every word in the art is built from these strokes, so the art needs no font file.
 *
 * A glyph is [width, path]. Paths use only M, L, A, Q and Z with absolute numbers in grid units.
 */
const G = {
  A: [4, 'M0 6L0 2A2 2 0 0 1 4 2L4 6M0 3.8L4 3.8'],
  B: [4, 'M0 6L0 0L2.5 0A1.5 1.5 0 0 1 2.5 3L0 3M2.5 3A1.5 1.5 0 0 1 2.5 6L0 6'],
  C: [4, 'M3.41 0.59A2 2 0 0 0 0 2L0 4A2 2 0 0 0 3.41 5.41'],
  D: [4, 'M0 0L2 0A2 2 0 0 1 4 2L4 4A2 2 0 0 1 2 6L0 6Z'],
  E: [3.6, 'M3.6 0L0 0L0 6L3.6 6M0 3L3 3'],
  F: [3.6, 'M3.6 0L0 0L0 6M0 3L3 3'],
  G: [4, 'M3.41 0.59A2 2 0 0 0 0 2L0 4A2 2 0 0 0 4 4L4 3.2L2.2 3.2'],
  H: [4, 'M0 0L0 6M4 0L4 6M0 3L4 3'],
  I: [0, 'M0 0L0 6'],
  J: [3.6, 'M3.6 0L3.6 4.2A1.8 1.8 0 0 1 0 4.2'],
  K: [4, 'M0 0L0 6M3.8 0L0 3.9M1.4 2.5L4 6'],
  L: [3.4, 'M0 0L0 6L3.4 6'],
  M: [5, 'M0 6L0 0L2.5 3.4L5 0L5 6'],
  N: [4, 'M0 6L0 0L4 6L4 0'],
  O: [4, 'M0 2A2 2 0 0 1 4 2L4 4A2 2 0 0 1 0 4Z'],
  P: [4, 'M0 6L0 0L2.4 0A1.6 1.6 0 0 1 2.4 3.2L0 3.2'],
  Q: [4, 'M0 2A2 2 0 0 1 4 2L4 4A2 2 0 0 1 0 4ZM2.6 4.6L4.2 6.2'],
  R: [4, 'M0 6L0 0L2.4 0A1.6 1.6 0 0 1 2.4 3.2L0 3.2M2.2 3.2L4 6'],
  S: [4, 'M4 0L1.5 0A1.5 1.5 0 0 0 1.5 3L2.5 3A1.5 1.5 0 0 1 2.5 6L0 6'],
  T: [4, 'M0 0L4 0M2 0L2 6'],
  U: [4, 'M0 0L0 4A2 2 0 0 0 4 4L4 0'],
  V: [4.4, 'M0 0L2.2 6L4.4 0'],
  W: [5.6, 'M0 0L1.4 6L2.8 1.8L4.2 6L5.6 0'],
  X: [4, 'M0 0L4 6M4 0L0 6'],
  Y: [4, 'M0 0L2 3L4 0M2 3L2 6'],
  Z: [4, 'M0 0L4 0L0 6L4 6'],
  0: [4, 'M0 2A2 2 0 0 1 4 2L4 4A2 2 0 0 1 0 4Z'],
  1: [1.8, 'M0 1.4L1.8 0L1.8 6'],
  2: [4, 'M0 2A2 2 0 0 1 4 2L0 6L4 6'],
  3: [4, 'M0.2 0L3.8 0L1.6 2.8L2.4 2.8A1.6 1.6 0 0 1 2.4 6L0 6'],
  4: [4, 'M3 6L3 0L0 4.2L4 4.2'],
  5: [4, 'M3.8 0L0.4 0L0.2 2.8L2.4 2.8A1.6 1.6 0 0 1 2.4 6L0 6'],
  6: [4, 'M3.41 0.59A2 2 0 0 0 0 2L0 4A2 2 0 0 0 4 4A2 2 0 0 0 0 4'],
  7: [4, 'M0 0L4 0L1.4 6'],
  8: [4, 'M2 0A1.5 1.5 0 0 1 2 3A1.5 1.5 0 0 1 2 0ZM2 3A1.9 1.5 0 0 1 2 6A1.9 1.5 0 0 1 2 3Z'],
  9: [4, 'M0.59 5.41A2 2 0 0 0 4 4L4 2A2 2 0 0 0 0 2A2 2 0 0 0 4 2'],
  '%': [4, 'M4 0L0 6M0 1A0.9 0.9 0 1 0 1.8 1A0.9 0.9 0 1 0 0 1M2.2 5A0.9 0.9 0 1 0 4 5A0.9 0.9 0 1 0 2.2 5'],
  '+': [3.2, 'M1.6 1.4L1.6 4.6M0 3L3.2 3'],
  '-': [2.6, 'M0 3L2.6 3'],
  '=': [3.4, 'M0 2.2L3.4 2.2M0 3.8L3.4 3.8'],
  '.': [0, 'M0 6L0 6'],
  ',': [0.6, 'M0.6 5.6L0 7'],
  ':': [0, 'M0 2.4L0 2.4M0 6L0 6'],
  '!': [0, 'M0 0L0 3.8M0 6L0 6'],
  '?': [4, 'M0 2A2 2 0 0 1 4 2Q4 3.2 2 3.8L2 4.2M2 6L2 6'],
  "'": [0, 'M0 0L0 1.6'],
  '/': [3, 'M3 0L0 6'],
  '#': [4.4, 'M1.4 0L0.6 6M3.8 0L3 6M0 2L4.4 2M0 4L4.4 4'],
  // A smaller S with one bar through the full height, for the stock's cashtag, $NVDA.
  '$': [3.6, 'M3.6 0.75L1.4 0.75A1.125 1.125 0 0 0 1.4 3L2.2 3A1.125 1.125 0 0 1 2.2 5.25L0 5.25M1.8 0L1.8 6'],
  '→': [5, 'M0 3L5 3M3 1L5 3L3 5'],
  '←': [5, 'M5 3L0 3M2 1L0 3L2 5'],
  '↑': [4, 'M2 6L2 0M0 2L2 0L4 2'],
  '↓': [4, 'M2 0L2 6M0 4L2 6L4 4'],
  ' ': [1.4, ''],
};

/** Cap height in grid units. */
export const CAP = 6;
/** Gap between lines in grid units, from the bottom of one line to the top of the next. */
export const LINE_GAP = 3.6;

const n2 = (v) => Number(v.toFixed(2));

function glyph(ch) {
  const g = G[ch];
  if (!g) throw new Error(`no glyph for ${JSON.stringify(ch)}`);
  return g;
}

/** Moves and scales a glyph path: every point (x, y) becomes (ox + x * s, oy + y * s). */
function place(d, s, ox, oy) {
  const tokens = d.match(/[MLAQZ]|-?\d*\.?\d+/g) ?? [];
  const out = [];
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M' || cmd === 'L') out.push(`${cmd}${n2(ox + num() * s)} ${n2(oy + num() * s)}`);
    else if (cmd === 'Q') out.push(`Q${n2(ox + num() * s)} ${n2(oy + num() * s)} ${n2(ox + num() * s)} ${n2(oy + num() * s)}`);
    else if (cmd === 'A') {
      const [rx, ry, rot, large, sweep, x, y] = [num(), num(), num(), num(), num(), num(), num()];
      out.push(`A${n2(rx * s)} ${n2(ry * s)} ${rot} ${large} ${sweep} ${n2(ox + x * s)} ${n2(oy + y * s)}`);
    } else if (cmd === 'Z') out.push('Z');
    else throw new Error(`unknown path command ${cmd}`);
  }
  return out.join('');
}

/** The gap between two letters in grid units, for a stroke `sw` units wide. */
const letterGap = (sw) => sw + 1.25;

/** Width of one line in grid units, measured on the stroke centres. */
export function lineUnits(text, sw = 1) {
  const chars = [...text];
  return chars.reduce((sum, ch) => sum + glyph(ch)[0], 0) + letterGap(sw) * Math.max(0, chars.length - 1);
}

/** One line as a single path, starting at (x, y) at the top of the caps. `s` is pixels per grid unit. */
function linePath(text, s, x, y, sw) {
  let cx = x;
  const parts = [];
  for (const ch of text) {
    const [w, d] = glyph(ch);
    if (d) parts.push(place(d, s, cx, y));
    cx += (w + letterGap(sw)) * s;
  }
  return parts.join('');
}

/** While `recordLettering` runs, every line of lettering drawn is noted here, with its cap height in pixels. */
let recorder = null;

/**
 * Whether lettering is drawn. `withoutWords` turns it off while build-art.mjs --no-words builds the word-free reference
 * pictures: every call still measures its box, so plates and everything placed by a box keep their size and place,
 * but no stroke is drawn and no line is recorded.
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
 * Runs `draw` and returns every line of lettering it drew, in order. check.mjs uses it to read the words in the
 * pictures, which are paths and carry no text. With `sizes`, each line comes as { text, size }, size being the cap
 * height in pixels, so the check can tell how big the words are.
 */
export function recordLettering(draw, { sizes = false } = {}) {
  const seen = [];
  recorder = seen;
  try {
    draw();
  } finally {
    recorder = null;
  }
  return sizes ? seen : seen.map((line) => line.text);
}

/**
 * Lettering. `size` is the cap height in pixels, (x, y) the anchor at the top of the first line.
 * `sw` is the stroke width in grid units. `layers` draws the same strokes several times, widest first,
 * as [color, width factor, opacity]; that is how the hot tube letters get their bands.
 * Returns the markup and the box the letters cover, strokes included.
 */
export function lettering(text, { x, y, size, color, sw = 1, anchor = 'middle', layers = null, lineGap = LINE_GAP }) {
  const lines = Array.isArray(text) ? text : [text];
  if (recorder && words) recorder.push(...lines.map((line) => ({ text: line, size })));
  const s = size / CAP;
  const widest = layers ? Math.max(...layers.map(([, f]) => f)) * sw : sw;
  const units = lines.map((t) => lineUnits(t, widest));
  const wMax = Math.max(...units) * s;
  const d = lines.map((t, i) => {
    const w = units[i] * s;
    const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    return linePath(t, s, left, y + i * (CAP + lineGap) * s, widest);
  }).join('');
  const stroke = (c, width, opacity = 1) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="${n2(width * s)}" stroke-linecap="round" stroke-linejoin="round"${opacity < 1 ? ` stroke-opacity="${opacity}"` : ''}/>`;
  const markup = layers ? layers.map(([c, f, o = 1]) => stroke(c, f * sw, o)).join('') : stroke(color, sw);
  const h = (lines.length * CAP + (lines.length - 1) * lineGap) * s;
  const pad = (widest * s) / 2;
  const left = anchor === 'middle' ? x - wMax / 2 : anchor === 'end' ? x - wMax : x;
  const box = { x: left - pad, y: y - pad, w: wMax + 2 * pad, h: h + 2 * pad };
  return words ? { markup, box, d, s } : { markup: '', box, d: '', s };
}

/** Every character the alphabet can draw. */
export const CHARSET = Object.freeze(Object.keys(G));
