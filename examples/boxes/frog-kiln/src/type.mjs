/**
 * The loop-tool alphabet, drawn for this kit: every letter is one or more round-ended strokes of the same width, like
 * lines cut into leather-hard clay with a potter's loop tool. Letters sit on a grid 10 units tall, and each one leans
 * and sits a little differently, by a seeded random source, so a word looks cut by hand and every build is the same.
 * All lettering in the art comes from here, so the pictures need no font file.
 *
 * Two treatments: `carved` cuts the letters through a dark glaze to the light clay below, with a shadow lip on the
 * upper left of each groove. `brushed` paints them in soot, like underglaze brushwork on a light wall.
 */
import { C, MIX } from './palette.mjs';
import { group, r2, seeded } from './doc.mjs';

/** Cap height, stroke, space between letters and between lines (units). */
export const CAP = 10;
export const STROKE = 1.9;
export const TRACK = 1.15;
export const LINE_GAP = 3.6;
/** How far a letter may lean (degrees) and sit off the line (units), at most. */
export const LEAN = 1.8;
export const BOB = 0.22;

/** Each glyph: its width in units and its strokes as path data, 0 at the cap line and 10 on the baseline. */
const G = {
  A: { w: 6.8, d: 'M0.95 9.05L3.4 0.95L5.85 9.05M1.75 6.4H5.05' },
  B: { w: 6.6, d: 'M0.95 0.95V9.05H3.5A2.1 2.1 0 0 0 3.5 4.85H0.95M0.95 0.95H3.25A1.95 1.95 0 0 1 3.25 4.85' },
  C: { w: 6.3, d: 'M5.14 1.9A2.55 4.05 0 1 0 5.14 8.1' },
  D: { w: 6.6, d: 'M0.95 0.95V9.05H2.9A2.75 4.05 0 0 0 2.9 0.95Z' },
  E: { w: 5.8, d: 'M4.85 0.95H0.95V9.05H4.85M0.95 5H4.3' },
  F: { w: 5.6, d: 'M4.75 0.95H0.95V9.05M0.95 5H4.2' },
  G: { w: 7, d: 'M5.29 1.99A2.6 4.05 0 1 0 6.12 5.56H3.9' },
  H: { w: 6.6, d: 'M0.95 0.95V9.05M5.65 0.95V9.05M0.95 5H5.65' },
  I: { w: 1.9, d: 'M0.95 0.95V9.05' },
  J: { w: 5.2, d: 'M4.25 0.95V6.65A1.65 2.4 0 0 1 0.95 6.65' },
  K: { w: 6.2, d: 'M0.95 0.95V9.05M5.3 0.95L0.95 5.6M2.55 3.9L5.3 9.05' },
  L: { w: 5.2, d: 'M0.95 0.95V9.05H4.65' },
  M: { w: 8, d: 'M0.95 9.05V0.95L4 6.6L7.05 0.95V9.05' },
  N: { w: 6.8, d: 'M0.95 9.05V0.95L5.85 9.05V0.95' },
  O: { w: 7, d: 'M0.95 5A2.55 4.05 0 1 0 6.05 5A2.55 4.05 0 1 0 0.95 5Z' },
  P: { w: 6.2, d: 'M0.95 9.05V0.95H3.25A2 2.05 0 0 1 3.25 5.05H0.95' },
  Q: { w: 7.2, d: 'M0.95 5A2.55 4.05 0 1 0 6.05 5A2.55 4.05 0 1 0 0.95 5ZM4.3 6.9L6.25 9.05' },
  R: { w: 6.4, d: 'M0.95 9.05V0.95H3.25A2 2.05 0 0 1 3.25 5.05H0.95M3.1 5.05L5.45 9.05' },
  S: { w: 5.9, d: 'M5 2.05C4.55 1.3 3.85 0.95 2.95 0.95C1.75 0.95 0.95 1.75 0.95 2.75C0.95 4 2 4.45 2.95 4.75C4.15 5.1 5 5.75 5 7C5 8.25 4.05 9.05 2.85 9.05C1.9 9.05 1.2 8.65 0.85 8' },
  T: { w: 6.2, d: 'M0.95 0.95H5.25M3.1 0.95V9.05' },
  U: { w: 6.6, d: 'M0.95 0.95V6.05A2.35 3 0 0 0 5.65 6.05V0.95' },
  V: { w: 6.6, d: 'M0.95 0.95L3.3 9.05L5.65 0.95' },
  W: { w: 9.2, d: 'M0.95 0.95L2.6 9.05L4.6 2.6L6.6 9.05L8.25 0.95' },
  X: { w: 6.2, d: 'M0.95 0.95L5.25 9.05M5.25 0.95L0.95 9.05' },
  Y: { w: 6.4, d: 'M0.95 0.95L3.2 5L5.45 0.95M3.2 5V9.05' },
  Z: { w: 6, d: 'M1 0.95H5.05L0.95 9.05H5.05' },
  0: { w: 6.2, d: 'M0.95 5A2.15 4.05 0 1 0 5.25 5A2.15 4.05 0 1 0 0.95 5Z' },
  1: { w: 4, d: 'M0.95 2.75L3.05 0.95V9.05' },
  2: { w: 6.1, d: 'M1.05 2.75C1.25 1.6 2.05 0.95 3.05 0.95C4.2 0.95 5.05 1.75 5.05 2.95C5.05 4.35 3.9 5.35 0.95 9.05H5.15' },
  3: { w: 6.05, d: 'M0.95 1.85C1.55 1.25 2.25 0.95 3 0.95C4.2 0.95 5 1.65 5 2.8C5 3.95 4.1 4.75 2.75 4.75C4.25 4.75 5.1 5.6 5.1 6.9C5.1 8.2 4.15 9.05 2.85 9.05C2.05 9.05 1.3 8.7 0.9 8.1' },
  4: { w: 6.3, d: 'M4.2 9.05V0.95L0.95 6.55H5.35' },
  5: { w: 6.05, d: 'M4.9 0.95H1.5L1.15 4.55C1.75 4.2 2.4 4.05 3 4.05C4.3 4.05 5.1 5.05 5.1 6.5C5.1 7.95 4.15 9.05 2.85 9.05C2 9.05 1.3 8.7 0.9 8.1' },
  6: { w: 6.2, d: 'M4.8 1.45C4.35 1.1 3.75 0.95 3.2 0.95C1.85 0.95 0.95 2.4 0.95 5.2C0.95 7.6 1.85 9.05 3.15 9.05C4.45 9.05 5.25 8 5.25 6.6C5.25 5.2 4.4 4.25 3.15 4.25C2.2 4.25 1.4 4.8 0.98 5.7' },
  7: { w: 5.8, d: 'M0.95 0.95H4.85L2.15 9.05' },
  8: { w: 6.2, d: 'M1.3 2.85A1.8 1.9 0 1 0 4.9 2.85A1.8 1.9 0 1 0 1.3 2.85ZM0.95 6.95A2.15 2.1 0 1 0 5.25 6.95A2.15 2.1 0 1 0 0.95 6.95Z' },
  9: { w: 6.2, d: 'M1.4 8.55C1.85 8.9 2.45 9.05 3 9.05C4.35 9.05 5.25 7.6 5.25 4.8C5.25 2.4 4.35 0.95 3.05 0.95C1.75 0.95 0.95 2 0.95 3.4C0.95 4.8 1.8 5.75 3.05 5.75C4 5.75 4.8 5.2 5.22 4.3' },
  '.': { w: 1.9, d: 'M0.95 8.95V9.05' },
  ',': { w: 2.1, d: 'M1.15 8.95V9.15Q1.15 10.35 0.55 11', bottom: 11.95 },
  '!': { w: 1.9, d: 'M0.95 0.95V6.2M0.95 8.95V9.05' },
  '?': { w: 5.6, d: 'M0.95 2.65C1.1 1.55 1.9 0.95 2.9 0.95C4 0.95 4.7 1.7 4.7 2.7C4.7 4.1 2.85 4.45 2.85 6.2M2.85 8.95V9.05' },
  "'": { w: 1.9, d: 'M0.95 0.95V3.1' },
  ':': { w: 1.9, d: 'M0.95 3.65V3.75M0.95 8.95V9.05' },
  '-': { w: 4.1, d: 'M0.95 5.3H3.15' },
  '%': { w: 7.6, d: 'M6.3 0.95L1.3 9.05M0.95 2.5A1.15 1.55 0 1 0 3.25 2.5A1.15 1.55 0 1 0 0.95 2.5ZM4.35 7.5A1.15 1.55 0 1 0 6.65 7.5A1.15 1.55 0 1 0 4.35 7.5Z' },
  '+': { w: 5.2, d: 'M2.6 2.9V7.1M0.95 5H4.25' },
  ' ': { w: 3.4, d: '' },
};

