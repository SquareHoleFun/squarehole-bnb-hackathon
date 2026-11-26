/**
 * One share certificate with its coupon sheet, the item picture of the collection. The sheet is one piece of paper on
 * a deep mat in the certificate's ink. The upper part is the certificate: a guilloche frame with four corner rosettes,
 * the number box and the edition box, the vignette in an oval, the company's name, the line THIS CERTIFIES NOTHING,
 * a seal and two signatures. Under a perforation hangs a sheet of five coupons. Every certificate is printed in one
 * ink; the blue chips are printed in blue with a gold seal and a gold ribbon over the vignette.
 */
import { C, MIX } from './palette.mjs';
import { ellipse, group, place, pt, r2, rect, roundRect, seeded } from './doc.mjs';
import { band, fill, lathe, line, perforation, rosette, scallops, scribble, shape } from './engrave.mjs';
import { DRAWN, letter, placeDrawn } from './type.mjs';

/** Item pictures are square, this many px a side. */
export const ITEM_PX = 1024;

export const SHEET = Object.freeze({ x: 30, y: 30, w: 964, h: 964 });
export const FRAME = Object.freeze({ x: 58, y: 58, w: 908, h: 624, r: 30 });
export const OVAL = Object.freeze({ cx: 512, cy: 238, rx: 196, ry: 124 });
const BAND = 30;
/** Where the number goes, so a real collection's files can print each certificate's own number there. */
export const NUMBER_BOX = Object.freeze({ x: 124, y: 196, w: 184, h: 72 });
const EDITION_BOX = Object.freeze({ x: 716, y: 196, w: 184, h: 72 });
const PERFORATION_Y = 710;
const COUPONS = Object.freeze({ x: 58, y: 730, w: 908, h: 236, count: 5, gap: 12 });

