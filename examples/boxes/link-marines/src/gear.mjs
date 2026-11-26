/**
 * Headgear for the marines, in the same bust box as the faces. Every hat sits on the brow line `by` of a face's
 * geometry. A hat returns { back, front }: `back` is drawn before the head, `front` after the face.
 * None copies a real uniform, badge, insignia or unit: no emblems, no ranks, no flags, no real camouflage.
 */
import { C, MIX } from './palette.mjs';
import { r2, circlePath, ellipsePath, roundRect } from './doc.mjs';
import { shape, holed, flat, line, band, halftone, clipped } from './pen.mjs';

const P = (x, y) => `${r2(x)} ${r2(y)}`;

/** The steel helmet's dome and brim. */
function helmetShapes(g, lift = 0) {
  const { cx } = g;
  const by = g.by - lift;
  const hw = g.w / 2 + 64;
  const top = by - 240;
  const dome = `M${P(cx - hw, by)}C${P(cx - hw, by - 172)} ${P(cx - hw * 0.62, top)} ${P(cx, top)}C${P(cx + hw * 0.62, top)} ${P(cx + hw, by - 172)} ${P(cx + hw, by)}Z`;
  const brim = `M${P(cx - hw - 36, by + 6)}Q${P(cx, by - 44)} ${P(cx + hw + 36, by + 6)}L${P(cx + hw + 30, by + 34)}Q${P(cx, by - 8)} ${P(cx - hw - 30, by + 34)}Z`;
  return { dome, brim, hw, top, by };
}

/** Chin straps hanging open down both cheeks, with a buckle at each end. */
function straps(g, hw, ow) {
  return [-1, 1].map((s) => {
    const x1 = g.cx + s * (hw - 26);
    const x2 = g.cx + s * (g.w * 0.43);
    const y2 = g.ny + 92;
    return band(`M${P(x1, g.by + 20)}Q${P(x2 + s * 18, g.by + 120)} ${P(x2, y2)}`, MIX.oliveDeep, 15, ow * 0.7)
      + shape(roundRect(x2 - 15, y2 - 4, 30, 24, 5), C.steel, ow * 0.7);
  }).join('');
}

/** The steel helmet: olive dome, shade on the right, a light streak on the left, and a brim. Options add a band. */
export function helmet(doc, g, ow, { straps: withStraps = true, band: strap = null, net = false, lamp = false } = {}) {
  const { dome, brim, hw, top, by } = helmetShapes(g);
  const shade = halftone(doc, ellipsePath(g.cx + hw * 0.78, by - 70, hw * 0.55, 230), MIX.oliveDot, 14);
  const light = flat(`M${P(g.cx - hw * 0.72, by - 40)}C${P(g.cx - hw * 0.74, by - 150)} ${P(g.cx - hw * 0.42, top + 26)} ${P(g.cx - hw * 0.12, top + 18)}C${P(g.cx - hw * 0.44, top + 50)} ${P(g.cx - hw * 0.6, by - 120)} ${P(g.cx - hw * 0.56, by - 40)}Z`, MIX.oliveLight);
  const parts = [withStraps ? straps(g, hw, ow) : '', shape(dome, C.olive, ow), clipped(doc, dome, shade, light, net ? netting(doc, g, hw, top, by, ow) : '')];
  if (strap) parts.push(clipped(doc, dome, flat(`M${P(g.cx - hw, by - 58)}Q${P(g.cx, by - 92)} ${P(g.cx + hw, by - 58)}V${r2(by - 16)}Q${P(g.cx, by - 50)} ${P(g.cx - hw, by - 16)}Z`, C.khaki)));
  parts.push(shape(dome, 'none', ow), shape(brim, C.olive, ow), line(`M${P(g.cx - hw - 20, by + 12)}Q${P(g.cx, by - 32)} ${P(g.cx + hw + 20, by + 12)}`, MIX.oliveLight, ow * 0.6));
  if (net) parts.push(leaves(g, hw, top, ow));
  if (lamp) parts.push(headlamp(g, by, ow));
  return { back: '', front: parts.join('') };
}

