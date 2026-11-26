/**
 * The twelve marine variants, one squad. Each picture is one marine, head and shoulders, on a tiled mess hall wall,
 * 1024 x 1024.
 * Every marine has something to do with coins: biting one, shouting with one on the tongue, a ladle full of them.
 */
import { Doc } from './doc.mjs';
import { ground } from './poster.mjs';
import { marine } from './marine.mjs';
import { VARIANT_NAMES } from '../assign.mjs';

export const ITEM_SIZE = 1024;
const OW = 10;
/** The bust box is drawn 1000 px wide, its top 40 px down, so the shoulders run off the bottom edge. */
const BUST = { x: 12, y: 40, size: 1000 };

const ART = [
  { n: '01', wall: 'olive', spec: { nose: { rx: 44, ry: 40 }, hat: 'helmet', eyes: 'hidden', brimShade: true, mouth: 'chomp', mouthOpts: { bite: -48 }, ears: 1.15, face: { jaw: 330, chin: 150 } },
    alt: 'A marine in a steel helmet pulled down over the eyes, biting a gold coin, in front of an olive tile wall.' },
  { n: '02', wall: 'orange', spec: { nose: { rx: 62, ry: 50 }, hat: 'patrolCap', eyes: 'dots', brows: 16, mouth: 'shout', extras: ['mustache', 'stubble'], face: { w: 420, h: 520, jaw: 420, chin: 290, eyeDrop: 14 } },
    alt: 'A marine sergeant with a square jaw and a big mustache, shouting with a gold coin on the tongue, in front of an orange tile wall.' },
  { n: '03', wall: 'khaki', spec: { nose: { rx: 56, ry: 46 }, hat: 'cookCap', eyes: 'happy', mouth: 'smile', face: { w: 430, h: 480, jaw: 410, chin: 230 }, hold: { tool: 'ladle', at: [790, 990], turn: -6, sleeve: [930, 1100, 800, 930], fist: [792, 900], fistTurn: -6 } },
    alt: 'A round-faced marine cook in a tall paper cap, smiling, holding up a ladle full of gold coins, in front of a khaki tile wall.' },
  { n: '04', wall: 'olive', spec: { nose: { rx: 46, ry: 40 }, hat: 'helmet', hatOpts: { band: true }, eyes: 'squint', mouth: 'none', extras: ['puff'], face: { w: 370, h: 520, jaw: 290, chin: 120 }, hold: { tool: 'bugle', at: [506, 604] } },
    alt: 'A marine bugler in a helmet with a khaki band, cheeks puffed, playing a steel bugle with a gold coin flying out of its bell, in front of an olive tile wall.' },
  { n: '05', wall: 'orange', spec: { nose: { rx: 50, ry: 44 }, hat: 'flightCap', eyes: 'dots', mouth: 'chomp', mouthOpts: { wide: 118 }, braids: [1], face: { w: 400, h: 500, jaw: 360, chin: 190 } },
    alt: 'A marine pilot with a braid, a leather flight cap and goggles pushed up, grinning with a gold coin in the teeth, in front of an orange tile wall.' },
  { n: '06', wall: 'khaki', spec: { nose: { rx: 44, ry: 38 }, hat: 'divingHelmet', eyes: 'wide', mouth: 'chomp', ears: 0, face: { w: 380, h: 480, jaw: 330, chin: 160 } },
    alt: 'A marine diver in a round steel diving helmet, wide-eyed behind the porthole, biting a gold coin, in front of a khaki tile wall.' },
  { n: '07', wall: 'olive', spec: { nose: { rx: 54, ry: 46 }, hat: 'helmet', hatOpts: { net: true }, eyes: 'squint', brows: 8, mouth: 'chomp', mouthOpts: { bite: 228 }, extras: ['paint'], face: { w: 410, h: 520, jaw: 390, chin: 240 } },
    alt: 'A jungle marine with leaves in the helmet net and stripes of face paint, chomping a bitten gold coin, in front of an olive tile wall.' },
  { n: '08', wall: 'orange', spec: { hat: 'furCap', eyes: 'sleepy', mouth: 'o', nose: { red: true }, face: { w: 390, h: 480, jaw: 330, chin: 170 }, hold: { tool: 'cup', at: [736, 900] } },
    alt: 'An arctic marine in a fur cap with ear flaps and a red nose, blowing on a steaming tin cup with a gold coin in it, in front of an orange tile wall.' },
  { n: '09', wall: 'khaki', spec: { nose: { rx: 40, ry: 54 }, hat: 'peakedCap', eyes: 'dots', brows: -8, mouth: 'smile', wear: 'napkin', face: { w: 380, h: 540, jaw: 340, chin: 220, eyeDrop: 34 }, hold: { tool: 'fork', at: [262, 960], scale: 1.35, sleeve: [110, 1110, 262, 950], fist: [262, 930] } },
    alt: 'A marine officer in a peaked cap with a napkin tucked into the collar, smiling politely, holding up a fork with a gold coin on it, in front of a khaki tile wall.' },
  { n: '10', wall: 'olive', spec: { nose: { rx: 50, ry: 44 }, hat: 'beanie', eyes: 'wink', mouth: 'chomp', mouthOpts: { gap: true, bite: -58 }, extras: ['smudge', 'freckles'], braids: [-1, 1], face: { w: 410, h: 490, jaw: 370, chin: 170 }, hold: { tool: 'wrench', at: [790, 1010], turn: 10, sleeve: [930, 1110, 800, 960], fist: [792, 940], fistTurn: 10 } },
    alt: 'A marine mechanic with two braids, an orange knit beanie and an oil smudge, winking and biting a gold coin, a wrench in hand, in front of an olive tile wall.' },
  { n: '11', wall: 'orange', spec: { nose: { rx: 48, ry: 42 }, hat: 'boonie', eyes: 'wink', mouth: 'o', face: { w: 390, h: 500, jaw: 350, chin: 180 }, wear: 'glasses', hold: { tool: 'spoon', at: [807, 930], turn: -40, scale: 1.15, sleeve: [990, 1110, 822, 900], fist: [807, 869], fistTurn: -40 } },
    alt: 'A marine scout in a floppy bush hat with field glasses on the chest, mouth wide open for a spoon with a gold coin on it, in front of an orange tile wall.' },
  { n: '12', wall: 'night', spec: { nose: { rx: 52, ry: 44 }, hat: 'helmet', hatOpts: { lamp: true }, eyes: 'sleepy', brimShade: true, mouth: 'chomp', face: { w: 400, h: 500, jaw: 350, chin: 170 } },
    alt: 'A sleepy marine on night watch with a lamp on the helmet, a gold coin in the teeth for a midnight snack, in front of a dark tile wall.' },
];

if (ART.length !== VARIANT_NAMES.length || ART.some((v, i) => v.n !== String(i + 1).padStart(2, '0'))) {
  throw new Error('src/items.mjs and assign.mjs must list the same variants in the same order');
}

/** The variants with their names from assign.mjs, the single list both files share. */
export const VARIANTS = Object.freeze(ART.map((v, i) => Object.freeze({ ...v, name: VARIANT_NAMES[i] })));

/** One variant as an SVG document. */
export function itemSvg(v) {
  const d = new Doc(ITEM_SIZE, ITEM_SIZE, `Link Marines, variant ${v.n}: ${v.name}`, v.alt);
  d.add(ground(d, { w: ITEM_SIZE, h: ITEM_SIZE, wall: v.wall, tile: 128, top: 64 }));
  d.add(marine(d, v.spec, { ...BUST, ow: OW }));
  return d.toString();
}
