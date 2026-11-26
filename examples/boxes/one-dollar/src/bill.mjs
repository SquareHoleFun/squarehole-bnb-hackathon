/**
 * The dollar: a cartoon one-dollar bill drawn for this kit. One side only, in green ink on pale green paper: an ornate
 * border of two crossing waves, a round medallion of fine lines with a big salon 1 in it, and the word ONE in a frame
 * on each side. It copies no real note: no portrait, no seal, no serial number, no signature, and no words but ONE
 * and 1 (brand-book.md, homage and IP). Everything is measured from the bill's width w.
 *
 * The bill can be cut into equal upright strips, counted from the left: `yours` rings strips in ivory, `gone` leaves
 * them out, and `billStrips()` draws strips that were taken on their own.
 */
import { C, MIX } from './palette.mjs';
import { lettering } from './type.mjs';
import { r2, pt, rect, ellipse, path, group, vgrad, clip, roundRect, blur } from './doc.mjs';

/** Width over height. A cartoon bill: a little stockier than a real note. */
export const BILL_RATIO = 2.2;
/** Below this width the bill drops its fine lines and side words, which would only blur. */
const FINE = 200;

/** The bill's box from its middle and width. */
export const billBox = (cx, cy, w) => {
  const h = w / BILL_RATIO;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
};

/** A thin line in proportion to a bill w wide. */
const hair = (w, k = 0.0035) => r2(Math.max(0.8, w * k));

/** Two waves that cross along one side of the border, from (x0, y0) to (x1, y1), `amp` from the centreline. */
function waves(x0, y0, x1, y1, amp, wavelength) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const halves = Math.max(2, Math.round(len / (wavelength / 2)));
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  const steps = halves * 8;
  const one = (sign) => {
    const pts = [];
    for (let i = 0; i <= steps; i += 1) {
      const u = i / steps;
      const off = sign * amp * Math.sin(Math.PI * halves * u);
      pts.push(pt(x0 + ux * len * u - uy * off, y0 + uy * len * u + ux * off));
    }
    return `M${pts.join('L')}`;
  };
  return one(1) + one(-1);
}

/** Three interleaved twelve-petal curves inside an oval: the medallion's fine lines. */
function lace(cx, cy, rx, ry) {
  const curves = [];
  for (let j = 0; j < 3; j += 1) {
    const phase = (j * Math.PI) / 18;
    const pts = [];
    for (let i = 0; i <= 240; i += 1) {
      const a = (i / 240) * 2 * Math.PI;
      const k = 0.8 + 0.2 * Math.cos(12 * a + phase);
      pts.push(pt(cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k));
    }
    curves.push(`M${pts.join('L')}Z`);
  }
  return curves.join('');
}

/** A small framed panel with ONE in it, centred on (cx, cy). `quiet` draws without recording the words. */
function cartouche(cx, cy, w, quiet) {
  const pw = w * 0.17;
  const ph = w * 0.11;
  const size = w * 0.046;
  return path(roundRect(cx - pw / 2, cy - ph / 2, pw, ph, ph * 0.28), `fill="${MIX.billLight}" fill-opacity="0.7" stroke="${C.deepGreen}" stroke-width="${hair(w, 0.004)}"`)
    + path(roundRect(cx - pw / 2 + w * 0.008, cy - ph / 2 + w * 0.008, pw - w * 0.016, ph - w * 0.016, ph * 0.2), `fill="none" stroke="${MIX.billLine}" stroke-width="${hair(w, 0.0025)}"`)
    + lettering('ONE', { x: cx, y: cy - size / 2, size, color: C.deepGreen, weight: 1.2, hair: 0.3, measure: quiet }).markup;
}