/** The number printed in the number box: the item id, grouped like 1,929; the kit's own pictures print a specimen 0. */
export function serialText(id) {
  if (id === null) return '0';
  if (!/^[1-9][0-9]*$/.test(String(id))) throw new TypeError('a certificate number is an item id such as "1929"');
  return String(id).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The frame: an ink band carrying white-line guilloche, a hairline inside it, and the security tint on the paper. */
function frame(doc, v) {
  const { x, y, w, h, r } = FRAME;
  const outer = roundRect(x, y, w, h, r);
  const inner = roundRect(x + BAND, y + BAND, w - 2 * BAND, h - 2 * BAND, Math.max(4, r - BAND));
  const mid = { x: x + BAND / 2, y: y + BAND / 2, w: w - BAND, h: h - BAND, r: r - BAND / 2 };
  return [
    lathe(doc, inner, { color: v.tint, ...v.tintStyle }),
    `<path d="${outer}${inner}" fill="${v.ink}" fill-rule="evenodd"/>`,
    group(doc.clip(`${outer}${inner}`), band(mid, { amp: BAND / 2 - 4, wave: v.border.wave, strands: v.border.strands, freq: v.border.freq, color: C.paper, width: 1.15 })),
    line(outer, v.ink, 3),
    line(roundRect(x + BAND + 8, y + BAND + 8, w - 2 * BAND - 16, h - 2 * BAND - 16, 6), v.ink, 1.4),
  ];
}

/** A corner medallion: a paper disc in an ink ring, holding the certificate's rosette. */
function medallion(cx, cy, v, turn) {
  return [
    shape(ellipse(cx, cy, 46), C.paper, 3, v.ink),
    line(ellipse(cx, cy, 39), v.ink, 1.2),
    rosette(cx, cy, { ...v.rosette, size: 34, rotate: turn, color: v.ink, width: 0.75 }),
    shape(ellipse(cx, cy, 6), v.ink, 1, v.ink),
  ];
}

/** A small box with a hairline inside its border. */
function plate(b, v) {
  return [shape(roundRect(b.x, b.y, b.w, b.h, 6), C.paper, 2.2, v.ink), line(roundRect(b.x + 6, b.y + 6, b.w - 12, b.h - 12, 3), v.ink, 1)];
}

/** The seal: red wax for the companies, gold foil for the blue chips. */
function seal(cx, cy, gold) {
  if (gold) {
    return [
      shape(scallops(cx, cy, 60, 36, 5), C.gold, 2.2, MIX.goldDark),
      line(ellipse(cx, cy, 46), MIX.goldDark, 1.6),
      rosette(cx, cy, { R: 50, rr: 18, dd: 14, size: 40, color: MIX.goldDark, width: 0.8 }),
      line(ellipse(cx, cy, 14), MIX.goldDark, 1.6),
    ];
  }
  const rand = seeded(`wax-${cx}-${cy}`);
  const blob = [];
  for (let i = 0; i < 18; i += 1) {
    const a = (Math.PI * 2 * i) / 18;
    const rad = 58 + (rand() - 0.5) * 9;
    blob.push(`${i ? 'L' : 'M'}${pt(cx + rad * Math.cos(a), cy + rad * Math.sin(a))}`);
  }
  return [
    shape(`${blob.join('')}Z`, C.seal, 2.2, MIX.sealDark),
    shape(ellipse(cx, cy, 44), C.seal, 2, MIX.sealDark),
    rosette(cx, cy, { R: 48, rr: 20, dd: 14, size: 36, color: MIX.sealLight, width: 0.9 }),
    line(ellipse(cx, cy, 40), MIX.sealLight, 1),
  ];
}

/** The gold ribbon of the blue chips: a straight band across the top of the vignette, notched tails behind it. */
function ribbon(v) {
  const { cx, cy, ry } = OVAL;
  const y = cy - ry - 14;
  const tail = (s) => `M${pt(cx + s * 128, y + 8)}H${r2(cx + s * 196)}L${pt(cx + s * 178, y + 26)}L${pt(cx + s * 196, y + 44)}H${r2(cx + s * 128)}Z`;
  return [
    shape(tail(-1), MIX.goldDark, 2.2, C.ink),
    shape(tail(1), MIX.goldDark, 2.2, C.ink),
    shape(`M${pt(cx - 128, y + 8)}L${pt(cx - 140, y + 44)}H${r2(cx - 128)}Z`, MIX.goldDark, 1.6, C.ink),
    shape(`M${pt(cx + 128, y + 8)}L${pt(cx + 140, y + 44)}H${r2(cx + 128)}Z`, MIX.goldDark, 1.6, C.ink),
    shape(roundRect(cx - 140, y, 280, 44, 3), C.gold, 2.4, C.ink),
    line(`M${pt(cx - 132, y + 6)}H${r2(cx + 132)}M${pt(cx - 132, y + 38)}H${r2(cx + 132)}`, MIX.goldDark, 1.2),
    letter('BLUE CHIP', { x: cx, y: y + 12, cap: 20, color: v.ink, weight: 'text', track: 2.2 }),
  ];
}

/** The coupon sheet: five coupons in a row, each with its rosette and number, perforated between. */
function coupons(doc, v) {
  const { x, y, w, h, count, gap } = COUPONS;
  const cw = (w - gap * (count - 1)) / count;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const cx = x + i * (cw + gap);
    const box = roundRect(cx, y, cw, h, 8);
    out.push(
      shape(box, C.paper, 2.2, v.ink),
      band({ x: cx + 12, y: y + 12, w: cw - 24, h: h - 24, r: 6 }, { amp: 4, wave: 13, strands: 2, color: v.ink, width: 0.8 }),
      shape(ellipse(cx + cw / 2, y + 96, 50), C.paper, 1.6, v.ink),
      rosette(cx + cw / 2, y + 96, { ...v.coupon, size: 42, rotate: 15 * i, color: v.ink, width: 0.75, samples: 80 }),
      letter(String(i + 1), { x: cx + cw / 2, y: y + 166, cap: 34, color: v.ink, weight: 'display' }),
    );
    if (i < count - 1) out.push(perforation(`M${r2(cx + cw + gap / 2)} ${r2(y - 8)}V${r2(y + h + 8)}`, v.ink, 2.4, 9));
  }
  return out;
}

