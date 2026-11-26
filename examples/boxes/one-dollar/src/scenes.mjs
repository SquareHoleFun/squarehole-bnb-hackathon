/**
 * The storybook: seven square scenes, 1200 x 1200, that show what the fees do. Every scene is a view of the same
 * gallery: a claret wall with panelled wainscot, a dark floor and a thin ivory frame. Captions and alt text live here
 * and in storybook.md; check.mjs makes sure the two agree.
 */
import { C } from './palette.mjs';
import { Doc } from './doc.mjs';
import { room, vignette, frame, spotlight, glow } from './gallery.mjs';
import { coin, coinRow } from './coins.mjs';
import { bill, billBox, billStrips, stripOutline } from './bill.mjs';
import { token, tokenRow, heap } from './tokens.mjs';
import { exhibit, placard } from './exhibit.mjs';
import { label, roseTicker, fireplace, sparks, pool, jar, plaque, envelope, arrow, brace, raiseBar } from './props.mjs';

export const SCENE_SIZE = 1200;
/** Where the wall meets the floor. Things stand in front of it, lower on the page the nearer they are. */
const FLOOR = 880;
const S = SCENE_SIZE;

/** The page every scene is drawn on. `dim` turns the lights down for the closing scene. */
function stage(s) {
  const d = new Doc(S, S, `One Dollar is all you need story, scene ${s.n}: ${s.title}`, s.alt);
  d.add(room(d, S, S, { floor: FLOOR, panelH: 220, dim: Boolean(s.dim) }));
  return d;
}

/** The finishing touches every scene shares: darker corners and the ivory frame. */
function finish(d, s) {
  d.add(vignette(d, S, S, s.dim ? 0.75 : 0.5));
  d.add(frame({ w: S, h: S, inset: 28, gap: 10, weight: 3 }));
}

/** Fifteen small coins split 10, 2 and 3 across the page, with a wider gap between the groups. */
function coinGroups(d, cy, r, step, gap) {
  const total = 14 * step + 2 * gap;
  let x = (S - total) / 2;
  return [10, 2, 3].map((count) => {
    const xs = Array.from({ length: count }, (_, i) => x + i * step);
    x = xs.at(-1) + step + gap;
    return { markup: xs.map((cx) => coin(d, cx, cy, r)).join(''), x1: xs[0] - r, x2: xs.at(-1) + r, mid: (xs[0] + xs.at(-1)) / 2 };
  });
}

/** Coins stepping along a path of points, each step joined to the next by a short arrow. */
function steps(d, points, r, color) {
  const out = [];
  points.forEach(([x, y], i) => {
    out.push(coin(d, x, y, r));
    const next = points[i + 1];
    if (!next) return;
    const len = Math.hypot(next[0] - x, next[1] - y);
    const ux = (next[0] - x) / len;
    const uy = (next[1] - y) / len;
    out.push(arrow({ x1: x + ux * (r + 8), y1: y + uy * (r + 8), x2: next[0] - ux * (r + 6), y2: next[1] - uy * (r + 6), color, width: 5, head: 16 }));
  });
  return out.join('');
}

function scene01(d) {
  const ex = exhibit(d, { cx: 480, cy: 420, billW: 380, ropeBase: 1030, ropeH: 150, ropeSpan: 0.53 });
  d.add(ex.markup);
  d.add(placard({ x: 480, y: 612, lines: ['ONE DOLLAR', 'PLEASE DO NOT TOUCH'], size: 14, anchor: 'middle' }));
  d.add(label('SEED', { x: 160, y: 132, size: 44, color: C.green }));
  d.add(arrow({ x1: 172, y1: 200, x2: ex.bill.x + 22, y2: ex.bill.y + 30, bend: 60, color: C.green, width: 8, head: 28, dash: '3 15' }));
  d.add(label('THE TOKEN', { x: 968, y: 560, size: 34 }));
  d.add(label('1', { x: 968, y: 618, size: 64, colorAt: roseTicker('1') }));
  d.add(heap(d, { cx: 968, base: 1075, w: 356, h: 280, seed: 5 }));
}

