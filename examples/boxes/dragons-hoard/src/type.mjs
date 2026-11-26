/**
 * The gilt alphabet: capitals like letters cut into a stone plaque and gilded. Each letter is a set of even strokes
 * with square ends and sharp corners, plus thin serifs where a stroke meets the baseline or the cap line. Every word
 * in the art is built from these strokes, so the art needs no font file.
 *
 * Coordinates are grid units: the cap line is y 0, the baseline y 6. A glyph is [width, strokes, serifs]. Strokes use
 * only M, L, A and Z. Serifs are tokens: `t<x>` and `b<x>` put a level serif on the cap line or the baseline,
 * `d<x>,<y>`, `u<x>,<y>` and `c<x>,<y>` put an upright beak below, above or across a point.
 */
const G = {
  A: [4.6, 'M0 6L2.3 0L4.6 6M1.08 3.85L3.52 3.85', 'b0 b4.6'],
  B: [4.1, 'M0 0L0 6M0 0L2.55 0A1.45 1.45 0 0 1 2.55 2.9L0 2.9M2.55 2.9L2.65 2.9A1.55 1.55 0 0 1 2.65 6L0 6', 't0 b0'],
  C: [4.2, 'M4.06 1.02A2.45 3 0 1 0 4.06 4.98', 'c4.06,1.02 c4.06,4.98'],
  D: [4.6, 'M0 0L0 6M0 0L1.7 0A2.9 3 0 0 1 1.7 6L0 6', 't0 b0'],
  E: [3.7, 'M3.55 0L0 0L0 6L3.7 6M0 2.9L2.75 2.9', 't0 b0 d3.55,0 u3.7,6 c2.75,2.9'],
  F: [3.55, 'M3.55 0L0 0L0 6M0 2.9L2.75 2.9', 't0 b0 d3.55,0 c2.75,2.9'],
  G: [4.5, 'M4.1 1.05A2.45 3 0 1 0 4.5 3.7L4.5 6M2.75 3.55L4.5 3.55', 'c4.1,1.05'],
  H: [4.3, 'M0 0L0 6M4.3 0L4.3 6M0 3L4.3 3', 't0 b0 t4.3 b4.3'],
  I: [0, 'M0 0L0 6', 't0 b0'],
  J: [2.6, 'M2.6 0L2.6 4.3A1.6 1.7 0 0 1 0 4.85', 't2.6'],
  K: [4.2, 'M0 0L0 6M4.05 0L0 3.7M1.45 2.6L4.2 6', 't0 b0 t4.05 b4.2'],
  L: [3.5, 'M0 0L0 6L3.5 6', 't0 b0 u3.5,6'],
  M: [5.6, 'M0 6L0.35 0L2.8 6L5.25 0L5.6 6', 'b0 b5.6'],
  N: [4.4, 'M0 6L0 0L4.4 6L4.4 0', 'b0 t4.4'],
  O: [4.8, 'M2.4 0A2.4 3 0 1 1 2.4 6A2.4 3 0 1 1 2.4 0Z', ''],
  P: [4, 'M0 0L0 6M0 0L2.45 0A1.55 1.6 0 0 1 2.45 3.2L0 3.2', 't0 b0'],
  Q: [4.8, 'M2.4 0A2.4 3 0 1 1 2.4 6A2.4 3 0 1 1 2.4 0ZM2.9 4.7L4.9 6.7', ''],
  R: [4.2, 'M0 0L0 6M0 0L2.45 0A1.55 1.55 0 0 1 2.45 3.1L0 3.1M2.1 3.1L4.2 6', 't0 b0 b4.2'],
  S: [3.8, 'M3.5 0.75A1.75 1.5 0 1 0 1.9 3A1.9 1.5 0 1 1 0.2 5.25', 'c3.5,0.75 c0.2,5.25'],
  T: [4.4, 'M0 0L4.4 0M2.2 0L2.2 6', 'b2.2 d0,0 d4.4,0'],
  U: [4.3, 'M0 0L0 3.9A2.15 2.1 0 0 0 4.3 3.9L4.3 0', 't0 t4.3'],
  V: [4.6, 'M0 0L2.3 6L4.6 0', 't0 t4.6'],
  W: [6.2, 'M0 0L1.5 6L3.1 1L4.7 6L6.2 0', 't0 t6.2'],
  X: [4.4, 'M0 0L4.4 6M4.4 0L0 6', 't0 t4.4 b0 b4.4'],
  Y: [4.4, 'M0 0L2.2 3.1L4.4 0M2.2 3.1L2.2 6', 't0 t4.4 b2.2'],
  Z: [4, 'M0.1 0L4 0L0 6L4 6', 'd0.1,0 u4,6'],
  0: [4, 'M2 0A2 3 0 1 1 2 6A2 3 0 1 1 2 0Z', ''],
  1: [2.2, 'M0 1.25L1.6 0L1.6 6', 'b1.6'],
  2: [3.9, 'M0.15 1.55A1.85 1.6 0 1 1 3.55 2.6L0 6L3.9 6', 'u3.9,6'],
  3: [3.8, 'M0.25 0L3.6 0L1.75 2.55A1.75 1.72 0 1 1 0.1 5.15', 'd0.25,0'],
  4: [4.2, 'M3 6L3 0L0 4.2L4.2 4.2', 'b3'],
  5: [3.8, 'M3.6 0L0.55 0L0.3 2.75A1.85 1.68 0 1 1 0.1 5.2', 'd3.6,0'],
  6: [3.9, 'M3.55 0.4A3.4 4.6 0 0 0 0 4.1A1.95 1.9 0 1 0 3.9 4.1A1.95 1.9 0 1 0 0 4.1', ''],
  7: [3.9, 'M0 0L3.9 0L1.35 6', 'd0,0 b1.35'],
  8: [3.9, 'M1.95 0A1.6 1.45 0 1 1 1.95 2.9A1.6 1.45 0 1 1 1.95 0ZM1.95 2.9A1.95 1.55 0 1 1 1.95 6A1.95 1.55 0 1 1 1.95 2.9Z', ''],
  9: [3.9, 'M0.35 5.6A3.4 4.6 0 0 0 3.9 1.9A1.95 1.9 0 1 0 0 1.9A1.95 1.9 0 1 0 3.9 1.9', ''],
  '%': [4.4, 'M4.2 0L0.2 6M1 0.05A0.95 1.05 0 1 1 1 2.15A0.95 1.05 0 1 1 1 0.05ZM3.4 3.85A0.95 1.05 0 1 1 3.4 5.95A0.95 1.05 0 1 1 3.4 3.85Z', ''],
  "'": [0, 'M0 0L0 1.7', ''],
  '.': [0, 'M0 5.6L0 5.6', ''],
  ',': [0.7, 'M0.6 5.6L0 7', ''],
  ':': [0, 'M0 2.2L0 2.2M0 5.6L0 5.6', ''],
  '!': [0, 'M0 0L0 3.8M0 5.6L0 5.6', ''],
  '?': [3.6, 'M0.1 1.5A1.75 1.5 0 1 1 1.8 3.3L1.8 4M1.8 5.6L1.8 5.6', ''],
  '-': [2.4, 'M0 3.3L2.4 3.3', ''],
  '+': [3.4, 'M1.7 1.6L1.7 5M0 3.3L3.4 3.3', ''],
  '·': [0, 'M0 3.1L0 3.1', ''],
  '/': [3, 'M3 0L0 6', ''],
  '→': [5, 'M0 3L4.6 3M2.8 1.2L4.6 3L2.8 4.8', ''],
  '←': [5, 'M5 3L0.4 3M2.2 1.2L0.4 3L2.2 4.8', ''],
  '↑': [3.6, 'M1.8 6L1.8 0.4M0 2.2L1.8 0.4L3.6 2.2', ''],
  '↓': [3.6, 'M1.8 0L1.8 5.6M0 3.8L1.8 5.6L3.6 3.8', ''],
  ' ': [1.6, '', ''],
};

