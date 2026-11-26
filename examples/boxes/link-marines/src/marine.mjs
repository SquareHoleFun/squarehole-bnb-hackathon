/**
 * One caricature marine, head and shoulders, in a bust box 1000 units wide and 1000 tall, face centred on x = 500.
 * A spec names the face, the eyes, the mouth, the extras, the hat and anything held. `marine()` places the bust
 * anywhere at any size, keeping the outline the same width in the picture at every size.
 */
import { C, MIX } from './palette.mjs';
import { r2, group, place, circlePath, ellipsePath, roundRect } from './doc.mjs';
import { shape, flat, line, halftone, clipped } from './pen.mjs';
import { geometry, head, ears, neck, cheeks, eyes, brows, nose, mouth, mustache, stubble, paint, freckles, smudge, braid } from './face.mjs';
import { HATS } from './gear.mjs';
import { TOOLS, sleeve, fist, glasses } from './tools.mjs';

export const BUST = 1000;
const TORSO = 'M70 1000C80 890 130 830 240 798C310 778 375 764 425 752L575 752C625 764 690 778 760 798C870 830 920 890 930 1000Z';

/** The shirt: olive, shaded right, with an open collar over a khaki undershirt, two pocket flaps and shoulder straps. */
function torso(doc, ow, shirt = C.olive) {
  const flapL = 'M426 750L500 862L456 882L370 786Z';
  const flapR = 'M574 750L500 862L544 882L630 786Z';
  const pocket = (x) => shape(roundRect(x, 902, 140, 44, 10), MIX.oliveDeep, ow * 0.8) + shape(circlePath(x + 70, 930, 10), C.khaki, ow * 0.6)
    + line(`M${x + 6} 958V1000M${x + 134} 958V1000`, MIX.oliveDeep, ow * 0.6, { dash: '12 10' });
  const strap = (x, turn) => `<g transform="translate(${x} 806) rotate(${turn})">${shape(roundRect(-62, -16, 124, 32, 12), MIX.oliveDeep, ow * 0.8)}</g>`;
  return shape(TORSO, shirt, ow) + clipped(doc, TORSO, halftone(doc, ellipsePath(880, 960, 280, 240), MIX.oliveDot, 14))
    + shape(TORSO, 'none', ow) + shape('M434 750L500 858L566 750Q500 776 434 750Z', C.khaki, ow * 0.8)
    + shape(flapL, shirt, ow) + shape(flapR, shirt, ow) + pocket(262) + pocket(598) + strap(250, -16) + strap(750, 16);
}

/** The face's features, in drawing order. */
function features(doc, g, spec, ow) {
  const extras = new Set(spec.extras ?? []);
  const out = [extras.has('puff') ? puffed(g) : cheeks(g)];
  if (spec.eyes) out.push(eyes(g, spec.eyes, ow));
  if (spec.brows !== undefined && spec.brows !== null) out.push(brows(g, spec.brows, spec.browLift ?? 0));
  if (extras.has('stubble')) out.push(stubble(doc, g));
  if (extras.has('paint')) out.push(paint(g, ow));
  if (extras.has('freckles')) out.push(freckles(g));
  if (extras.has('smudge')) out.push(smudge(doc, g));
  out.push(mouth(doc, g, spec.mouth, ow, spec.mouthOpts));
  out.push(nose(g, ow, spec.nose));
  if (extras.has('mustache')) out.push(mustache(g, ow));
  return out.join('');
}

/** Cheeks puffed full of air: big blush spots with a shine on each. */
function puffed(g) {
  return [-1, 1].map((s) => flat(circlePath(g.cx + s * g.w * 0.33, g.ny + 46, 60), MIX.blush) + flat(ellipsePath(g.cx + s * g.w * 0.33 - 18, g.ny + 26, 16, 11), MIX.white)).join('');
}

/** A paper napkin tucked into the collar, hanging over the chest, with its two tucked corners and a fold. */
function napkin(doc, ow) {
  const d = 'M384 770Q500 800 616 770L560 1000H440Z';
  const ears2 = [-1, 1].map((s) => shape(`M${500 + s * 70} 778L${500 + s * 150} 742L${500 + s * 132} 796Z`, C.paper, ow * 0.8)).join('');
  return shape(d, C.paper, ow) + clipped(doc, d, halftone(doc, 'M500 760H640V1010H500Z', MIX.paperDot, 13))
    + line('M500 800V1000', MIX.paperShade, ow * 0.8) + line('M414 790Q500 818 586 790', MIX.paperShade, ow * 0.6) + ears2;
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
  const hand = tool(x, y, o, h.turn ?? 0, h.empty ?? false) + (h.fist ? fist(...h.fist, o, h.fistTurn ?? 0) : '');
  const grown = s === 1 ? hand : `<g transform="translate(${r2(x)} ${r2(y)}) scale(${s}) translate(${r2(-x)} ${r2(-y)})">${hand}</g>`;
  return (h.sleeve ? sleeve(...h.sleeve, ow) : '') + grown;
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
    torso(doc, local, spec.shirt),
    spec.wear === 'napkin' ? napkin(doc, local) : '',
    ...(spec.braids ?? []).map((side) => braid(g, local, side)),
    ears(g, local, spec.ears ?? 1),
    head(doc, g, local, { brimShade: spec.brimShade ?? false }),
    features(doc, g, spec, local),
    hat.front,
    spec.wear === 'glasses' ? glasses(doc, 500, 905, local) : '',
    holding(doc, spec, local),
  ];
  return group(place(x, y, { scale: k }), parts);
}
