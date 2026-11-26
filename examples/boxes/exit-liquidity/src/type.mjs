/**
 * The sign alphabet: hand-drawn letters on a 7-row grid ('#' on, '.' off), drawn for this kit.
 * Every letter in the art is built from these cells, so the art needs no font file.
 * HEAVY holds the chunky 3x5 numerals used only in the logo.
 */
const G = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '%': ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  0: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  1: ['.#.', '##.', '.#.', '.#.', '.#.', '.#.', '###'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '!': ['#', '#', '#', '#', '#', '.', '#'],
  '.': ['.', '.', '.', '.', '.', '.', '#'],
  "'": ['#', '#', '.', '.', '.', '.', '.'],
  ' ': ['...', '...', '...', '...', '...', '...', '...'],
  '←': ['.....', '..#..', '.#...', '#####', '.#...', '..#..', '.....'],
  '→': ['.....', '..#..', '...#.', '#####', '...#.', '..#..', '.....'],
  '↑': ['..#..', '.###.', '#.#.#', '..#..', '..#..', '..#..', '..#..'],
  '↓': ['..#..', '..#..', '..#..', '..#..', '#.#.#', '.###.', '..#..'],
};

const HEAVY = {
  4: ['#.#', '#.#', '###', '..#', '..#'],
  0: ['###', '#.#', '#.#', '#.#', '###'],
};

export const ROWS = 7;
export const LINE_GAP = 3;

function glyph(ch, heavy) {
  const set = heavy ? HEAVY : G;
  const g = set[ch];
  if (!g) throw new Error(`no glyph for ${JSON.stringify(ch)}${heavy ? ' (heavy)' : ''}`);
  return g;
}

/** Cells of one line: [{c, r}], plus its width in columns. One empty column between letters. */
export function lineCells(text, { heavy = false, mirror = false } = {}) {
  const cells = [];
  let x = 0;
  const chars = [...text];
  chars.forEach((ch, i) => {
    const g = glyph(ch, heavy);
    g.forEach((row, r) => [...row].forEach((v, c) => { if (v === '#') cells.push({ c: x + c, r }); }));
    x += g[0].length + (i < chars.length - 1 ? 1 : 0);
  });
  const width = x;
  const rows = heavy ? 5 : ROWS;
  return { cells: mirror ? cells.map(({ c, r }) => ({ c: width - 1 - c, r })) : cells, width, rows };
}

/**
 * Whether the letters are drawn. `withoutWords` turns them off while build-art.mjs --no-words builds the word-free
 * reference pictures: a block keeps its columns and rows, so every sign, plate, button and counter keeps its size and
 * place, but no cell of a letter is lit. The arrow on an EXIT square is the token's symbol, not a word, and stays.
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

/** False while `withoutWords` runs. */
export const drawsWords = () => words;

/** Lines stacked and centred on a common grid. Returns cells, cols and rows of the whole block. */
export function blockCells(lines, opts = {}) {
  const laid = lines.map((t) => lineCells(t, opts));
  const cols = Math.max(...laid.map((l) => l.width));
  const lineRows = laid[0].rows;
  const rows = laid.length * lineRows + (laid.length - 1) * LINE_GAP;
  const cells = [];
  laid.forEach((l, i) => {
    const dx = Math.floor((cols - l.width) / 2);
    const dy = i * (lineRows + LINE_GAP);
    l.cells.forEach(({ c, r }) => cells.push({ c: c + dx, r: r + dy }));
  });
  return { cells: words ? cells : [], cols, rows };
}

/** Directed outline edges of a cell set (clockwise per cell; shared edges cancel). */
function boundaryEdges(cells) {
  const on = new Set(cells.map(({ c, r }) => `${c},${r}`));
  const has = (c, r) => on.has(`${c},${r}`);
  const edges = [];
  for (const { c, r } of cells) {
    if (!has(c, r - 1)) edges.push([c, r, c + 1, r]);
    if (!has(c + 1, r)) edges.push([c + 1, r, c + 1, r + 1]);
    if (!has(c, r + 1)) edges.push([c + 1, r + 1, c, r + 1]);
    if (!has(c - 1, r)) edges.push([c, r + 1, c, r]);
  }
  return edges;
}

/** Chain edges into closed loops and drop points on straight runs. */
function loops(edges) {
  const out = new Map();
  edges.forEach((e, i) => {
    const k = `${e[0]},${e[1]}`;
    out.set(k, [...(out.get(k) ?? []), i]);
  });
  const used = new Set();
  const result = [];
  edges.forEach((start, i) => {
    if (used.has(i)) return;
    const pts = [];
    let cur = i;
    while (cur !== undefined && !used.has(cur)) {
      used.add(cur);
      const e = edges[cur];
      pts.push([e[0], e[1]]);
      const next = (out.get(`${e[2]},${e[3]}`) ?? []).find((j) => !used.has(j));
      cur = next;
    }
    result.push(pts.filter((p, j) => {
      const a = pts[(j - 1 + pts.length) % pts.length];
      const b = pts[(j + 1) % pts.length];
      return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
    }));
  });
  return result;
}

const n = (v) => Number(v.toFixed(2));

/** One SVG path for a cell set: solid pixel letters with no seams between cells. */
export function cellsPath(cells, m, ox, oy) {
  return loops(boundaryEdges(cells))
    .map((pts) => `M${pts.map(([c, r]) => `${n(ox + c * m)} ${n(oy + r * m)}`).join('L')}Z`)
    .join('');
}

/** LED dots for a whole panel: lit cells get `on`, every other cell of the grid gets `off`. */
export function ledDots(cells, cols, rows, { pitch, ox, oy, radius = 0.39 }) {
  const lit = new Set(cells.map(({ c, r }) => `${c},${r}`));
  const rad = n(pitch * radius);
  const on = [];
  const off = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const dot = `<circle cx="${n(ox + (c + 0.5) * pitch)}" cy="${n(oy + (r + 0.5) * pitch)}" r="${rad}"/>`;
      (lit.has(`${c},${r}`) ? on : off).push(dot);
    }
  }
  return { on: on.join(''), off: off.join('') };
}
