/**
 * The storybook: seven square scenes, 1200 x 1200, that show what the fees do.
 * Captions and alt text live here and in storybook.md; check.mjs makes sure the two agree.
 */
import { C, MIX } from './palette.mjs';
import { Doc, rect, r2 } from './doc.mjs';
import { wall, shelf, holes } from './wall.mjs';
import { hangBag } from './hang.mjs';
import { lettering } from './type.mjs';
import { coin, coinRow, chip, arrow, bracket, plate, button, pointer, pool, box, jar, raiseBar } from './props.mjs';

export const SCENE_SIZE = 1200;
const SHELF = 1020;
const OW = 7;
const GRID = holes(SCENE_SIZE, SCENE_SIZE, 60);
/** A bag on a hook in one of the wall's holes. */
const hang = (d, kind, opts) => hangBag(d, kind, { grid: GRID, ...opts });

function stage(n, title, alt, dim = false) {
  const d = new Doc(SCENE_SIZE, SCENE_SIZE, `Bag Holders story, scene ${n}: ${title}`, alt);
  d.add(wall(d, { w: SCENE_SIZE, h: SCENE_SIZE, pitch: 60, hole: 7, dim }));
  d.add(shelf({ w: SCENE_SIZE, y: SHELF, h: SCENE_SIZE, dim }));
  return d;
}

const say = (text, x, y, cap, color = C.canvas, extra = {}) => lettering(text, { x, y, cap, color, outline: C.ink, ...extra });
const coinsIn = (n) => (cx, py) => Array.from({ length: n }, (_, i) => coin(cx + (i - (n - 1) / 2) * 34, py - 6 - (i % 2) * 10, 20, 5)).join('');

function scene01(d) {
  d.add(box({ x: 110, y: 660, w: 560, h: SHELF - 660, ow: OW, bags: [C.canvas, C.tomato, C.gold, C.aqua], label: '420', cap: 64 }));
  d.add(hang(d, 'tote', { cx: 946, hookY: 210, top: 420, w: 270, h: 260, ow: OW, size: 0.8, color: C.leaf }));
  d.add(arrow({ x1: 470, y1: 500, x2: 765, y2: 430, bend: -70, color: C.canvas, width: 18, head: 52, ow: OW }));
  d.add(say('TOTE', 950, 750, 44, C.tomato));
  d.add(chip(850, 880, 80, OW), chip(950, 850, 80, OW), chip(1050, 880, 80, OW));
  d.add(arrow({ x1: 800, y1: 930, x2: 700, y2: 930, color: C.tomato, width: 16, head: 46, ow: OW }));
}

/** Fifteen coins split 10, 2 and 3, centred, with a gap between the groups. */
function coinGroups(cy, r, step, gap) {
  const groups = [10, 2, 3];
  const total = 14 * step + 2 * gap;
  let x = (SCENE_SIZE - total) / 2;
  return groups.map((count) => {
    const xs = Array.from({ length: count }, (_, i) => x + i * step);
    x = xs.at(-1) + step + gap;
    return { markup: xs.map((cx) => coin(cx, cy, r, 5)).join(''), x1: xs[0] - r, x2: xs.at(-1) + r };
  });
}

