/**
 * The seven story scenes, 1200 x 1200, on the studio wall with the plank floor at y 1040. Each scene has its title,
 * its caption (at most two short sentences) and its alt text here; storybook.md uses the same words, and check.mjs
 * makes sure it does. Green coins are the frog coin, orange clay tiles are KILN, the crock marked 420 is the box,
 * the pond is the box's own pool, and the kiln burns what goes into it.
 */
import { C, MIX } from './palette.mjs';
import { Doc, r2, smooth } from './doc.mjs';
import { arrow, flat, line, shape } from './pen.mjs';
import { floor, wall } from './studio.mjs';
import { counter, kiln, smoke } from './kiln.mjs';
import { ashFlake, frogCoin, kilnTile } from './coins.mjs';
import { toad } from './toad.mjs';
import { bowl, crate, crock, dish, glassJar, peel, pond, raiseBar, shelf, spark, tag } from './props.mjs';
import { brushed } from './type.mjs';
import { VARIANTS } from './items.mjs';

export const SCENE_PX = 1200;
const FLOOR = 1040;
const OW = 7;

function ground(d, seed) {
  return [wall(SCENE_PX, SCENE_PX, { seed }), floor(SCENE_PX, SCENE_PX, FLOOR, OW)];
}

/** A toad standing with its foot on `foot`, centred on `cx`, `size` px for its 1000-unit box. */
function toadAt(d, v, cx, foot, size, extra = {}) {
  return toad(d, { ...v.spec, ...extra }, { x: cx - size / 2, y: foot - size * 0.905, size, ow: OW * 0.8 });
}

/** A crumpled sheet of the paper a toad was wrapped in. */
function crumple(x, y, w) {
  const d = smooth([[x, y], [x + w * 0.3, y - w * 0.28], [x + w * 0.55, y - w * 0.18], [x + w * 0.8, y - w * 0.34], [x + w, y - w * 0.05], [x + w * 0.62, y + w * 0.04]], 0.7);
  return [shape(d, C.bisque, OW * 0.8), line(`M${r2(x + w * 0.3)} ${r2(y - w * 0.2)}L${r2(x + w * 0.45)} ${r2(y - w * 0.02)}L${r2(x + w * 0.7)} ${r2(y - w * 0.22)}`, MIX.bisqueDark, OW * 0.7)];
}

/** A little flame burning on top of something at (x, y). */
function littleFlame(x, y, s) {
  const outer = smooth([[x - s, y], [x - s * 0.8, y - s * 0.9], [x - s * 0.1, y - s * 1.6], [x + s * 0.1, y - s * 2.4], [x + s * 0.6, y - s * 1.3], [x + s, y]], 0.85);
  const inner = smooth([[x - s * 0.45, y], [x - s * 0.3, y - s * 0.7], [x + s * 0.05, y - s * 1.4], [x + s * 0.4, y - s * 0.6], [x + s * 0.5, y]], 0.85);
  return [shape(outer, C.flame, OW * 0.8), flat(inner, MIX.fireCore)];
}

