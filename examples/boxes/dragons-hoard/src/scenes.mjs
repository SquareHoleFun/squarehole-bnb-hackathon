/**
 * The storybook: seven square scenes, 1200 x 1200, that show what the fees do. Every scene is a page of the same
 * lair: lapis sky with gold glints, a floor and the gold page frame. Captions and alt text live here and in
 * storybook.md; check.mjs makes sure the two agree.
 */
import { C } from './palette.mjs';
import { Doc } from './doc.mjs';
import { sky, floor, frame, glints, warmth } from './lair.mjs';
import { coin, coinRow, coinStack } from './coins.mjs';
import { token, tokenRow } from './scales.mjs';
import { hoard, oldOutline, pouch } from './hoard.mjs';
import { label, pool, brazier, chest, plate, arrow, brace, raiseBar, sparks } from './props.mjs';

export const SCENE_SIZE = 1200;
/** Where the back wall meets the floor. Things stand in front of it, lower on the page the nearer they are. */
const FLOOR = 880;

/** The page every scene is drawn on. `quiet` dims the glints for the night scene. */
function stage(s) {
  const d = new Doc(SCENE_SIZE, SCENE_SIZE, `Dragon's Hoard story, scene ${s.n}: ${s.title}`, s.alt);
  d.add(sky(d, SCENE_SIZE, SCENE_SIZE));
  d.add(glints({ x: 70, y: 60, w: 1060, h: 560, count: s.quiet ? 10 : 24, seed: Number(s.n) * 7 + 3, rMin: 3, rMax: s.quiet ? 6 : 11, keepOut: s.keepOut ?? [] }));
  d.add(floor(SCENE_SIZE, SCENE_SIZE, FLOOR));
  return d;
}

/** Fifteen small coins split 10, 2 and 3, centred on the page, with a gap between the groups. */
function coinGroups(cy, r, step, gap) {
  const total = 14 * step + 2 * gap;
  let x = (SCENE_SIZE - total) / 2;
  return [10, 2, 3].map((count) => {
    const xs = Array.from({ length: count }, (_, i) => x + i * step);
    x = xs.at(-1) + step + gap;
    return { markup: xs.map((cx) => coin(cx, cy, r)).join(''), x1: xs[0] - r, x2: xs.at(-1) + r, mid: (xs[0] + xs.at(-1)) / 2 };
  });
}

/** Coins stepping along a path of points, each step joined to the next by a short arrow. */
function steps(points, r, color) {
  const out = [];
  points.forEach(([x, y], i) => {
    out.push(coin(x, y, r));
    const next = points[i + 1];
    if (!next) return;
    const len = Math.hypot(next[0] - x, next[1] - y);
    const ux = (next[0] - x) / len;
    const uy = (next[1] - y) / len;
    out.push(arrow({ x1: x + ux * (r + 8), y1: y + uy * (r + 8), x2: next[0] - ux * (r + 6), y2: next[1] - uy * (r + 6), color, width: 6, head: 18 }));
  });
  return out.join('');
}

function scene01(d) {
  d.add(warmth(d, 600, 760, 560, 360, 0.26));
  d.add(label('SEED', { x: 215, y: 130, size: 46, color: C.gold }));
  d.add(coinStack(215, 380, 48, 4), coin(215, 236, 46));
  d.add(arrow({ x1: 265, y1: 430, x2: 420, y2: 640, bend: 60, color: C.gold, width: 12, head: 36 }));
  d.add(label('HOARD', { x: 960, y: 130, size: 46, color: C.jade }));
  d.add(tokenRow(d, 960, 256, 3, 44, 22));
  d.add(hoard(d, { cx: 600, base: 930, w: 520, seed: 11 }));
}

