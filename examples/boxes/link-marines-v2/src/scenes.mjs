/**
 * The seven story scenes, 1200 x 1200 each, with their captions and alt text. storybook.md uses exactly these words,
 * and check.mjs makes sure of it. Every scene is the same mess hall at mess night: a panelled wall of ration paper
 * over a wooden floor, and a table with a white cloth.
 */
import { C, MIX } from './palette.mjs';
import { Doc, roundRect } from './doc.mjs';
import { shape } from './pen.mjs';
import { ground } from './poster.mjs';
import { marine } from './marine.mjs';
import { coin, tag, ration, plate, cloche, rationR } from './coins.mjs';
import { floor, cloth, placeCard, tureen, pool, crate, peeker, raiseBar, arrow, sign, bubble, button, pointer, plaque, padlock, noKey, jar } from './props.mjs';
import { lettering } from './type.mjs';
import { VARIANTS, cardLines } from './items.mjs';

export const SCENE_SIZE = 1200;
export const FLOOR_Y = 1040;
const OW = 7;
const S = SCENE_SIZE;

/** Generic rank characters for fee illustrations, drawn from the base art library; no numbered NFT is depicted. */
const SPEC = Object.freeze({
  private: VARIANTS[0].spec,
  corporal: VARIANTS[2].spec,
  lieutenant: VARIANTS[7].spec,
  general: VARIANTS[11].spec,
});
/** The cook who serves the rations: the kit's one flannel shirt, in this one scene. */
const COOK = Object.freeze({
  hat: 'cookCap', shirt: 'flannel', eyes: 'happy', mouth: 'smile', extras: ['freckles'], braids: [-1, 1], hairColor: MIX.hair,
  nose: { rx: 52, ry: 44 }, face: { w: 420, h: 480, jaw: 400, chin: 240 },
  hold: { tool: 'ladle', at: [820, 760], turn: 30, sleeve: [920, 1060, 826, 790], fist: [822, 752], fistTurn: 30 },
});
const seated = (spec) => ({ ...spec, hold: undefined });

/** The mess hall every scene shares: the panelled wall and the floor. */
function hall(d) {
  return ground(d, { w: S, h: FLOOR_Y, wall: 'paper', panel: 200, top: 0 }) + floor(d, { y: FLOOR_Y, w: S, h: S - FLOOR_Y, ow: OW });
}

/** One marine sitting behind the table: the bust's box at (x, y), `size` px wide. */
const seat = (d, spec, x, y, size) => marine(d, spec, { x, y, size, ow: OW });

function scene01(d) {
  const top = 560;
  const parts = [hall(d)];
  for (const [i, x] of [130, 235, 340, 445, 550].entries()) parts.push(peeker(x, top - 56, 112, OW, i % 2 ? 6 : -6));
  parts.push(crate(d, { cx: 340, y: top, w: 560, h: FLOOR_Y - top, ow: OW, words: ['420'], cap: 190, open: true }));
  parts.push(tag(150, 250, 120, OW, -12), tag(290, 210, 120, OW, 8), tag(430, 260, 120, OW, -4));
  parts.push(arrow(300, 330, 330, 440, { bend: 24, color: C.orange, ow: OW }));
  parts.push(seat(d, seated(SPEC.private), 700, 380, 450));
  parts.push(cloth(d, { x: 650, y: 800, w: 530, h: 150, ow: OW, legs: true, to: FLOOR_Y }));
  parts.push(ration(d, 925, 836, 190, OW));
  parts.push(arrow(540, 420, 760, 470, { bend: -110, color: C.gold, ow: OW }));
  return parts;
}