function scene02(d) {
  d.add(label('↑ BUY', { x: 330, y: 80, size: 44 }));
  d.add(coin(d, 255, 205, 36), arrow({ x1: 302, y1: 205, x2: 362, y2: 205, width: 7, head: 22 }), token(d, 410, 205, 36));
  d.add(label('↓ SELL', { x: 870, y: 80, size: 44 }));
  d.add(token(d, 795, 205, 36), arrow({ x1: 842, y1: 205, x2: 902, y2: 205, width: 7, head: 22 }), coin(d, 950, 205, 36));
  d.add(arrow({ x1: 360, y1: 262, x2: 520, y2: 372, bend: -24, width: 7, head: 22 }));
  d.add(arrow({ x1: 840, y1: 262, x2: 680, y2: 372, bend: 24, width: 7, head: 22 }));
  d.add(label('1% FEE', { x: 600, y: 300, size: 36, color: C.silver }));
  d.add(coin(d, 600, 418, 46));
  d.add(arrow({ x1: 600, y1: 474, x2: 600, y2: 516, width: 7, head: 20 }));
  const [a, b, c] = coinGroups(d, 556, 20, 47, 95);
  d.add(a.markup, b.markup, c.markup);
  for (const [g, color, n] of [[a, C.flame, '10'], [b, C.teal, '2'], [c, C.brass, '3']]) {
    d.add(brace({ x1: g.x1, x2: g.x2, y: 590, color, width: 5, depth: 20 }));
    d.add(label(n, { x: g.mid, y: 628, size: 38, color }));
  }
  d.add(arrow({ x1: a.mid, y1: 680, x2: a.mid, y2: 748, color: C.flame, width: 8, head: 24 }));
  d.add(arrow({ x1: b.mid, y1: 680, x2: b.mid, y2: 820, color: C.teal, width: 7, head: 22 }));
  d.add(arrow({ x1: c.mid, y1: 680, x2: c.mid, y2: 870, color: C.brass, width: 7, head: 22 }));
  const fp = fireplace(d, { cx: a.mid, base: 1075, w: 270 });
  d.add(fp.markup);
  d.add(pool(d, { cx: b.mid, top: 860, w: 190, items: 4 }));
  d.add(plaque({ cx: c.mid, cy: 945, text: ['SQUARE', 'HOLE'], size: 22 }));
  d.add(label('BURN', { x: a.mid, y: 1098, size: 32, color: C.flame }));
  d.add(label('POOL', { x: b.mid, y: 1098, size: 32, color: C.teal }));
}

function scene03(d) {
  const ex = exhibit(d, { cx: 196, cy: 500, billW: 184, rope: false, strength: 0.16 });
  d.add(ex.markup);
  d.add(label('THE DOLLAR', { x: 196, y: 608, size: 24, color: C.green }));
  d.add(label('10', { x: 520, y: 92, size: 44, color: C.flame }));
  d.add(coinRow(d, 520, 210, 5, 22, 10), coinRow(d, 520, 270, 5, 22, 10));
  d.add(arrow({ x1: 520, y1: 312, x2: 520, y2: 642, color: C.silver, width: 8, head: 26 }));
  d.add(pool(d, { cx: 520, top: 700, w: 300, items: 5 }));
  d.add(label('POOL', { x: 520, y: 1080, size: 32, color: C.teal }));
  d.add(arrow({ x1: 655, y1: 690, x2: 735, y2: 520, bend: -40, color: C.rose, width: 8, head: 26 }));
  d.add(token(d, 760, 470, 30), token(d, 830, 455, 30), token(d, 900, 470, 28));
  const fp = fireplace(d, { cx: 955, base: 1050, w: 290 });
  d.add(fp.markup);
  d.add(arrow({ x1: 870, y1: 505, x2: fp.opening.x0 + 48, y2: fp.mouth.y + 42, via: [655, 1010], color: C.flame, width: 7, head: 22, dash: '2 14' }));
  d.add(sparks(fp.mouth.x + 20, fp.mouth.y + 70, 55, 6));
  d.add(label('BURN', { x: 955, y: 1080, size: 32, color: C.flame }));
}

