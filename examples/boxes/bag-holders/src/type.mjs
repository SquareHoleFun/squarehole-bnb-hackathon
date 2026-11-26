/**
 * The sticker alphabet, drawn for this kit. Every letter is one thick round stroke on a grid 6 units tall, with an
 * ink outline around it, like a printed sticker. All lettering in the art comes from here, so the pictures need no
 * font file. Each glyph is [width in units, path data in units].
 */
import { C } from './palette.mjs';
import { r2 } from './doc.mjs';

/** Stroke of a letter, outline on each side, gap between two letters' strokes, gap between lines (units). */
export const STROKE = 1.5;
export const OUTLINE = 0.55;
export const GAP = 0.5;
export const LINE_GAP = 2.4;
export const CAP = 6;

const G = {
  A: [4, 'M0 6V2A2 2 0 0 1 4 2V6M0 3.7H4'],
  B: [4, 'M0 3V0H2.5A1.5 1.5 0 0 1 2.5 3H0V6H2.5A1.5 1.5 0 0 0 2.5 3'],
  C: [3.9, 'M3.73 1A2 2 0 0 0 0 2V4A2 2 0 0 0 3.73 5'],
  D: [4, 'M0 0V6H1.8A2.2 2.2 0 0 0 4 3.8V2.2A2.2 2.2 0 0 0 1.8 0Z'],
  E: [3.6, 'M3.6 0H0V6H3.6M0 3H3'],
  F: [3.6, 'M3.6 0H0V6M0 3H3'],
  G: [4, 'M3.73 1A2 2 0 0 0 0 2V4A2 2 0 0 0 4 4V3.3H2.3'],
  H: [4, 'M0 0V6M4 0V6M0 3H4'],
  I: [0, 'M0 0V6'],
  J: [3.4, 'M3.4 0V4.3A1.7 1.7 0 0 1 0 4.3'],
  K: [3.9, 'M0 0V6M3.8 0L0.6 3.4M1.6 2.4L3.9 6'],
  L: [3.4, 'M0 0V6H3.4'],
  M: [5, 'M0 6V0L2.5 3.4L5 0V6'],
  N: [4, 'M0 6V0L4 6V0'],
  O: [4, 'M2 0A2 2 0 0 1 4 2V4A2 2 0 0 1 0 4V2A2 2 0 0 1 2 0Z'],
  P: [3.9, 'M0 6V0H2.4A1.5 1.5 0 0 1 2.4 3H0'],
  Q: [4.3, 'M2 0A2 2 0 0 1 4 2V4A2 2 0 0 1 0 4V2A2 2 0 0 1 2 0ZM2.6 4.4L4.3 6.2'],
  R: [3.9, 'M0 6V0H2.4A1.5 1.5 0 0 1 2.4 3H0M2.1 3L3.9 6'],
  S: [3.5, 'M3.39 0.99A1.75 1.5 0 1 0 1.75 3A1.75 1.5 0 1 1 0.11 5.01'],
  T: [4, 'M0 0H4M2 0V6'],
  U: [4, 'M0 0V4A2 2 0 0 0 4 4V0'],
  V: [4.2, 'M0 0L2.1 6L4.2 0'],
  W: [5.4, 'M0 0L1.35 6L2.7 2.2L4.05 6L5.4 0'],
  X: [4, 'M0 0L4 6M4 0L0 6'],
  Y: [4, 'M0 0L2 3L4 0M2 3V6'],
  Z: [3.8, 'M0 0H3.8L0 6H3.8'],
  0: [4, 'M2 0A2 2 0 0 1 4 2V4A2 2 0 0 1 0 4V2A2 2 0 0 1 2 0Z'],
  1: [1.9, 'M0 1.2L1.9 0V6'],
  2: [3.8, 'M0.15 1.55A1.85 1.6 0 1 1 3.3 3L0 6H3.8'],
  3: [3.6, 'M0.1 0.9A1.75 1.45 0 1 1 1.75 2.95A1.8 1.52 0 1 1 0.05 5.05'],
  4: [4, 'M2.9 6V0L0 4.1H4'],
  5: [3.7, 'M3.5 0H0.4L0.15 2.75A1.85 1.65 0 1 1 0 5.25'],
  6: [4, 'M3.55 0.75A2 2 0 0 0 0 2.2V4M0 4A2 2 0 1 0 4 4A2 2 0 1 0 0 4'],
  7: [3.8, 'M0 0H3.8L1.3 6'],
  8: [3.8, 'M1.9 2.9A1.55 1.45 0 1 1 1.9 0A1.55 1.45 0 1 1 1.9 2.9M1.9 2.9A1.9 1.55 0 1 1 1.9 6A1.9 1.55 0 1 1 1.9 2.9'],
  9: [4, 'M4 2A2 2 0 1 0 0 2A2 2 0 1 0 4 2V3.8A2 2 0 0 1 0.45 5.25'],
  '%': [4.1, 'M3.75 0.1L0.35 5.9M0 0.85h0M4.1 5.15h0'],
  '.': [0, 'M0 6h0'],
  ',': [0.5, 'M0.5 5.9L0 7'],
  '!': [0, 'M0 0V3.6M0 6h0'],
  '?': [3.7, 'M0.1 1.55A1.8 1.55 0 1 1 1.9 3.2V3.9M1.9 6h0'],
  "'": [0, 'M0 0V1.7'],
  '+': [3.8, 'M1.9 1.3V4.9M0 3.1H3.8'],
  '-': [2.6, 'M0 3.2H2.6'],
  '#': [4.2, 'M1.5 0.3L0.9 5.7M3.3 0.3L2.7 5.7M0 1.9H4.2M0 4.1H4.2'],
  '→': [4.4, 'M0 3H4.2M2.4 1.1L4.3 3L2.4 4.9'],
  '←': [4.4, 'M4.4 3H0.2M2 1.1L0.1 3L2 4.9'],
  '↑': [3.8, 'M1.9 6V0.2M0 2.1L1.9 0.1L3.8 2.1'],
  '↓': [3.8, 'M1.9 0V5.8M0 3.9L1.9 5.9L3.8 3.9'],
  ' ': [1.4, ''],
};

