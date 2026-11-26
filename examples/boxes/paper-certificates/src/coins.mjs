/**
 * The coins of the story. The gold coin is a gold disc stamped with a small bar of gold. The index coin, the price
 * coin of the later edition, is a steel disc stamped with a basket, because an index is a basket of many companies.
 * SCRIP, the box's own token, is a lilac paper coupon with a violet rosette and torn edges. None of them carries a
 * letter, a number, a face or a real logo.
 */
import { C, MIX } from './palette.mjs';
import { ellipse, group, place, pt, r2 } from './doc.mjs';
import { fill, line, rosette, shape } from './engrave.mjs';

/** The engraved shade of a coin: hatching on its lower right, inside the disc. */
function coinShade(doc, cx, cy, r, color) {
  const id = doc.uid('c');
  doc.def(id, `<clipPath id="${id}"><path d="${ellipse(cx, cy, r)}"/></clipPath>`);
  let d = '';
  for (let t = -r; t <= r; t += Math.max(2.4, r / 9)) d += `M${pt(cx - r, cy + t + r * 0.55)}L${pt(cx + r, cy + t - r * 0.55)}`;
  const mask = `M${pt(cx + r * 0.2, cy - r * 1.2)}A${r2(r * 1.25)} ${r2(r * 1.25)} 0 0 1 ${pt(cx - r * 1.2, cy + r * 0.2)}L${pt(cx + r * 1.4, cy + r * 1.4)}Z`;
  return group(`clip-path="url(#${id})"`, group(doc.clip(mask), `<path d="${d}" fill="none" stroke="${color}" stroke-width="${r2(Math.max(0.8, r / 22))}"/>`));
}

/** A coin of radius `r` at (cx, cy): `kind` 'gold' for the gold coin, 'index' for the index coin. */
export function coin(doc, cx, cy, r, kind = 'gold') {
  const gold = kind === 'gold';
  const [face, deep, light] = gold ? [C.gold, MIX.goldDark, MIX.goldLight] : [C.steel, MIX.steelDark, MIX.steelLight];
  const ow = Math.max(1.4, r * 0.075);
  const stamp = gold
    ? shape(`M${pt(cx - r * 0.3, cy - r * 0.2)}H${r2(cx + r * 0.3)}L${pt(cx + r * 0.46, cy + r * 0.22)}H${r2(cx - r * 0.46)}Z`, light, ow * 0.7, deep)
    : [
      shape(`M${pt(cx - r * 0.44, cy - r * 0.08)}H${r2(cx + r * 0.44)}L${pt(cx + r * 0.32, cy + r * 0.34)}H${r2(cx - r * 0.32)}Z`, light, ow * 0.7, deep),
      line(`M${pt(cx - r * 0.3, cy - r * 0.08)}A${r2(r * 0.3)} ${r2(r * 0.3)} 0 0 1 ${pt(cx + r * 0.3, cy - r * 0.08)}`, deep, ow * 0.7),
      line(`M${pt(cx - r * 0.38, cy + r * 0.07)}H${r2(cx + r * 0.38)}M${pt(cx - r * 0.34, cy + r * 0.2)}H${r2(cx + r * 0.34)}M${pt(cx - r * 0.12, cy - r * 0.08)}V${r2(cy + r * 0.34)}M${pt(cx + r * 0.12, cy - r * 0.08)}V${r2(cy + r * 0.34)}`, deep, ow * 0.45),
    ];
  return [
    shape(ellipse(cx, cy, r), face, ow, C.ink),
    coinShade(doc, cx, cy, r * 0.97, deep),
    line(ellipse(cx, cy, r * 0.8), deep, ow * 0.6),
    line(`M${pt(cx - r * 0.62, cy - r * 0.16)}A${r2(r * 0.64)} ${r2(r * 0.64)} 0 0 1 ${pt(cx - r * 0.16, cy - r * 0.62)}`, light, ow * 0.9),
    stamp,
  ];
}

/** A coin seen edge-on in a heap or a stack: a flat ellipse with its rim. */
export function coinFlat(cx, cy, r, kind = 'gold') {
  const gold = kind === 'gold';
  const [face, deep, light] = gold ? [C.gold, MIX.goldDark, MIX.goldLight] : [C.steel, MIX.steelDark, MIX.steelLight];
  const h = r * 0.34;
  return [
    shape(`M${pt(cx - r, cy)}V${r2(cy + h * 0.5)}A${r2(r)} ${r2(h)} 0 0 0 ${pt(cx + r, cy + h * 0.5)}V${r2(cy)}Z`, deep, Math.max(1, r * 0.08), C.ink),
    shape(ellipse(cx, cy, r, h), face, Math.max(1, r * 0.08), C.ink),
    line(ellipse(cx, cy, r * 0.7, h * 0.7), light, Math.max(0.8, r * 0.05)),
  ];
}

/** The SCRIP coupon, `w` px wide, centred on (cx, cy) and turned by `rotate` degrees. */
export function coupon(cx, cy, w, rotate = 0) {
  const h = w * 0.62;
  const teeth = 5;
  const bite = h / (teeth * 2);
  // Left and right edges torn along their perforation: a row of small bites.
  const edge = (x, dir) => {
    let d = '';
    for (let i = 0; i < teeth; i += 1) {
      const y0 = -h / 2 + (i * h) / teeth;
      d += `L${pt(x, y0 + bite * 0.5)}A${r2(bite * 0.6)} ${r2(bite * 0.6)} 0 0 ${dir > 0 ? 1 : 0} ${pt(x, y0 + bite * 1.7)}L${pt(x, y0 + h / teeth)}`;
    }
    return d;
  };
  const right = edge(w / 2, -1);
  const leftPts = [];
  for (let i = teeth - 1; i >= 0; i -= 1) {
    const y0 = -h / 2 + (i * h) / teeth;
    leftPts.push(`L${pt(-w / 2, y0 + h / teeth - bite * 0.5)}A${r2(bite * 0.6)} ${r2(bite * 0.6)} 0 0 1 ${pt(-w / 2, y0 + h / teeth - bite * 1.7)}L${pt(-w / 2, y0)}`);
  }
  const body = `M${pt(-w / 2, -h / 2)}H${r2(w / 2)}${right}H${r2(-w / 2)}${leftPts.join('')}Z`;
  const ow = Math.max(1.2, w * 0.028);
  return group(place(cx, cy, { rotate }), [
    shape(body, C.lilac, ow, C.ink),
    line(`M${pt(-w * 0.36, -h * 0.34)}H${r2(w * 0.36)}V${r2(h * 0.34)}H${r2(-w * 0.36)}Z`, C.scrip, ow * 0.7),
    rosette(0, 0, { R: 24, rr: 9, dd: 8, size: h * 0.26, color: C.scrip, width: Math.max(0.7, w * 0.012), samples: 60 }),
    fill(ellipse(0, 0, h * 0.06), C.scrip),
  ]);
}