function scene02(d) {
  d.add(label('↑ BUY', { x: 600, y: 84, size: 50, color: C.jade }));
  d.add(coin(470, 230, 44), arrow({ x1: 530, y1: 230, x2: 660, y2: 230, color: C.vellum, width: 10, head: 30 }), token(d, 730, 230, 44));
  d.add(label('1% FEE', { x: 600, y: 316, size: 38, color: C.gold }));
  d.add(coin(600, 430, 58));
  d.add(arrow({ x1: 600, y1: 505, x2: 600, y2: 552, color: C.vellum, width: 9, head: 26 }));
  const [a, b, c] = coinGroups(600, 22, 50, 58);
  d.add(a.markup, b.markup, c.markup);
  for (const [g, color, n] of [[a, C.gold, '10'], [b, C.vellum, '2'], [c, C.vellum, '3']]) {
    d.add(brace({ x1: g.x1, x2: g.x2, y: 640, color, width: 7, depth: 20 }));
    d.add(label(n, { x: g.mid, y: 698, size: 40, color }));
  }
  d.add(arrow({ x1: a.mid, y1: 756, x2: a.mid - 20, y2: 820, color: C.gold, width: 10, head: 28 }));
  d.add(arrow({ x1: b.mid, y1: 756, x2: b.mid, y2: 846, color: C.vellum, width: 9, head: 26 }));
  d.add(arrow({ x1: c.mid, y1: 756, x2: c.mid, y2: 846, color: C.vellum, width: 9, head: 26 }));
  d.add(hoard(d, { cx: a.mid - 40, base: 1020, w: 300, seed: 12 }));
  d.add(pool(d, { cx: b.mid, top: 905, w: 190, items: 3 }));
  d.add(plate({ cx: c.mid + 6, cy: 955, text: ['SQUARE', 'HOLE'], size: 25 }));
  d.add(label('PILE', { x: 140, y: 930, size: 34, color: C.gold }));
  d.add(label('POOL', { x: b.mid, y: 1060, size: 32, color: C.vellum }));
}

function scene03(d) {
  d.add(label('↓ SELL', { x: 600, y: 84, size: 50, color: C.vermilion }));
  d.add(token(d, 470, 230, 44), arrow({ x1: 530, y1: 230, x2: 660, y2: 230, color: C.vellum, width: 10, head: 30 }), coin(730, 230, 44));
  d.add(label('10', { x: 245, y: 352, size: 40, color: C.gold }));
  d.add(coinRow(245, 455, 5, 24, 12), coinRow(245, 525, 5, 24, 12));
  d.add(arrow({ x1: 300, y1: 585, x2: 440, y2: 800, bend: 70, color: C.gold, width: 11, head: 32 }));
  d.add(pool(d, { cx: 560, top: 860, w: 400, items: 5 }));
  d.add(label('POOL', { x: 560, y: 1082, size: 34, color: C.vellum }));
  d.add(arrow({ x1: 690, y1: 800, x2: 780, y2: 490, bend: -60, color: C.jade, width: 11, head: 32 }));
  d.add(token(d, 845, 410, 34), token(d, 935, 452, 34), token(d, 1010, 525, 30));
  d.add(arrow({ x1: 975, y1: 590, x2: 975, y2: 680, color: C.vermilion, width: 9, head: 26, dash: '2 16' }));
  d.add(brazier(d, { cx: 975, bottom: 1010, w: 230, flameH: 230 }));
  d.add(sparks(975, 650, 170, 8));
  d.add(label('BURN', { x: 975, y: 1056, size: 34, color: C.vermilion }));
}

function scene04(d) {
  d.add(label('RAISE', { x: 325, y: 92, size: 40, color: C.gold }));
  d.add(raiseBar({ x: 160, y: 158, w: 330, h: 46, level: 1 }));
  d.add(chest({ cx: 235, bottom: 1000, w: 280, open: true, coins: 1, seed: 31 }));
  d.add(steps([[430, 650], [540, 585], [650, 560], [760, 585]], 24, C.gold));
  d.add(arrow({ x1: 785, y1: 605, x2: 840, y2: 668, color: C.gold, width: 6, head: 18 }));
  d.add(hoard(d, { cx: 905, base: 990, w: 280, seed: 14 }));
  d.add(steps([[420, 925], [500, 952], [580, 975]], 20, C.vermilion));
  d.add(arrow({ x1: 604, y1: 982, x2: 628, y2: 990, color: C.vermilion, width: 5, head: 16 }));
  d.add(brazier(d, { cx: 680, bottom: 1085, w: 110, flameH: 120 }));
  d.add(label('PILE', { x: 1075, y: 700, size: 34, color: C.gold }));
  d.add(label('BURN', { x: 515, y: 1060, size: 30, color: C.vermilion }));
}

