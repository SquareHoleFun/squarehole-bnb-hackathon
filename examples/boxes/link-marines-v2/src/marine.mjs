/**
 * One caricature marine at mess night, head and shoulders, in a bust box 1000 units wide and 1000 tall, face centred on
 * x = 500. A spec names the face, the eyes, the mouth, the extras, the cap and anything held. `marine()` places the
 * bust anywhere at any size, keeping the outline the same width in the picture at every size.
 *
 * Every marine wears the same dress-navy mess jacket: open lapels, a white shirt front with a black bow tie, steel
 * buttons and plain shoulder straps. There are no medals, ribbons, chevrons or badges of any kind.
 */
import { C, MIX } from './palette.mjs';
import { r2, group, place, circlePath, ellipsePath, roundRect } from './doc.mjs';
import { shape, flat, line, halftone, clipped, plaid } from './pen.mjs';
import { geometry, head, ears, neck, cheeks, eyes, brows, nose, mouth, mustache, handlebar, stubble, freckles, braid, spectacles, sideburns } from './face.mjs';
import { HATS } from './gear.mjs';
import { TOOLS, sleeve, fist } from './tools.mjs';

export const BUST = 1000;
const TORSO = 'M70 1000C80 890 130 830 240 798C310 778 375 764 425 752L575 752C625 764 690 778 760 798C870 830 920 890 930 1000Z';
const FRONT = 'M396 772L500 1010L604 772Q500 800 396 772Z';

/** The mess jacket: navy shaded with slate dots, open lapels over a white shirt front, a bow tie, buttons and straps. */
function jacket(doc, ow) {
  const lapelL = 'M396 772L500 1010L452 1010L352 790Z';
  const lapelR = 'M604 772L500 1010L548 1010L648 790Z';
  const strap = (x, turn) => `<g transform="translate(${x} 808) rotate(${turn})">${shape(roundRect(-62, -16, 124, 32, 12), C.navy, ow * 0.8)}${shape(circlePath(-40, 0, 9), C.steel, ow * 0.5)}</g>`;
  const studs = [870, 930].map((y) => flat(circlePath(500, y, 9), C.ink)).join('');
  const buttons = [[430, 960], [570, 960]].map(([x, y]) => shape(circlePath(x, y, 15), C.steel, ow * 0.6) + flat(circlePath(x - 4, y - 4, 4), MIX.steelLight)).join('');
  const bow = 'M500 792L446 768Q436 792 446 818ZM500 792L554 768Q564 792 554 818Z';
  return shape(TORSO, C.navy, ow) + clipped(doc, TORSO, halftone(doc, ellipsePath(880, 960, 280, 240), C.slate, 14))
    + shape(TORSO, 'none', ow)
    + shape(FRONT, C.white, ow * 0.8) + clipped(doc, FRONT, halftone(doc, 'M500 760H640V1010H500Z', MIX.whiteDot, 13)) + studs
    + shape(lapelL, C.navy, ow * 0.8) + shape(lapelR, C.navy, ow * 0.8)
    + line('M396 772L500 1010M604 772L500 1010', C.slate, ow * 0.6)
    + shape('M430 760L472 800L456 812L414 776Z', C.white, ow * 0.6) + shape('M570 760L528 800L544 812L586 776Z', C.white, ow * 0.6)
    + shape(bow, C.ink, ow * 0.6) + shape(roundRect(486, 778, 28, 28, 8), C.ink, ow * 0.5)
    + buttons + strap(250, -16) + strap(750, 16);
}

/** The cook's flannel shirt: the kit's one plaid, with an open collar. */
function flannel(doc, ow) {
  const collar = 'M434 752L500 850L566 752Q500 776 434 752Z';
  return shape(TORSO, plaid(doc), ow) + clipped(doc, TORSO, halftone(doc, ellipsePath(880, 960, 280, 240), C.ink, 14, 2.6)) + shape(TORSO, 'none', ow)
    + shape(collar, C.paper, ow * 0.8) + shape('M426 750L500 852L456 876L370 782Z', C.navy, ow) + shape('M574 750L500 852L544 876L630 782Z', C.navy, ow)
    + [890, 960].map((y) => shape(circlePath(500, y, 12), C.paper, ow * 0.5)).join('');
}

