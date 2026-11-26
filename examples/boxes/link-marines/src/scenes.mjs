/**
 * The seven story scenes, 1200 x 1200 each, with their captions and alt text. storybook.md uses exactly these words,
 * and check.mjs makes sure of it. Every scene is the same mess hall: a wall of ration-paper tiles over a wooden floor.
 */
import { C } from './palette.mjs';
import { Doc } from './doc.mjs';
import { ground } from './poster.mjs';
import { marine } from './marine.mjs';
import { coin, bitten, tag } from './coins.mjs';
import { floor, table, messTin, pool, crate, peeker, bell, footlocker, noKey, raiseBar, arrow, sign, frame, tray, jar } from './props.mjs';
import { lettering } from './type.mjs';
import { VARIANTS } from './items.mjs';

export const SCENE_SIZE = 1200;
export const FLOOR_Y = 1040;
const OW = 7;
const S = SCENE_SIZE;

/** The specs of the marines who appear in the story, taken from the collection and changed only in what they do. */
const SPEC = Object.freeze({
  private: VARIANTS[0].spec,
  pilot: VARIANTS[4].spec,
  scout: VARIANTS[10].spec,
  officer: VARIANTS[8].spec,
});
const waiting = (spec, hold) => ({ ...spec, eyes: 'dots', brimShade: false, mouth: 'smile', mouthOpts: undefined, hold });
// Sleeves start behind the table top, so only the fist and the cutlery show above it.
const FORK = { tool: 'fork', at: [262, 830], sleeve: [200, 1000, 262, 820], fist: [262, 800], empty: true };
const SPOON = { tool: 'spoon', at: [738, 830], sleeve: [800, 1000, 738, 820], fist: [738, 800], empty: true };

/** The mess hall every scene shares: the tiled wall and the floor. */
function hall(d) {
  return ground(d, { w: S, h: FLOOR_Y, wall: 'paper', tile: 100, top: 40 }) + floor(d, { y: FLOOR_Y, w: S, h: S - FLOOR_Y, ow: OW });
}

/** One marine sitting behind the mess table: the bust's box at (x, y), `size` px wide. */
const seat = (d, spec, x, y, size) => marine(d, spec, { x, y, size, ow: OW });

function scene01(d) {
  const top = 560;
  const parts = [hall(d)];
  for (const [i, x] of [130, 235, 340, 445, 550].entries()) parts.push(peeker(x, top - 60, 118, OW, i % 2 ? 6 : -6));
  parts.push(crate(d, { cx: 340, y: top, w: 560, h: FLOOR_Y - top, ow: OW, words: ['420'], cap: 190, open: true }));
  parts.push(tag(150, 250, 120, OW, -12), tag(290, 210, 120, OW, 8), tag(430, 260, 120, OW, -4));
  parts.push(arrow(300, 330, 330, 450, { bend: 24, color: C.orange, ow: OW }));
  parts.push(seat(d, waiting(SPEC.private), 690, 400, 460));
  parts.push(table(d, { x: 650, y: 800, w: 520, ow: OW, to: FLOOR_Y }));
  parts.push(arrow(540, 430, 760, 470, { bend: -110, color: C.olive, ow: OW }));
  return parts;
}

function scene02(d) {
  const parts = [hall(d)];
  parts.push(lettering(d, '1% FEE', { x: 600, y: 70, cap: 70, color: C.ink }));
  parts.push(coin(600, 260, 88, OW));
  parts.push(arrow(520, 330, 290, 520, { bend: -40, color: C.gold, ow: OW }));
  parts.push(arrow(600, 370, 600, 630, { color: C.gold, ow: OW }));
  parts.push(arrow(680, 330, 940, 520, { bend: 40, color: C.gold, ow: OW }));
  // Ten coins fly to the mess tin, two to the pool and three to the Square Hole crate, each group with its count.
  for (let i = 0; i < 10; i += 1) parts.push(coin(184 + (i % 5) * 58, 590 + Math.floor(i / 5) * 58, 26, OW * 0.7));
  parts.push(lettering(d, '10', { x: 64, y: 590, cap: 58, color: C.olive, anchor: 'start' }));
  parts.push(coin(582, 700, 26, OW * 0.7), coin(640, 700, 26, OW * 0.7));
  parts.push(lettering(d, '2', { x: 536, y: 676, cap: 50, color: C.olive, anchor: 'end' }));
  parts.push(coin(882, 590, 26, OW * 0.7), coin(940, 590, 26, OW * 0.7), coin(998, 590, 26, OW * 0.7));
  parts.push(lettering(d, '3', { x: 1046, y: 562, cap: 58, color: C.olive, anchor: 'start' }));
  parts.push(messTin(d, { cx: 250, y: FLOOR_Y - 0.62 * 300, w: 300, ow: OW, label: 'MESS' }));
  parts.push(pool(d, { cx: 610, cy: 900, w: 250, ow: OW, floating: false }));
  parts.push(crate(d, { cx: 960, y: 760, w: 300, h: FLOOR_Y - 760, ow: OW, words: ['SQUARE', 'HOLE'], cap: 56 }));
  return parts;
}