function scene05(d) {
  d.add(label('ALL HOARD', { x: 600, y: 84, size: 46, color: C.jade }));
  d.add(label('YOURS', { x: 185, y: 160, size: 30, color: C.vellum }));
  d.add(tokenRow(d, 400, 280, 7, 34, 18, (i) => ({ ring: i < 2 })));
  d.add(pool(d, { cx: 930, top: 285, w: 300, items: 0 }));
  d.add(token(d, 860, 282, 30), token(d, 930, 268, 30), token(d, 1000, 282, 30));
  d.add(label('POOL', { x: 930, y: 440, size: 30, color: C.vellum }));
  const xs = Array.from({ length: 10 }, (_, i) => 150 + i * 100);
  d.add(arrow({ x1: 142, y1: 340, x2: 150, y2: 690, bend: -24, color: C.vellum, width: 8, head: 24 }));
  d.add(arrow({ x1: 228, y1: 340, x2: 250, y2: 690, bend: 24, color: C.vellum, width: 8, head: 24 }));
  xs.forEach((x, i) => d.add(coinStack(x, 930, 42, 16, { highlight: i < 2 })));
  d.add(label('YOUR SHARE', { x: 200, y: 990, size: 26, color: C.vellum }));
  d.add(label('THE PILE', { x: 700, y: 990, size: 26, color: C.gold }));
}

function scene06(d) {
  d.add(label('BURN HOARD', { x: 250, y: 88, size: 34, color: C.vermilion }));
  d.add(token(d, 185, 215, 40, { ring: true }), token(d, 295, 215, 40, { ring: true }));
  d.add(arrow({ x1: 240, y1: 290, x2: 240, y2: 590, color: C.vermilion, width: 9, head: 26, dash: '2 16' }));
  d.add(brazier(d, { cx: 240, bottom: 1000, w: 210, flameH: 220 }));
  d.add(sparks(240, 640, 150, 7));
  d.add(hoard(d, { cx: 880, base: 990, w: 320, seed: 16 }));
  d.add(label('SHARE', { x: 570, y: 214, size: 30, color: C.gold }));
  const grid = [];
  for (let j = 0; j < 4; j += 1) for (let i = 0; i < 5; i += 1) grid.push([470 + i * 50, 300 + j * 50]);
  grid.forEach(([x, y]) => d.add(coin(x, y, 20)));
  const [sx, sy] = grid[4];
  d.add(`<circle cx="${sx}" cy="${sy + 2}" r="31" fill="none" stroke="${C.vellum}" stroke-width="6"/>`);
  d.add(arrow({ x1: 800, y1: 720, x2: 700, y2: 480, bend: 40, color: C.gold, width: 10, head: 30 }));
  d.add(arrow({ x1: sx + 36, y1: sy - 8, x2: 905, y2: 690, bend: -110, color: C.vellum, width: 8, head: 24 }));
  d.add(label('STAYS', { x: 1010, y: 360, size: 30, color: C.vellum }));
  d.add(arrow({ x1: 560, y1: 480, x2: 560, y2: 790, color: C.gold, width: 10, head: 30 }));
  d.add(pouch({ cx: 560, bottom: 990, w: 170 }));
  d.add(label('YOURS', { x: 560, y: 1040, size: 30, color: C.gold }));
}

