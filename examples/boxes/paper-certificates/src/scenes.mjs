/**
 * The seven story scenes: what the fees do, drawn for a ten-year-old. Each scene has its caption (two short sentences
 * at most) and its alt text next to it, so storybook.md can be checked against the pictures. The same scenes are built
 * for both editions; only the price coin changes, so every caption is written once with `${coin}` in it.
 */
import { Doc } from './doc.mjs';
import { coin as drawCoin, coupon } from './coins.mjs';
import { arrow, border, burningCoupon, cashBox, dish, fallingCoins, framed, miniCertificate, raiseBar, room, safe, scale, slotBox, smoke, stove, tag, tray } from './props.mjs';
import { VARIANTS } from './items.mjs';

/** Scenes are square, this many px a side. */
export const SCENE_PX = 1200;
const FLOOR = 1000;

/** A caption or alt text with the edition's price coin filled in. */
const forEdition = (text, e) => text.replaceAll('${coin}', e.coinName).replaceAll('${Coin}', e.coinName[0].toUpperCase() + e.coinName.slice(1));

const DRAW = {
  '01': (d) => [
    safe(d, 440, FLOOR, 440, { open: true, count: 6 }),
    coupon(150, 330, 150, -12),
    arrow([150, 420], [300, 770], 70),
    miniCertificate(d, VARIANTS[9], 880, 330, 400, { rotate: 5 }),
    arrow([660, 720], [860, 520], 60),
  ],
  '02': (d, e) => [
    tag(600, 150, '1% FEE', { cap: 30 }),
    drawCoin(d, 600, 330, 92, e.coin),
    arrow([520, 400], [260, 780], 30),
    arrow([600, 440], [526, 800], -30),
    arrow([680, 400], [930, 640], -40),
    tray(d, 250, FLOOR, 320, { coin: e.coin, heap: 10 }),
    tag(150, 640, '10', { cap: 34 }),
    scale(d, 620, FLOOR, 300, { coin: e.coin, left: 2, right: 0 }),
    tag(620, 1070, 'POOL', { cap: 26, pin: null }),
    tag(720, 640, '2', { cap: 34 }),
    slotBox(d, 970, FLOOR, 200),
    fallingCoins(d, 980, 700, e.coin, 3),
    tag(970, 1070, 'SQUARE HOLE', { cap: 22, pin: null }),
    tag(1080, 560, '3', { cap: 34 }),
  ],
  '03': (d, e) => [
    raiseBar(d, 170, 150, 700, 0.55, { coin: e.coin }),
    tray(d, 280, FLOOR, 330, { coin: e.coin, heap: 9 }),
    tag(280, 760, 'BUYERS', { cap: 28 }),
    tray(d, 700, FLOOR, 330, { coin: e.coin, heap: 9 }),
    tag(700, 760, 'SELLERS', { cap: 28 }),
    stove(d, 1030, FLOOR, 190, { lit: false, pipeTo: 360 }),
    tag(490, 470, 'WAIT', { cap: 36 }),
  ],
  '04': (d, e) => [
    raiseBar(d, 140, 150, 640, 1, { coin: e.coin, state: 'full' }),
    tray(d, 200, FLOOR, 300, { coin: e.coin, heap: 8 }),
    tag(200, 700, 'BUYERS', { cap: 26 }),
    arrow([250, 880], [420, 850], -40),
    scale(d, 580, FLOOR, 320, { coin: e.coin, left: 6, right: 3 }),
    tag(580, 1070, 'POOL', { cap: 26, pin: null }),
    stove(d, 1040, FLOOR, 230, { lit: true, pipeTo: 330 }),
    smoke(1050, 300, 60),
    arrow([700, 800], [985, 850], -170),
    coupon(760, 640, 96, -14),
    coupon(880, 610, 90, 12),
  ],
  '05': (d, e) => [
    tray(d, 190, FLOOR, 270, { coin: e.coin, heap: 8 }),
    tag(190, 700, 'SELLERS', { cap: 26 }),
    arrow([240, 880], [380, 850], -40),
    scale(d, 520, FLOOR, 300, { coin: e.coin, left: 6, right: 4 }),
    tag(520, 1070, 'POOL', { cap: 26, pin: null }),
    arrow([640, 800], [740, 330], 90),
    arrow([640, 800], [740, 590], 40),
    arrow([640, 800], [740, 850], -10),
    miniCertificate(d, VARIANTS[0], 900, 300, 270),
    miniCertificate(d, VARIANTS[5], 900, 560, 270),
    miniCertificate(d, VARIANTS[7], 900, 820, 270),
    coupon(1062, 300, 84, 8),
    coupon(1062, 560, 84, -6),
    coupon(1062, 820, 84, 10),
  ],
  '06': (d) => [
    tag(300, 160, 'OUT', { cap: 34 }),
    framed(d, VARIANTS[5], 300, 470, 340),
    coupon(240, 770, 120, -8),
    coupon(370, 785, 120, 6),
    dish(300, 840, 300),
    tag(900, 160, 'IN', { cap: 34 }),
    safe(d, 830, FLOOR, 320, { open: true, count: 4 }),
    arrow([880, 640], [920, 560], 10, 12),
    burningCoupon(940, 430, 150),
  ],
  '07': (d, e) => [
    raiseBar(d, 140, 150, 640, 0.7, { coin: e.coin, state: 'failed' }),
    tray(d, 190, FLOOR, 260, { coin: e.coin, heap: 8 }),
    tag(190, 720, 'BUYERS', { cap: 26 }),
    tray(d, 1010, FLOOR, 260, { coin: e.coin, heap: 8 }),
    tag(1010, 720, 'SELLERS', { cap: 26 }),
    arrow([280, 860], [440, 880], -30),
    arrow([920, 860], [760, 880], 30),
    cashBox(d, 600, FLOOR, 300, { coin: e.coin }),
    tag(600, 1070, 'CLOSING POOL', { cap: 22, pin: null }),
    coupon(520, 430, 110, -8),
    arrow([530, 500], [550, 660], 20, 12),
    drawCoin(d, 690, 450, 46, e.coin),
    arrow([660, 660], [680, 520], 20, 12),
  ],
};