function scene02(d) {
  const parts = [hall(d)];
  parts.push(lettering(d, '1% FEE', { x: 600, y: 70, cap: 70, color: C.ink }));
  parts.push(coin(600, 260, 88, OW));
  parts.push(arrow(520, 330, 290, 520, { bend: -40, color: C.gold, ow: OW }));
  parts.push(arrow(600, 370, 600, 630, { color: C.gold, ow: OW }));
  parts.push(arrow(680, 330, 940, 520, { bend: 40, color: C.gold, ow: OW }));
  // Ten coins go to the rations, two to the pool and three to the Square Hole crate, each group with its count.
  for (let i = 0; i < 10; i += 1) parts.push(coin(184 + (i % 5) * 58, 590 + Math.floor(i / 5) * 58, 26, OW * 0.7));
  parts.push(lettering(d, '10', { x: 64, y: 590, cap: 58, color: C.ink, anchor: 'start' }));
  parts.push(coin(582, 700, 26, OW * 0.7), coin(640, 700, 26, OW * 0.7));
  parts.push(lettering(d, '2', { x: 536, y: 676, cap: 50, color: C.ink, anchor: 'end' }));
  parts.push(coin(882, 590, 26, OW * 0.7), coin(940, 590, 26, OW * 0.7), coin(998, 590, 26, OW * 0.7));
  parts.push(lettering(d, '3', { x: 1046, y: 562, cap: 58, color: C.ink, anchor: 'start' }));
  parts.push(tureen(d, { cx: 236, y: 830, w: 320, ow: OW, label: 'RATIONS' }));
  parts.push(pool(d, { cx: 640, cy: 900, w: 240, ow: OW }));
  parts.push(crate(d, { cx: 960, y: 760, w: 300, h: FLOOR_Y - 760, ow: OW, words: ['SQUARE', 'HOLE'], cap: 56 }));
  return parts;
}

function scene03(d) {
  const parts = [hall(d)];
  parts.push(sign(d, { cx: 760, cy: 200, w: 560, h: 118, lines: 'SAME FOR ALL 420', cap: 50, ow: OW, cords: 100 }));
  parts.push(seat(d, COOK, -40, 250, 520));
  parts.push(cloth(d, { x: 20, y: 760, w: 1160, h: 170, ow: OW, legs: true, to: FLOOR_Y }));
  const xs = [470, 660, 850, 1040];
  for (const x of xs) parts.push(ration(d, x, 800, 170, OW));
  parts.push(placeCard(d, { cx: xs[0], y: 850, w: 170, lines: cardLines(VARIANTS[0].name), ow: OW, cap: 22 }));
  parts.push(placeCard(d, { cx: xs[3], y: 850, w: 170, lines: cardLines(VARIANTS[11].name), ow: OW, cap: 22 }));
  return parts;
}

function scene04(d) {
  const parts = [hall(d)];
  parts.push(seat(d, seated(SPEC.lieutenant), 640, 300, 500));
  parts.push(bubble(d, { cx: 500, cy: 240, w: 470, h: 130, lines: 'NOT SELLING.', cap: 46, ow: OW, tx: 760, ty: 500 }));
  parts.push(cloth(d, { x: 20, y: 780, w: 1160, h: 160, ow: OW, legs: true, to: FLOOR_Y }));
  parts.push(plate(d, 600, 826, 220, OW), coin(600, 826 - rationR(220) * 0.62, rationR(220), OW * 0.85));
  parts.push(cloche(d, 560, 814, 210, OW, 190));
  parts.push(button(d, { cx: 230, cy: 560, w: 280, h: 100, ow: OW }));
  parts.push(pointer(266, 586, 110, OW));
  parts.push(arrow(520, 770, 290, 712, { bend: 50, color: C.gold, ow: OW }), coin(200, 716, 34, OW * 0.8));
  return parts;
}

function scene05(d) {
  const top = 560;
  const parts = [hall(d)];
  for (const [i, x] of [130, 235, 340, 445, 550].entries()) parts.push(peeker(x, top - 56, 112, OW, i % 2 ? 8 : 2));
  parts.push(crate(d, { cx: 340, y: top, w: 560, h: FLOOR_Y - top, ow: OW, words: ['420'], cap: 190, open: true }));
  parts.push(arrow(470, 420, 800, 610, { bend: -120, color: C.gold, ow: OW }));
  parts.push(coin(560, 330, 26, OW * 0.7), coin(640, 350, 26, OW * 0.7), coin(712, 400, 26, OW * 0.7));
  parts.push(pool(d, { cx: 900, cy: 860, w: 460, ow: OW, gauge: true, level: 0.7, rising: true }));
  return parts;
}

