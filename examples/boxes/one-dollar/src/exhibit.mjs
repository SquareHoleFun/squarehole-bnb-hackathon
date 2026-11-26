/**
 * The exhibit: the dollar, a cartoon bill, framed under glass in a deep brass frame (a shadow box) that hangs on the
 * gallery wall from a brass hook, under a spotlight, behind a velvet rope. Like the first dollar a shop frames on its
 * wall, it is on show and nobody spends it. Everything is measured from the bill's width, so the same exhibit works in
 * the logo, the banners and the scenes.
 */
import { C, MIX } from './palette.mjs';
import { bill, billBox, stripOutline } from './bill.mjs';
import { glint } from './coins.mjs';
import { lettering } from './type.mjs';
import { r2, pt, rect, ellipse, path, group, vgrad, clip, blur, poly } from './doc.mjs';
import { spotlight, glow } from './gallery.mjs';

/** The frame's parts as shares of the bill's width: the mat around the bill, the box's depth, the brass moulding. */
export const FRAME = Object.freeze({ mat: 0.075, depth: 0.03, moulding: 0.07 });

/** The frame's boxes from the bill's middle and width: the bill, the mat, the glass opening and the outer edge. */
export function frameBoxes(cx, cy, billW, k = FRAME) {
  const b = billBox(cx, cy, billW);
  const grow = (box, by) => ({ x: box.x - by, y: box.y - by, w: box.w + 2 * by, h: box.h + 2 * by });
  const mat = grow(b, billW * k.mat);
  const opening = grow(mat, billW * k.depth);
  const outer = grow(opening, billW * k.moulding);
  return { bill: b, mat, opening, outer };
}

/** Four mitred faces between an outer and an inner box, as [top, right, bottom, left] path data. */
function faces(o, i) {
  const [ox0, oy0, ox1, oy1] = [o.x, o.y, o.x + o.w, o.y + o.h];
  const [ix0, iy0, ix1, iy1] = [i.x, i.y, i.x + i.w, i.y + i.h];
  return [
    poly([[ox0, oy0], [ox1, oy0], [ix1, iy0], [ix0, iy0]]),
    poly([[ox1, oy0], [ox1, oy1], [ix1, iy1], [ix1, iy0]]),
    poly([[ox1, oy1], [ox0, oy1], [ix0, iy1], [ix1, iy1]]),
    poly([[ox0, oy1], [ox0, oy0], [ix0, iy0], [ix0, iy1]]),
  ];
}

const box = (b, attrs) => rect(b.x, b.y, b.w, b.h, attrs);

/** The brass hook the frame hangs from and its cord, drawn behind the frame. */
function hanging(outer, w) {
  const cx = outer.x + outer.w / 2;
  const hookY = outer.y - outer.h * 0.3;
  const lw = r2(Math.max(1.2, w * 0.006));
  const cord = `M${pt(cx - outer.w * 0.3, outer.y + outer.h * 0.06)}L${pt(cx, hookY)}L${pt(cx + outer.w * 0.3, outer.y + outer.h * 0.06)}`;
  return path(cord, `fill="none" stroke="${C.ink}" stroke-width="${r2(lw * 2.6)}" stroke-linejoin="round"`)
    + path(cord, `fill="none" stroke="${MIX.brassDark}" stroke-width="${lw}" stroke-linejoin="round"`)
    + ellipse(cx, hookY, w * 0.022, w * 0.022, `fill="${C.brass}" stroke="${C.ink}" stroke-width="${lw}"`)
    + ellipse(cx - w * 0.006, hookY - w * 0.006, w * 0.008, w * 0.008, `fill="${MIX.brassLight}" fill-opacity="0.8"`);
}

/**
 * The framed dollar, the bill's middle on (cx, cy) and the bill `billW` wide: a soft shadow on the wall, the brass
 * moulding lit from the top left, the box's linen walls, the ivory mat, the bill and the glass with its streaks and
 * a glint. `bill` passes options to the bill (strips, yours, gone); `hang` adds the hook and cord. Returns the markup
 * and the boxes, so a scene can point at the bill.
 */