/** A net over the dome: two sets of olive cords, crossing. */
function netting(doc, g, hw, top, by, ow) {
  const cords = [];
  for (let i = -6; i <= 6; i += 1) {
    const x = g.cx + i * 44;
    cords.push(`M${P(x - 140, by + 10)}L${P(x + 140, top - 30)}`, `M${P(x + 140, by + 10)}L${P(x - 140, top - 30)}`);
  }
  return line(cords.join(''), MIX.oliveDeep, ow * 0.55);
}

/** Leaves tucked into the net. */
function leaves(g, hw, top, ow) {
  const leaf = (x, y, turn, s = 1) => `<g transform="translate(${r2(x)} ${r2(y)}) rotate(${r2(turn)}) scale(${s})">`
    + shape('M0 0C18 -26 52 -34 82 -30C64 -6 34 8 0 0Z', MIX.oliveLight, ow * 0.6) + line('M4 -2C28 -14 50 -20 72 -26', MIX.oliveDeep, ow * 0.4) + '</g>';
  return [
    leaf(g.cx - hw * 0.5, top + 40, -120, 1.1), leaf(g.cx + hw * 0.3, top + 20, -60, 1.2), leaf(g.cx + hw * 0.75, top + 110, -20),
    leaf(g.cx - hw * 0.85, top + 120, -160), leaf(g.cx - 10, top + 6, -90, 0.9),
  ].join('');
}

/** A lamp on the helmet's front, with its beam reaching up and to the right. */
function headlamp(g, by, ow) {
  const x = g.cx;
  const y = by - 74;
  const beam = flat(`M${P(x + 30, y - 26)}L${P(x + 380, y - 236)}L${P(x + 420, y - 96)}L${P(x + 34, y + 20)}Z`, MIX.paperShade);
  return beam + shape(roundRect(x - 54, y - 40, 108, 76, 18), C.steel, ow) + shape(circlePath(x, y - 2, 28), MIX.goldLight, ow * 0.8)
    + flat(circlePath(x - 9, y - 11, 8), MIX.white);
}