/** The face's features, in drawing order. */
function features(doc, g, spec, ow) {
  const extras = new Set(spec.extras ?? []);
  const out = [extras.has('puff') ? puffed(g) : cheeks(g)];
  if (extras.has('sideburns')) out.push(sideburns(doc, g, ow, spec.hairColor ?? MIX.hair));
  if (spec.eyes) out.push(eyes(g, spec.eyes, ow));
  if (spec.brows !== undefined && spec.brows !== null) out.push(brows(g, spec.brows, spec.browLift ?? 0, { ...(spec.browOpts ?? {}), ow }));
  if (extras.has('stubble')) out.push(stubble(doc, g));
  if (extras.has('freckles')) out.push(freckles(g));
  out.push(mouth(doc, g, spec.mouth, ow, spec.mouthOpts));
  out.push(nose(g, ow, spec.nose));
  if (extras.has('mustache')) out.push(mustache(g, ow, spec.mustacheColor ?? C.ink));
  if (extras.has('handlebar')) out.push(handlebar(g, ow, spec.mustacheColor ?? C.ink));
  if (extras.has('spectacles')) out.push(spectacles(g, ow));
  return out.join('');
}

/** Cheeks puffed full of air: big blush spots with a shine on each. */
function puffed(g) {
  return [-1, 1].map((s) => flat(circlePath(g.cx + s * g.w * 0.33, g.ny + 46, 60), MIX.blush) + flat(ellipsePath(g.cx + s * g.w * 0.33 - 18, g.ny + 26, 16, 11), MIX.glint)).join('');
}

/** A white napkin tucked into the collar, hanging over the chest, with its two tucked corners and a fold. */
function napkin(doc, ow) {
  const d = 'M384 770Q500 800 616 770L560 1000H440Z';
  const corners = [-1, 1].map((s) => shape(`M${500 + s * 70} 778L${500 + s * 150} 742L${500 + s * 132} 796Z`, C.white, ow * 0.8)).join('');
  return shape(d, C.white, ow) + clipped(doc, d, halftone(doc, 'M500 760H640V1010H500Z', MIX.whiteDot, 13))
    + line('M500 800V1000', MIX.whiteShade, ow * 0.8) + line('M414 790Q500 818 586 790', MIX.whiteShade, ow * 0.6) + corners;
}

/** What the marine holds in front: a tool in a fist on a sleeve. `scale` grows the hand and the tool together. */
function holding(doc, spec, ow) {
  const h = spec.hold;
  if (!h) return '';
  const tool = TOOLS[h.tool];
  if (!tool) throw new Error(`no tool called ${h.tool}`);
  const [x, y] = h.at;
  const s = h.scale ?? 1;
  const o = ow / s;
  const hand = tool(x, y, o, h.turn ?? 0) + (h.fist ? fist(...h.fist, o, h.fistTurn ?? 0) : '');
  const grown = s === 1 ? hand : `<g transform="translate(${r2(x)} ${r2(y)}) scale(${s}) translate(${r2(-x)} ${r2(-y)})">${hand}</g>`;
  return (h.sleeve ? sleeve(...h.sleeve, ow, 160, spec.shirt === 'flannel' ? plaid(doc) : C.navy) : '') + grown;
}

/** One marine as markup, its bust box placed with its top-left corner at (x, y) and scaled to `size` px wide. */
export function marine(doc, spec, { x = 0, y = 0, size = BUST, ow = 10 }) {
  const k = size / BUST;
  const local = ow / k;
  const g = geometry(spec.face);
  const hat = HATS[spec.hat](doc, g, local, spec.hatOpts);
  const parts = [
    hat.back,
    neck(doc, g, local),
    spec.shirt === 'flannel' ? flannel(doc, local) : jacket(doc, local),
    spec.wear === 'napkin' ? napkin(doc, local) : '',
    ...(spec.braids ?? []).map((side) => braid(g, local, side, spec.hairColor ?? MIX.hair)),
    ears(g, local, spec.ears ?? 1),
    head(doc, g, local, { brimShade: spec.brimShade ?? false }),
    features(doc, g, spec, local),
    hat.front,
    holding(doc, spec, local),
  ];
  return group(place(x, y, { scale: k }), parts);
}
