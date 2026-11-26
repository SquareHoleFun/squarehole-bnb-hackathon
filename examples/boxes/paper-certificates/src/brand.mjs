/**
 * The brand pieces: the mark (logo and X avatar), and for each edition the X banner, the link cover and the box page
 * banner, plus the bare grounds check.mjs compares them with. The mark is a gold foil seal, the kind pressed onto a
 * share certificate, with an engraved S for SCRIP in its middle. It is the same for both editions.
 */
import { C, MIX } from './palette.mjs';
import { Doc, box, ellipse, group, pt, r2, roundRect } from './doc.mjs';
import { band, lathe, line, rosette, scallops, shape } from './engrave.mjs';
import { coin, coupon } from './coins.mjs';
import { miniCertificate } from './props.mjs';
import { DRAWN, letter, shadowed } from './type.mjs';
import { VARIANTS } from './items.mjs';

/** The mark sits on a grid of 32 modules a side and keeps 2 modules of bare paper on every side. */
export const MARK_GRID = 32;
export const MARK_CLEAR = 2;
/** The seal's outer radius in modules: inside the clear space, and inside 95% of a round crop. */
export const SEAL_RADIUS = 13.4;
/** The X banner's bottom-left corner, where the avatar overlaps it: bare ground only. */
export const AVATAR_CORNER = Object.freeze({ x: 0, y: 270, w: 420, h: 230 });

const MARK = 1024;
const M = MARK / MARK_GRID;

/** The seal in 1024 px units: a scalloped gold edge, an ink ring with white-line guilloche, a gold middle and the S. */
function seal() {
  const [cx, cy] = [MARK / 2, MARK / 2];
  const outer = SEAL_RADIUS * M;
  const ringOut = 11.2 * M;
  const ringIn = 8.9 * M;
  const ring = `${ellipse(cx, cy, ringOut)}${ellipse(cx, cy, ringIn)}`;
  return [
    shape(scallops(cx, cy, outer, 44, 0.75 * M), C.gold, 0.32 * M, C.ink),
    line(ellipse(cx, cy, 12 * M), MIX.goldDark, 0.12 * M),
    `<path d="${ring}" fill="${C.ink}" fill-rule="evenodd"/>`,
    group(`clip-path="url(#ring)"`, band({ x: cx - 10.05 * M, y: cy - 10.05 * M, w: 20.1 * M, h: 20.1 * M, r: 10.05 * M }, { amp: 0.85 * M, wave: 0.9 * M, strands: 3, color: C.paper, width: 0.075 * M })),
    shape(ellipse(cx, cy, ringIn), C.gold, 0.16 * M, C.ink),
    rosette(cx, cy, { R: 63, rr: 23, dd: 21, size: 8.2 * M, color: MIX.goldDark, width: 0.06 * M, samples: 110 }),
    shape(ellipse(cx, cy, 5.4 * M), C.gold, 0.12 * M, MIX.goldDark),
    letter('S', { x: cx + 0.18 * M, y: cy - 4.55 * M + 0.18 * M, cap: 9.1 * M, color: MIX.goldDark, weight: 'display', wide: 1.08 }),
    letter('S', { x: cx, y: cy - 4.55 * M, cap: 9.1 * M, color: C.ink, weight: 'display', wide: 1.08 }),
  ];
}

/** The square mark at `size` px: bare paper, then the seal. */
function markSvg(size, title) {
  const d = new Doc(size, size, title,
    'A round gold foil seal with a scalloped edge, the kind pressed onto an old share certificate. A dark ring of fine white lacework runs around it, and an engraved letter S stands in its gold middle.');
  d.def('ring', `<clipPath id="ring"><path d="${ellipse(MARK / 2, MARK / 2, 11.2 * M)}${ellipse(MARK / 2, MARK / 2, 8.9 * M)}" clip-rule="evenodd"/></clipPath>`);
  const before = DRAWN.length;
  const art = seal();
  // The seal is drawn at 1024 and scaled; its lettering's boxes are scaled the same way for the margin check.
  for (const { box: b } of DRAWN.slice(before)) for (const k of ['x', 'y', 'w', 'h']) b[k] *= size / MARK;
  d.add(`<rect width="${size}" height="${size}" fill="${C.paper}"/>`, group(`transform="scale(${Number((size / MARK).toFixed(4))})"`, art));
  return d.toString();
}

export const logoSvg = () => markSvg(MARK, 'Paper Certificates logo');
export const avatarSvg = () => markSvg(400, 'Paper Certificates X avatar');

/** The bare paper behind the mark at `size`, for the clear-space and round-crop checks. */
export function markBareSvg(size) {
  const d = new Doc(size, size, 'Bare paper', 'The paper alone.');
  d.add(`<rect width="${size}" height="${size}" fill="${C.paper}"/>`);
  return d.toString();
}

/** The ground of the wide pieces: paper with a pale security tint. */
function ground(doc, w, h) {
  return [`<rect width="${w}" height="${h}" fill="${C.paper}"/>`, lathe(doc, box(0, 0, w, h), { gap: 10, amp: 3.2, period: 64, rows: 8, width: 1.1, color: MIX.paperShade })];
}

