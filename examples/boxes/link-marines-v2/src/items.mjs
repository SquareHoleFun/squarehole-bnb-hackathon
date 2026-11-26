/**
 * The twelve base rank library variants, one illustrative squad, the ranks from Private to General. Each picture is one marine at mess night,
 * 1024 x 1024: head and shoulders behind a table with a white cloth, in front of a panelled wall. Every marine has the
 * same plate with the same one coin on it, its ration, and a place card that names its rank. Rank is only the picture.
 */
import { C, MIX } from './palette.mjs';
import { Doc } from './doc.mjs';
import { ground } from './poster.mjs';
import { marine } from './marine.mjs';
import { ration } from './coins.mjs';
import { cloth, placeCard } from './props.mjs';
import { VARIANT_NAMES } from '../ranks.mjs';

export const ITEM_SIZE = 1024;
const OW = 10;
/** The bust box is drawn 900 px wide, its top 16 px above the picture, so the table hides where the bust ends. */
const BUST = { x: 62, y: -16, size: 900 };
/** The table's top edge, the plate and the place card, the same in every picture. */
export const TABLE_Y = 830;
const PLATE = { cx: 540, cy: 872, w: 280 };
const CARD = { cx: 226, y: 846, w: 300 };

/** The rank on the place card, broken where a name is too long for one line. */
const CARD_LINES = Object.freeze({
  'Staff Sergeant': ['STAFF', 'SERGEANT'], 'Master Sergeant': ['MASTER', 'SERGEANT'], 'Sergeant Major': ['SERGEANT', 'MAJOR'],
});
export const cardLines = (name) => CARD_LINES[name] ?? [name.toUpperCase()];