function scene03(d) {
  const parts = [hall(d)];
  parts.push(raiseBar(d, { x: 180, y: 170, w: 760, h: 64, frac: 0.6, ow: OW }));
  parts.push(sign(d, { cx: 600, cy: 440, w: 240, h: 112, lines: 'WAIT', cap: 60, ow: OW, cords: 370 }));
  parts.push(seat(d, waiting(SPEC.private, FORK), 20, 440, 460));
  parts.push(seat(d, waiting(SPEC.pilot, SPOON), 720, 440, 460));
  parts.push(table(d, { x: 40, y: 846, w: 1120, ow: OW, to: FLOOR_Y }));
  parts.push(messTin(d, { cx: 600, y: 846 - 0.62 * 280, w: 280, ow: OW, coins: 16, label: 'MESS' }));
  return parts;
}

function scene04(d) {
  const parts = [hall(d)];
  parts.push(raiseBar(d, { x: 180, y: 170, w: 760, h: 64, frac: 1, ow: OW, mark: 'check' }));
  parts.push(bell(d, { x: 600, y: 300, size: 180, ow: OW, ring: true }));
  parts.push(seat(d, SPEC.private, 20, 440, 460));
  parts.push(seat(d, SPEC.pilot, 720, 440, 460));
  parts.push(lettering(d, 'CHOMP!', { x: 250, y: 330, cap: 52, color: C.orange, shadow: C.ink }));
  parts.push(lettering(d, 'CHOMP!', { x: 950, y: 330, cap: 52, color: C.orange, shadow: C.ink }));
  parts.push(table(d, { x: 40, y: 846, w: 1120, ow: OW, to: FLOOR_Y }));
  parts.push(messTin(d, { cx: 600, y: 846 - 0.62 * 280, w: 280, ow: OW, coins: 2, label: 'MESS' }));
  return parts;
}

function scene05(d) {
  const parts = [hall(d)];
  parts.push(lettering(d, 'LOCKED FOR GOOD', { x: 600, y: 90, cap: 64, color: C.ink }));
  const drops = [[470, 300, -30], [600, 250, 60], [730, 320, 150], [540, 450, 200], [660, 520, -110]];
  for (const [x, y, at] of drops) parts.push(bitten(d, x, y, 40, OW * 0.8, at));
  parts.push(arrow(600, 580, 600, 690, { color: C.olive, ow: OW }));
  parts.push(footlocker(d, { cx: 600, y: FLOOR_Y - 360, w: 600, ow: OW, words: ['NO KEY'] }));
  parts.push(noKey(1010, 470, 180, OW));
  return parts;
}

function scene06(d) {
  const parts = [hall(d)];
  const inner = marine(d, SPEC.officer, { x: 260 - 142, y: 420 - 128, size: 284, ow: 4 });
  parts.push(frame(d, { cx: 260, cy: 420, size: 380, ow: OW, inner }));
  parts.push(sign(d, { cx: 900, cy: 250, w: 300, h: 124, lines: [], cap: 70, ow: OW, cords: 180 }));
  parts.push(coin(840, 250, 36, OW * 0.8), lettering(d, '0', { x: 950, y: 215, cap: 70, color: C.ink }));
  parts.push(seat(d, { ...SPEC.scout, eyes: 'wide', mouth: 'o', wear: undefined, hold: undefined }, 700, 440, 420));
  parts.push(table(d, { x: 40, y: 846, w: 1120, ow: OW, to: FLOOR_Y }));
  parts.push(tray(d, { cx: 620, cy: 850, w: 260, ow: OW }));
  return parts;
}

