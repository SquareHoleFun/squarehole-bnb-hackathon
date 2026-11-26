/**
 * The storybook: seven square scenes, 1200 x 1200, that show what the fees do in a graduated box.
 * Captions and alt text live here and in storybook.md; check.mjs makes sure the two agree.
 */
import { C } from './palette.mjs';
import { Doc } from './doc.mjs';
import { room, nightWindow } from './room.mjs';
import { sign, signs } from './sign.mjs';
import { label, coin, tile, coinRow, tank, crate, burner, pointer, button, plate, arrow, bracket, tray } from './props.mjs';

export const SCENE_SIZE = 1200;
const CEIL = 96;
const FLOOR = 1056;

function stage(n, title, alt) {
  const d = new Doc(SCENE_SIZE, SCENE_SIZE, `Exit Liquidity story, scene ${n}: ${title}`, alt);
  d.add(room(d, { w: SCENE_SIZE, h: SCENE_SIZE, ceilingY: CEIL, floorY: FLOOR, seams: 5 }));
  return d;
}

const counter = (d, cx, cy, text, m = 14) => sign(d, { cx, cy, lines: [text], m, style: 'led', color: 'green', glow: 0 }).markup;

function scene01(d) {
  d.add(sign(d, { cx: 900, cy: 330, lines: ['EXIT?'], m: 11, style: 'led', color: 'green', mount: 'bracket' }).halo);
  d.add(crate(d, { x: 120, y: 560, w: 600, h: 496, inside: ['green', 'red', 'amber', 'green', 'mint', 'red'], counter: counter(d, 420, 850, '404', 15) }));
  d.add(sign(d, { cx: 900, cy: 330, lines: ['EXIT?'], m: 11, style: 'led', color: 'green', mount: 'bracket' }).markup);
  d.add(arrow({ x1: 560, y1: 470, x2: 820, y2: 430, bend: -90, color: C.mint, width: 12, head: 38 }));
  d.add(arrow({ x1: 880, y1: 470, x2: 650, y2: 545, bend: -40, color: C.mint, width: 7, head: 28, dash: '4 18', opacity: 0.8 }));
  d.add(tile(870, 800, 74), tile(960, 760, 74), tile(1050, 800, 74));
  d.add(label('EXIT', { x: 960, y: 640, m: 9, color: C.green }));
  d.add(arrow({ x1: 820, y1: 800, x2: 740, y2: 800, color: C.green, width: 12, head: 36 }));
}

/** Fifteen coins split 10, 2 and 3, centred, with a gap between the groups. */
function coinGroups(cy, r, step, gap) {
  const groups = [10, 2, 3];
  const total = 14 * step + 2 * gap;
  let x = (SCENE_SIZE - total) / 2;
  return groups.map((count) => {
    const xs = Array.from({ length: count }, (_, i) => x + i * step);
    x = xs.at(-1) + step + gap;
    return { xs, markup: xs.map((cx) => coin(cx, cy, r)).join(''), x1: xs[0] - r, x2: xs.at(-1) + r };
  });
}

function scene02(d) {
  d.add(label('1% FEE', { x: 600, y: 150, m: 9, color: C.amber }));
  d.add(coin(600, 300, 74), label('USDC', { x: 600, y: 396, m: 6, color: C.amber }));
  const [a, b, c] = coinGroups(540, 27, 62, 70);
  d.add(arrow({ x1: 600, y1: 452, x2: 600, y2: 500, color: C.amber, width: 10, head: 28 }));
  d.add(a.markup, b.markup, c.markup);
  const groups = [[a, C.green, '10'], [b, C.mint, '2'], [c, C.paper, '3']];
  for (const [g, color, n] of groups) {
    d.add(bracket({ x1: g.x1, x2: g.x2, y: 584, color }));
    d.add(label(n, { x: (g.x1 + g.x2) / 2, y: 660, m: 8, color }));
  }
  const ax = (a.x1 + a.x2) / 2;
  const bx = (b.x1 + b.x2) / 2;
  const cx = (c.x1 + c.x2) / 2;
  d.add(arrow({ x1: ax, y1: 728, x2: ax, y2: 790, color: C.green, width: 10, head: 28 }));
  d.add(arrow({ x1: bx, y1: 728, x2: bx, y2: 800, color: C.mint, width: 10, head: 28 }));
  d.add(arrow({ x1: cx, y1: 728, x2: cx, y2: 800, color: C.paper, width: 10, head: 28 }));
  d.add(plate({ cx: ax, cy: 900, text: ['BUY → POOL', 'SELL → SIGNS'], m: 6, color: C.green }));
  d.add(tank(d, { x: bx - 70, y: 830, w: 140, h: 150, level: 0.6, rows: 1, lock: false }));
  d.add(label('POOL', { x: bx, y: 1000, m: 5, color: C.mint }));
  d.add(plate({ cx, cy: 900, text: ['SQUARE', 'HOLE'], m: 5, color: C.paper }));
}