/** The characters the alphabet can draw. */
export const CHARS = Object.freeze(Object.keys(G).join(''));

function glyph(ch) {
  const g = G[ch];
  if (!g) throw new Error(`the sticker alphabet has no ${JSON.stringify(ch)}`);
  return g;
}

/** Width of one line in units, measured on the outside of the outline. */
export function lineUnits(text) {
  const chars = [...text];
  const inner = chars.reduce((sum, ch, i) => sum + glyph(ch)[0] + (i < chars.length - 1 ? STROKE + GAP : 0), 0);
  return inner + STROKE + 2 * OUTLINE;
}

/**
 * The outside box of a block of lines, in px, for a cap height `cap`: { w, h, unit }.
 * The top of the box sits STROKE / 2 + OUTLINE units above the cap line.
 */
export function measure(lines, cap) {
  const list = Array.isArray(lines) ? lines : [lines];
  const u = cap / CAP;
  const w = Math.max(...list.map(lineUnits)) * u;
  const h = (list.length * CAP + (list.length - 1) * LINE_GAP + STROKE + 2 * OUTLINE) * u;
  return { w, h, unit: u };
}

/** Glyph paths of a block, each placed in unit space; the block's cap line starts at y = 0. */
function placed(lines, anchor) {
  const out = [];
  lines.forEach((text, li) => {
    const width = lineUnits(text) - STROKE - 2 * OUTLINE;
    const edge = STROKE / 2 + OUTLINE;
    let x = anchor === 'middle' ? -width / 2 : anchor === 'end' ? -width - edge : edge;
    const y = li * (CAP + LINE_GAP);
    for (const ch of [...text]) {
      const [w, d] = glyph(ch);
      if (d) out.push(`<path transform="translate(${r2(x)} ${r2(y)})" d="${d}"/>`);
      x += w + STROKE + GAP;
    }
  });
  return out.join('');
}

/**
 * Whether lettering is drawn. `withoutWords` turns it off while build-art.mjs --no-words builds the word-free reference
 * pictures: `measure` still sizes every block, so plates, buttons, patches and bags keep their size and place, but no
 * letter is drawn.
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
 * Lettering from the sticker alphabet. (x, y) is the anchor on the first line's cap line (its top).
 * `anchor` is 'start', 'middle' or 'end'. The art never writes the price coin's name, so the pictures work for any
 * community coin.
 */
export function lettering(text, { x, y, cap, color = C.canvas, outline = C.ink, shadow = null, depth = 0.9, anchor = 'middle' }) {
  const lines = Array.isArray(text) ? text : [text];
  for (const line of lines) if (/LINK/.test(line)) throw new Error('the art never writes the price coin\'s name');
  const u = cap / CAP;
  const inner = placed(lines, anchor);
  if (!words) return '';
  const layer = (dx, dy, stroke, width) => `<g transform="translate(${r2(x + dx)} ${r2(y + dy)}) scale(${Number(u.toFixed(4))})" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
  const d = depth * u;
  return [
    shadow ? layer(d, d, shadow, r2(STROKE + 2 * OUTLINE)) : '',
    outline ? layer(0, 0, outline, r2(STROKE + 2 * OUTLINE)) : '',
    layer(0, 0, color, STROKE),
  ].join('');
}