export function framedBill(d, { cx, cy, billW, bill: billOpts = {}, hang = true, k = FRAME }) {
  const B = frameBoxes(cx, cy, billW, k);
  const { outer, opening, mat } = B;
  const lw = r2(Math.max(1.2, billW * 0.005));
  const parts = [];
  if (hang) parts.push(hanging(outer, billW));
  parts.push(rect(outer.x + billW * 0.016, outer.y + billW * 0.026, outer.w, outer.h, `fill="${C.ink}" fill-opacity="0.45" filter="${blur(d, Math.max(3, billW * 0.016))}"`));
  // The moulding: four mitred faces, lit on the top and the left, with a bead line and an inner lip.
  const [top, right, bottom, left] = faces(outer, opening);
  parts.push(path(top, `fill="${MIX.brassLight}"`), path(left, `fill="${C.brass}"`), path(right, `fill="${MIX.brassDark}"`), path(bottom, `fill="${MIX.brassDark}"`));
  const midInset = billW * k.moulding * 0.5;
  const mid = { x: outer.x + midInset, y: outer.y + midInset, w: outer.w - 2 * midInset, h: outer.h - 2 * midInset };
  parts.push(box(mid, `fill="none" stroke="${MIX.brassDark}" stroke-opacity="0.85" stroke-width="${r2(Math.max(1.2, billW * 0.008))}" stroke-dasharray="0.1 ${r2(billW * 0.016)}" stroke-linecap="round"`));
  parts.push(box(mid, `fill="none" stroke="${MIX.brassLight}" stroke-opacity="0.5" stroke-width="${r2(Math.max(0.8, billW * 0.0025))}" transform="translate(${r2(-billW * 0.004)} ${r2(-billW * 0.004)})"`));
  parts.push(box(outer, `fill="none" stroke="${C.ink}" stroke-width="${lw}"`));
  parts.push(path(faces(outer, opening).join(''), `fill="none" stroke="${C.ink}" stroke-opacity="0.35" stroke-width="${r2(lw * 0.6)}"`));
  // The box inside the frame, lined with dark red velvet: its walls are darker on the top and the left, where the
  // light cannot reach, and the back is the deep velvet the bill lies on.
  const [wTop, wRight, wBottom, wLeft] = faces(opening, mat);
  parts.push(path(wTop, `fill="${C.night}"`), path(wLeft, `fill="${MIX.wallDeep}"`), path(wRight, `fill="${MIX.velvetDark}"`), path(wBottom, `fill="${MIX.velvet}" fill-opacity="0.9"`));
  const matShade = vgrad(d, 'mat-shade', [[0, C.ink, 0.45], [0.2, C.ink, 0], [1, C.ink, 0]]);
  parts.push(box(mat, `fill="${MIX.velvetDark}"`), box(mat, `fill="${matShade}"`));
  parts.push(box(opening, `fill="none" stroke="${C.ink}" stroke-width="${lw}"`));
  // The dollar on its mat.
  parts.push(bill(d, { cx, cy, w: billW, ...billOpts }));
  if (billOpts.gone?.length) parts.push(stripOutline(cx, cy, billW, billOpts.strips, billOpts.gone));
  // The glass: a faint tint, two slanted streaks of light and a glint in the top right corner.
  const glassClip = clip(d, `M${pt(opening.x, opening.y)}h${r2(opening.w)}v${r2(opening.h)}h${r2(-opening.w)}Z`);
  const tint = vgrad(d, 'frame-glass', [[0, MIX.glass, 0.16], [1, MIX.glass, 0.06]]);
  const slant = opening.h * 0.55;
  const streak = (x0, wide, opacity) => path(poly([[x0, opening.y], [x0 + wide, opening.y], [x0 + wide + slant, opening.y + opening.h], [x0 + slant, opening.y + opening.h]]), `fill="${MIX.shine}" fill-opacity="${opacity}"`);
  parts.push(group(`clip-path="${glassClip}"`, box(opening, `fill="${tint}"`),
    streak(opening.x + opening.w * 0.08, opening.w * 0.1, 0.16), streak(opening.x + opening.w * 0.22, opening.w * 0.035, 0.12),
    streak(opening.x + opening.w * 0.62, opening.w * 0.05, 0.07)));
  parts.push(path(`M${pt(opening.x + lw, opening.y + lw * 1.5)}H${r2(opening.x + opening.w - lw)}`, `fill="none" stroke="${MIX.shine}" stroke-opacity="0.35" stroke-width="${r2(Math.max(1, billW * 0.004))}"`));
  parts.push(glint(opening.x + opening.w * 0.9, opening.y + opening.h * 0.16, billW * 0.035, 0.85));
  return { markup: parts.join(''), ...B };
}