function scene03(d) {
  d.add(label('↑ BUY', { x: 250, y: 190, m: 10, color: C.green }));
  for (let r = 0; r < 3; r += 1) d.add(coinRow(250, 380 + r * 76, 4, 29, 18));
  d.add(label('10 + 2', { x: 250, y: 620, m: 7, color: C.amber }));
  d.add(arrow({ x1: 330, y1: 330, x2: 640, y2: 300, bend: -70, color: C.amber, width: 12, head: 36 }));
  d.add(coin(700, 300, 34), tile(800, 300, 66));
  d.add(arrow({ x1: 700, y1: 350, x2: 700, y2: 420, color: C.amber, width: 8, head: 24 }));
  d.add(arrow({ x1: 800, y1: 350, x2: 800, y2: 420, color: C.green, width: 8, head: 24 }));
  d.add(tank(d, { x: 480, y: 400, w: 560, h: 640, level: 0.74, oldLevel: 0.5, rows: 4 }));
  d.add(label('POOL', { x: 760, y: 470, m: 9, color: C.mint }));
}

function scene04(d) {
  d.add(label('↓ SELL', { x: 600, y: 140, m: 10, color: C.red }));
  d.add(coinRow(600, 300, 10, 27, 20));
  const outside = [170, 380];
  const inside = [790, 900, 1010];
  d.add(signs(d, outside.map((cx) => ({ cx, cy: 640, lines: ['404'], m: 10, style: 'box', color: 'green', heavy: true, mount: 'rods', ceilingY: CEIL }))).markup);
  d.add(crate(d, { x: 700, y: 700, w: 400, h: 356, inside: ['green', 'red', 'amber'] }));
  const targets = [...outside.map((x) => [x, 500]), ...inside.map((x) => [x, 590])];
  for (const [x, y] of targets) {
    d.add(arrow({ x1: 600, y1: 345, x2: x, y2: y - 52, bend: x < 600 ? 30 : -30, color: C.amber, width: 5, head: 18, dash: '2 14', opacity: 0.75 }));
    d.add(coin(x - 24, y, 22), coin(x + 24, y, 22));
  }
  d.add(label('OUTSIDE', { x: 275, y: 880, m: 7, color: C.mint }), label('INSIDE', { x: 900, y: 880, m: 7, color: C.mint }));
}

function scene05(d) {
  const top = sign(d, { cx: 380, cy: 300, lines: ['404'], m: 15, style: 'box', color: 'green', heavy: true, mount: 'rods', ceilingY: CEIL });
  d.add(top.halo, top.markup);
  const trayTop = top.box.y + top.box.h + 90;
  d.add(tray({ cx: 380, top: trayTop, w: 260, coins: 6, chainFrom: top.box.y + top.box.h }));
  d.add(arrow({ x1: 520, y1: trayTop - 40, x2: 780, y2: 420, bend: -60, color: C.amber, width: 10, head: 32 }));
  d.add(coin(640, 330, 22), coin(720, 350, 18));
  d.add(button({ cx: 900, cy: 470, text: 'CLAIM', m: 9 }), pointer(930, 490, 96));
  d.add(`<rect x="0" y="700" width="1200" height="8" fill="${C.rim}"/>`);
  const small = (cx) => {
    const s = sign(d, { cx, cy: 800, lines: ['404'], m: 7, style: 'box', color: 'green', heavy: true, glow: 0.22 });
    return s.halo + `<rect x="${cx - 2}" y="708" width="4" height="${s.box.y - 708}" fill="${C.rim}"/>` + s.markup
      + tray({ cx, top: s.box.y + s.box.h + 52, w: 130, coins: 3, chainFrom: s.box.y + s.box.h });
  };
  d.add(small(220), small(980));
  d.add(arrow({ x1: 340, y1: 860, x2: 860, y2: 860, bend: -50, color: C.amber, width: 8, head: 30, dash: '10 16' }));
  d.add(label('SOLD', { x: 600, y: 920, m: 8, color: C.amber }));
}

