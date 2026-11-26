/**
 * The twelve certificates: nine joke companies and three blue chips. Each variant has its company's name, its ink,
 * its frame, its rosette and its vignette. The names, counts and traits for the collection come from assign.mjs, so
 * the art and the assignment can never disagree.
 */
import { C, MIX } from './palette.mjs';
import { Doc } from './doc.mjs';
import { ITEM_PX, certificate } from './certificate.mjs';
import { VIGNETTES } from './vignettes.mjs';
import { VARIANT_NAMES } from '../assign.mjs';

export { ITEM_PX };

/** The coupons' rosettes: lighter curves of four or five turns, one per variant. */
const COUPON_ROSETTES = [
  { R: 44, rr: 16, dd: 13 }, { R: 33, rr: 12, dd: 11 }, { R: 45, rr: 18, dd: 15 }, { R: 52, rr: 20, dd: 15 },
  { R: 39, rr: 15, dd: 14 }, { R: 44, rr: 16, dd: 17 }, { R: 33, rr: 12, dd: 9 }, { R: 52, rr: 20, dd: 19 },
  { R: 45, rr: 18, dd: 12 }, { R: 44, rr: 16, dd: 15 }, { R: 44, rr: 16, dd: 15 }, { R: 44, rr: 16, dd: 15 },
];

const SPECS = [
  { vignette: 'bags', company: ['BAGHOLDER', '& SONS'], ink: MIX.sepia, deep: MIX.sepiaDeep, tint: MIX.sepiaTint, border: { wave: 24, strands: 4, freq: 0 }, rosette: { R: 50, rr: 18, dd: 16 },
    alt: 'a pile of bags: a tied sack, a strapped suitcase with a carpet bag on top, and a small doctor\'s bag' },
  { vignette: 'exitDoor', company: ['EXIT LIQUIDITY', 'PARTNERS LLP'], cap: [46, 34], ink: MIX.teal, deep: MIX.tealDeep, tint: MIX.tealTint, border: { wave: 30, strands: 3, freq: 3 }, rosette: { R: 52, rr: 20, dd: 22 },
    alt: 'water pouring out of an arched door in a stone wall under a small sign that says EXIT' },
  { vignette: 'candles', company: ['LONG WICK', 'CANDLE WORKS'], ink: MIX.vermilion, deep: MIX.vermilionDeep, tint: MIX.vermilionTint, border: { wave: 20, strands: 4, freq: 0 }, rosette: { R: 49, rr: 15, dd: 18 },
    alt: 'three candles on dishes, two of them with very long, curling wicks' },
  { vignette: 'windmill', company: ['RUMOR MILL', 'FLOUR CO.'], ink: MIX.olive, deep: MIX.oliveDeep, tint: MIX.oliveTint, border: { wave: 26, strands: 2, freq: 3 }, rosette: { R: 45, rr: 16, dd: 12 },
    alt: 'a windmill with four lattice sails on a hill, with two sacks of flour at its foot' },
  { vignette: 'press', company: ['SELL THE NEWS', 'PRINTING CO.'], cap: [46, 34], ink: MIX.slate, deep: MIX.slateDeep, tint: MIX.slateTint, border: { wave: 22, strands: 4, freq: 3 }, rosette: { R: 56, rr: 20, dd: 24 },
    alt: 'an iron hand press with its long bar, and a stack of fresh newspapers beside it' },
  { vignette: 'crab', company: ['SIDEWAYS CRAB', 'SHIPPING CO.'], cap: [46, 34], ink: MIX.crimson, deep: MIX.crimsonDeep, tint: MIX.crimsonTint, border: { wave: 28, strands: 4, freq: 0 }, rosette: { R: 40, rr: 14, dd: 20 },
    alt: 'a big crab walking sideways along the shore, with a sailing ship on the sea behind it' },
  { vignette: 'bananas', company: ['SLIPPAGE', 'BANANA CO.'], ink: MIX.ochre, deep: MIX.ochreDeep, tint: MIX.ochreTint, border: { wave: 24, strands: 3, freq: 0 }, rosette: { R: 54, rr: 21, dd: 16 },
    alt: 'a bunch of bananas on a crate, and a banana peel on the floor with skid marks next to it' },
  { vignette: 'fondue', company: ['DIP BUYERS', 'FONDUE CO.'], ink: MIX.plum, deep: MIX.plumDeep, tint: MIX.plumTint, border: { wave: 26, strands: 4, freq: 2 }, rosette: { R: 48, rr: 17, dd: 14 },
    alt: 'a fondue pot over a small flame, with two long forks dipping bread into it' },
  { vignette: 'telephone', company: ['MARGIN CALL', 'TELEPHONE CO.'], cap: [50, 34], ink: MIX.green, deep: MIX.greenDeep, tint: MIX.greenTint, border: { wave: 22, strands: 3, freq: 2 }, rosette: { R: 44, rr: 18, dd: 20 },
    alt: 'an old candlestick telephone ringing on a desk' },
  { vignette: 'chipShop', company: ['BLUE CHIP', 'CHIP SHOP'], special: true, ink: C.blue, deep: MIX.blueDeep, tint: MIX.blueTint, border: { wave: 24, strands: 4, freq: 3 }, rosette: { R: 60, rr: 22, dd: 21 },
    alt: 'a paper cone full of blue chips, with a salt shaker beside it' },
  { vignette: 'woodChips', company: ['BLUE CHIP', 'WOOD CHIP CO.'], special: true, ink: C.blue, deep: MIX.blueDeep, tint: MIX.blueTint, border: { wave: 24, strands: 4, freq: 3 }, rosette: { R: 60, rr: 22, dd: 21 },
    alt: 'an axe in a tree stump, with blue wood chips flying around it' },
  { vignette: 'paintChips', company: ['BLUE CHIP', 'PAINT CHIP CO.'], special: true, ink: C.blue, deep: MIX.blueDeep, tint: MIX.blueTint, border: { wave: 24, strands: 4, freq: 3 }, rosette: { R: 60, rr: 22, dd: 21 },
    alt: 'a fan of paint chip cards in three blues, a paint tin and a brush' },
];

/** The variants in order, numbered 01 to 12, with their names from assign.mjs. */
export const VARIANTS = Object.freeze(SPECS.map((s, i) => Object.freeze({
  ...s,
  special: Boolean(s.special),
  n: String(i + 1).padStart(2, '0'),
  name: VARIANT_NAMES[i],
  vignette: VIGNETTES[s.vignette],
  tintStyle: { gap: 8, amp: 2.8, period: 56, rows: 8, width: 0.9 },
  coupon: COUPON_ROSETTES[i],
})));

/** The picture of one certificate. `id` prints that item's number; null prints the specimen number. */
export function itemSvg(v, id = null) {
  const series = v.special ? 'one of the twelve blue chips, printed in blue with a gold seal and a gold BLUE CHIP ribbon' : 'printed in one ink with a red wax seal';
  const d = new Doc(ITEM_PX, ITEM_PX, `${v.name} share certificate`,
    `A joke share certificate of ${v.company.join(' ').replace(/ +/g, ' ')}, ${series}. The vignette shows ${v.alt}. Under the name it says THIS CERTIFIES NOTHING, and a sheet of five numbered coupons hangs below a perforation.`);
  d.add(certificate(d, v, id));
  return d.toString();
}
