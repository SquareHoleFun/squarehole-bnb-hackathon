/**
 * The twelve toad pictures: nine glazes and three cracked toads. Each is one figurine on a ware board, in front of an
 * arch like the kiln's door. The names come from assign.mjs, in the same order, so the art and the assignment agree.
 */
import { C, MIX } from './palette.mjs';
import { Doc, archPath, group, path, place, r2, rect } from './doc.mjs';
import { flat, line, outline } from './pen.mjs';
import { toad } from './toad.mjs';
import { VARIANT_NAMES, CRACKED } from '../assign.mjs';

export const ITEM_PX = 1024;

/** The glazes, each with its base, shade, light, belly, warts, pattern color and the ink for eyes and mouth. */
export const GLAZE = Object.freeze({
  bisque: { base: C.clay, shade: MIX.clayDark, light: MIX.clayLight, belly: MIX.clayLight, warts: C.bisque, dots: C.bisque },
  celadon: { base: C.celadon, shade: MIX.celadonDark, light: MIX.celadonLight, belly: MIX.celadonLight, warts: MIX.celadonDark, dots: MIX.celadonDark },
  tenmoku: { base: MIX.tenmoku, shade: MIX.doorDark, light: MIX.tenmokuLight, belly: MIX.tenmokuLight, warts: MIX.rust, dots: MIX.rust, ink: C.clay },
  shino: { base: MIX.shino, shade: MIX.shinoShade, light: MIX.glint, belly: MIX.glint, warts: MIX.blush, dots: MIX.blush },
  oxblood: { base: MIX.oxblood, shade: MIX.oxbloodDark, light: MIX.oxbloodLight, belly: MIX.oxbloodLight, warts: MIX.oxbloodDark, dots: MIX.oxbloodDark, ink: MIX.glint },
  ash: { base: MIX.ashGlaze, shade: MIX.ashGlazeDark, light: MIX.ashGlazeLight, belly: MIX.ashGlazeLight, warts: MIX.ashGlazeDark, dots: MIX.ashGlazeDark },
  cobalt: { base: MIX.porcelain, shade: MIX.porcelainShade, light: MIX.glint, belly: MIX.glint, warts: MIX.porcelainShade, dots: MIX.cobalt },
  honey: { base: MIX.honey, shade: MIX.honeyDark, light: MIX.honeyLight, belly: MIX.honeyLight, warts: MIX.honeyDark, dots: MIX.honeyDark },
  speckle: { base: MIX.oatmeal, shade: MIX.oatmealShade, light: MIX.glint, belly: MIX.glint, warts: MIX.oatmealShade, dots: MIX.speckle },
  raku: { base: MIX.raku, shade: MIX.doorDark, light: MIX.rakuLight, belly: MIX.rakuLight, warts: MIX.rakuLight, dots: MIX.rakuLight, ink: C.ember },
});

/** The tints behind the toads: a wall color and the deeper arch in front of it. The cracked toads stand in the kiln. */
const WALLS = Object.freeze({
  celadon: [MIX.tintCeladon, MIX.tintCeladonDeep],
  clay: [MIX.tintClay, MIX.tintClayDeep],
  ash: [MIX.tintAsh, MIX.tintAshDeep],
  kiln: [C.slab, MIX.doorDark],
});