/** A soft patrol cap with a flat top and a short bill. */
export function patrolCap(doc, g, ow) {
  const { cx, by } = g;
  const hw = g.w / 2 + 34;
  const crown = `M${P(cx - hw, by + 8)}L${P(cx - hw + 26, by - 200)}Q${P(cx, by - 216)} ${P(cx + hw - 26, by - 200)}L${P(cx + hw, by + 8)}Z`;
  const bill = `M${P(cx - hw + 10, by - 6)}Q${P(cx, by - 22)} ${P(cx + hw - 10, by - 6)}Q${P(cx + hw * 0.74, by + 62)} ${P(cx, by + 70)}Q${P(cx - hw * 0.74, by + 62)} ${P(cx - hw + 10, by - 6)}Z`;
  const shade = halftone(doc, `M${P(cx + 30, by - 230)}L${P(cx + hw + 20, by - 230)}V${r2(by + 20)}H${r2(cx + 60)}Z`, MIX.oliveDot, 14);
  return {
    back: '',
    front: shape(crown, C.olive, ow) + clipped(doc, crown, shade, flat(`M${P(cx - hw, by - 190)}H${r2(cx + hw)}V${r2(by - 160)}H${r2(cx - hw)}Z`, MIX.oliveDeep))
      + shape(crown, 'none', ow) + line(`M${P(cx, by - 206)}V${r2(by - 8)}`, MIX.oliveDeep, ow * 0.8)
      + shape(bill, MIX.oliveDeep, ow) + line(`M${P(cx - hw + 40, by + 8)}Q${P(cx, by + 56)} ${P(cx + hw - 40, by + 8)}`, C.olive, ow * 0.6, { dash: '14 12' }),
  };
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

/** A leather flight cap with ear flaps, and goggles pushed up on the forehead. */
export function flightCap(doc, g, ow) {
  const { cx, by } = g;
  const hw = g.w / 2 + 26;
  const cap = `M${P(cx - hw, g.ny + 70)}C${P(cx - hw - 20, by - 30)} ${P(cx - hw, by - 190)} ${P(cx, by - 196)}C${P(cx + hw, by - 190)} ${P(cx + hw + 20, by - 30)} ${P(cx + hw, g.ny + 70)}`
    + `Q${P(cx + hw - 40, g.ny + 96)} ${P(cx + hw - 70, g.ny + 60)}L${P(cx + hw - 64, by + 20)}Q${P(cx, by - 20)} ${P(cx - hw + 64, by + 20)}L${P(cx - hw + 70, g.ny + 60)}Q${P(cx - hw + 40, g.ny + 96)} ${P(cx - hw, g.ny + 70)}Z`;
  const seam = line(`M${P(cx, by - 194)}V${r2(by - 10)}`, MIX.crateDark, ow * 0.7, { dash: '12 10' });
  const strapD = `M${P(cx - hw - 6, by - 50)}Q${P(cx, by - 92)} ${P(cx + hw + 6, by - 50)}`;
  const lens = (x) => shape(circlePath(x, by - 66, 56), C.steel, ow) + shape(circlePath(x, by - 66, 38), C.sage, ow * 0.8)
    + line(`M${P(x - 22, by - 78)}Q${P(x - 16, by - 96)} ${P(x + 2, by - 98)}`, MIX.sageLight, ow);
  return {
    back: '',
    front: shape(cap, C.crate, ow) + clipped(doc, cap, halftone(doc, ellipsePath(cx + hw, by - 40, 120, 260), MIX.crateDark, 13), seam) + shape(cap, 'none', ow)
      + band(strapD, C.ink, 26, 0) + lens(cx - 74) + lens(cx + 74) + shape(roundRect(cx - 22, by - 78, 44, 22, 8), C.steel, ow * 0.7),
  };
}

/** A round diving helmet of steel with a porthole for the face, a collar and bolts. */
export function divingHelmet(doc, g, ow) {
  const { cx } = g;
  const cy = g.ny - 30;
  const hole = { x: cx, y: g.ny + 20, r: 196 };
  const sphere = `${circlePath(cx, cy, 340)}${circlePath(hole.x, hole.y, hole.r)}`;
  const collar = `M${P(cx - 380, 1000)}L${P(cx - 330, 790)}Q${P(cx, 740)} ${P(cx + 330, 790)}L${P(cx + 380, 1000)}Z`;
  const bolts = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * 2 * Math.PI + Math.PI / 8;
    return shape(circlePath(hole.x + (hole.r + 28) * Math.cos(a), hole.y + (hole.r + 28) * Math.sin(a), 12), MIX.steelLight, ow * 0.6);
  }).join('');
  const ring = holed(`${circlePath(hole.x, hole.y, hole.r + 50)}${circlePath(hole.x, hole.y, hole.r)}`, MIX.steelDark, ow);
  const glass = line(`M${P(hole.x - 130, hole.y - 70)}A150 150 0 0 1 ${P(hole.x - 40, hole.y - 160)}`, MIX.white, 18);
  const shade = halftone(doc, ellipsePath(cx + 250, cy + 40, 160, 330), MIX.steelDark, 14);
  return {
    back: '',
    front: shape(collar, C.steel, ow) + holed(sphere, C.steel, ow) + clipped(doc, sphere, shade, flat(ellipsePath(cx - 200, cy - 180, 70, 40), MIX.steelLight))
      + holed(sphere, 'none', ow) + ring + bolts + glass
      + [-1, 1].map((s) => shape(roundRect(cx + s * 250 - 28, 830, 56, 56, 10), MIX.steelDark, ow)).join('')
      + [[cx + 300, cy - 300, 30], [cx + 352, cy - 372, 21], [cx + 318, cy - 430, 14]].map(([x, y, r]) => shape(circlePath(x, y, r), MIX.steelLight, ow * 0.7) + flat(circlePath(x - r * 0.3, y - r * 0.3, r * 0.3), MIX.white)).join(''),
  };
}