/** The vignette in its oval: drawn around (0, 0), moved to the oval's centre, its lettering recorded in place. */
function vignette(doc, v) {
  const { cx, cy, rx, ry } = OVAL;
  const from = DRAWN.length;
  const art = v.vignette(doc, v);
  placeDrawn(from, cx, cy);
  return group(place(cx, cy), group(doc.clip(ellipse(0, 0, rx, ry)), art));
}

/**
 * The whole item picture for a variant `v` (see src/items.mjs) on `doc`. `id` prints that item's number in the
 * number box; null prints the specimen number 0, as the kit's own pictures show.
 */
export function certificate(doc, v, id = null) {
  const { cx, cy, rx, ry } = OVAL;
  const oval = ellipse(cx, cy, rx, ry);
  const nameTop = v.company.length === 2 ? 386 : 410;
  const out = [
    rect(0, 0, ITEM_PX, ITEM_PX, `fill="${v.deep}"`),
    fill(roundRect(SHEET.x + 8, SHEET.y + 10, SHEET.w, SHEET.h, 4), MIX.ironDark),
    fill(roundRect(SHEET.x, SHEET.y, SHEET.w, SHEET.h, 4), C.paper),
    frame(doc, v),
    medallion(FRAME.x + 44, FRAME.y + 44, v, 0),
    medallion(FRAME.x + FRAME.w - 44, FRAME.y + 44, v, 30),
    medallion(FRAME.x + 44, FRAME.y + FRAME.h - 44, v, 60),
    medallion(FRAME.x + FRAME.w - 44, FRAME.y + FRAME.h - 44, v, 90),
    plate(NUMBER_BOX, v),
    letter('Nº', { x: NUMBER_BOX.x + 18, y: NUMBER_BOX.y + 26, cap: 22, anchor: 'start', color: v.ink, weight: 'text' }),
    letter(serialText(id), { x: NUMBER_BOX.x + 112, y: NUMBER_BOX.y + 22, cap: 30, color: C.seal, weight: 'text', track: 1 }),
    plate(EDITION_BOX, v),
    letter(['ONE OF', '1,929'], { x: EDITION_BOX.x + EDITION_BOX.w / 2, y: EDITION_BOX.y + 13, cap: 17, color: v.ink, weight: 'small', track: 1.6, gap: 4.6 }),
    // The vignette: paper in a double ring, the drawing clipped to the oval.
    shape(ellipse(cx, cy, rx + 10, ry + 10), C.paper, 3, v.ink),
    vignette(doc, v),
    line(oval, v.ink, 2.6),
    v.special ? ribbon(v) : null,
    letter(v.company[0], { x: 512, y: nameTop, cap: v.cap?.[0] ?? 54, color: v.ink, weight: 'display', wide: 1.04, track: 1.5 }),
    v.company[1] ? letter(v.company[1], { x: 512, y: nameTop + 74, cap: v.cap?.[1] ?? 36, color: v.ink, weight: 'display', track: 1.8 }) : null,
    line(`M${pt(400, 532)}H${r2(486)}M${pt(538, 532)}H${r2(624)}`, v.ink, 1.4),
    shape(`M${pt(512, 524)}L${pt(522, 532)}L${pt(512, 540)}L${pt(502, 532)}Z`, v.ink, 1, v.ink),
    letter('THIS CERTIFIES NOTHING', { x: 512, y: 552, cap: 15, color: v.ink, weight: 'small', track: 2.6 }),
    seal(206, 592, v.special),
    line(`M${pt(606, 632)}H${r2(740)}M${pt(764, 632)}H${r2(862)}`, v.ink, 1.4),
    scribble(612, 596, 122, 32, `${v.n}-a`, { color: v.ink, width: 1.7 }),
    scribble(770, 598, 88, 30, `${v.n}-b`, { color: v.ink, width: 1.7 }),
    perforation(`M${r2(SHEET.x + 14)} ${PERFORATION_Y}H${r2(SHEET.x + SHEET.w - 14)}`, v.ink, 2.6, 10),
    coupons(doc, v),
  ];
  return out;
}
