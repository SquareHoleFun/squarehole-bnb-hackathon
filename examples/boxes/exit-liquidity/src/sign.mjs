/**
 * The sign: one housing, one face, letters from the sign alphabet, and a mount.
 * Every size is a multiple of the module `m` (one letter cell), so signs of any size share proportions.
 *
 *   style 'box'  a light box: the whole face glows, letters are cut out in ink
 *   style 'led'  an LED panel: a black face with lit and unlit dots
 */
import { C, MIX, OFF, GLOW } from './palette.mjs';
import { blockCells, cellsPath, ledDots, drawsWords } from './type.mjs';
import { blur, halo, litFace, rect, circle, path, group, r2 } from './doc.mjs';

const BORDER = 0.7; // housing border around the face, in modules
const PAD = { box: { x: 2, y: 1.5 }, led: { x: 2, y: 2 } }; // face padding around the letters, in modules

/** Housing and face boxes for a sign centred on (cx, cy). */
export function signBox({ cx, cy, lines, m, heavy = false, style = 'led', pad = PAD[style] }) {
  const block = blockCells(lines, { heavy });
  const fw = (block.cols + 2 * pad.x) * m;
  const fh = (block.rows + 2 * pad.y) * m;
  const w = fw + 2 * BORDER * m;
  const h = fh + 2 * BORDER * m;
  return { x: cx - w / 2, y: cy - h / 2, w, h, fx: cx - fw / 2, fy: cy - fh / 2, fw, fh, block };
}

function mountRods({ x, y, w }, m, ceilingY) {
  const xs = [x + w * 0.2, x + w * 0.8];
  return xs.map((rx) => rect(rx - 0.16 * m, ceilingY, 0.32 * m, y - ceilingY + 0.2 * m, `fill="${C.rim}"`)
    + rect(rx - 0.7 * m, ceilingY, 1.4 * m, 0.4 * m, `fill="${C.rim}"`)).join('');
}

function mountBracket({ x, y, w }, m) {
  const cx = x + w / 2;
  return rect(cx - 0.2 * m, y - 1.8 * m, 0.4 * m, 1.9 * m, `fill="${C.rim}"`)
    + rect(cx - 1.6 * m, y - 2.3 * m, 3.2 * m, 0.6 * m, `rx="${r2(0.15 * m)}" fill="${C.rim}"`);
}

function mountFlag({ x, y, w }, m, wallX) {
  const armY = y - 2.2 * m;
  const xs = [x + w * 0.22, x + w * 0.78];
  return rect(wallX, armY - 1.2 * m, 0.7 * m, 2.6 * m, `fill="${C.rim}"`)
    + rect(wallX, armY, xs[1] - wallX + 0.4 * m, 0.45 * m, `fill="${C.rim}"`)
    + xs.map((rx) => rect(rx - 0.12 * m, armY, 0.24 * m, y - armY + 0.2 * m, `fill="${C.rim}"`)).join('');
}

/** A chain of oval links from (x, y1) down to (x, y2). */
export function chain(x, y1, y2, m) {
  const step = 0.9 * m;
  const links = [];
  for (let y = y1, i = 0; y < y2 - 0.2 * m; y += step, i += 1) {
    links.push(i % 2 === 0
      ? `<ellipse cx="${r2(x)}" cy="${r2(y + step / 2)}" rx="${r2(0.28 * m)}" ry="${r2(0.55 * m)}" fill="none" stroke="${C.rim}" stroke-width="${r2(0.18 * m)}"/>`
      : rect(x - 0.08 * m, y, 0.16 * m, step, `fill="${C.rim}"`));
  }
  return links.join('');
}

function faceBox(doc, box, m, color, opts) {
  const { fx, fy, fw, fh, block } = box;
  const cols = block.cols;
  const ox = fx + (fw - cols * m) / 2;
  const oy = fy + (fh - block.rows * m) / 2;
  const cells = opts.mirror ? block.cells.map(({ c, r }) => ({ c: cols - 1 - c, r })) : block.cells;
  return rect(fx, fy, fw, fh, `rx="${r2(0.3 * m)}" fill="${color}"`)
    + rect(fx, fy, fw, fh, `rx="${r2(0.3 * m)}" fill="${litFace(doc, color)}"`)
    + path(cellsPath(cells, m, ox, oy), `fill="${C.ink}"`);
}