function scene07(d) {
  d.add(oldOutline(600, 960, 560, 360));
  d.add(hoard(d, { cx: 600, base: 960, w: 420, h: 210, seed: 17 }));
  d.add(arrow({ x1: 470, y1: 820, x2: 330, y2: 650, bend: 30, color: C.gold, width: 7, head: 22, dash: '2 14', opacity: 0.8 }));
  d.add(coin(320, 600, 18), coin(285, 560, 14));
  d.add(chest({ cx: 180, bottom: 1010, w: 210, open: true, coins: 0 }));
  d.add(brazier(d, { cx: 1040, bottom: 1000, w: 140, lit: false }));
}

export const SCENES = Object.freeze([
  { n: '01', title: 'The pile', draw: scene01, keepOut: [[100, 120, 260, 260], [800, 120, 260, 220]],
    alt: 'A pile of coins sits on the floor of a dark blue lair, with a green scaly tail curled around it. On the left, coins marked SEED drop onto the pile. On the right, three green tokens covered in scales are marked HOARD.',
    caption: ["Dragon's Hoard is a token called HOARD with a pile of ETH in the box.", 'The creator puts the first coins on the pile.'] },
  { n: '02', title: 'Buyers feed the pile', draw: scene02, keepOut: [[380, 60, 440, 410]],
    alt: 'Under the word BUY, a coin turns into a green HOARD token. A 1% fee coin splits into fifteen small coins. Ten go to the pile, two go to a stone pool and three go to a plate marked SQUARE HOLE.',
    caption: ['Every buy pays a small fee in ETH, split into 15 parts.', 'Ten are for the pile, two go to the pool and three go to Square Hole (its platform and its buy-back).'] },
  { n: '03', title: 'Sellers feed the fire', draw: scene03, keepOut: [[380, 60, 440, 220], [150, 330, 200, 240]],
    alt: 'Under the word SELL, a green HOARD token turns into a coin. Ten small fee coins go into the stone pool, green tokens come out, and the tokens drop into a fire marked BURN and break into sparks.',
    caption: ['Every sale pays the same small fee.', 'Its ten parts buy HOARD in the pool, and that HOARD burns.'] },
  { n: '04', title: 'The chest', draw: scene04, keepOut: [[140, 70, 420, 160]],
    alt: 'A full raise bar with a check mark. Below it, an open chest full of coins. Single coins leave the chest one step at a time, some up to the pile and some down to a small fire.',
    caption: ['While the box fills its raise, the fee coins wait in a chest.', 'Once it graduates, they go on to the pile and the fire, one step at a time.'] },
  { n: '05', title: 'Your part', draw: scene05, keepOut: [[0, 60, 1200, 470]],
    alt: 'Ten green tokens stand for all the HOARD there is. Two are ringed and marked YOURS, and three sit in the stone pool. Below, the pile is split into ten equal stacks of coins, and the two ringed stacks are your share.',
    caption: ['Your share is your HOARD out of all the HOARD there is.', 'The HOARD in the pool counts too.'] },
  { n: '06', title: 'Take your share', draw: scene06, keepOut: [[100, 60, 1000, 520]],
    alt: 'Under the words BURN HOARD, two ringed HOARD tokens drop into a fire. Twenty coins come off the pile as the share. Nineteen go down into a pouch marked YOURS, and one ringed coin goes back onto the pile, marked STAYS.',
    caption: ['After graduation, anyone can burn HOARD to take its share of the pile.', 'One coin in twenty of that share stays on the pile for everyone else.'] },
  { n: '07', title: 'A quiet night', draw: scene07, quiet: true,
    alt: 'The same lair, quiet and dark. The chest is open and empty, and the fire in the brazier has gone out. A dashed line shows the pile was bigger before, and two coins drift away from it. The green tail is still curled around what is left.',
    caption: ['Fees only come from trades.', 'With no trades no coins arrive, and every share taken makes the pile smaller.'] },
]);

export function sceneSvg(s) {
  const d = stage(s);
  s.draw(d);
  d.add(frame({ w: SCENE_SIZE, h: SCENE_SIZE, inset: 28, r: 36 }));
  return d.toString();
}