/** The characters the alphabet can draw. */
export const CHARSET = Object.freeze(Object.keys(G).join(''));

/** Every block of lettering drawn since the last reset, with its outside box in px, for the margin check. */
export const DRAWN = [];

function glyph(ch) {
  const g = G[ch];
  if (!g) throw new Error(`the loop-tool alphabet has no ${JSON.stringify(ch)}`);
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

/**
 * The glyphs of a block, placed in unit space with the first line's cap line at y = 0, each with its own lean and
 * bob. Returns path elements without paint, to be stroked by a treatment.
 */
function layout(lines, anchor, hand, seed) {
  const rand = seeded(`${seed}|${lines.join('/')}`);
  const out = [];
  lines.forEach((text, li) => {
    const lw = lineUnits(text);
    let x = anchor === 'middle' ? -lw / 2 : anchor === 'end' ? -lw : 0;
    const y = li * (CAP + LINE_GAP);
    for (const ch of [...text]) {
      const g = glyph(ch);
      const lean = hand ? (rand() * 2 - 1) * LEAN : 0;
      const bob = hand ? (rand() * 2 - 1) * BOB : 0;
      if (g.d) {
        const t = `translate(${r2(x)} ${r2(y + bob)})${lean ? ` rotate(${r2(lean)} ${r2(g.w / 2)} 5)` : ''}`;
        out.push(`<path transform="${t}" d="${g.d}"/>`);
      }
      x += g.w + TRACK;
    }
  });
  return out.join('');
}

/**
 * Whether lettering is drawn. `withoutWords` turns it off while build-art.mjs --no-words builds the word-free reference
 * pictures: `measure` still sizes every block, so the name plaque, the clay tags, the crate's label and the kiln's
 * counter keep their size and place, but `carved` and `brushed` draw nothing and record nothing in DRAWN.
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

function check(lines) {
  for (const line of lines) {
    if (typeof line !== 'string' || line.length === 0) throw new Error('lettering needs text');
  }
}

/** Records a block's outside box in px, with room for the lean and the bob. */
function record(lines, { x, y, cap, anchor }) {
  const m = measure(lines, cap);
  const slack = (BOB + 0.45) * m.unit;
  const left = anchor === 'middle' ? x - m.w / 2 : anchor === 'end' ? x - m.w : x;
  const bottom = lines.at(-1).includes(',') ? 1.95 * m.unit : 0;
  DRAWN.push({ text: lines.join(' / '), box: { x: left - slack, y: y - slack, w: m.w + 2 * slack, h: m.h + bottom + 2 * slack } });
  return m;
}

/**
 * Letters cut through a dark glaze to the light clay. (x, y) is the anchor on the first line's cap line (its top);
 * `anchor` is 'start', 'middle' or 'end'. Three strokes of the same letters: a light rim where the glaze's cut edge
 * catches the light (lower right), the groove's dark wall, and the clay floor moved down and right, so a dark lip
 * shows on the upper left of every cut.
 */
export function carved(text, { x, y, cap, anchor = 'middle', floor = C.bisque, wall = MIX.groove, rim = MIX.slabLight, hand = true, seed = 'carved' }) {
  const lines = Array.isArray(text) ? text : [text];
  check(lines);
  if (!words) return [];
  const m = record(lines, { x, y, cap, anchor });
  const u = m.unit;
  const glyphs = layout(lines, anchor, hand, seed);
  const stroke = (color, width, dx, dy) => group(
    `transform="translate(${r2(x + dx * u)} ${r2(y + dy * u)}) scale(${Number(u.toFixed(4))})" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`,
    glyphs,
  );
  return [stroke(rim, 2.15, 0.22, 0.26), stroke(wall, STROKE, 0, 0), stroke(floor, 1.42, 0.2, 0.24)];
}

/** Letters painted in one color, like underglaze brushwork. Same placement as `carved`. */
export function brushed(text, { x, y, cap, anchor = 'middle', color = C.soot, width = 1.75, hand = true, seed = 'brushed' }) {
  const lines = Array.isArray(text) ? text : [text];
  check(lines);
  if (!words) return '';
  const m = record(lines, { x, y, cap, anchor });
  const u = m.unit;
  return group(
    `transform="translate(${r2(x)} ${r2(y)}) scale(${Number(u.toFixed(4))})" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`,
    layout(lines, anchor, hand, seed),
  );
}