function scene02(d) {
  d.add(say('1% FEE', 600, 92, 64, C.gold));
  d.add(coin(600, 300, 84, 9));
  d.add(arrow({ x1: 600, y1: 405, x2: 600, y2: 478, color: C.gold, width: 14, head: 40, ow: 6 }));
  const [a, b, c] = coinGroups(540, 25, 60, 74);
  d.add(a.markup, b.markup, c.markup);
  const groups = [[a, C.canvas, '10'], [b, C.aqua, '2'], [c, C.steel, '3']];
  for (const [g, color, n] of groups) {
    d.add(bracket({ x1: g.x1, x2: g.x2, y: 584, color, width: 9, depth: 22, ow: 5 }));
    d.add(say(n, (g.x1 + g.x2) / 2, 648, 46, color));
  }
  const [ax, bx, cx] = [a, b, c].map((g) => (g.x1 + g.x2) / 2);
  d.add(arrow({ x1: ax, y1: 712, x2: ax, y2: 760, color: C.canvas, width: 12, head: 34, ow: 5 }));
  d.add(arrow({ x1: bx, y1: 712, x2: bx, y2: 780, color: C.aqua, width: 12, head: 34, ow: 5 }));
  d.add(arrow({ x1: cx, y1: 712, x2: cx, y2: 780, color: C.steel, width: 12, head: 34, ow: 5 }));
  // A steel rail for the three small bags: these hooks hang on the rail, not in the wall, so they take no grid.
  d.add(rect(ax - 230, 778, 460, 12, `rx="6" fill="${C.steel}" stroke="${C.ink}" stroke-width="5"`));
  [[ax - 150, C.canvas], [ax, C.tomato], [ax + 150, C.gold]].forEach(([x, color], i) => {
    d.add(hangBag(d, 'tote', { cx: x, hookY: 784, top: 862, w: 104, h: 104, ow: 5, size: 0.42, color, pocket: i === 0 ? C.tomato : C.canvas, id: `s2-${i}` }));
  });
  d.add(pool({ cx: bx, cy: 862, w: 176, ow: 5 }));
  d.add(say('POOL', bx, 948, 26, C.aqua));
  d.add(plate({ cx, cy: 880, text: ['SQUARE', 'HOLE'], cap: 22, ow: 5 }));
}

function scene03(d) {
  d.add(say('BUY', 300, 92, 44, C.leaf), say('SELL', 900, 92, 44, C.tomato));
  d.add(arrow({ x1: 330, y1: 170, x2: 470, y2: 222, bend: -20, color: C.leaf, width: 12, head: 36, ow: 5 }));
  d.add(arrow({ x1: 870, y1: 170, x2: 730, y2: 222, bend: 20, color: C.tomato, width: 12, head: 36, ow: 5 }));
  d.add(coinRow(600, 270, 10, 22, 14, 5));
  const outside = [162, 402];
  const inside = [790, 900, 1010];
  outside.forEach((x, i) => d.add(hang(d, 'tote', { cx: x, hookY: 450, top: 580, w: 170, h: 170, ow: 6, size: 0.6, color: [C.canvas, C.gold][i], pocket: C.tomato, id: `s3-${i}` })));
  d.add(box({ x: 720, y: 720, w: 360, h: SHELF - 720, ow: OW, bags: [C.aqua, C.tomato, C.canvas], label: 'INSIDE', cap: 30 }));
  const targets = [...outside.map((x) => [x, 420]), ...inside.map((x) => [x, 570])];
  for (const [x, y] of targets) {
    d.add(arrow({ x1: 600, y1: 310, x2: x, y2: y - 34, bend: x < 600 ? 34 : -34, color: C.gold, width: 6, head: 22, ow: 4, dash: '2 16' }));
    d.add(coin(x - 22, y, 19, 5), coin(x + 22, y, 19, 5));
  }
  d.add(say('OUTSIDE', 295, 860, 34, C.canvas));
}

function scene04(d) {
  d.add(hang(d, 'tote', { cx: 410, hookY: 90, top: 320, w: 340, h: 320, ow: OW, inPocket: coinsIn(3) }));
  d.add(arrow({ x1: 560, y1: 520, x2: 780, y2: 390, bend: -60, color: C.gold, width: 12, head: 38, ow: 6 }));
  d.add(coin(640, 410, 22, 5), coin(710, 372, 18, 5));
  d.add(button({ cx: 940, cy: 330, text: 'CLAIM', cap: 44, ow: OW }), pointer(960, 352, 96));
  d.add(hang(d, 'tote', { cx: 221, hookY: 690, top: 790, w: 170, h: 160, ow: 6, size: 0.55, color: C.aqua, inPocket: coinsIn(2), id: 's4-a' }));
  d.add(hang(d, 'tote', { cx: 1001, hookY: 690, top: 790, w: 170, h: 160, ow: 6, size: 0.55, color: C.aqua, inPocket: coinsIn(2), id: 's4-b' }));
  d.add(arrow({ x1: 330, y1: 820, x2: 870, y2: 820, bend: -60, color: C.canvas, width: 12, head: 40, ow: 6, dash: '18 18' }));
  d.add(say('SOLD', 600, 880, 40, C.canvas));
}

