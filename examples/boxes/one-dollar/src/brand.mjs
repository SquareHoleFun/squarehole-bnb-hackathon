/**
 * Brand pieces: the logo and X avatar (one mark), the X banner, the link cover and the wide box banner. Each also has
 * a bare version, the same ground with nothing on it, which check.mjs compares with the piece to prove the clear
 * space, the round crop and the calm avatar corner.
 */
import { C } from './palette.mjs';
import { Doc } from './doc.mjs';
import { room, vignette, frame, spotlight, glow } from './gallery.mjs';
import { token, heap } from './tokens.mjs';
import { framedBill, exhibit, placard } from './exhibit.mjs';
import { label, title, roseTicker, fireplace, sparks, arrow } from './props.mjs';

/** The box's name, the way it is lettered in the art: on two lines, the meme's second half smaller. */
export const NAME_LINES = Object.freeze(['ONE DOLLAR', 'IS ALL YOU NEED']);
/** The mark is built on a grid of 32 modules. */
export const MARK_GRID = 32;
/**
 * Where the mark sits on its grid, in modules: the bill's middle and width. The logo's frame is slimmer than the
 * scenes' (`frame`, as shares of the bill's width), so the bill and its 1 stay big enough to read at 48 px.
 */
export const MARK = Object.freeze({ cx: 16, cy: 17.4, billW: 18.4, frame: Object.freeze({ mat: 0.05, depth: 0.022, moulding: 0.062 }) });
/** The cover line as text, and as the art letters it. Pages show the literal line next to it (brand-book.md). */
export const COVER_TEXT = 'The token is 1. The dollar is in the box.';
export const COVER_LINE = Object.freeze(['THE TOKEN IS 1.', 'THE DOLLAR IS IN THE BOX.']);
/** The literal line that always stands next to the cover line. */
export const LITERAL_LINE = 'In plain words, the token is called 1 and the box holds one USDC. On buys and on sales, ten of every 15 fee parts buy the token and burn it.';

/** The mark's ground: the claret wall, darker at the top, with the spotlight's glow where the dollar hangs. */
function markGround(d, size) {
  const m = size / MARK_GRID;
  return room(d, size, size, { floor: size * 2, panels: false })
    + spotlight(d, { x: size / 2, y1: -m * 2, y2: 24 * m, wTop: 5 * m, wBottom: 24 * m, strength: 0.15, lamp: false })
    + glow(d, size / 2, MARK.cy * m, 14 * m, 11 * m, 0.3);
}

/**
 * The mark: the dollar, framed under glass and hung from its hook. Clear space is 2 modules on every side, and the
 * whole mark sits inside 95% of a round crop.
 */
function mark(d, size) {
  const m = size / MARK_GRID;
  const f = framedBill(d, { cx: MARK.cx * m, cy: MARK.cy * m, billW: MARK.billW * m, k: MARK.frame });
  return markGround(d, size) + f.markup;
}

export function logoSvg(size = 1024) {
  const d = new Doc(size, size, 'One Dollar is all you need logo', 'A green cartoon one-dollar bill with a big 1 in the middle, framed under glass in a deep brass frame that hangs from a brass hook on a dark red wall, lit from above.');
  return d.add(mark(d, size)).toString();
}

export function avatarSvg() {
  const d = new Doc(400, 400, 'One Dollar is all you need X avatar', 'The mark, a green cartoon one-dollar bill framed under glass on a dark red wall, sized for a round crop.');
  return d.add(mark(d, 400)).toString();
}

/** The mark's ground alone, for the clear space and round crop checks. */
export function markBareSvg(size = 1024) {
  const d = new Doc(size, size, 'bare', 'bare');
  return d.add(markGround(d, size)).toString();
}

/** 1500 x 500. The lower left (x below 420, y from 270 down) stays bare ground for the avatar overlap. */
export const AVATAR_CORNER = Object.freeze({ x: 0, y: 270, w: 420, h: 230 });

function xBannerGround(d, W, H) {
  return room(d, W, H, { floor: 440, panels: false }) + vignette(d, W, H, 0.45);
}

export function xBannerSvg() {
  const [W, H] = [1500, 500];
  const d = new Doc(W, H, 'One Dollar is all you need X banner', 'ONE DOLLAR IS ALL YOU NEED in ivory capitals on a dark red gallery wall, with the lines THE TOKEN IS 1 and THE DOLLAR IS IN THE BOX under it. On the right, a green cartoon one-dollar bill hangs framed under glass in a spotlight, behind a velvet rope.');
  d.add(xBannerGround(d, W, H));
  const ex = exhibit(d, { cx: 1222, cy: 236, billW: 232, beamTop: -10, strength: 0.18, ropeBase: 474, ropeH: 92, ropeSpan: 0.6 });
  d.add(ex.markup);
  d.add(title(NAME_LINES[0], { x: 702, y: 66, size: 68 }).markup);
  d.add(title(NAME_LINES[1], { x: 702, y: 152, size: 36 }).markup);
  d.add(label(COVER_LINE[0], { x: 702, y: 213, size: 26, colorAt: roseTicker(COVER_LINE[0]) }));
  d.add(label(COVER_LINE[1], { x: 702, y: 253, size: 26, color: C.green }));
  d.add(frame({ w: W, h: H, inset: 24, gap: 9, weight: 3, cut: { x: AVATAR_CORNER.w, y: AVATAR_CORNER.y } }));
  return d.toString();
}