const ART = [
  { n: '01', wall: 'khaki', spec: { hat: 'peakedCap', hatOpts: { grade: 'enlisted', low: 12 }, eyes: 'dots', mouth: 'grin', mouthOpts: { gap: true }, extras: ['freckles'], ears: 1.15, nose: { rx: 46, ry: 40 }, face: { w: 390, h: 480, jaw: 340, chin: 170 }, hold: { tool: 'spoon', at: [800, 760], turn: 6, sleeve: [930, 1100, 806, 790], fist: [802, 724], fistTurn: 6 } },
    alt: 'A young marine in a white peaked cap a size too big, with freckles and a gap-toothed grin, holds up a spoon at a table with a white cloth. On the table are a plate with one gold coin and a place card that says PRIVATE.' },
  { n: '02', wall: 'crate', spec: { hat: 'peakedCap', hatOpts: { grade: 'enlisted' }, eyes: 'dots', mouth: 'smile', extras: ['spectacles'], nose: { rx: 40, ry: 46 }, face: { w: 370, h: 520, jaw: 320, chin: 170, eyeDrop: 6 }, hold: { tool: 'fork', at: [806, 770], turn: 4, sleeve: [930, 1100, 810, 800], fist: [806, 734], fistTurn: 4 } },
    alt: 'A marine in round spectacles and a white peaked cap smiles neatly and holds up a fork. On the table are a plate with one gold coin and a place card that says SPECIALIST.' },
  { n: '03', wall: 'paper', spec: { hat: 'peakedCap', hatOpts: { grade: 'enlisted' }, eyes: 'happy', mouth: 'smile', braids: [-1, 1], nose: { rx: 44, ry: 40 }, face: { w: 390, h: 490, jaw: 350, chin: 180 }, hold: { tool: 'teacup', at: [800, 760], sleeve: [930, 1100, 806, 790], fist: [802, 730] } },
    alt: 'A marine with two braids and a white peaked cap smiles with closed eyes and holds up a steaming teacup on its saucer. On the table are a plate with one gold coin and a place card that says CORPORAL.' },
  { n: '04', wall: 'khaki', spec: { hat: 'peakedCap', hatOpts: { grade: 'enlisted' }, eyes: 'dots', brows: 16, mouth: 'call', extras: ['mustache', 'stubble'], nose: { rx: 62, ry: 50 }, face: { w: 420, h: 520, jaw: 420, chin: 290, eyeDrop: 14 }, hold: { tool: 'handBell', at: [810, 590], turn: -8, sleeve: [930, 1100, 816, 640], fist: [812, 596], fistTurn: -8 } },
    alt: 'A marine with a square jaw, a big mustache and a white peaked cap calls out to the table and rings a small steel hand bell. On the table are a plate with one gold coin and a place card that says SERGEANT.' },
  { n: '05', wall: 'crate', spec: { hat: 'peakedCap', hatOpts: { grade: 'enlisted' }, eyes: 'wink', mouth: 'grin', braids: [1], hairColor: MIX.hairDark, nose: { rx: 48, ry: 42 }, face: { w: 390, h: 500, jaw: 350, chin: 180 }, hold: { tool: 'saltShaker', at: [806, 770], turn: -10, sleeve: [930, 1100, 812, 800], fist: [806, 736], fistTurn: -10 } },
    alt: 'A marine with one dark braid and a white peaked cap winks and grins, holding a salt shaker. On the table are a plate with one gold coin and a place card that says STAFF SERGEANT.' },
  { n: '06', wall: 'paper', spec: { hat: 'peakedCap', hatOpts: { grade: 'enlisted' }, eyes: 'squint', mouth: 'chew', extras: ['sideburns', 'stubble'], nose: { rx: 58, ry: 48 }, face: { w: 430, h: 510, jaw: 420, chin: 260 }, hold: { tool: 'pepperMill', at: [806, 770], turn: 8, sleeve: [930, 1100, 812, 800], fist: [806, 736], fistTurn: 8 } },
    alt: 'A broad marine with sideburns, stubble and a white peaked cap squints and chews, holding a wooden pepper mill. On the table are a plate with one gold coin and a place card that says MASTER SERGEANT.' },
  { n: '07', wall: 'khaki', spec: { hat: 'peakedCap', hatOpts: { grade: 'enlisted' }, eyes: 'dots', brows: -10, browLift: 8, mouth: 'o', extras: ['handlebar'], nose: { rx: 50, ry: 54 }, face: { w: 380, h: 540, jaw: 330, chin: 200 }, hold: { tool: 'menuCard', at: [804, 790], turn: 6, sleeve: [930, 1100, 810, 820], fist: [804, 756], fistTurn: 6 } },
    alt: 'A marine with a curled mustache and raised brows in a white peaked cap reads a folded menu card. On the table are a plate with one gold coin and a place card that says SERGEANT MAJOR.' },
  { n: '08', wall: 'crate', spec: { hat: 'peakedCap', hatOpts: { grade: 'officer' }, eyes: 'wide', mouth: 'cheer', nose: { rx: 40, ry: 36 }, face: { w: 370, h: 480, jaw: 320, chin: 160 }, hold: { tool: 'waterGlass', at: [810, 740], turn: 6, sleeve: [930, 1100, 816, 770], fist: [810, 712], fistTurn: 6 } },
    alt: 'A young officer with wide eyes and a wider white peaked cap with a khaki cord cheers and raises a glass of water. On the table are a plate with one gold coin and a place card that says LIEUTENANT.' },
  { n: '09', wall: 'paper', spec: { hat: 'peakedCap', hatOpts: { grade: 'officer' }, eyes: 'squint', mouth: 'none', extras: ['puff'], braids: [-1, 1], hairColor: MIX.hairDark, nose: { rx: 46, ry: 40 }, face: { w: 400, h: 500, jaw: 360, chin: 190 }, wear: 'napkin', hold: { tool: 'teapot', at: [800, 790], scale: 0.78, sleeve: [930, 1100, 860, 800], fist: [862, 770] } },
    alt: 'An officer with two dark braids, a napkin tucked into the collar and a white peaked cap with a khaki cord puffs out both cheeks and holds up a steel teapot. On the table are a plate with one gold coin and a place card that says CAPTAIN.' },
  { n: '10', wall: 'khaki', spec: { hat: 'peakedCap', hatOpts: { grade: 'officer' }, eyes: 'sleepy', brows: 0, browOpts: { bushy: true, color: MIX.hairGrey }, mouth: 'smile', extras: ['mustache'], mustacheColor: MIX.hairGrey, nose: { rx: 54, ry: 46 }, face: { w: 400, h: 520, jaw: 360, chin: 220 }, hold: { tool: 'jug', at: [800, 800], scale: 0.7, sleeve: [930, 1100, 870, 810], fist: [880, 750] } },
    alt: 'An older officer with bushy grey brows, a grey mustache and a white peaked cap with a khaki cord smiles sleepily and holds a steel water jug. On the table are a plate with one gold coin and a place card that says MAJOR.' },
  { n: '11', wall: 'crate', spec: { hat: 'peakedCap', hatOpts: { grade: 'officer' }, eyes: 'happy', mouth: 'o', nose: { rx: 50, ry: 44, red: true }, face: { w: 410, h: 500, jaw: 380, chin: 210 }, hold: { tool: 'mug', at: [790, 780], sleeve: [930, 1100, 796, 820], fist: [792, 760] } },
    alt: 'An officer with a red nose and a white peaked cap with a khaki cord blows on a steaming tin mug of cocoa. On the table are a plate with one gold coin and a place card that says COLONEL.' },
  { n: '12', wall: 'paper', spec: { hat: 'peakedCap', hatOpts: { grade: 'general' }, eyes: 'happy', brows: 4, browOpts: { bushy: true, color: C.white }, mouth: 'smile', extras: ['mustache'], mustacheColor: C.white, nose: { rx: 60, ry: 52 }, face: { w: 420, h: 530, jaw: 380, chin: 230 }, wear: 'napkin', hold: { tool: 'spoon', at: [800, 760], turn: -6, sleeve: [930, 1100, 806, 790], fist: [802, 724], fistTurn: -6 } },
    alt: 'The oldest marine, with a big white mustache, white brows, a napkin tucked in and the widest white peaked cap with a khaki edge on its visor, smiles and holds up a spoon. On the table are the same plate with one gold coin and a place card that says GENERAL.' },
];

if (ART.length !== VARIANT_NAMES.length || ART.some((v, i) => v.n !== String(i + 1).padStart(2, '0'))) {
  throw new Error('src/items.mjs and ranks.mjs must list the same variants in the same order');
}

/** The variants with their ranks from ranks.mjs, the single list both files share. */
export const VARIANTS = Object.freeze(ART.map((v, i) => Object.freeze({ ...v, name: VARIANT_NAMES[i] })));

/** One variant as an SVG document. */
export function itemSvg(v) {
  const d = new Doc(ITEM_SIZE, ITEM_SIZE, `Link Marines, version 2, variant ${v.n}: ${v.name}`, v.alt);
  d.add(ground(d, { w: ITEM_SIZE, h: ITEM_SIZE, wall: v.wall, panel: 224, top: 0 }));
  d.add(marine(d, v.spec, { ...BUST, ow: OW }));
  d.add(cloth(d, { x: -20, y: TABLE_Y, w: ITEM_SIZE + 40, h: ITEM_SIZE - TABLE_Y + 20, ow: OW }));
  d.add(ration(d, PLATE.cx, PLATE.cy, PLATE.w, OW));
  d.add(placeCard(d, { ...CARD, lines: cardLines(v.name), ow: OW }));
  return d.toString();
}