function scene05(d) {
  const rest = (cx, by) => coin(cx - 16, by - 16, 17, 4) + coin(cx + 16, by - 26, 17, 4);
  d.add(arrow({ x1: 1080, y1: 250, x2: 930, y2: 500, bend: -40, color: C.gold, width: 14, head: 44, ow: 6 }));
  d.add(coin(1040, 200, 22, 5), coin(1110, 170, 20, 5), coin(985, 160, 18, 5));
  d.add(box({ x: 560, y: 680, w: 560, h: SHELF - 680, ow: OW, bags: [null, C.canvas, C.aqua, C.tomato], fill: (cx, by, bw, i) => (i === 0 ? '' : rest(cx, by)) }));
  d.add(padlock(840, 880, 110));
  d.add(hang(d, 'tote', { cx: 288, hookY: 150, top: 360, w: 300, h: 290, ow: OW, size: 0.9, color: C.gold, pocket: C.tomato, inPocket: coinsIn(3), id: 's5' }));
  d.add(arrow({ x1: 640, y1: 610, x2: 470, y2: 520, bend: 50, color: C.canvas, width: 16, head: 48, ow: OW }));
}

/** A padlock, for "nobody can claim here". */
function padlock(cx, cy, s) {
  const shackle = `M${r2(cx - s * 0.3)} ${r2(cy - s * 0.2)}V${r2(cy - s * 0.42)}A${r2(s * 0.3)} ${r2(s * 0.3)} 0 0 1 ${r2(cx + s * 0.3)} ${r2(cy - s * 0.42)}V${r2(cy - s * 0.2)}`;
  return `<path d="${shackle}" fill="none" stroke="${C.ink}" stroke-width="${r2(s * 0.2 + 2 * OW)}"/>`
    + `<path d="${shackle}" fill="none" stroke="${C.steel}" stroke-width="${r2(s * 0.2)}"/>`
    + `<rect x="${r2(cx - s / 2)}" y="${r2(cy - s * 0.25)}" width="${r2(s)}" height="${r2(s * 0.75)}" rx="${r2(s * 0.12)}" fill="${C.gold}" stroke="${C.ink}" stroke-width="${OW}"/>`
    + `<circle cx="${r2(cx)}" cy="${r2(cy + s * 0.08)}" r="${r2(s * 0.1)}" fill="${C.ink}"/>`
    + `<rect x="${r2(cx - s * 0.04)}" y="${r2(cy + s * 0.08)}" width="${r2(s * 0.08)}" height="${r2(s * 0.22)}" fill="${C.ink}"/>`;
}

function scene06(d) {
  d.add(say('RAISE', 140, 92, 40, C.canvas, { anchor: 'start' }));
  d.add(raiseBar({ x: 140, y: 170, w: 760, h: 56, fill: 1, ow: OW }));
  d.add(jar({ cx: 280, bottom: SHELF, w: 250, h: 300, coins: 9, ow: OW, open: true }));
  const fill = (cx, by) => coin(cx - 16, by - 16, 17, 4) + coin(cx + 16, by - 26, 17, 4)
    + arrow({ x1: cx, y1: by - 120, x2: cx, y2: by - 52, color: C.gold, width: 6, head: 20, ow: 4 });
  d.add(box({ x: 560, y: 700, w: 560, h: SHELF - 700, ow: OW, bags: [C.canvas, C.tomato, C.gold, C.aqua], fill }));
  d.add(arrow({ x1: 290, y1: 690, x2: 560, y2: 470, bend: -60, color: C.gold, width: 14, head: 44, ow: 6 }));
  d.add(coin(620, 430, 22, 5), coin(690, 400, 20, 5), coin(600, 370, 18, 5));
}

