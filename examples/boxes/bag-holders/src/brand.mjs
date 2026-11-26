/**
 * Brand pieces: the logo and X avatar (one mark), the X banner, the link cover and the wide box banner.
 */
import { C } from './palette.mjs';
import { Doc } from './doc.mjs';
import { wall, holes, shelf } from './wall.mjs';
import { hangBag, hookOffset } from './hang.mjs';
import { lettering } from './type.mjs';

/** The mark is built on a module of 1/32 of its square: 32 px on the 1024 px logo. */
export const MARK_MODULES = 32;
/** Clear space around the mark and its shadow, in modules. check.mjs proves the border holds only bare wall. */
export const MARK_CLEAR = 2;
const MARK = { toteW: 16, toteH: 13.5, toteTop: 13.5, hookY: 3.4, hook: 2.3, ow: 0.62, pitch: 4, hole: 0.42, shadow: [14, 16] };

function markGrid(size) {
  const m = size / MARK_MODULES;
  const s = (size / 1024) * MARK.hook;
  const hookY = MARK.hookY * m;
  return { m, s, hookY, grid: holes(size, size, MARK.pitch * m, (size / 2 - hookOffset(s)) % (MARK.pitch * m), hookY % (MARK.pitch * m)) };
}

function markWall(d, size) {
  const { m, grid } = markGrid(size);
  return wall(d, { w: size, h: size, pitch: MARK.pitch * m, hole: MARK.hole * m, ox: grid[1], oy: grid[2] });
}

/**
 * The mark: a canvas tote with a red pocket, hanging from a steel hook on plum pegboard.
 * Tote 16 x 13.5 modules, its top 13.5 modules down; the hook's hole 3.4 modules down; holes 4 modules apart.
 */
function mark(d, size) {
  const { m, s, hookY, grid } = markGrid(size);
  return markWall(d, size)
    + hangBag(d, 'tote', { cx: size / 2, hookY, top: MARK.toteTop * m, w: MARK.toteW * m, h: MARK.toteH * m, ow: MARK.ow * m, size: s, shadow: MARK.shadow, grid, id: `mark${size}` });
}

export function logoSvg(size = 1024) {
  const d = new Doc(size, size, 'Bag Holders logo', 'A canvas tote bag with a red pocket, hanging from a steel hook on a plum pegboard.');
  return d.add(mark(d, size)).toString();
}

/** The logo's bare wall. check.mjs renders it to prove the clear space holds nothing else. */
export function logoWallSvg(size = 1024) {
  const d = new Doc(size, size, 'Bag Holders logo, wall only', 'The bare pegboard behind the logo, for the clear space check.');
  return d.add(markWall(d, size)).toString();
}

export function avatarSvg() {
  const d = new Doc(400, 400, 'Bag Holders X avatar', 'The Bag Holders mark, a canvas tote with a red pocket on a steel hook on plum pegboard, sized for a round crop.');
  return d.add(mark(d, 400)).toString();
}

const title = (lines, x, y, cap, anchor = 'middle') => lettering(lines, { x, y, cap, color: C.canvas, outline: C.ink, shadow: C.tomato, anchor });

/** Hangs a row of bags: each entry is [kind, cx, hookY, top, w, h, extra]. */
function row(d, grid, size, ow, list) {
  return list.map(([kind, cx, hookY, top, w, h, extra = {}], i) => hangBag(d, kind, { cx, hookY, top, w, h, ow, size, grid, id: `row${i}-${kind}`, ...extra })).join('');
}

/** The avatar overlap on the X banner: x 0 to 420, y 270 to 500. Only the bare pegboard shows there. */
export const X_CALM = Object.freeze([0, 270, 420, 230]);
const X_SIZE = [1500, 500];

function xWall(title, desc) {
  const [W, H] = X_SIZE;
  const d = new Doc(W, H, title, desc);
  return d.add(wall(d, { w: W, h: H, pitch: 50, hole: 6 }));
}