/** A strip of guilloche across a piece, between two rules, from x0 to x1 at y. */
function strip(x0, x1, y, color) {
  return [
    line(`M${pt(x0, y)}H${r2(x1)}M${pt(x0, y + 26)}H${r2(x1)}`, color, 2.2),
    band({ x: x0 + 4, y: y + 5, w: x1 - x0 - 8, h: 16, r: 8 }, { amp: 5.5, wave: 20, strands: 3, color, width: 1 }),
  ];
}

/** The X banner's bare ground: everything that is not the name, the line or the art. The corner is part of it. */
function bannerGround(doc, e) {
  return [...ground(doc, 1500, 500), strip(40, 1460, 26, e.accentDark), strip(440, 1460, 448, e.accentDark)];
}

export function xBannerBareSvg(e) {
  const d = new Doc(1500, 500, 'Bare banner', 'The banner ground alone.');
  d.add(bannerGround(d, e));
  return d.toString();
}

/** A small fan of certificates with coins and coupons in front, the art of the banners and the cover. */
function fan(doc, e, cx, cy, w, picks) {
  const out = [];
  picks.forEach((n, i) => {
    const turn = (i - (picks.length - 1) / 2) * 9;
    out.push(miniCertificate(doc, VARIANTS[n], cx + (i - (picks.length - 1) / 2) * w * 0.42, cy + Math.abs(i - (picks.length - 1) / 2) * w * 0.05, w, { rotate: turn }));
  });
  return out;
}

export function xBannerSvg(e) {
  const d = new Doc(1500, 500, `${e.name} X banner`,
    `The name ${e.name.toUpperCase()} engraved across old certificate paper, with the line ${e.cover.join(' ')} under it. Three joke share certificates fan out on the right, with ${e.coinName} and two lilac SCRIP coupons in front of them. The bottom left corner is bare paper.`);
  d.add(
    bannerGround(d, e),
    shadowed(e.name.toUpperCase(), { x: 750, y: 84, cap: 70, color: C.ink, shadow: e.accent, weight: 'display', wide: 1.04, track: 1.8 }),
    letter(e.cover.join(' '), { x: 750, y: 184, cap: 34, color: e.text, weight: 'text', track: 2 }),
    fan(d, e, 1020, 340, 300, [2, 9, 5]),
    coin(d, 640, 380, 46, e.coin),
    coin(d, 590, 420, 36, e.coin),
    coupon(1330, 400, 120, 12),
    coupon(1250, 420, 110, -10),
  );
  return d.toString();
}

export function coverSvg(e) {
  const d = new Doc(1200, 630, `${e.name} cover`,
    `An engraved certificate frame around the name ${e.name.toUpperCase()} and the line ${e.cover.join(' ')}. On the right, two joke share certificates fan out behind ${e.coinName} and a lilac SCRIP coupon.`);
  const frame = roundRect(20, 20, 1160, 590, 22);
  d.add(
    ground(d, 1200, 630),
    line(frame, C.ink, 3),
    band({ x: 32, y: 32, w: 1136, h: 566, r: 14 }, { amp: 7, wave: 22, strands: 4, color: e.accentDark, width: 1 }),
    line(roundRect(46, 46, 1108, 538, 8), C.ink, 1.6),
    shadowed(e.lines[0], { x: 96, y: 110, cap: 118, anchor: 'start', color: C.ink, shadow: e.accent, weight: 'display', wide: 1.06, track: 2 }),
    shadowed(e.lines[1], { x: 98, y: 262, cap: 56, anchor: 'start', color: C.ink, shadow: e.accent, weight: 'display', wide: 1.04, track: 2 }),
    letter(e.cover, { x: 98, y: 392, cap: 40, anchor: 'start', color: e.text, weight: 'text', track: 2, gap: 4.6 }),
    fan(d, e, 945, 290, 320, [0, 9]),
    coin(d, 850, 470, 62, e.coin),
    coupon(1040, 482, 128, 10),
  );
  return d.toString();
}

export function boxBannerSvg(e) {
  const d = new Doc(2400, 600, `${e.name} box banner`,
    `The name ${e.name.toUpperCase()} and the line ${e.cover.join(' ')} on the left. On the right, all twelve certificates hang in two rows: nine joke companies in nine inks and the three blue chips in blue with gold seals.`);
  const minis = VARIANTS.map((v, i) => {
    const col = i % 6;
    const row = Math.floor(i / 6);
    return miniCertificate(d, v, 1060 + col * 232, 196 + row * 214, 214, { rotate: (col % 2 ? 2 : -2) });
  });
  d.add(
    ground(d, 2400, 600),
    strip(40, 2360, 24, e.accentDark),
    strip(40, 2360, 550, e.accentDark),
    shadowed(e.lines[0], { x: 120, y: 132, cap: 120, anchor: 'start', color: C.ink, shadow: e.accent, weight: 'display', wide: 1.06, track: 2 }),
    shadowed(e.lines[1], { x: 122, y: 286, cap: 58, anchor: 'start', color: C.ink, shadow: e.accent, weight: 'display', wide: 1.04, track: 2 }),
    letter(e.cover.join(' '), { x: 122, y: 400, cap: 38, anchor: 'start', color: e.text, weight: 'text', track: 2 }),
    minis,
  );
  return d.toString();
}
