/**
 * The storybook: seven square scenes, 1200 x 1200, that show what the fees do. Every scene is one room seen
 * through the heat camera, with the heat scale on the right. Captions and alt text live here and in
 * storybook.md; check.mjs makes sure the two agree.
 */
import { C } from './palette.mjs';
import { Doc, rect } from './doc.mjs';
import { contours, ember } from './heat.mjs';
import { label, stockCoin, coinRow, chip, bits, tank, jar, burner, arrow, brace, crystal, hud, reticle, room, plate, TICKER, NAME_LABEL } from './props.mjs';
import { emptyGpu, slot, cardLength, CARD_H } from './gpu.mjs';

export const SCENE_SIZE = 1200;
const FLOOR = 1060;

function stage(s) {
  const d = new Doc(SCENE_SIZE, SCENE_SIZE, `GPU Poor story, scene ${s.n}: ${s.title}`, s.alt);
  d.add(room(d, { w: SCENE_SIZE, h: SCENE_SIZE, floorY: FLOOR }));
  return d;
}

const frame = (d, level) => hud(d, { w: SCENE_SIZE, h: SCENE_SIZE, inset: 30, len: 56, weight: 6, level, scaleH: 460 });

/**
 * A name under a small coin or chip, the way the fee loop names its coins: $NVDA in ice, VRAM in orange. (cx, y) is
 * the middle of the top of the letters.
 */
const nameUnder = (word, cx, y, color) => label(word, { x: cx, y, size: NAME_LABEL, color });

/** The empty GPU on the wall: a dashed outline over an empty slot. */
function missingGpu(cx, y, u, fans = 2) {
  const L = cardLength(fans) * u;
  const x = cx - L / 2;
  return emptyGpu({ x, y, u, fans }) + slot({ x: x + 6, y: y + (CARD_H + 1.4) * u, len: L - 12, u });
}

function scene01(d) {
  d.add(missingGpu(560, 130, 18));
  d.add(tank(d, { x: 330, y: 560, w: 460, h: 480, level: 0.6, rows: 3 }));
  d.add(label('POOL', { x: 560, y: 610, size: 44, color: C.violet }));
  d.add(stockCoin(150, 610, 50), nameUnder(TICKER, 150, 680, C.ice));
  d.add(arrow({ x1: 160, y1: 745, x2: 310, y2: 830, bend: 50, color: C.ice, width: 12, head: 36 }));
  d.add(arrow({ x1: 810, y1: 830, x2: 960, y2: 745, bend: 50, color: C.orange, width: 12, head: 36 }));
  d.add(chip({ cx: 975, cy: 610, w: 120, heat: 2 }), nameUnder('VRAM', 975, 680, C.orange));
}

/** Fifteen coins split 10, 2 and 3, centred, with a gap between the groups. */
function coinGroups(cy, r, step, gap) {
  const groups = [10, 2, 3];
  const total = 14 * step + 2 * gap;
  let x = (1110 - total) / 2;
  return groups.map((count) => {
    const xs = Array.from({ length: count }, (_, i) => x + i * step);
    x = xs.at(-1) + step + gap;
    return { markup: xs.map((cx) => stockCoin(cx, cy, r)).join(''), x1: xs[0] - r, x2: xs.at(-1) + r };
  });
}

function scene02(d) {
  d.add(label('1% FEE', { x: 555, y: 120, size: 60, color: C.ice }));
  d.add(stockCoin(555, 300, 82));
  d.add(arrow({ x1: 555, y1: 400, x2: 555, y2: 470, color: C.ice, width: 10, head: 30 }));
  const [a, b, c] = coinGroups(530, 25, 55, 58);
  d.add(a.markup, b.markup, c.markup);
  const groups = [[a, C.magenta, '10'], [b, C.violet, '2'], [c, C.white, '3']];
  for (const [g, color, n] of groups) {
    d.add(brace({ x1: g.x1, x2: g.x2, y: 576, color }));
    d.add(label(n, { x: (g.x1 + g.x2) / 2, y: 640, size: 50, color }));
  }
  const mid = (g) => (g.x1 + g.x2) / 2;
  d.add(arrow({ x1: mid(a), y1: 712, x2: mid(a), y2: 770, color: C.magenta, width: 10, head: 28 }));
  d.add(arrow({ x1: mid(b), y1: 712, x2: mid(b), y2: 790, color: C.violet, width: 10, head: 28 }));
  d.add(arrow({ x1: mid(c), y1: 712, x2: mid(c), y2: 790, color: C.white, width: 10, head: 28 }));
  d.add(burner(d, { cx: mid(a), bottom: 975, w: 130, flameH: 150 }));
  d.add(label('BURN', { x: mid(a), y: 995, size: 34, color: C.magenta }));
  d.add(tank(d, { x: mid(b) - 66, y: 815, w: 132, h: 150, level: 0.62, rows: 1 }));
  d.add(label('POOL', { x: mid(b), y: 995, size: 34, color: C.violet }));
  d.add(plate({ cx: mid(c), cy: 890, text: ['SQUARE', 'HOLE'], size: 26 }));
}