/** Cap height in grid units. */
export const CAP = 6;
/** Room between lines in grid units, from one baseline to the next cap line. */
export const LINE_GAP = 3.4;
/** Serif length and beak length in grid units, and the serif stroke as a share of the main stroke. */
const SERIF = 1.7;
const BEAK = 1.05;
const SERIF_WEIGHT = 0.58;

const n2 = (v) => {
  const n = Number(v.toFixed(2));
  return Object.is(n, -0) ? 0 : n;
};

function glyph(ch) {
  const g = G[ch];
  if (!g) throw new Error(`the gilt alphabet has no ${JSON.stringify(ch)}`);
  return g;
}

/** Moves and scales a path in grid units: every point (x, y) becomes (ox + x * s, oy + y * s). */
function place(d, s, ox, oy) {
  const tokens = d.match(/[MLAZ]|-?\d*\.?\d+/g) ?? [];
  const out = [];
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M' || cmd === 'L') out.push(`${cmd}${n2(ox + num() * s)} ${n2(oy + num() * s)}`);
    else if (cmd === 'A') {
      const [rx, ry, rot, large, sweep, x, y] = [num(), num(), num(), num(), num(), num(), num()];
      out.push(`A${n2(rx * s)} ${n2(ry * s)} ${rot} ${large} ${sweep} ${n2(ox + x * s)} ${n2(oy + y * s)}`);
    } else if (cmd === 'Z') out.push('Z');
    else throw new Error(`unknown path command ${cmd}`);
  }
  return out.join('');
}