function scene06(d) {
  const parts = [hall(d)];
  parts.push(plaque(d, { cx: 600, cy: 330, w: 720, h: 300, lines: ['SAME RATION', 'FOR ALL 420'], cap: 64, ow: OW }));
  parts.push(shape(roundRect(578, 466, 44, 70, 10), MIX.steelDark, OW), padlock(600, 600, 150, OW));
  parts.push(noKey(980, 640, 200, OW));
  parts.push(cloth(d, { x: 20, y: 790, w: 1160, h: 150, ow: OW, legs: true, to: FLOOR_Y }));
  for (const x of [300, 600, 900]) parts.push(ration(d, x, 830, 170, OW));
  return parts;
}

function scene07(d) {
  const parts = [hall(d)];
  parts.push(raiseBar(d, { x: 180, y: 170, w: 760, h: 64, frac: 0.45, ow: OW, mark: 'cross' }));
  parts.push(sign(d, { cx: 300, cy: 380, w: 300, h: 110, lines: '90 DAYS', cap: 52, ow: OW, cords: 300 }));
  parts.push(tureen(d, { cx: 300, y: 760, w: 340, ow: OW, coins: 9, label: 'RATIONS' }));
  parts.push(arrow(420, 600, 780, 600, { bend: -110, color: C.gold, ow: OW }));
  parts.push(coin(540, 500, 24, OW * 0.7), coin(610, 486, 24, OW * 0.7), coin(680, 500, 24, OW * 0.7));
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
    alt: 'A wooden crate marked 420 is full of marines in white caps peeking over its edge. Three orange dog tags go into the crate, and an arrow lifts one marine out to a seat at a table with a white cloth and a plate with one gold coin.',
  },
  {
    n: '02', title: 'Fifteen coins', draw: scene02,
    caption: ['Every buy and every sale pays a small fee in LINK, and the fee splits into 15 coins.', 'Ten go to the marines\' rations, two go to the pool and three go to Square Hole (its platform and its buy-back).'],
    alt: 'A big gold coin under the words 1% FEE splits into fifteen small coins. Ten go to a steel tureen marked RATIONS, two go to a small pool and three go to a crate marked SQUARE HOLE.',
  },
  {
    n: '03', title: 'The same ration', draw: scene03,
    caption: ['The ten coins are shared out equally among all 420 marines.', 'The Private gets the same ration as the General.'],
    alt: 'A smiling cook in a paper cap and a navy-and-cream flannel shirt serves one gold coin with a ladle. Along a table with a white cloth, four plates each hold one gold coin, under a sign that says SAME FOR ALL 420. Place cards say PRIVATE and GENERAL.',
  },
  {
    n: '04', title: 'A marine you own', draw: scene04,
    caption: ['A marine that someone owns keeps its ration under the cloche until its owner claims it in LINK.', 'Only the owner can claim it, and nobody can stop the claim.'],
    alt: 'A marine in a white cap sits at the table and says NOT SELLING. A steel cloche lifts off a plate with one gold coin. A pointer presses a CLAIM button, and an arrow carries the coin to the owner.',
  },
  {
    n: '05', title: 'Still in the box', draw: scene05,
    caption: ['A marine still in the box sends its ration into the box\'s own pool.', 'The pool gets deeper while the marines wait.'],
    alt: 'Marines in white caps peek out of the crate marked 420. Their gold coins fly along an arrow into a sage pool, where the water on a depth post has risen and an arrow points up.',
  },
  {
    n: '06', title: 'Rules that stay', draw: scene06,
    caption: ['Nobody can change these rules once the box is created.', 'No one holds a key, Square Hole included.'],
    alt: 'A steel plaque held by four bolts says SAME RATION FOR ALL 420. Below it hangs a padlock with no keyhole, and beside it a key is crossed out. Three plates with one gold coin each stand on the table.',
  },
  {
    n: '07', title: 'If the box fails', draw: scene07,
    caption: ['If the raise misses its 90 days, the box fails and no rations are served.', 'The rations waiting in the box join the closing pool, where holders hand in the box\'s token for their part.'],
    alt: 'The raise bar stopped short and has an orange cross, next to a sign that says 90 DAYS. Coins fly from the tureen of rations into a glass jar marked CLOSING POOL. An orange dog tag goes into the jar, and a gold coin comes out of it.',
  },
]);

/** One scene as an SVG document. */
export function sceneSvg(s) {
  const d = new Doc(S, S, `Link Marines, version 2, story scene ${s.n}: ${s.title}`, s.alt);
  d.add(s.draw(d));
  return d.toString();
}