function faceLed(doc, box, m, key, opts) {
  const { fx, fy, fw, fh, block } = box;
  const cols = Math.round(fw / m);
  const rows = Math.round(fh / m);
  const dx = Math.floor((cols - block.cols) / 2);
  const dy = Math.floor((rows - block.rows) / 2);
  const ox = fx + (fw - cols * m) / 2;
  const oy = fy + (fh - rows * m) / 2;
  const dim = opts.burnt ?? (() => false);
  const lit = block.cells.filter((cell) => !dim(cell)).map(({ c, r }) => ({ c: c + dx, r: r + dy }));
  const dots = ledDots(lit, cols, rows, { pitch: m, ox, oy });
  const flicker = (drawsWords() ? (opts.flicker ?? []) : []).map(({ c, r }) => circle(ox + (c + dx + 0.5) * m, oy + (r + dy + 0.5) * m, 0.36 * m, `fill="${C.red}"`)).join('');
  return rect(fx, fy, fw, fh, `rx="${r2(0.3 * m)}" fill="${MIX.panel}"`)
    + group(`fill="${OFF[key]}"`, dots.off)
    + group(`fill="${GLOW[key]}" filter="${blur(doc, 0.55 * m)}" opacity="0.95"`, dots.on)
    + group(`fill="${GLOW[key]}"`, dots.on)
    + flicker;
}

/**
 * Draws one sign. Returns { markup, box }.
 * opts: cx, cy, lines, m, style ('box'|'led'), color ('green'|'mint'|'red'|'amber'), heavy, mirror,
 *       mount ('rods'|'bracket'|'flag'|'chain'|'none'), ceilingY, wallX, tilt (degrees), burnt(cell)->bool, flicker,
 *       glow (halo strength, 0 to switch it off)
 */
export function sign(doc, opts) {
  const { m, style = 'led', color = 'green', mount = 'none', ceilingY = 0, wallX = 0, tilt = 0, glow = 0.32 } = opts;
  const box = signBox(opts);
  const lit = GLOW[color];
  const haloMark = glow > 0
    ? `<ellipse cx="${r2(box.x + box.w / 2)}" cy="${r2(box.y + box.h / 2)}" rx="${r2(box.w * 0.95)}" ry="${r2(box.h * 1.7)}" fill="${halo(doc, lit, glow)}"/>`
    : '';
  const mountMark = {
    rods: () => mountRods(box, m, ceilingY),
    bracket: () => mountBracket(box, m),
    flag: () => mountFlag(box, m, wallX),
    chain: () => chain(box.x + 0.8 * m, ceilingY, box.y + 0.3 * m, m),
    none: () => '',
  }[mount]();
  const housing = rect(box.x, box.y, box.w, box.h, `rx="${r2(0.6 * m)}" fill="${C.rim}"`)
    + rect(box.x + 0.15 * m, box.y + 0.15 * m, box.w - 0.3 * m, box.h - 0.3 * m, `rx="${r2(0.5 * m)}" fill="${C.slate}"`);
  const face = style === 'box' ? faceBox(doc, box, m, lit, opts) : faceLed(doc, box, m, color, opts);
  const body = tilt ? group(`transform="rotate(${tilt} ${r2(box.x + 0.8 * m)} ${r2(box.y + 0.3 * m)})"`, housing, face) : housing + face;
  return { halo: haloMark, markup: mountMark + body, box };
}

/** Draws several signs: every halo first, so no sign's light falls on top of another sign. */
export function signs(doc, list) {
  const drawn = list.map((s) => sign(doc, s));
  return { markup: drawn.map((x) => x.halo).join('') + drawn.map((x) => x.markup).join(''), boxes: drawn.map((x) => x.box) };
}
