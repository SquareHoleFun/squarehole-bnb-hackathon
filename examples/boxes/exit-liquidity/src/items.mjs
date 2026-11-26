/**
 * The twelve base sign families on the same hallway wall, 1024 x 1024.
 * Family 08 supplies sign #404's lettering; unique/ adds that id's five other visual traits.
 */
import { Doc } from './doc.mjs';
import { room, brickWall, brickedDoor, tinyDoor, paintedDoor, hatch } from './room.mjs';
import { signs, chain } from './sign.mjs';
import { VARIANT_NAMES } from '../assign.mjs';

export const ITEM_SIZE = 1024;
const CEIL = 120;
const FLOOR = 880;
const MID = 470; // sign centre when nothing stands below it
const HIGH = 318; // sign centre when a door stands below it

/** The X of "EXIT" sits in columns 6 to 10 of the line, so the burnt-out sign dims exactly those cells. */
const xOfExit = ({ c }) => c >= 6 && c <= 10;

const ART = [
  { n: '01', alt: 'A green LED sign reading EXIT? above a door the size of a mouse hole.',
    signs: [{ lines: ['EXIT?'], m: 20, style: 'led', color: 'green', mount: 'bracket', cy: HIGH + 40 }],
    extra: () => tinyDoor({ cx: 512, floorY: FLOOR, w: 78 }) },
  { n: '02', alt: 'A red LED sign reading NOT FOUND on two lines, hanging from the ceiling.',
    signs: [{ lines: ['NOT', 'FOUND'], m: 17, style: 'led', color: 'red', mount: 'rods', cy: MID }] },
  { n: '03', alt: 'A red light-box sign reading NO EXIT on a wall of bricks.',
    back: (d) => brickWall(d, { w: ITEM_SIZE, ceilingY: CEIL, floorY: FLOOR, size: 40 }),
    signs: [{ lines: ['NO EXIT'], m: 15, style: 'box', color: 'red', mount: 'bracket', cy: MID - 20 }] },
  { n: '04', alt: 'An amber LED sign reading EXIT with arrows pointing left and right, hanging from an arm.',
    signs: [{ lines: ['EXIT', '← →'], m: 18, style: 'led', color: 'amber', mount: 'flag', wallX: 0, cy: MID + 10 }] },
  { n: '05', alt: 'A green LED sign reading EXIT with the X burnt out, so it reads E IT, and one red dot flickering.',
    signs: [{ lines: ['EXIT'], m: 24, style: 'led', color: 'green', mount: 'bracket', cy: HIGH + 30, burnt: xOfExit, flicker: [{ c: 8, r: 3 }] }],
    extra: () => paintedDoor({ cx: 512, floorY: FLOOR, w: 230, h: 320 }) },
  { n: '06', alt: 'A mint light-box sign hung the wrong way round, so EXIT reads backwards as TIXE.',
    signs: [{ lines: ['EXIT'], m: 26, style: 'box', color: 'mint', mount: 'rods', cy: MID, mirror: true }] },
  { n: '07', alt: 'A green LED sign reading EXIT with an arrow pointing down at a bolted floor hatch.',
    signs: [{ lines: ['EXIT ↓'], m: 18, style: 'led', color: 'green', mount: 'rods', cy: HIGH + 60 }],
    extra: () => hatch({ cx: 512, cy: FLOOR + 72, w: 300, h: 56 }) },
  { n: '08', alt: 'A green light-box sign reading 404 above a doorway filled with bricks.',
    signs: [{ lines: ['404'], m: 36, style: 'box', color: 'green', mount: 'rods', cy: HIGH, heavy: true }],
    extra: (d) => brickedDoor(d, { cx: 512, floorY: FLOOR, w: 236, h: 330 }) },
  { n: '09', alt: 'A mint LED sign reading EXIT with an arrow pointing up at a bolted ceiling hatch.',
    back: () => hatch({ cx: 512, cy: CEIL / 2, w: 280, h: 74 }),
    signs: [{ lines: ['EXIT ↑'], m: 18, style: 'led', color: 'mint', mount: 'rods', cy: MID + 40 }] },
  { n: '10', alt: 'Two green LED signs pointing at each other: EXIT with an arrow right, and an arrow left with EXIT.',
    signs: [
      { lines: ['EXIT →'], m: 12, style: 'led', color: 'green', mount: 'rods', cx: 268, cy: MID },
      { lines: ['← EXIT'], m: 12, style: 'led', color: 'green', mount: 'rods', cx: 756, cy: MID },
    ] },
  { n: '11', alt: 'A red LED sign reading ERROR, hanging crooked from one chain, its other chain broken.',
    signs: [{ lines: ['ERROR'], m: 18, style: 'led', color: 'red', mount: 'chain', cy: MID - 10, tilt: 9 }],
    extra: (d, box) => chain(box.x + box.w - 0.8 * 18, CEIL, CEIL + 150, 18) },
  { n: '12', alt: 'An amber light-box sign reading TRY AGAIN on two lines, hanging from the ceiling.',
    signs: [{ lines: ['TRY', 'AGAIN'], m: 17, style: 'box', color: 'amber', mount: 'rods', cy: MID }] },
];

if (ART.length !== VARIANT_NAMES.length || ART.some((v, i) => v.n !== String(i + 1).padStart(2, '0'))) {
  throw new Error('src/items.mjs and assign.mjs must list the same variants in the same order');
}

/** The variants with their names from assign.mjs, the single list both files share. */
export const VARIANTS = Object.freeze(ART.map((v, i) => Object.freeze({ ...v, name: VARIANT_NAMES[i] })));

/** One variant as an SVG document. */
export function itemSvg(v) {
  const d = new Doc(ITEM_SIZE, ITEM_SIZE, `Exit Liquidity sign, variant ${v.n}: ${v.name}`, v.alt);
  d.add(room(d, { w: ITEM_SIZE, h: ITEM_SIZE, ceilingY: CEIL, floorY: FLOOR }));
  if (v.back) d.add(v.back(d));
  const drawn = signs(d, v.signs.map((s) => ({ cx: 512, ceilingY: CEIL, ...s })));
  d.add(drawn.markup);
  if (v.extra) d.add(v.extra(d, drawn.boxes[0]));
  return d.toString();
}