/** The face of the bill: paper, border, medallion, the big 1 and the side panels. */
function face(d, { x, y, w, h }, quiet) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const fine = w >= FINE;
  const paper = vgrad(d, 'bill-paper', [[0, MIX.billLight, 0.8], [0.45, MIX.billLight, 0], [0.7, MIX.billShade, 0], [1, MIX.billShade, 0.7]]);
  const parts = [
    path(roundRect(x, y, w, h, w * 0.018), `fill="${MIX.billPaper}"`),
    path(roundRect(x, y, w, h, w * 0.018), `fill="${paper}"`),
  ];
  // The border: an outer rule, a band of crossing waves and an inner rule, with a small block at each corner.
  const e1 = w * 0.028;
  const e2 = w * 0.07;
  const band = e2 - e1;
  parts.push(rect(x + e1, y + e1, w - 2 * e1, h - 2 * e1, `fill="none" stroke="${C.deepGreen}" stroke-width="${hair(w, 0.006)}"`));
  parts.push(path(`M${pt(x + e1, y + e1)}H${r2(x + w - e1)}V${r2(y + h - e1)}H${r2(x + e1)}Z M${pt(x + e2, y + e2)}V${r2(y + h - e2)}H${r2(x + w - e2)}V${r2(y + e2)}Z`,
    `fill="${MIX.billShade}" fill-opacity="0.75" fill-rule="evenodd"`));
  if (fine) {
    const m = (e1 + e2) / 2;
    const amp = band * 0.32;
    const wl = w * 0.055;
    const d0 = waves(x + m, y + m, x + w - m, y + m, amp, wl) + waves(x + m, y + h - m, x + w - m, y + h - m, amp, wl)
      + waves(x + m, y + m, x + m, y + h - m, amp, wl) + waves(x + w - m, y + m, x + w - m, y + h - m, amp, wl);
    parts.push(path(d0, `fill="none" stroke="${C.deepGreen}" stroke-opacity="0.8" stroke-width="${hair(w, 0.003)}" stroke-linejoin="round"`));
  }
  parts.push(rect(x + e2, y + e2, w - 2 * e2, h - 2 * e2, `fill="none" stroke="${C.deepGreen}" stroke-width="${hair(w, 0.004)}"`));
  const blocks = [[x + e1, y + e1], [x + w - e2, y + e1], [x + e1, y + h - e2], [x + w - e2, y + h - e2]]
    .map(([bx, by]) => rect(bx, by, band, band, `fill="${MIX.billLight}" stroke="${C.deepGreen}" stroke-width="${hair(w, 0.004)}"`)
      + path(`M${pt(bx + band / 2, by + band * 0.18)}L${pt(bx + band * 0.82, by + band / 2)}L${pt(bx + band / 2, by + band * 0.82)}L${pt(bx + band * 0.18, by + band / 2)}Z`, `fill="${C.deepGreen}"`))
    .join('');
  parts.push(blocks);
  // Fine level lines across the inner field, like an engraving.
  if (fine) {
    const lines = [];
    for (let ly = y + e2 + w * 0.012; ly < y + h - e2 - w * 0.006; ly += w * 0.012) lines.push(`M${pt(x + e2 + w * 0.006, ly)}H${r2(x + w - e2 - w * 0.006)}`);
    parts.push(path(lines.join(''), `fill="none" stroke="${MIX.billLine}" stroke-opacity="0.22" stroke-width="${hair(w, 0.0018)}"`));
  }
  // The medallion: a round field of fine lines with the big 1 in it.
  const rx = w * 0.15;
  const ry = Math.min(h / 2 - e2 - w * 0.012, w * 0.15);
  parts.push(ellipse(cx, cy, rx, ry, `fill="${MIX.billLight}" stroke="${C.deepGreen}" stroke-width="${hair(w, 0.006)}"`));
  if (fine) parts.push(path(lace(cx, cy, rx * 0.92, ry * 0.92), `fill="none" stroke="${MIX.billLine}" stroke-opacity="0.75" stroke-width="${hair(w, 0.0022)}"`));
  parts.push(ellipse(cx, cy, rx * 0.9, ry * 0.9, `fill="none" stroke="${C.deepGreen}" stroke-opacity="0.6" stroke-width="${hair(w, 0.0025)}"`));
  const size = ry * 1.36;
  parts.push(lettering('1', { x: cx + w * 0.004, y: cy - size / 2, size, weight: 1.35, hair: 0.28, color: C.deepGreen,
    layers: [[MIX.billLight, Math.max(1.5, w * 0.012)], [null, 0]], measure: quiet }).markup);
  if (fine) {
    parts.push(cartouche(cx - w * 0.31, cy, w, quiet), cartouche(cx + w * 0.31, cy, w, quiet));
  }
  parts.push(path(roundRect(x, y, w, h, w * 0.018), `fill="none" stroke="${C.ink}" stroke-width="${hair(w, 0.006)}" stroke-linejoin="round"`));
  return parts.join('');
}

/** The rectangles of strips [from, to) of a bill cut into n, with `pad` more above and below. */
const stripRect = (b, n, i, pad = 0) => [b.x + (i * b.w) / n, b.y - pad, b.w / n, b.h + 2 * pad];

/**
 * The bill, its middle on (cx, cy) and `w` wide. `strips` cuts it into that many equal upright strips with ink seams,
 * `yours` rings strips in ivory and `gone` leaves strips out. `shadow` drops a soft shadow down and to the right.
 */