/** The twelve variants, in assign.mjs order. */
const SPECS = [
  { glaze: 'bisque', raw: true, eyes: 'bead', mouth: 'smile', wall: 'celadon', what: 'Bare terracotta with white slip dots, fired with no glaze at all' },
  { glaze: 'celadon', eyes: 'bead', mouth: 'grin', pattern: 'rings', wall: 'clay', what: 'A pale jade glaze with three rings carved around its back' },
  { glaze: 'tenmoku', eyes: 'wide', mouth: 'smile', wall: 'ash', what: 'A glossy black-brown glaze breaking to rust on every wart' },
  { glaze: 'shino', eyes: 'closed', mouth: 'smile', pattern: 'flash', wall: 'celadon', what: 'A creamy glaze with orange blushes where the flame touched it, eyes shut in a happy squint' },
  { glaze: 'oxblood', eyes: 'up', mouth: 'o', wall: 'ash', what: 'A deep red glaze, eyes looking up and mouth open in a little O' },
  { glaze: 'ash', eyes: 'wink', mouth: 'grin', pattern: 'runs', wall: 'clay', what: 'An olive ash glaze that ran in long streaks, winking' },
  { glaze: 'cobalt', eyes: 'closed', mouth: 'o', pattern: 'brush', wall: 'clay', what: 'White glaze with fat cobalt brush spots, eyes shut and mouth open, singing' },
  { glaze: 'honey', eyes: 'sleepy', mouth: 'smile', hat: 'pot', wall: 'celadon', what: 'An amber glaze, sleepy, wearing a tiny clay pot on its head as a hat' },
  { glaze: 'speckle', eyes: 'wide', mouth: 'grin', pattern: 'speckle', wall: 'ash', what: 'An oatmeal glaze full of iron speckles' },
  { glaze: 'celadon', eyes: 'sleepy', mouth: 'smile', crack: 'gold', wall: 'kiln', what: 'A celadon toad that cracked in the kiln, its crack mended with gold' },
  { glaze: 'cobalt', eyes: 'up', mouth: 'grin', crack: 'staples', warts: true, wall: 'kiln', what: 'A white toad that cracked in the kiln, held together with three steel staples' },
  { glaze: 'raku', eyes: 'wide', mouth: 'o', crack: 'ember', wall: 'kiln', what: 'A smoky black toad with a crack that still glows from the fire' },
];

if (SPECS.length !== VARIANT_NAMES.length) throw new Error('src/items.mjs and assign.mjs must list the same variants');

/** Every variant with its two-digit number, name, glaze and look. */
export const VARIANTS = Object.freeze(SPECS.map((s, i) => {
  const n = String(i + 1).padStart(2, '0');
  const name = VARIANT_NAMES[i];
  if (Boolean(s.crack) !== CRACKED.includes(n)) throw new Error(`variant ${n}: the cracked toads in assign.mjs and src/items.mjs disagree`);
  return Object.freeze({ n, name, wall: s.wall, what: s.what, spec: { ...s, name: `toad-${n}`, glaze: GLAZE[s.glaze] } });
}));

/** The ware board a toad sits on: a plank with its top lit and a little grain. Full width, top edge at `top`. */
export function board(w, top, ow, seedShift = 0) {
  const grain = [0.18, 0.47, 0.71].map((f, i) => line(`M${r2(w * f + seedShift)} ${r2(top + 34 + i * 6)}q${r2(w * 0.12)} 10 ${r2(w * 0.22)} 2`, MIX.woodDark, ow * 0.6));
  return [
    rect(0, top, w, 400, `fill="${C.wood}"`),
    rect(0, top, w, 18, `fill="${MIX.woodLight}"`),
    ...grain,
    path(`M0 ${r2(top)}H${r2(w)}`, `fill="none" stroke="${C.soot}" stroke-width="${r2(ow)}"`),
    path(`M0 ${r2(top + 18)}H${r2(w)}`, `fill="none" stroke="${MIX.woodDark}" stroke-width="${r2(ow * 0.5)}"`),
  ];
}

/** The wall and arch behind a toad, with the kiln's glow when the toad stands in the kiln. */
function backdrop(wall) {
  const [tint, deep] = WALLS[wall];
  const out = [rect(0, 0, ITEM_PX, ITEM_PX, `fill="${tint}"`)];
  if (wall === 'kiln') {
    out.push(flat(archPath(512, 900, 820, 780), MIX.brickDark), flat(archPath(512, 900, 700, 690), C.flame),
      flat(archPath(512, 900, 560, 590), C.ember), flat(archPath(512, 900, 400, 470), MIX.fireCore));
  } else {
    out.push(flat(archPath(512, 900, 820, 780), deep), outline(archPath(512, 900, 760, 730), 4, tint));
  }
  return out;
}

/** One variant's picture, 1024 x 1024. */
export function itemSvg(v) {
  const d = new Doc(ITEM_PX, ITEM_PX, `Frog Kiln toad ${v.n}: ${v.name}`, `A clay toad figurine on a wooden ware board. ${v.what}.`);
  d.add(backdrop(v.wall), board(ITEM_PX, 896, 8), group(place(0, 0), toad(d, { ...v.spec, shadow: MIX.woodDark }, { x: 12, y: -6, size: 1000, ow: 11 })));
  return d.toString();
}