function scene04(d) {
  d.add(label('RAISE', { x: 270, y: 92, size: 40, color: C.silver }));
  d.add(raiseBar({ x: 110, y: 160, w: 320, h: 40, level: 1 }));
  d.add(jar(d, { cx: 200, base: 1010, w: 190, level: 0.62, open: true }));
  d.add(steps(d, [[240, 735], [330, 660], [425, 625], [520, 640]], 22, C.silver));
  d.add(arrow({ x1: 545, y1: 662, x2: 590, y2: 730, color: C.silver, width: 5, head: 16 }));
  d.add(pool(d, { cx: 640, top: 780, w: 250, items: 4 }));
  d.add(label('POOL', { x: 640, y: 1080, size: 32, color: C.teal }));
  d.add(arrow({ x1: 745, y1: 730, x2: 790, y2: 600, bend: -24, color: C.rose, width: 6, head: 18 }));
  d.add(token(d, 820, 560, 26), token(d, 885, 548, 26));
  const fp = fireplace(d, { cx: 1000, base: 1060, w: 230 });
  d.add(fp.markup);
  d.add(arrow({ x1: 880, y1: 580, x2: fp.opening.x0 + 38, y2: fp.mouth.y + 34, via: [735, 1010], color: C.flame, width: 6, head: 18, dash: '2 12' }));
  d.add(label('BURN', { x: 1000, y: 1080, size: 32, color: C.flame }));
  d.add(label('FEES', { x: 200, y: 1080, size: 32, color: C.silver }));
}

function scene05(d) {
  d.add(label('ALL TOKENS', { x: 600, y: 84, size: 46, color: C.rose }));
  d.add(label('YOURS', { x: 190, y: 160, size: 30 }));
  d.add(tokenRow(d, 410, 270, 7, 31, 17, (i) => ({ ring: i < 2 })));
  d.add(pool(d, { cx: 960, top: 290, w: 300, items: 0 }));
  d.add(token(d, 885, 274, 26), token(d, 960, 262, 26), token(d, 1035, 274, 26));
  d.add(label('POOL', { x: 960, y: 466, size: 28, color: C.teal }));
  d.add(spotlight(d, { x: 600, y1: 470, y2: 980, wTop: 140, wBottom: 900, strength: 0.1, lamp: false }));
  d.add(glow(d, 600, 790, 470, 260, 0.2));
  d.add(label('THE DOLLAR', { x: 600, y: 548, size: 30, color: C.green }));
  d.add(bill(d, { cx: 600, cy: 800, w: 800, strips: 10, yours: [0, 1] }));
  d.add(label('YOUR SLICE', { x: 280, y: 1022, size: 28 }));
}

function scene06(d) {
  d.add(label('BURN TOKENS', { x: 300, y: 84, size: 44, color: C.flame }));
  d.add(token(d, 205, 210, 34, { ring: true }), token(d, 300, 240, 34, { ring: true }));
  const fp = fireplace(d, { cx: 250, base: 1050, w: 300 });
  d.add(fp.markup);
  d.add(arrow({ x1: 318, y1: 285, x2: fp.opening.x1 - 48, y2: fp.mouth.y + 40, via: [540, 1000], color: C.flame, width: 7, head: 22, dash: '2 14' }));
  d.add(sparks(fp.mouth.x - 10, fp.mouth.y + 75, 55, 6));
  const [cx, cy, w] = [770, 440, 560];
  d.add(spotlight(d, { x: cx, y1: 0, y2: 700, wTop: 70, wBottom: 760, strength: 0.14 }));
  d.add(bill(d, { cx, cy, w, strips: 10, gone: [8, 9] }), stripOutline(cx, cy, w, 10, [8, 9]));
  const b = billBox(cx, cy, w);
  const env = { cx: 952, cy: 968, w: 236 };
  const stripX = b.x + (9 * w) / 10;
  const inside = billStrips(d, { cx, cy, w, strips: 10, from: 8, to: 10, dx: env.cx - stripX, dy: env.cy - env.w * 0.32 - b.y - b.h * 0.42 });
  d.add(arrow({ x1: stripX, y1: b.y + b.h + 22, x2: env.cx, y2: env.cy - env.w * 0.32 - b.h * 0.44, color: C.green, width: 6, head: 20, dash: '2 12' }));
  d.add(envelope({ ...env, inside }));
  d.add(label('YOURS', { x: env.cx, y: 1080, size: 32 }));
}