const SCENES_SPEC = [
  {
    title: 'The box',
    alt: 'A big stoneware crock marked 420 is full of clay toads wrapped in paper. An orange clay tile with an arch on it goes into the crock, and out comes a pale green toad with a crack mended in gold.',
    caption: ['This box holds 420 clay toads, wrapped up until someone draws one with KILN.', 'A few came out of the kiln cracked.'],
    draw(d) {
      return [
        ...ground(d, 'scene-1'),
        crock(d, { x: 110, y: FLOOR - 475, w: 440, ow: OW, seed: 'scene-1' }),
        kilnTile(880, 250, 96, OW, { turn: 12 }),
        arrow([820, 300], [600, 250], [455, 420], { width: 22, ow: OW }),
        arrow([585, 700], [700, 610], [776, 752], { width: 22, ow: OW }),
        crumple(730, FLOOR - 12, 150),
        toadAt(d, VARIANTS[9], 975, FLOOR, 380, { shadow: MIX.woodDark }),
        spark(1150, 640, 22), spark(812, 600, 16),
      ];
    },
  },
  {
    title: 'Fifteen coins',
    alt: 'A big green coin under the words 1% FEE splits into fifteen small green coins. Ten go to a clay bowl, two go to a small pond and three go to a crate marked SQUARE HOLE.',
    caption: ['Every buy and every sale pays a small fee in the frog coin, split into 15 coins.', 'Ten follow the box\'s choice for that side, two go to the box\'s own pool and three go to Square Hole (its platform and its buy-back).'],
    draw(d) {
      const row = [];
      const xs = [...Array.from({ length: 10 }, (_, i) => 128 + i * 60), 790, 850, 968, 1028, 1088];
      xs.forEach((x) => row.push(frogCoin(x, 556, 24, OW * 0.7)));
      return [
        ...ground(d, 'scene-2'),
        tag({ x: 600, y: 64, words: '1% FEE', cap: 50, ow: OW, drop: 34, seed: 'fee' }),
        frogCoin(600, 330, 92, OW),
        arrow([600, 440], [600, 460], [600, 506], { width: 20, ow: OW }),
        brushed('10', { x: 398, y: 438, cap: 52, seed: 'n10' }),
        brushed('2', { x: 820, y: 438, cap: 52, seed: 'n2' }),
        brushed('3', { x: 1028, y: 438, cap: 52, seed: 'n3' }),
        ...row,
        arrow([398, 600], [392, 680], [372, 760], { width: 22, ow: OW }),
        arrow([820, 600], [812, 720], [790, 852], { width: 22, ow: OW }),
        arrow([1028, 600], [1040, 640], [1052, 690], { width: 22, ow: OW }),
        bowl(d, { x: 160, y: 806, w: 410, ow: OW, seed: 'scene-2' }),
        pond(d, { x: 620, y: 880, w: 330, ow: OW }),
        crate({ x: 958, y: 712, w: 196, ow: OW }),
      ];
    },
  },
  {
    title: 'Waiting',
    alt: 'A raise bar is a little more than half full. A cold brick kiln with a dark door stands next to two clay bowls heaped with green coins, one tagged BUYERS and one tagged SELLERS, under a sign that says WAIT.',
    caption: ['While the box fills its raise, the coins wait by the kiln.', 'Nothing is fired yet.'],
    draw(d) {
      return [
        ...ground(d, 'scene-3'),
        raiseBar(d, { x: 150, y: 110, w: 760, h: 64, fill: 0.58, state: 'filling', ow: OW }),
        kiln(d, { x: 660, y: FLOOR - 546, size: 460, state: 'cold', ow: OW }),
        tag({ x: 345, y: 300, words: 'WAIT', cap: 64, ow: OW, drop: 40, seed: 'wait' }),
        tag({ x: 178, y: 590, words: 'BUYERS', cap: 30, ow: OW * 0.8, drop: 26, seed: 'buyers' }),
        tag({ x: 494, y: 590, words: 'SELLERS', cap: 30, ow: OW * 0.8, drop: 26, seed: 'sellers' }),
        bowl(d, { x: 60, y: FLOOR - 108, w: 250, ow: OW, coins: 9, seed: 'b3' }),
        bowl(d, { x: 372, y: FLOOR - 108, w: 250, ow: OW, coins: 9, seed: 's3' }),
      ];
    },
  },
  {
    title: 'Fire the kiln',
    alt: 'The raise bar is full and has a check mark. A long wooden peel slides green coins from the bowl tagged BUYERS into the burning kiln. Smoke and grey ash rise from the chimney, and a plaque on the wall says FIRED over a row of counter wheels.',
    caption: ['After the box graduates, anyone can fire the kiln, and the buyers\' coins are burned for good.', 'The counter shows how many have been fired.'],
    draw(d) {
      return [
        ...ground(d, 'scene-4'),
        raiseBar(d, { x: 110, y: 110, w: 520, h: 64, fill: 1, state: 'full', ow: OW }),
        kiln(d, { x: 590, y: FLOOR - 606, size: 510, state: 'fire', ow: OW }),
        ashFlake(1010, 250, 18, OW * 0.7, { turn: 20 }), ashFlake(1092, 196, 14, OW * 0.7, { turn: -30 }), ashFlake(960, 170, 12, OW * 0.7),
        counter({ x: 150, y: 330, w: 300, ow: OW }),
        tag({ x: 220, y: 680, words: 'BUYERS', cap: 30, ow: OW * 0.8, drop: 26, seed: 'buyers4' }),
        bowl(d, { x: 96, y: FLOOR - 108, w: 250, ow: OW, coins: 2, seed: 'b4' }),
        peel({ x: 812, y: 948, len: 470, angle: 176, ow: OW }),
        frogCoin(780, 930, 26, OW * 0.7, { squash: 0.5 }), frogCoin(836, 926, 26, OW * 0.7, { squash: 0.5 }), frogCoin(808, 912, 26, OW * 0.7, { squash: 0.5 }),
      ];
    },
  },
  {
    title: 'KILN for the toads',
    alt: 'Green coins slide from a clay bowl tagged SELLERS into a small pond. Orange clay tiles come out of the pond and drop, one for each, onto four clay toads on a shelf.',
    caption: ['The sellers\' coins are swapped for KILN in the box\'s own pool.', 'The KILN is shared by all 420 toads, the same part for each.'],
    draw(d) {
      const toads = [VARIANTS[0], VARIANTS[2], VARIANTS[4], VARIANTS[6]];
      const xs = [566, 736, 906, 1076];
      return [
        ...ground(d, 'scene-5'),
        tag({ x: 186, y: 640, words: 'SELLERS', cap: 30, ow: OW * 0.8, drop: 26, seed: 'sellers5' }),
        bowl(d, { x: 60, y: FLOOR - 108, w: 250, ow: OW, coins: 9, seed: 's5' }),
        arrow([292, 884], [330, 846], [378, 902], { width: 20, ow: OW }),
        pond(d, { x: 330, y: 900, w: 330, ow: OW, reeds: false }),
        frogCoin(420, 944, 20, OW * 0.6, { squash: 0.5 }),
        arrow([480, 880], [400, 600], [470, 360], { width: 24, ow: OW }),
        kilnTile(440, 760, 54, OW * 0.8, { turn: -8 }), kilnTile(424, 580, 54, OW * 0.8, { turn: 10 }),
        shelf({ x: 470, y: 700, w: 700, ow: OW }),
        ...toads.map((v, i) => toadAt(d, v, xs[i], 700, 214)),
        ...xs.map((x, i) => [kilnTile(x, 350, 60, OW * 0.8, { turn: (i % 2 ? 1 : -1) * 8 }),
          line(`M${x} 394V492`, MIX.bisqueDark, OW, { dash: `${OW * 1.6} ${OW * 1.6}` })]),
      ];
    },
  },
  {
    title: 'Out or in',
    alt: 'On the left, under a tag that says OUT, a clay toad sits on a shelf next to a dish of orange clay tiles. On the right, under a tag that says IN, wrapped toads wait in the big crock, and the tile meant for them burns up in a little flame.',
    caption: ['A toad out of the box keeps its part for its owner to claim.', 'The part of a toad still inside the box is burned.'],
    draw(d) {
      return [
        ...ground(d, 'scene-6'),
        tag({ x: 300, y: 90, words: 'OUT', cap: 70, ow: OW, drop: 40, seed: 'out' }),
        tag({ x: 880, y: 90, words: 'IN', cap: 70, ow: OW, drop: 40, seed: 'in' }),
        line('M600 120V1000', MIX.bisqueDark, OW * 1.4, { dash: `${OW * 3} ${OW * 3}` }),
        kilnTile(300, 360, 70, OW * 0.8, { turn: -10 }),
        arrow([300, 410], [300, 450], [300, 500], { width: 18, ow: OW }),
        shelf({ x: 60, y: 760, w: 480, ow: OW }),
        toadAt(d, VARIANTS[5], 220, 760, 300),
        dish({ x: 360, y: 724, w: 150, ow: OW }),
        kilnTile(410, 706, 46, OW * 0.7, { turn: -12 }), kilnTile(458, 700, 46, OW * 0.7, { turn: 14 }), kilnTile(434, 670, 46, OW * 0.7, { turn: 4 }),
        crock(d, { x: 700, y: FLOOR - 410, w: 380, ow: OW, seed: 'scene-6' }),
        kilnTile(880, 500, 70, OW * 0.8, { turn: 8 }),
        littleFlame(880, 472, 30),
        ashFlake(944, 404, 14, OW * 0.6, { turn: 30 }), ashFlake(840, 370, 11, OW * 0.6, { turn: -20 }),
        smoke(908, 420, 0.42, OW * 0.6),
      ];
    },
  },
  {
    title: 'If the box fails',
    alt: 'The raise bar stopped short and has a cross. The kiln stays cold. Green coins from the two bowls go into a glass jar tagged CLOSING POOL. An orange clay tile goes in and a green coin comes out.',
    caption: ['If the box fails, nothing is fired.', 'The waiting coins go to the closing pool, where holders hand in KILN for their part.'],
    draw(d) {
      return [
        ...ground(d, 'scene-7'),
        raiseBar(d, { x: 110, y: 110, w: 760, h: 64, fill: 0.62, state: 'failed', ow: OW }),
        kiln(d, { x: 820, y: FLOOR - 404, size: 340, state: 'cold', ow: OW }),
        bowl(d, { x: 40, y: FLOOR - 92, w: 210, ow: OW, coins: 4, seed: 'b7' }),
        bowl(d, { x: 290, y: FLOOR - 92, w: 210, ow: OW, coins: 4, seed: 's7' }),
        arrow([150, 900], [200, 700], [420, 640], { width: 20, ow: OW }),
        arrow([400, 900], [420, 800], [470, 700], { width: 20, ow: OW }),
        tag({ x: 590, y: 300, words: ['CLOSING', 'POOL'], cap: 34, ow: OW * 0.8, drop: 30, seed: 'closing' }),
        glassJar(d, { x: 480, y: 560, w: 230, ow: OW, coins: 6 }),
        kilnTile(820, 470, 64, OW * 0.8, { turn: -10 }),
        arrow([786, 500], [760, 560], [720, 600], { width: 18, ow: OW }),
        arrow([700, 840], [760, 880], [790, 940], { width: 18, ow: OW }),
        frogCoin(800, 980, 30, OW * 0.8),
      ];
    },
  },
];

/** The scenes with their two-digit numbers. */
export const SCENES = Object.freeze(SCENES_SPEC.map((s, i) => Object.freeze({ ...s, n: String(i + 1).padStart(2, '0') })));

/** One scene's picture. */
export function sceneSvg(s) {
  const d = new Doc(SCENE_PX, SCENE_PX, `Frog Kiln story ${s.n}: ${s.title}`, s.alt);
  d.add(s.draw(d));
  return d.toString();
}