/** A winter cap: an olive crown, a fur band and fur ear flaps. */
export function furCap(doc, g, ow) {
  const { cx, by } = g;
  const hw = g.w / 2 + 40;
  const crown = `M${P(cx - hw + 10, by - 40)}C${P(cx - hw, by - 200)} ${P(cx - hw * 0.5, by - 240)} ${P(cx, by - 240)}C${P(cx + hw * 0.5, by - 240)} ${P(cx + hw, by - 200)} ${P(cx + hw - 10, by - 40)}Z`;
  const fluff = (x1, x2, y, deep) => {
    const n = Math.max(3, Math.round((x2 - x1) / 52));
    const step = (x2 - x1) / n;
    let d = `M${P(x1, y)}`;
    for (let i = 0; i < n; i += 1) d += `Q${P(x1 + (i + 0.5) * step, y - 34)} ${P(x1 + (i + 1) * step, y)}`;
    d += `V${r2(y + deep)}`;
    for (let i = n; i > 0; i -= 1) d += `Q${P(x1 + (i - 0.5) * step, y + deep + 30)} ${P(x1 + (i - 1) * step, y + deep)}`;
    return `${d}Z`;
  };
  const flap = (s) => `M${P(cx + s * (hw - 60), by - 10)}Q${P(cx + s * (hw + 30), by + 40)} ${P(cx + s * (hw + 10), by + 220)}Q${P(cx + s * (hw - 20), by + 270)} ${P(cx + s * (hw - 70), by + 230)}Q${P(cx + s * (hw - 90), by + 100)} ${P(cx + s * (hw - 60), by - 10)}Z`;
  return {
    back: '',
    front: [-1, 1].map((s) => shape(flap(s), C.khaki, ow) + clipped(doc, flap(s), halftone(doc, flap(s), MIX.khakiDark, 12, 2.4))).join('')
      + shape(crown, C.olive, ow) + clipped(doc, crown, halftone(doc, ellipsePath(cx + hw, by - 120, 150, 160), MIX.oliveDot, 14))
      + shape(crown, 'none', ow) + shape(fluff(cx - hw - 20, cx + hw + 20, by - 64, 70), C.khaki, ow),
  };
}

/** An officer's peaked cap: a wide crown, a dark band, a shiny visor and a plain round button. */
export function peakedCap(doc, g, ow) {
  const { cx, by } = g;
  const hw = g.w / 2 + 96;
  const crown = `M${P(cx - g.w / 2 - 10, by - 40)}C${P(cx - hw - 40, by - 110)} ${P(cx - hw - 30, by - 230)} ${P(cx, by - 236)}C${P(cx + hw + 30, by - 230)} ${P(cx + hw + 40, by - 110)} ${P(cx + g.w / 2 + 10, by - 40)}Z`;
  const bandD = `M${P(cx - g.w / 2 - 14, by - 64)}Q${P(cx, by - 80)} ${P(cx + g.w / 2 + 14, by - 64)}V${r2(by - 4)}Q${P(cx, by - 20)} ${P(cx - g.w / 2 - 14, by - 4)}Z`;
  const visor = `M${P(cx - g.w / 2 - 8, by - 12)}Q${P(cx, by - 30)} ${P(cx + g.w / 2 + 8, by - 12)}Q${P(cx + g.w * 0.4, by + 60)} ${P(cx, by + 64)}Q${P(cx - g.w * 0.4, by + 60)} ${P(cx - g.w / 2 - 8, by - 12)}Z`;
  return {
    back: '',
    front: shape(crown, C.olive, ow) + clipped(doc, crown, halftone(doc, ellipsePath(cx + hw, by - 140, 220, 140), MIX.oliveDot, 14), flat(ellipsePath(cx - 120, by - 190, 80, 22), MIX.oliveLight))
      + shape(crown, 'none', ow) + shape(bandD, MIX.oliveDeep, ow) + shape(visor, C.ink, ow)
      + line(`M${P(cx - 110, by + 4)}Q${P(cx - 40, by + 30)} ${P(cx + 30, by + 26)}`, MIX.steelLight, ow * 0.9)
      + shape(circlePath(cx, by - 92, 30), C.steel, ow) + flat(circlePath(cx - 9, by - 101, 8), MIX.steelLight),
  };
}