function scene07(d) {
  const fp = fireplace(d, { cx: 200, base: 1050, w: 230, lit: false });
  d.add(fp.markup);
  const ex = exhibit(d, { cx: 600, cy: 450, billW: 400, light: false, ropeBase: 1040, ropeH: 150, ropeSpan: 0.42, bill: { strips: 10, gone: [3, 8, 9] } });
  d.add(glow(d, 600, 450, 360, 260, 0.08));
  d.add(ex.markup);
  d.add(jar(d, { cx: 950, base: 1035, w: 150, level: 0, open: true }));
}

export const SCENES = Object.freeze([
  {
    n: '01',
    title: 'The dollar',
    alt: 'A dark red gallery. Under a spotlight, a green cartoon one-dollar bill with a big 1 hangs framed under glass behind a velvet rope, and a dashed arrow marked SEED points at it. A small card under it reads ONE DOLLAR, PLEASE DO NOT TOUCH. On the right, a big heap of pink tokens is marked THE TOKEN 1.',
    caption: ['This box has a token called 1, and one dollar of USDC inside.', 'The creator puts the dollar in, and a billion tokens share it.'],
    draw: scene01,
  },
  {
    n: '02',
    title: 'Every trade pays a fee',
    alt: 'Under BUY, a silver coin turns into a pink token. Under SELL, a pink token turns into a silver coin. Both pay a 1% FEE, a big silver coin that splits into fifteen small coins. Ten go to a fireplace marked BURN, two go to a fountain marked POOL, and three go to a brass plate marked SQUARE HOLE.',
    caption: ['Every buy and every sale pays a small fee in USDC, cut into 15 parts.', 'Ten are for the fire, two go to the pool and three go to Square Hole (its platform and its buy-back).'],
    draw: scene02,
  },
  {
    n: '03',
    title: 'Ten parts for the fire',
    alt: 'Ten small silver coins drop into a fountain marked POOL. Pink tokens come out of it and fall into a fireplace marked BURN, where they break into sparks. On the left, the framed dollar hangs on the wall, marked THE DOLLAR, and nothing goes near it.',
    caption: ['The ten parts buy the token 1 in the pool, and it burns for good.', 'Fewer tokens are left to share the same dollar.'],
    draw: scene03,
  },
  {
    n: '04',
    title: 'Waiting in a jar',
    alt: 'A full RAISE bar with a check mark. Below it, an open glass jar of silver coins marked FEES. Single coins leave the jar one step at a time toward a fountain marked POOL, and pink tokens go from the fountain into a fireplace marked BURN.',
    caption: ['While the box fills its raise, the coins for the fire and the pool wait in a jar.', 'After graduation they go on, one small step at a time.'],
    draw: scene04,
  },
  {
    n: '05',
    title: 'Your slice',
    alt: 'Under the words ALL TOKENS, ten pink tokens stand for all the tokens there are. Two are ringed and marked YOURS, and three float in a fountain marked POOL. Below, the green dollar bill marked THE DOLLAR is cut into ten equal strips, and the two ringed strips are marked YOUR SLICE.',
    caption: ['Two of the ten tokens are yours, so two of the ten strips are your slice.', 'The tokens in the pool count too.'],
    draw: scene05,
  },
  {
    n: '06',
    title: 'Take your slice',
    alt: 'Under the words BURN TOKENS, two ringed pink tokens fall into a fireplace and break into sparks. Two strips have come out of the green dollar bill, leaving a gap with a dashed edge, and stand in an envelope marked YOURS.',
    caption: ['After graduation, anyone can burn the token to take its slice of the dollar.', 'The burned tokens are gone for good.'],
    draw: scene06,
  },
  {
    n: '07',
    title: 'Closing time',
    dim: true,
    alt: 'The same gallery at night. The spotlight is off, the fireplace is cold with a thread of smoke, and the jar is empty. In its frame, the green dollar bill has three strips missing, and a dashed line shows where they were.',
    caption: ['No fee goes into the coin pile, so fees never add to the dollar.', 'Every slice taken makes the dollar a little smaller.'],
    draw: scene07,
  },
]);

/** One scene as SVG text. */
export function sceneSvg(s) {
  const d = stage(s);
  s.draw(d);
  finish(d, s);
  return d.toString();
}