/** The X banner's bare wall. check.mjs renders it to prove the avatar corner holds nothing else. */
export function xBannerWallSvg() {
  return xWall('Bag Holders X banner, wall only', 'The bare pegboard of the X banner, for the avatar corner check.').toString();
}

/** 1500 x 500. The lower left corner (X_CALM) stays bare pegboard for the avatar overlap. */
export function xBannerSvg() {
  const [W, H] = X_SIZE;
  const grid = holes(W, H, 50);
  const d = xWall('Bag Holders X banner', 'Plum pegboard with a small tote on the left and a bag of chips and a punching bag on the right, all on steel hooks. BAG HOLDERS in big cream letters in the middle.');
  const off = hookOffset(0.6);
  d.add(row(d, grid, 0.6, 6, [
    ['tote', 175 + off, 25, 112, 150, 135],
    ['chips', 1175 + off, 25, 100, 170, 230],
    ['punch', 1375 + off, 25, 110, 120, 300],
  ]));
  d.add(title(['BAG', 'HOLDERS'], 790, 120, 104));
  return d.toString();
}

/** 1200 x 630 link card. */
export function coverSvg() {
  const [W, H, SHELF] = [1200, 630, 566];
  const grid = holes(W, H, 60);
  const d = new Doc(W, H, 'Bag Holders cover', 'Plum pegboard with a canvas tote and a net of lemons on steel hooks. BAG HOLDERS in big cream letters, with the line 420 BAGS SHARE THE FEES below it.');
  d.add(wall(d, { w: W, h: H, pitch: 60 }), shelf({ w: W, y: SHELF, h: H }));
  const off = hookOffset(0.7);
  d.add(row(d, grid, 0.7, 7, [
    ['tote', 930 + off, 45, 205, 220, 210, { print: 'TOTE' }],
    ['lemons', 1110 + off, 45, 150, 118, 170],
  ]));
  d.add(title(['BAG', 'HOLDERS'], 70, 110, 96, 'start'));
  d.add(lettering('420 BAGS SHARE THE FEES.', { x: 70, y: 450, cap: 34, color: C.gold, outline: C.ink, anchor: 'start' }));
  return d.toString();
}

/** 2400 x 600 box-page banner: the name in the middle and all twelve kinds of bag along the wall. */
export function boxBannerSvg() {
  const [W, H, SHELF] = [2400, 600, 548];
  const grid = holes(W, H, 60);
  const d = new Doc(W, H, 'Bag Holders box banner', 'A long plum pegboard with twelve kinds of bag on steel hooks, six on each side of BAG HOLDERS in big cream letters. A tote, a bean bag, a sleeping bag, a paper bag, a punching bag and a tea bag hang on the left. A duffel bag, a bag of chips, a gift bag, a backpack, a bag of lemons and a sandbag hang on the right.');
  d.add(wall(d, { w: W, h: H, pitch: 60 }), shelf({ w: W, y: SHELF, h: H }));
  const s = 0.7;
  const off = hookOffset(s);
  // Two staggered rows on each side of the name: hooks in the top row of holes and in the fifth row.
  d.add(row(d, grid, s, 6, [
    ['tote', 90 + off, 30, 150, 160, 150, { print: 'TOTE' }],
    ['beans', 330 + off, 30, 130, 180, 150],
    ['sleep', 570 + off, 30, 140, 190, 140],
    ['paper', 210 + off, 270, 370, 130, 160],
    ['punch', 450 + off, 270, 340, 100, 200],
    ['tea', 690 + off, 270, 380, 100, 130],
    ['duffel', 1650 + off, 30, 140, 200, 150],
    ['chips', 1890 + off, 30, 115, 130, 170],
    ['gift', 2130 + off, 30, 165, 140, 140],
    ['pack', 1770 + off, 270, 345, 130, 180],
    ['lemons', 2010 + off, 270, 350, 120, 170],
    ['sand', 2250 + off, 270, 345, 160, 175],
  ]));
  d.add(title(['BAG', 'HOLDERS'], 1200, 140, 100));
  return d.toString();
}