/** Two brass posts with a velvet rope hanging between them, standing on `base`, `h` tall. */
export function rope(d, { x1, x2, base, h }) {
  const lw = r2(Math.max(1.2, h * 0.012));
  const post = (x) => ellipse(x, base, h * 0.16, h * 0.045, `fill="${MIX.iron}" stroke="${C.ink}" stroke-width="${lw}"`)
    + rect(x - h * 0.03, base - h, h * 0.06, h, `fill="${C.brass}" stroke="${C.ink}" stroke-width="${lw}"`)
    + rect(x - h * 0.012, base - h * 0.95, h * 0.016, h * 0.9, `fill="${MIX.brassLight}" fill-opacity="0.7"`)
    + ellipse(x, base - h - h * 0.05, h * 0.065, h * 0.065, `fill="${C.brass}" stroke="${C.ink}" stroke-width="${lw}"`);
  const y = base - h * 0.9;
  const sag = h * 0.32;
  const swag = `M${pt(x1, y)}Q${pt((x1 + x2) / 2, y + sag * 2)} ${pt(x2, y)}`;
  return post(x1) + post(x2)
    + path(swag, `fill="none" stroke="${C.ink}" stroke-width="${r2(h * 0.095)}" stroke-linecap="round"`)
    + path(swag, `fill="none" stroke="${MIX.velvetDark}" stroke-width="${r2(h * 0.075)}" stroke-linecap="round"`)
    + path(`M${pt(x1, y - h * 0.012)}Q${pt((x1 + x2) / 2, y + sag * 2 - h * 0.02)} ${pt(x2, y - h * 0.012)}`, `fill="none" stroke="${MIX.velvet}" stroke-width="${r2(h * 0.045)}" stroke-linecap="round"`);
}

/**
 * A museum label: an ivory card with an ink rule inside its edge and lines of small salon capitals in ink. (x, y) is
 * its top-left corner, its top-right corner with `anchor: 'end'`, or the middle of its top edge with `anchor:
 * 'middle'`; the card is as wide as its longest line.
 */
export function placard({ x, y, lines, size, anchor = 'start' }) {
  const pad = size * 1.15;
  const lineH = size * 1.62;
  const sizes = lines.map((_, i) => (i === 0 ? size * 1.08 : size * 0.86));
  const widest = Math.max(...lines.map((t, i) => lettering(t, { x: 0, y: 0, size: sizes[i], weight: i === 0 ? 1.05 : 0.95, hair: 0.3, measure: true }).box.w));
  const w = widest + pad * 2.2;
  const left = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
  const h = pad * 2 + size + (lines.length - 1) * lineH;
  const words = lines.map((t, i) => lettering(t, { x: left + w / 2, y: y + pad + i * lineH, size: sizes[i], color: C.ink, weight: i === 0 ? 1.05 : 0.95, hair: 0.3 }).markup).join('');
  return rect(left + size * 0.18, y + size * 0.24, w, h, `fill="${C.ink}" fill-opacity="0.35"`)
    + rect(left, y, w, h, `fill="${C.ivory}" stroke="${C.ink}" stroke-width="${r2(Math.max(1.2, size * 0.06))}"`)
    + rect(left + size * 0.35, y + size * 0.35, w - size * 0.7, h - size * 0.7, `fill="none" stroke="${C.ink}" stroke-opacity="0.55" stroke-width="${r2(Math.max(1, size * 0.04))}"`)
    + words;
}

/**
 * The whole exhibit: the framed dollar on the wall, the bill's middle on (cx, cy) and the bill `billW` wide, with the
 * spotlight from `beamTop` and its glow on the wall (`light`), and the velvet rope on the floor in front, standing on
 * `ropeBase` (`rope`). `bill` passes options to the bill. Returns the markup and the frame's boxes.
 */
export function exhibit(d, { cx, cy, billW, light = true, beamTop = 0, strength = 0.2, rope: withRope = true, ropeBase = null, ropeH = null, ropeSpan = 0.62, bill: billOpts = {}, hang = true }) {
  const parts = [];
  const B = frameBoxes(cx, cy, billW);
  if (light) {
    parts.push(spotlight(d, { x: cx, y1: beamTop, y2: B.outer.y + B.outer.h * 1.08, wTop: billW * 0.22, wBottom: B.outer.w * 1.3, strength }));
    parts.push(glow(d, cx, cy, B.outer.w * 0.95, B.outer.h * 1.25, 0.22));
  }
  const frame = framedBill(d, { cx, cy, billW, bill: billOpts, hang });
  parts.push(frame.markup);
  if (withRope && ropeBase !== null) {
    const h = ropeH ?? billW * 0.4;
    parts.push(rope(d, { x1: cx - B.outer.w * ropeSpan, x2: cx + B.outer.w * ropeSpan, base: ropeBase, h }));
  }
  return { ...frame, markup: parts.join('') };
}
