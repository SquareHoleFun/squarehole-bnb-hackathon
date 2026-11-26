/**
 * The hallway: a wall, a ceiling band, a floor band, and the doors that never lead out.
 */
import { C, MIX } from './palette.mjs';
import { rect, circle, path, group, r2 } from './doc.mjs';

/** Wall with faint panel seams, a ceiling band and a floor band. No seam is drawn left of `calmX`. */
export function room(doc, { w, h, ceilingY, floorY, seams = 6, calmX = 0 }) {
  const seamXs = Array.from({ length: seams - 1 }, (_, i) => ((i + 1) * w) / seams).filter((x) => x > calmX);
  const seamMarks = seamXs.map((x) => rect(x - 1.5, ceilingY, 3, floorY - ceilingY, `fill="${MIX.seam}"`)).join('');
  return rect(0, 0, w, h, `fill="${C.ink}"`)
    + seamMarks
    + rect(0, 0, w, ceilingY, `fill="${MIX.ceiling}"`)
    + rect(0, ceilingY - 3, w, 3, `fill="${C.slate}"`)
    + rect(0, floorY - 14, w, 14, `fill="${C.slate}"`)
    + rect(0, floorY, w, h - floorY, `fill="${MIX.floor}"`)
    + rect(0, floorY, w, 3, `fill="${MIX.floorEdge}"`);
}

/** A brick pattern, registered once. */
function bricks(doc, size) {
  const id = `bricks-${size}`;
  const bw = size * 2;
  const bh = size;
  const g = Math.max(2, r2(size * 0.12));
  return doc.def(id, `<pattern id="${id}" width="${bw}" height="${bh * 2}" patternUnits="userSpaceOnUse">`
    + rect(0, 0, bw, bh * 2, `fill="${MIX.brickLine}"`)
    + rect(g / 2, g / 2, bw - g, bh - g, `fill="${MIX.brick}"`)
    + rect(-bw / 2 + g / 2, bh + g / 2, bw - g, bh - g, `fill="${MIX.brick}"`)
    + rect(bw / 2 + g / 2, bh + g / 2, bw - g, bh - g, `fill="${MIX.brick}"`)
    + '</pattern>');
}

/** A whole wall of bricks between ceiling and floor. */
export function brickWall(doc, { w, ceilingY, floorY, size = 34 }) {
  return rect(0, ceilingY, w, floorY - 14 - ceilingY, `fill="${bricks(doc, size)}"`);
}

function frame(x, y, w, h, t) {
  return rect(x - t, y - t, w + 2 * t, h + t, `fill="${C.rim}"`) + rect(x, y, w, h, `fill="${C.ink}"`);
}

/** A doorway filled with bricks: the exit, not found. */
export function brickedDoor(doc, { cx, floorY, w, h }) {
  const x = cx - w / 2;
  const y = floorY - h;
  return frame(x, y, w, h, w * 0.06) + rect(x, y, w, h, `fill="${bricks(doc, r2(w / 7))}"`);
}

/** A door the size of a mouse hole, at floor level. */
export function tinyDoor({ cx, floorY, w }) {
  const h = w * 1.45;
  const arch = (dw, top) => {
    const x = cx - dw / 2;
    return `M${r2(x)} ${r2(floorY)}V${r2(top + dw / 2)}A${r2(dw / 2)} ${r2(dw / 2)} 0 0 1 ${r2(x + dw)} ${r2(top + dw / 2)}V${r2(floorY)}Z`;
  };
  const y = floorY - h;
  const inner = w * 0.78;
  return path(arch(w, y), `fill="${C.rim}"`)
    + path(arch(inner, y + (w - inner) / 2), `fill="${C.slate}"`)
    + circle(cx + inner * 0.26, floorY - h * 0.4, w * 0.07, `fill="${C.amber}"`);
}

/** A door painted on the wall: a dashed outline and a painted knob. */
export function paintedDoor({ cx, floorY, w, h }) {
  const x = cx - w / 2;
  const y = floorY - 14 - h;
  const sw = r2(w * 0.035);
  return rect(x, y, w, h, `fill="none" stroke="${C.paper}" stroke-opacity="0.42" stroke-width="${sw}" stroke-dasharray="${r2(w * 0.09)} ${r2(w * 0.06)}"`)
    + rect(x + w * 0.12, y + h * 0.08, w * 0.76, h * 0.36, `fill="none" stroke="${C.paper}" stroke-opacity="0.2" stroke-width="${sw}"`)
    + circle(x + w * 0.8, y + h * 0.55, w * 0.045, `fill="${C.paper}" fill-opacity="0.42"`);
}

/** A closed hatch with four bolts. Used in the floor and in the ceiling. */
export function hatch({ cx, cy, w, h }) {
  const x = cx - w / 2;
  const y = cy - h / 2;
  const b = Math.min(w, h) * 0.08;
  const bolts = [[x + b * 2, y + b * 2], [x + w - b * 2, y + b * 2], [x + b * 2, y + h - b * 2], [x + w - b * 2, y + h - b * 2]];
  return rect(x, y, w, h, `rx="${r2(b)}" fill="${C.rim}"`)
    + rect(x + b * 0.8, y + b * 0.8, w - b * 1.6, h - b * 1.6, `rx="${r2(b * 0.6)}" fill="${C.slate}"`)
    + rect(cx - w * 0.18, cy - b * 0.5, w * 0.36, b, `rx="${r2(b * 0.5)}" fill="${C.rim}"`)
    + bolts.map(([bx, by]) => circle(bx, by, b * 0.55, `fill="${C.rim}"`)).join('');
}

/** A tall window with a few pixel stars, for the quiet night scene. */
export function nightWindow({ x, y, w, h }) {
  const star = (sx, sy, p) => rect(sx - p / 2, sy - 1.5 * p, p, 3 * p, `fill="${C.paper}"`) + rect(sx - 1.5 * p, sy - p / 2, 3 * p, p, `fill="${C.paper}"`);
  const dots = [[0.2, 0.15], [0.3, 0.7], [0.8, 0.82], [0.72, 0.12], [0.12, 0.45]];
  return rect(x - 8, y - 8, w + 16, h + 16, `fill="${C.rim}"`)
    + rect(x, y, w, h, `fill="#0A1A22"`)
    + star(x + w * 0.66, y + h * 0.3, w * 0.035)
    + star(x + w * 0.3, y + h * 0.58, w * 0.025)
    + group(`fill="${C.paper}" fill-opacity="0.6"`, ...dots.map(([fx, fy]) => circle(x + w * fx, y + h * fy, 2.5)))
    + rect(x + w / 2 - 3, y, 6, h, `fill="${C.rim}"`)
    + rect(x, y + h / 2 - 3, w, 6, `fill="${C.rim}"`);
}