/** The X banner's ground alone, for the avatar corner check. */
export function xBannerBareSvg() {
  const d = new Doc(1500, 500, 'bare', 'bare');
  return d.add(xBannerGround(d, 1500, 500)).toString();
}

/** 1200 x 630 link card: the name across the top, the token and the fire on the left with the first half of the
 * cover line, the framed dollar in the middle and its museum label with the second half on the right. */
export function coverSvg() {
  const [W, H] = [1200, 630];
  const d = new Doc(W, H, 'One Dollar is all you need cover', 'ONE DOLLAR IS ALL YOU NEED in ivory capitals across the top of a dark red gallery. On the left, THE TOKEN IS 1, with a pink token falling into a marble fireplace. In the middle, a green cartoon one-dollar bill hangs framed under glass in a spotlight, behind a velvet rope. On the right, a museum label reads THE DOLLAR IS IN THE BOX.');
  d.add(room(d, W, H, { floor: 548, panelH: 120 }));
  const ex = exhibit(d, { cx: 600, cy: 334, billW: 236, beamTop: -10, strength: 0.17, ropeBase: 584, ropeH: 96, ropeSpan: 0.6 });
  d.add(ex.markup);
  d.add(title(NAME_LINES[0], { x: 600, y: 54, size: 62 }).markup);
  d.add(title(NAME_LINES[1], { x: 600, y: 132, size: 32 }).markup);
  d.add(label(['THE TOKEN', 'IS 1.'], { x: 200, y: 214, size: 34, colorAt: roseTicker(['THE TOKEN', 'IS 1.']) }));
  const fp = fireplace(d, { cx: 190, base: 600, w: 205 });
  d.add(fp.markup);
  d.add(token(d, 338, 352, 24));
  d.add(arrow({ x1: 338, y1: 384, x2: fp.opening.x1 - 36, y2: fp.mouth.y + 30, via: [400, 560], color: C.flame, width: 6, head: 18, dash: '2 12' }));
  d.add(sparks(fp.mouth.x - 8, fp.mouth.y + 62, 40, 5));
  d.add(placard({ x: 830, y: 214, lines: ['THE DOLLAR', 'IS IN', 'THE BOX.'], size: 27 }));
  d.add(vignette(d, W, H, 0.4));
  d.add(frame({ w: W, h: H, inset: 22, gap: 9, weight: 3 }));
  return d.toString();
}

/** 2400 x 600 box-page banner: the name and cover line on the left, the framed dollar in the middle, and on the right
 * a heap of tokens beside a fire that tokens fall into. */
export function boxBannerSvg() {
  const [W, H] = [2400, 600];
  const d = new Doc(W, H, 'One Dollar is all you need box banner', 'A long dark red gallery. On the left, ONE DOLLAR IS ALL YOU NEED in ivory capitals with THE TOKEN IS 1 and THE DOLLAR IS IN THE BOX under it. In the middle, a green cartoon one-dollar bill hangs framed under glass in a spotlight, behind a velvet rope. On the right, pink tokens fall from a big heap into a marble fireplace.');
  d.add(room(d, W, H, { floor: 500, panelH: 120 }));
  const ex = exhibit(d, { cx: 1200, cy: 262, billW: 262, beamTop: -10, strength: 0.2, ropeBase: 556, ropeH: 104, ropeSpan: 0.62 });
  d.add(ex.markup);
  d.add(title(NAME_LINES[0], { x: 560, y: 104, size: 84 }).markup);
  d.add(title(NAME_LINES[1], { x: 560, y: 212, size: 44 }).markup);
  d.add(label(COVER_LINE[0], { x: 560, y: 300, size: 34, colorAt: roseTicker(COVER_LINE[0]) }));
  d.add(label(COVER_LINE[1], { x: 560, y: 354, size: 34, color: C.green }));
  d.add(heap(d, { cx: 2105, base: 560, w: 330, h: 230, seed: 13 }));
  const fp = fireplace(d, { cx: 1730, base: 565, w: 250 });
  d.add(fp.markup);
  d.add(token(d, 1935, 270, 26), token(d, 1880, 215, 24));
  d.add(arrow({ x1: 1905, y1: 300, x2: fp.opening.x1 - 44, y2: fp.mouth.y + 34, via: [1930, 520], color: C.flame, width: 7, head: 20, dash: '2 13' }));
  d.add(sparks(fp.mouth.x - 8, fp.mouth.y + 70, 48, 6));
  d.add(vignette(d, W, H, 0.4));
  d.add(frame({ w: W, h: H, inset: 26, gap: 10, weight: 3.5 }));
  return d.toString();
}