function scene07(d) {
  const parts = [hall(d)];
  parts.push(raiseBar(d, { x: 180, y: 170, w: 760, h: 64, frac: 0.45, ow: OW, mark: 'cross' }));
  parts.push(table(d, { x: 40, y: 846, w: 560, ow: OW, to: FLOOR_Y }));
  parts.push(messTin(d, { cx: 300, y: 846 - 0.62 * 300, w: 300, ow: OW, coins: 12, label: 'MESS' }));
  parts.push(arrow(420, 520, 800, 600, { bend: -110, color: C.gold, ow: OW }));
  parts.push(coin(540, 440, 24, OW * 0.7), coin(610, 430, 24, OW * 0.7), coin(680, 446, 24, OW * 0.7));
  parts.push(jar(d, { cx: 900, y: FLOOR_Y - 408, w: 340, ow: OW, coins: 9, label: ['CLOSING', 'POOL'] }));
  parts.push(tag(650, 960, 100, OW, -10), arrow(704, 948, 752, 940, { color: C.orange, ow: OW, width: 12 }));
  parts.push(arrow(1010, 640, 1080, 560, { color: C.gold, ow: OW, width: 12 }), coin(1106, 520, 30, OW * 0.8));
  return parts;
}

/** Each scene: number, title, the caption (two short sentences at most), the alt text and its drawing. */
export const SCENES = Object.freeze([
  {
    n: '01', title: 'The box', draw: scene01,
    caption: ['This box holds 420 marines.', 'After it graduates, anyone can take one out with the box\'s token.'],
    alt: 'A wooden crate marked 420 is full of marines in helmets peeking over its edge. Three orange dog tags go into the crate, and an arrow lifts one marine out to a seat at a mess table.',
  },
  {
    n: '02', title: 'Fifteen coins', draw: scene02,
    caption: ['Every buy and every sale pays a small fee, and the fee splits into 15 coins.', 'Ten go to the mess tin, two go to the pool and three go to Square Hole (its platform and its buy-back).'],
    alt: 'A big gold coin under the words 1% FEE splits into fifteen small coins. Ten go to a steel mess tin, two go to a small pool and three go to a crate marked SQUARE HOLE.',
  },
  {
    n: '03', title: 'Waiting for the box', draw: scene03,
    caption: ['While the box fills its raise, nobody eats.', 'The coins wait in the mess tin.'],
    alt: 'A raise bar is a little more than half full. Two marines sit at a mess table with an empty fork and an empty spoon, waiting. Between them a steel mess tin is heaped with gold coins, under a sign that says WAIT.',
  },
  {
    n: '04', title: 'Chow time', draw: scene04,
    caption: ['After the box graduates, anyone can ring the bell, and the marines eat the coins in the tin.', 'No trades means no coins, and nothing to eat.'],
    alt: 'The raise bar is full and has a check mark. A steel triangle bell rings, and two marines at the mess table chomp gold coins from the tin. CHOMP is written above them.',
  },
  {
    n: '05', title: 'The locker with no key', draw: scene05,
    caption: ['This box\'s coin cannot be burned, so the eaten coins go into a locker with no key.', 'Nobody can take them out again.'],
    alt: 'Gold coins with bites out of them drop into a steel footlocker marked NO KEY. Its padlock has no keyhole, and beside it a key is crossed out. Above it are the words LOCKED FOR GOOD.',
  },
  {
    n: '06', title: 'Nothing for the marines', draw: scene06,
    caption: ['The marines never get any coins.', 'A marine is a picture you own, with no share of the fees.'],
    alt: 'A marine\'s portrait hangs in a wooden frame. Next to it a marine sits at the mess table with an empty steel tray, under a sign with a coin and the number 0.',
  },
  {
    n: '07', title: 'If the box fails', draw: scene07,
    caption: ['If the box fails, nobody eats.', 'The coins in the tin join the closing pool, where holders hand in the box\'s token for their part.'],
    alt: 'The raise bar stopped short and has an orange cross. Coins fly from the mess tin into a glass jar marked CLOSING POOL. An orange dog tag goes into the jar, and a gold coin comes out of it.',
  },
]);

/** One scene as an SVG document. */
export function sceneSvg(s) {
  const d = new Doc(S, S, `Link Marines story, scene ${s.n}: ${s.title}`, s.alt);
  d.add(s.draw(d));
  return d.toString();
}