function scene07(d) {
  d.add(hang(d, 'sleep', { cx: 287, hookY: 150, top: 300, w: 380, h: 300, ow: OW, size: 0.85, id: 's7-a' }));
  d.add(hang(d, 'tote', { cx: 766, hookY: 150, top: 360, w: 250, h: 240, ow: OW, size: 0.8, id: 's7-b' }));
  d.add(hang(d, 'punch', { cx: 1066, hookY: 150, top: 310, w: 150, h: 330, ow: OW, size: 0.8, id: 's7-c' }));
  d.add(box({ x: 150, y: 760, w: 520, h: SHELF - 760, ow: OW, bags: [C.canvas, C.tomato, C.gold, C.aqua] }));
  d.add(rect(0, 0, SCENE_SIZE, SCENE_SIZE, `fill="${MIX.nightDeep}" fill-opacity="0.42"`));
  d.add(counter(410, 900, 64));
  d.add(say('Z', 420, 250, 40, C.canvas), say('Z', 480, 175, 54, C.canvas), say('Z', 560, 85, 68, C.canvas));
}

/** A small sign with a coin and a count, such as "no new coins". */
function counter(cx, cy, cap) {
  const w = cap * 3.3;
  const h = cap * 1.7;
  return `<path d="M${r2(cx - w / 2)} ${r2(cy - h / 2)}h${r2(w)}v${r2(h)}h${r2(-w)}Z" fill="${C.canvas}" stroke="${C.ink}" stroke-width="${OW}" stroke-linejoin="round"/>`
    + coin(cx - w * 0.22, cy, cap * 0.42, 5)
    + lettering('0', { x: cx + w * 0.2, y: cy - cap / 2, cap, color: C.ink, outline: null });
}

export const SCENES = Object.freeze([
  { n: '01', title: 'The box', draw: scene01,
    alt: 'A cardboard box marked 420 is full of bags. An arrow lifts one bag out onto a hook on the wall, while three red TOTE chips go into the box.',
    caption: ['This box holds 420 bags, and every one of them wants to be held.', 'Anyone can take a bag out with TOTE, and its owner can put it back.'] },
  { n: '02', title: 'Fifteen coins', draw: scene02,
    alt: 'A big gold coin under the words 1% FEE splits into fifteen small coins. Ten go to three bags on hooks, two go to a small pool and three go to a plate marked SQUARE HOLE.',
    caption: ['Every buy and every sale pays a small fee, and the fee splits into 15 coins.', 'Ten go to the bags, two go to the pool and three go to Square Hole (its platform and its buy-back).'] },
  { n: '03', title: 'The same for every bag', draw: scene03,
    alt: 'Ten gold coins from buys and sales are shared out, two coins to each of five bags. Two bags hang on hooks outside the box and three stand inside it.',
    caption: ['The ten coins are shared by all 420 bags.', 'Every bag gets the same share, in the box or out of it.'] },
  { n: '04', title: 'Bags outside', draw: scene04,
    alt: 'A tote on a hook has gold coins in its pocket. A pointer clicks CLAIM and the coins fly out. Below, a small bag moves to a new hook with its coins, marked SOLD.',
    caption: ['A bag outside the box keeps its coins until its owner claims them.', 'If the bag is sold, its coins go with it.'] },
  { n: '05', title: 'Bags inside', draw: scene05,
    alt: 'Coins fall into a box with a padlock on it, and every bag in the box holds two coins. One bag has been lifted out onto a hook, and its pocket is full of coins.',
    caption: ['A bag in the box keeps its coins too, and nobody can claim them there.', 'Whoever takes the bag out gets the coins with it.'] },
  { n: '06', title: 'Waiting for the box', draw: scene06,
    alt: 'A raise bar is full and has a check mark. Coins pour from a jar into a box of bags, two coins for each bag.',
    caption: ['While the box fills its raise, the bags\' coins wait in a jar.', 'When the box graduates, the jar is shared by all 420 bags.'] },
  { n: '07', title: 'A quiet night', draw: scene07,
    alt: 'The bag wall at night with the lights low. Bags hang still, a sleeping bag snores Z Z Z, and a sign on the box shows a coin and 0.',
    caption: ['Fees only come from trades.', 'No trades, no coins, and the bags just hang there.'] },
]);

export function sceneSvg(s) {
  const d = stage(s.n, s.title, s.alt, s.n === '07');
  s.draw(d);
  return d.toString();
}
