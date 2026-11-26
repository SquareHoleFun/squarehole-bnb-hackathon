/**
 * Headgear, in the same bust box as the faces. Every hat sits on the brow line `by` of a face's geometry and returns
 * { back, front }: `back` is drawn before the head, `front` after the face.
 *
 * Every marine wears the same white peaked cap with a dress-navy band, a black visor and a plain gold coin as its
 * badge. Officers' caps are a little wider and carry a khaki cord; the General's visor has a khaki edge. No cap copies
 * a real service's cover: no emblem, no insignia, no rank badge, no braid on the visor, no flag. The cook wears a
 * pleated paper cap.
 */
import { C, MIX } from './palette.mjs';
import { r2, ellipsePath, roundRect } from './doc.mjs';
import { shape, flat, line, band, halftone, clipped } from './pen.mjs';
import { coin } from './coins.mjs';

const P = (x, y) => `${r2(x)} ${r2(y)}`;

/** How wide each kind of cap sits over the head, in bust units on each side. */
const SPREAD = Object.freeze({ enlisted: 92, officer: 128, general: 150 });

/**
 * The white peaked cap. `grade` is 'enlisted', 'officer' or 'general'. `low` pulls the cap down over the brows by
 * that many units, as on a cap a size too big.
 */
export function peakedCap(doc, g, ow, { grade = 'enlisted', low = 0 } = {}) {
  const spread = SPREAD[grade];
  if (spread === undefined) throw new Error(`no cap grade ${grade}`);
  const { cx } = g;
  const by = g.by + low;
  const hw = g.w / 2 + spread;
  const top = by - 256;
  const half = g.w / 2;
  const crown = `M${P(cx - half - 6, by - 60)}C${P(cx - hw - 34, by - 110)} ${P(cx - hw - 26, top + 6)} ${P(cx, top)}`
    + `C${P(cx + hw + 26, top + 6)} ${P(cx + hw + 34, by - 110)} ${P(cx + half + 6, by - 60)}Z`;
  const lid = ellipsePath(cx, top + 34, hw * 0.92, 36);
  const bandD = `M${P(cx - half - 16, by - 100)}Q${P(cx, by - 118)} ${P(cx + half + 16, by - 100)}V${r2(by - 34)}Q${P(cx, by - 50)} ${P(cx - half - 16, by - 34)}Z`;
  const visor = `M${P(cx - half - 12, by - 40)}Q${P(cx, by - 58)} ${P(cx + half + 12, by - 40)}Q${P(cx + g.w * 0.42, by + 8)} ${P(cx, by + 12)}Q${P(cx - g.w * 0.42, by + 8)} ${P(cx - half - 12, by - 40)}Z`;
  const parts = [
    shape(crown, C.white, ow),
    clipped(doc, crown, flat(lid, MIX.whiteShade), halftone(doc, ellipsePath(cx + hw * 0.95, by - 140, hw * 0.5, 150), MIX.whiteDot, 13),
      flat(ellipsePath(cx - hw * 0.45, by - 170, hw * 0.24, 20), MIX.glint)),
    shape(crown, 'none', ow),
    shape(bandD, C.navy, ow),
    clipped(doc, bandD, halftone(doc, `M${P(cx + g.w * 0.2, by - 130)}H${r2(cx + hw)}V${r2(by - 20)}H${r2(cx + g.w * 0.2)}Z`, C.slate, 12, 2.6)),
    line(`M${P(cx - half - 6, by - 90)}Q${P(cx, by - 106)} ${P(cx + half + 6, by - 90)}`, C.slate, ow * 0.7),
  ];
  if (grade !== 'enlisted') {
    parts.push(band(`M${P(cx - half - 2, by - 58)}Q${P(cx, by - 74)} ${P(cx + half + 2, by - 58)}`, C.khaki, 12, ow * 0.6));
  }
  parts.push(shape(visor, C.ink, ow));
  if (grade === 'general') parts.push(line(`M${P(cx - half + 4, by - 30)}Q${P(cx - g.w * 0.4, by + 2)} ${P(cx, by + 4)}Q${P(cx + g.w * 0.4, by + 2)} ${P(cx + half - 4, by - 30)}`, C.khaki, ow * 0.9));
  parts.push(line(`M${P(cx - 110, by - 24)}Q${P(cx - 40, by - 6)} ${P(cx + 30, by - 10)}`, MIX.steelLight, ow * 0.9));
  parts.push(coin(cx, by - 136, 34, ow * 0.8));
  return { back: '', front: parts.join('') };
}

/** A tall cook's cap of folded paper, with pleats. */
export function cookCap(doc, g, ow) {
  const { cx, by } = g;
  const hw = g.w / 2 + 20;
  const puff = `M${P(cx - hw, by - 40)}C${P(cx - hw - 70, by - 160)} ${P(cx - hw - 20, by - 330)} ${P(cx - 110, by - 320)}C${P(cx - 90, by - 400)} ${P(cx + 90, by - 400)} ${P(cx + 110, by - 320)}`
    + `C${P(cx + hw + 20, by - 330)} ${P(cx + hw + 70, by - 160)} ${P(cx + hw, by - 40)}Z`;
  const bandD = roundRect(cx - hw - 4, by - 70, 2 * hw + 8, 92, 18);
  const pleats = [-2, -1, 0, 1, 2].map((i) => `M${P(cx + i * 66, by - 60)}Q${P(cx + i * 80, by - 200)} ${P(cx + i * 60, by - 320)}`).join('');
  return {
    back: '',
    front: shape(puff, C.paper, ow) + clipped(doc, puff, line(pleats, MIX.paperDot, ow * 0.8), halftone(doc, ellipsePath(cx + hw, by - 170, 110, 200), MIX.paperDot, 13))
      + shape(puff, 'none', ow) + shape(bandD, MIX.paperShade, ow) + line(`M${P(cx - hw + 10, by - 24)}H${r2(cx + hw - 10)}`, MIX.paperDot, ow * 0.6, { dash: '18 12' }),
  };
}

/** Every hat by name. */
export const HATS = Object.freeze({ peakedCap, cookCap });