export function bill(d, { cx, cy, w, strips = 0, yours = [], gone = [], shadow = true, quiet = false }) {
  const b = billBox(cx, cy, w);
  const out = [];
  if (shadow) {
    const keep = strips && gone.length ? Array.from({ length: strips }, (_, i) => i).filter((i) => !gone.includes(i)) : null;
    const shade = path(roundRect(b.x + w * 0.012, b.y + w * 0.018, w, b.h, w * 0.018), `fill="${C.ink}" fill-opacity="0.35" filter="${blur(d, Math.max(2, w * 0.01))}"`);
    out.push(keep ? group(`clip-path="${clip(d, keep.map((i) => { const [sx, sy, sw, sh] = stripRect(b, strips, i, w * 0.05); return `M${pt(sx + w * 0.012, sy)}h${r2(sw)}v${r2(sh)}h${r2(-sw)}Z`; }).join(''))}"`, shade) : shade);
  }
  const body = face(d, b, quiet);
  const seams = strips ? Array.from({ length: strips - 1 }, (_, i) => {
    const sx = b.x + ((i + 1) * w) / strips;
    return `M${pt(sx, b.y)}V${r2(b.y + b.h)}`;
  }).join('') : '';
  const seamMarkup = seams ? path(seams, `stroke="${C.ink}" stroke-opacity="0.8" stroke-width="${hair(w, 0.004)}"`) : '';
  if (strips && gone.length) {
    const keep = Array.from({ length: strips }, (_, i) => i).filter((i) => !gone.includes(i));
    const cut = clip(d, keep.map((i) => { const [sx, sy, sw, sh] = stripRect(b, strips, i, w * 0.02); return `M${pt(sx, sy)}h${r2(sw)}v${r2(sh)}h${r2(-sw)}Z`; }).join(''));
    out.push(group(`clip-path="${cut}"`, body, seamMarkup));
    // An ink edge where a strip was cut away.
    const edges = keep.filter((i) => gone.includes(i - 1) || gone.includes(i + 1)).flatMap((i) => [
      gone.includes(i - 1) ? b.x + (i * w) / strips : null,
      gone.includes(i + 1) ? b.x + ((i + 1) * w) / strips : null,
    ]).filter((v) => v !== null);
    if (edges.length) out.push(path(edges.map((ex) => `M${pt(ex, b.y)}V${r2(b.y + b.h)}`).join(''), `stroke="${C.ink}" stroke-width="${hair(w, 0.006)}"`));
  } else {
    out.push(body, seamMarkup);
  }
  for (const i of yours) {
    const [sx, sy, sw, sh] = stripRect(b, strips, i);
    out.push(rect(sx, sy, sw, sh, `fill="${C.ivory}" fill-opacity="0.32" stroke="${C.ivory}" stroke-width="${r2(Math.max(2, w * 0.007))}" stroke-linejoin="round"`));
  }
  return out.join('');
}

/** A dashed line where strips of the bill are gone: along the top and the bottom, and on the outer side at an end. */
export function stripOutline(cx, cy, w, strips, gone) {
  const b = billBox(cx, cy, w);
  const segs = gone.map((i) => {
    const x0 = b.x + (i * w) / strips;
    const x1 = b.x + ((i + 1) * w) / strips;
    let s = `M${pt(x0, b.y)}H${r2(x1)}M${pt(x0, b.y + b.h)}H${r2(x1)}`;
    if (i === 0) s += `M${pt(x0, b.y)}V${r2(b.y + b.h)}`;
    if (i === strips - 1) s += `M${pt(x1, b.y)}V${r2(b.y + b.h)}`;
    return s;
  }).join('');
  return path(segs, `fill="none" stroke="${C.green}" stroke-opacity="0.8" stroke-width="${r2(Math.max(2, w * 0.006))}" stroke-dasharray="${r2(w * 0.016)} ${r2(w * 0.012)}" stroke-linecap="round"`);
}

/**
 * Strips [from, to) of a bill drawn on their own, moved by (dx, dy): the same paper and ink, with a seam between
 * strips taken together and an ivory ring round them.
 */
export function billStrips(d, { cx, cy, w, strips, from, to, dx = 0, dy = 0, ring = true }) {
  const b = billBox(cx, cy, w);
  const x0 = b.x + (from * w) / strips;
  const x1 = b.x + (to * w) / strips;
  const cut = clip(d, `M${pt(x0, b.y - 1)}H${r2(x1)}V${r2(b.y + b.h + 1)}H${r2(x0)}Z`);
  const seams = [];
  for (let i = from + 1; i < to; i += 1) seams.push(`M${pt(b.x + (i * w) / strips, b.y)}V${r2(b.y + b.h)}`);
  const shade = rect(x0 + w * 0.012, b.y + w * 0.018, x1 - x0, b.h, `fill="${C.ink}" fill-opacity="0.35" filter="${blur(d, Math.max(2, w * 0.01))}"`);
  const inner = [
    shade,
    group(`clip-path="${cut}"`, face(d, b, true)),
    seams.length ? path(seams.join(''), `stroke="${C.ink}" stroke-opacity="0.8" stroke-width="${hair(w, 0.004)}"`) : '',
    rect(x0, b.y, x1 - x0, b.h, `fill="none" stroke="${C.ink}" stroke-width="${hair(w, 0.006)}"`),
    ring ? rect(x0, b.y, x1 - x0, b.h, `fill="none" stroke="${C.ivory}" stroke-width="${r2(Math.max(2, w * 0.007))}" stroke-linejoin="round"`) : '',
  ];
  return group(`transform="translate(${r2(dx)} ${r2(dy)})"`, inner);
}