function scene06(d) {
  d.add(crate(d, { x: 90, y: 620, w: 500, h: 436, inside: ['green', 'red', 'amber', 'mint'] }));
  d.add(label('INSIDE', { x: 340, y: 860, m: 8, color: C.mint }));
  d.add(coin(210, 470, 26), coin(330, 430, 26), coin(450, 470, 26));
  d.add(arrow({ x1: 470, y1: 400, x2: 600, y2: 330, bend: -30, color: C.amber, width: 10, head: 30 }));
  d.add(coin(650, 320, 34), arrow({ x1: 696, y1: 320, x2: 790, y2: 320, color: C.mint, width: 10, head: 28 }), tile(840, 320, 70));
  d.add(label('BUY EXIT', { x: 745, y: 200, m: 7, color: C.mint }));
  d.add(arrow({ x1: 870, y1: 380, x2: 950, y2: 610, bend: -40, color: C.green, width: 10, head: 30 }));
  d.add(burner(d, { cx: 960, bottom: FLOOR, w: 300 }));
  d.add(label('BURN', { x: 960, y: 900, m: 8, color: C.red }));
}

function scene07(d) {
  d.add(nightWindow({ x: 110, y: 200, w: 210, h: 330 }));
  const lit = signs(d, [
    { cx: 760, cy: 300, lines: ['404'], m: 15, style: 'box', color: 'green', heavy: true, mount: 'rods', ceilingY: CEIL },
    { cx: 760, cy: 640, lines: ['NOT', 'FOUND'], m: 8, style: 'led', color: 'red', mount: 'bracket' },
  ]);
  d.add(lit.markup);
  const t = lit.boxes[0];
  d.add(tray({ cx: 760, top: t.y + t.h + 70, w: 240, coins: 0, chainFrom: t.y + t.h }));
  d.add(counter(d, 975, t.y + t.h + 52, '0', 8));
  d.add(crate(d, { x: 120, y: 760, w: 380, h: 296, inside: ['green', 'amber', 'red'] }));
  d.add(label('Z', { x: 400, y: 660, m: 6, color: C.mint }), label('Z', { x: 455, y: 585, m: 8, color: C.mint }), label('Z', { x: 525, y: 490, m: 10, color: C.mint }));
}

export const SCENES = Object.freeze([
  { n: '01', title: 'The box', draw: scene01,
    alt: 'A crate with a 404 counter holds many signs. An arrow lifts one sign out onto the wall while three green EXIT squares go into the crate.',
    caption: ['This box holds 404 signs, and none of them can find the exit.', 'Anyone can take a sign out with EXIT, or put one back.'] },
  { n: '02', title: 'Fifteen coins', draw: scene02,
    alt: 'A 1% fee coin in USDC splits into fifteen small coins. Ten go to the box rule, which sends buys to the pool and sells to the signs. Two go to the pool and three go to a plate marked SQUARE HOLE.',
    caption: ['Every trade pays a small fee in USDC, and the fee splits into 15 coins.', 'Ten follow the box\'s rule, two go to the pool and three go to Square Hole (its platform and its buy-back).'] },
  { n: '03', title: 'Buyers fill the pool', draw: scene03,
    alt: 'Twelve fee coins from a buy fall into a glass pool tank as coins and EXIT squares. The water rises above its old line, and a padlock sits on the tank.',
    caption: ['When someone buys EXIT, the ten coins go into the box\'s own pool too.', 'The pool gets deeper, and nobody can ever take that out.'] },
  { n: '04', title: 'Sellers pay the signs', draw: scene04,
    alt: 'Ten fee coins from a sale are shared out, two coins to each of five signs. Two signs hang outside and three stand inside a crate.',
    caption: ['When someone sells EXIT, the ten coins go to the signs.', 'Every sign gets the same share.'] },
  { n: '05', title: 'Signs outside', draw: scene05,
    alt: 'A 404 sign with a tray of coins chained under it. A pointer clicks CLAIM and coins fly out. Below, a small sign moves to a new spot with its coins, marked SOLD.',
    caption: ['A sign outside the box keeps its share as USDC until its owner claims it.', 'If the sign is sold, the share goes with it.'] },
  { n: '06', title: 'Signs inside', draw: scene06,
    alt: 'Coins rise out of a crate of signs, turn into a green EXIT square, and drop into a small fire where the square breaks into bits.',
    caption: ['Signs inside the box can\'t keep coins.', 'Their share buys EXIT, and that EXIT is burned.'] },
  { n: '07', title: 'A quiet night', draw: scene07,
    alt: 'A dark hallway at night with stars in the window. The 404 sign glows over an empty tray with a 0 counter, and the crate of signs sleeps.',
    caption: ['Fees only come from trades.', 'No trades, no coins, and the signs still say 404.'] },
]);

export function sceneSvg(s) {
  const d = stage(s.n, s.title, s.alt);
  s.draw(d);
  return d.toString();
}