/** The scenes, in order, with their titles, captions and alt texts as templates over the price coin. */
export const SCENES = Object.freeze([
  {
    n: '01',
    title: 'The box',
    caption: ['This box holds 1,929 joke share certificates, sealed in envelopes until someone draws one with SCRIP.', 'Twelve of them are blue chips.'],
    alt: 'A big iron safe marked 1,929 stands open, full of envelopes sealed with red wax. A lilac SCRIP coupon goes in, and out comes a blue certificate of the Blue Chip Chip Shop with a gold ribbon.',
  },
  {
    n: '02',
    title: 'Fifteen coins',
    caption: ['Every buy and every sale pays a small fee in ${coin}, split into 15 coins.', 'Ten follow the box\'s choice for that side, two go to the box\'s own pool and three go to Square Hole (its platform and its buy-back).'],
    alt: 'A big coin under a tag that says 1% FEE splits three ways. Ten coins go to a wooden tray, two go to the pan of a balance scale tagged POOL, and three go into a collection box tagged SQUARE HOLE.',
  },
  {
    n: '03',
    title: 'Waiting',
    caption: ['While the box fills its raise, the coins wait.', 'Nothing is swapped and nothing is burned yet.'],
    alt: 'A raise bar is a little more than half full. Two wooden trays heaped with coins wait under tags that say BUYERS and SELLERS, next to a cold iron stove and a tag that says WAIT.',
  },
  {
    n: '04',
    title: 'Burn the SCRIP',
    caption: ['After the box graduates, the buyers\' coins are swapped for SCRIP in the box\'s own pool, and that SCRIP is burned.', '${Coin} goes into the pool.'],
    alt: 'The raise bar is full and has a check mark. Coins from the tray tagged BUYERS go into the pan of the scale tagged POOL, and lilac SCRIP coupons fly from the other pan into a burning iron stove with smoke coming out of its pipe.',
  },
  {
    n: '05',
    title: 'SCRIP for the certificates',
    caption: ['The sellers\' coins are swapped for SCRIP too.', 'The SCRIP is shared by all 1,929 certificates, the same part for each.'],
    alt: 'Coins from the tray tagged SELLERS go into the scale tagged POOL. Lilac SCRIP coupons come out and land one each on three certificates hanging on the wall.',
  },
  {
    n: '06',
    title: 'Out or in',
    caption: ['A certificate out of the box keeps its part for its owner to claim.', 'The part of a certificate still inside the box is burned.'],
    alt: 'On the left, under a tag that says OUT, a certificate hangs in a gold frame with two SCRIP coupons waiting in a dish below it. On the right, under a tag that says IN, sealed envelopes wait in the open safe, and the coupon meant for them burns in a small flame.',
  },
  {
    n: '07',
    title: 'If the box fails',
    caption: ['If the box fails, nothing is swapped or burned.', 'The waiting coins go to the closing pool, where holders hand in SCRIP for their part.'],
    alt: 'The raise bar stopped short and has a red cross. Coins from the trays tagged BUYERS and SELLERS go into a tin cash box tagged CLOSING POOL. A SCRIP coupon goes in and a coin comes out.',
  },
].map((s) => Object.freeze({ ...s, draw: DRAW[s.n] })));

/** A scene's caption sentences for an edition. */
export const captionFor = (s, e) => s.caption.map((c) => forEdition(c, e));

/** The picture of one scene for one edition. */
export function sceneSvg(s, e) {
  const d = new Doc(SCENE_PX, SCENE_PX, `${e.name}, scene ${s.n}: ${s.title}`, forEdition(s.alt, e));
  d.add(room(d, SCENE_PX, SCENE_PX, FLOOR), border(SCENE_PX, SCENE_PX), s.draw(d, e));
  return d.toString();
}