function scene03(d) {
  d.add(label('SELL A STOCK', { x: 555, y: 110, size: 54, color: C.white }));
  d.add(coinRow(230, 300, 5, 30, 14), coinRow(230, 370, 5, 30, 14));
  d.add(arrow({ x1: 300, y1: 430, x2: 440, y2: 600, bend: 60, color: C.ice, width: 12, head: 36 }));
  d.add(tank(d, { x: 420, y: 560, w: 420, h: 480, level: 0.62, rows: 3 }));
  d.add(label('POOL', { x: 630, y: 610, size: 44, color: C.violet }));
  d.add(arrow({ x1: 860, y1: 640, x2: 960, y2: 470, bend: 50, color: C.orange, width: 12, head: 36 }));
  d.add(chip({ cx: 930, cy: 300, w: 110, heat: 2, angle: -10 }), chip({ cx: 1010, cy: 390, w: 110, heat: 3, angle: 8 }), chip({ cx: 880, cy: 400, w: 96, heat: 2, angle: 4 }));
}

function scene04(d) {
  d.add(label('BURN', { x: 555, y: 110, size: 60, color: C.magenta }));
  d.add(contours(555, 760, { r0: 240, step: 52, count: 4, opacity: 0.2 }));
  d.add(burner(d, { cx: 555, bottom: 1010, w: 340, flameH: 420 }));
  d.add(chip({ cx: 300, cy: 290, w: 110, heat: 2, angle: -22 }), chip({ cx: 420, cy: 400, w: 96, heat: 3, angle: 14 }), chip({ cx: 520, cy: 520, w: 84, heat: 4, angle: -8 }));
  d.add(arrow({ x1: 250, y1: 380, x2: 420, y2: 640, bend: 40, color: C.orange, width: 8, head: 26, dash: '4 18', opacity: 0.85 }));
  d.add(bits(700, 520, 220, 8));
  d.add(reticle(555, 840, 62));
}

function scene05(d) {
  d.add(label('↑ BUY', { x: 290, y: 130, size: 46, color: C.ice }));
  d.add(stockCoin(190, 300, 52), nameUnder(TICKER, 190, 372, C.ice), arrow({ x1: 255, y1: 300, x2: 335, y2: 300, color: C.ice, width: 10, head: 28 }), chip({ cx: 410, cy: 300, w: 110, heat: 2 }));
  d.add(label('↓ SELL', { x: 820, y: 130, size: 46, color: C.magenta }));
  d.add(chip({ cx: 720, cy: 300, w: 110, heat: 2 }), arrow({ x1: 790, y1: 300, x2: 870, y2: 300, color: C.magenta, width: 10, head: 28 }), stockCoin(935, 300, 52), nameUnder(TICKER, 935, 372, C.ice));
  d.add(arrow({ x1: 300, y1: 352, x2: 300, y2: 425, color: C.ice, width: 6, head: 18, dash: '3 12', opacity: 0.8 }));
  d.add(arrow({ x1: 820, y1: 352, x2: 820, y2: 425, color: C.ice, width: 6, head: 18, dash: '3 12', opacity: 0.8 }));
  d.add(stockCoin(300, 470, 30), label('1%', { x: 300, y: 515, size: 28, color: C.ice }));
  d.add(stockCoin(820, 470, 30), label('1%', { x: 820, y: 515, size: 28, color: C.ice }));
  d.add(arrow({ x1: 310, y1: 580, x2: 510, y2: 760, bend: 30, color: C.ice, width: 10, head: 30 }));
  d.add(arrow({ x1: 810, y1: 580, x2: 610, y2: 760, bend: -30, color: C.ice, width: 10, head: 30 }));
  d.add(contours(560, 880, { r0: 170, step: 46, count: 3, opacity: 0.18 }));
  d.add(burner(d, { cx: 560, bottom: 1030, w: 240, flameH: 260 }));
}