/** A knit beanie with a turned-up cuff. */
export function beanie(doc, g, ow, color = C.orange) {
  const { cx, by } = g;
  const hw = g.w / 2 + 24;
  const dome = `M${P(cx - hw, by - 20)}C${P(cx - hw - 6, by - 200)} ${P(cx - hw * 0.5, by - 250)} ${P(cx, by - 252)}C${P(cx + hw * 0.5, by - 250)} ${P(cx + hw + 6, by - 200)} ${P(cx + hw, by - 20)}Z`;
  const cuff = roundRect(cx - hw - 12, by - 86, 2 * hw + 24, 100, 30);
  const ribs = Array.from({ length: 13 }, (_, i) => `M${P(cx - hw + 4 + i * ((2 * hw - 8) / 12), by - 74)}V${r2(by + 2)}`).join('');
  const knit = Array.from({ length: 7 }, (_, i) => `M${P(cx - hw + 30 + i * ((2 * hw - 60) / 6), by - 90)}Q${P(cx - hw * 0.8 + i * ((2 * hw * 0.8) / 6), by - 180)} ${P(cx - hw * 0.4 + i * ((2 * hw * 0.4) / 6), by - 240)}`).join('');
  return {
    back: '',
    front: shape(dome, color, ow) + clipped(doc, dome, line(knit, MIX.orangeDark, ow * 0.6), halftone(doc, ellipsePath(cx + hw, by - 130, 130, 170), MIX.orangeDark, 13))
      + shape(dome, 'none', ow) + shape(cuff, MIX.orangeDark, ow) + clipped(doc, cuff, line(ribs, C.orange, ow * 0.9)) + shape(cuff, 'none', ow),
  };
}

/** A floppy bush hat with a wide brim and a chin cord. */
export function boonie(doc, g, ow) {
  const { cx, by } = g;
  const hw = g.w / 2 + 30;
  const crown = `M${P(cx - hw, by - 30)}C${P(cx - hw, by - 170)} ${P(cx - hw * 0.6, by - 214)} ${P(cx, by - 214)}C${P(cx + hw * 0.6, by - 214)} ${P(cx + hw, by - 170)} ${P(cx + hw, by - 30)}Z`;
  const brimBack = `M${P(cx - hw - 150, by + 10)}Q${P(cx, by - 130)} ${P(cx + hw + 150, by + 10)}Z`;
  const brim = `M${P(cx - hw - 150, by + 10)}Q${P(cx - hw - 100, by - 50)} ${P(cx - hw, by - 40)}Q${P(cx, by - 70)} ${P(cx + hw, by - 40)}Q${P(cx + hw + 100, by - 50)} ${P(cx + hw + 150, by + 10)}`
    + `Q${P(cx + hw + 60, by + 60)} ${P(cx + hw - 10, by + 40)}Q${P(cx, by + 10)} ${P(cx - hw + 10, by + 40)}Q${P(cx - hw - 60, by + 60)} ${P(cx - hw - 150, by + 10)}Z`;
  const cord = line(`M${P(cx - hw + 20, by + 34)}Q${P(cx - g.w * 0.36, g.chinY + 10)} ${P(cx, g.chinY + 30)}Q${P(cx + g.w * 0.36, g.chinY + 10)} ${P(cx + hw - 20, by + 34)}`, C.ink, ow * 0.7);
  return {
    back: shape(brimBack, MIX.khakiDark, ow),
    front: cord + shape(crown, C.khaki, ow) + clipped(doc, crown, halftone(doc, ellipsePath(cx + hw, by - 110, 130, 160), MIX.khakiDark, 13),
      flat(`M${P(cx - hw, by - 86)}Q${P(cx, by - 116)} ${P(cx + hw, by - 86)}V${r2(by - 50)}Q${P(cx, by - 80)} ${P(cx - hw, by - 50)}Z`, C.olive))
      + shape(crown, 'none', ow) + shape(brim, C.khaki, ow) + line(`M${P(cx - hw - 100, by + 14)}Q${P(cx, by - 26)} ${P(cx + hw + 100, by + 14)}`, MIX.khakiDark, ow * 0.6, { dash: '14 12' }),
  };
}

/** Every hat by name. */
export const HATS = Object.freeze({
  helmet: (doc, g, ow, o) => helmet(doc, g, ow, o),
  patrolCap, cookCap, flightCap, divingHelmet, furCap, peakedCap, beanie, boonie,
});
