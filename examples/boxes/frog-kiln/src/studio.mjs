/**
 * The ground of every wide picture: the potter's studio. A limewashed wall in warm bisque with a few soft brush
 * sweeps, and a floor of wide planks. Bricks for the kiln are laid here too, in running bond with light mortar.
 */
import { C, MIX } from './palette.mjs';
import { path, r2, rect, seeded } from './doc.mjs';
import { clipped, line } from './pen.mjs';

/** The limewashed wall: one flat ground and a few wide, soft sweeps of a slightly darker wash. */
export function wall(w, h, { seed = 'wall', sweeps = true } = {}) {
  const out = [rect(0, 0, w, h, `fill="${C.bisque}"`)];
  if (!sweeps) return out;
  const rand = seeded(seed);
  const n = Math.max(3, Math.round(w / 260));
  for (let i = 0; i < n; i += 1) {
    const x = (i + 0.2 + rand() * 0.6) * (w / n);
    const y = 0.15 * h + rand() * 0.55 * h;
    const len = 160 + rand() * 220;
    const lift = (rand() - 0.5) * 60;
    out.push(line(`M${r2(x - len / 2)} ${r2(y)}q${r2(len / 2)} ${r2(lift)} ${r2(len)} ${r2(lift * 0.4)}`, MIX.wallShade, 34 + rand() * 30));
  }
  return out;
}

/** A floor of wide planks from `top` down, with soot edge and seams. */
export function floor(w, h, top, ow) {
  const out = [rect(0, top, w, h - top, `fill="${C.wood}"`), rect(0, top, w, 16, `fill="${MIX.woodLight}"`)];
  for (let y = top + 70; y < h; y += 70) out.push(path(`M0 ${r2(y)}H${r2(w)}`, `fill="none" stroke="${MIX.woodDark}" stroke-width="${r2(ow * 0.6)}"`));
  out.push(path(`M0 ${r2(top)}H${r2(w)}`, `fill="none" stroke="${C.soot}" stroke-width="${r2(ow)}"`));
  return out;
}

/**
 * Bricks in running bond inside a shape: the shape filled with mortar, then each brick as a rounded block with a
 * few lighter and darker ones. `course` is a brick's height in px, and a brick is twice as long.
 */
export function bricks(doc, d, { x, y, w, h, course = 40, seed = 'bricks' }) {
  const rand = seeded(seed);
  const len = course * 2.1;
  const gap = Math.max(2, course * 0.12);
  const out = [rect(x, y, w, h, `fill="${MIX.mortar}"`)];
  let row = 0;
  for (let top = y; top < y + h; top += course) {
    const shift = row % 2 === 0 ? 0 : -len / 2;
    for (let left = x + shift; left < x + w; left += len) {
      const pick = rand();
      const fill = pick < 0.16 ? MIX.brickLight : pick > 0.88 ? MIX.brickDark : C.brick;
      const bw = len - gap;
      const bh = course - gap;
      out.push(`<rect x="${r2(left + gap / 2)}" y="${r2(top + gap / 2)}" width="${r2(bw)}" height="${r2(bh)}" rx="${r2(course * 0.14)}" fill="${fill}"/>`);
    }
    row += 1;
  }
  return clipped(doc, d, out);
}