function scene06(d) {
  d.add(label('RAISE', { x: 260, y: 230, size: 40, color: C.ice }));
  d.add(rect(110, 300, 300, 44, `rx="22" fill="none" stroke="${C.ice}" stroke-width="6"`), rect(122, 312, 276, 20, `rx="10" fill="${C.ice}"`));
  d.add(`<path d="M432 322L450 340L484 300" fill="none" stroke="${C.white}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>`);
  d.add(jar({ cx: 260, bottom: 1030, w: 300, h: 420, coins: 9, lid: false }));
  const steps = [[470, 560], [580, 640], [690, 720], [800, 800]];
  d.add(arrow({ x1: 330, y1: 590, x2: 432, y2: 562, bend: -24, color: C.ice, width: 6, head: 18, opacity: 0.8 }));
  steps.forEach(([x, y], i) => {
    d.add(stockCoin(x, y, 26));
    if (i < steps.length - 1) d.add(arrow({ x1: x + 30, y1: y + 14, x2: steps[i + 1][0] - 30, y2: steps[i + 1][1] - 14, color: C.ice, width: 6, head: 18, opacity: 0.8 }));
  });
  d.add(burner(d, { cx: 920, bottom: 1030, w: 220, flameH: 250 }));
}

function scene07(d) {
  d.add(missingGpu(560, 130, 15));
  d.add(jar({ cx: 250, bottom: 1030, w: 280, h: 380, coins: 0 }));
  d.add(tank(d, { x: 470, y: 690, w: 260, h: 340, level: 0.6, rows: 2, chipHeat: 0 }));
  d.add(burner(d, { cx: 920, bottom: 1030, w: 200, lit: false }), ember(920, 975, 150));
  for (const [x, y, r] of [[170, 470, 18], [950, 560, 22], [800, 450, 14], [380, 560, 12], [1010, 760, 16]]) d.add(crystal(x, y, r));
}

export const SCENES = Object.freeze([
  { n: '01', title: 'No GPU', draw: scene01, heat: 0.5,
    alt: 'The dashed outline of a missing GPU hangs over an empty slot. Below it, a glass pool tank holds ice-blue $NVDA coins and VRAM chips. One arrow takes a coin labeled $NVDA in, another brings a chip labeled VRAM out.',
    caption: ["GPU Poor can't afford a GPU, so all it has is a token called VRAM.", "You trade VRAM for $NVDA, Nvidia's stock, in the box's own pool."] },
  { n: '02', title: 'Fifteen parts', draw: scene02, heat: 0.6,
    alt: 'A 1% fee coin marked $NVDA splits into fifteen small coins. Ten go to a fire marked BURN, two go to the pool and three go to a plate marked SQUARE HOLE.',
    caption: ['Every trade pays a small fee in $NVDA, and the fee splits into 15 parts.', 'Ten go to the burn, two go to the pool and three go to Square Hole (its platform and its buy-back).'] },
  { n: '03', title: 'Sell a stock', draw: scene03, heat: 0.7,
    alt: 'Under the words SELL A STOCK, ten ice-blue $NVDA coins go into the glass pool tank. VRAM chips come out of the other side of the tank.',
    caption: ['The box sells the ten fee parts in its own pool.', 'It gets VRAM back, and the $NVDA goes into the pool.'] },
  { n: '04', title: 'Burn the VRAM', draw: scene04, heat: 0.95,
    alt: 'Under the word BURN, VRAM chips drop into a big fire on a small grate and break into bits. A ring marks the hottest point of the fire.',
    caption: ['That VRAM goes into the fire and is gone for good.', 'After every burn there is less VRAM than before.'] },
  { n: '05', title: 'Both sides', draw: scene05, heat: 0.85,
    alt: 'On the left, a buy turns a coin labeled $NVDA into a VRAM chip. On the right, a sale turns a VRAM chip into a coin labeled $NVDA. Each drops a 1% fee coin, and both arrows lead to one fire.',
    caption: ['Buyers and sellers both pay the fee.', 'Both sides feed the same fire.'] },
  { n: '06', title: 'Small steps', draw: scene06, heat: 0.6,
    alt: 'A full raise bar with a check mark. Below it, an open jar full of ice-blue $NVDA coins. Single coins leave the jar one step at a time and lead to a fire.',
    caption: ['While the box fills its raise, the ten fee parts wait in a jar.', 'Once it graduates, they go to the fire in small steps.'] },
  { n: '07', title: 'A cold night', draw: scene07, heat: 0.04,
    alt: 'The same room, cold and dark. The fire is out and only an ember is left on the grate. The jar is empty, ice crystals float in the air, the heat scale points to cold, and the missing GPU is still missing.',
    caption: ['Fees only come from trades.', 'No trades, no fire, and the room stays cold.'] },
]);

export function sceneSvg(s) {
  const d = stage(s);
  s.draw(d);
  d.add(frame(d, s.heat));
  return d.toString();
}