/** The serif strokes of one glyph as a path in grid units. */
function serifPath(spec) {
  if (!spec) return '';
  return spec.split(/\s+/).map((tok) => {
    const kind = tok[0];
    const [x, y] = tok.slice(1).split(',').map(Number);
    if (kind === 't') return `M${n2(x - SERIF / 2)} 0L${n2(x + SERIF / 2)} 0`;
    if (kind === 'b') return `M${n2(x - SERIF / 2)} 6L${n2(x + SERIF / 2)} 6`;
    if (kind === 'd') return `M${x} ${y}L${x} ${n2(y + BEAK)}`;
    if (kind === 'u') return `M${x} ${y}L${x} ${n2(y - BEAK)}`;
    if (kind === 'c') return `M${x} ${n2(y - BEAK / 2)}L${x} ${n2(y + BEAK / 2)}`;
    throw new Error(`unknown serif ${tok}`);
  }).join('');
}

/** The room between two letters in grid units, for a main stroke `sw` units wide. */
const letterGap = (sw) => sw + 1.1;

/** Width of one line in grid units, measured on the stroke centres. */
export function lineUnits(text, sw = 1) {
  const chars = [...text];
  return chars.reduce((sum, ch) => sum + glyph(ch)[0], 0) + letterGap(sw) * Math.max(0, chars.length - 1);
}

/** One line as two paths, the main strokes and the serifs, starting at (x, y) on the cap line. */
function linePaths(text, s, x, y, sw) {
  let cx = x;
  const main = [];
  const serifs = [];
  for (const ch of text) {
    const [w, d, spec] = glyph(ch);
    if (d) main.push(place(d, s, cx, y));
    const sp = serifPath(spec);
    if (sp) serifs.push(place(sp, s, cx, y));
    cx += (w + letterGap(sw)) * s;
  }
  return { main: main.join(''), serifs: serifs.join('') };
}

/**
 * Whether lettering is drawn. `withoutWords` turns it off while build-art.mjs --no-words builds the word-free reference
 * pictures: every call still measures its box, so plates and everything placed by a box keep their size and place,
 * but no letter is drawn and nothing goes into DRAWN.
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
 * Lettering. `size` is the cap height in pixels and (x, y) the anchor on the cap line of the first line. `sw` is the
 * main stroke in grid units. `layers` draws the strokes several times, as [color, extra width in grid units, dx, dy,
 * opacity]; the gilt look is an ink outline, a dark bevel, the gold and a thin shine. Without `layers` it draws one
 * color. Returns the markup and the box the letters cover, outline included. `measure: true` only measures.
 */
export function lettering(text, { x, y, size, color, sw = 1, anchor = 'middle', layers = null, lineGap = LINE_GAP, measure = false }) {
  const lines = Array.isArray(text) ? text : [text];
  const s = size / CAP;
  const units = lines.map((t) => lineUnits(t, sw));
  const wMax = Math.max(...units) * s;
  const paths = lines.map((t, i) => {
    const w = units[i] * s;
    const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    return linePaths(t, s, left, y + i * (CAP + lineGap) * s, sw);
  });
  const main = paths.map((p) => p.main).join('');
  const serifs = paths.map((p) => p.serifs).join('');
  const stroke = (d, c, width, dx, dy, opacity) => (d
    ? `<path d="${d}"${dx || dy ? ` transform="translate(${n2(dx * s)} ${n2(dy * s)})"` : ''} fill="none" stroke="${c}" stroke-width="${n2(width * s)}" stroke-linecap="square" stroke-linejoin="miter" stroke-miterlimit="2.2"${opacity < 1 ? ` stroke-opacity="${opacity}"` : ''}/>`
    : '');
  const use = layers ?? [[color, 0, 0, 0, 1]];
  const markup = use.map(([c, extra, dx = 0, dy = 0, o = 1]) => stroke(main, c, sw + extra, dx, dy, o) + stroke(serifs, c, sw * SERIF_WEIGHT + extra, dx, dy, o)).join('');
  const reach = Math.max(...use.map(([, extra, dx = 0, dy = 0]) => (sw + extra) / 2 + Math.max(Math.abs(dx), Math.abs(dy))));
  const h = (lines.length * CAP + (lines.length - 1) * lineGap) * s;
  const left = anchor === 'middle' ? x - wMax / 2 : anchor === 'end' ? x - wMax : x;
  const pad = reach * s;
  const box = { x: left - pad, y: y - pad, w: wMax + 2 * pad, h: h + 2 * pad };
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
