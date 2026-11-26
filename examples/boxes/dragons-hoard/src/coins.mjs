/**
 * Coins: the price coin of the story. A coin is a plain gold disc with a rim and a shine. It carries no letters, no
 * symbol and no picture, so it is nobody's coin logo, and the same art works for any price coin. Coins lie flat in
 * stacks and heaps, or stand face-on when they move.
 */
import { C, MIX } from './palette.mjs';
import { r2, pt, ellipse, path, group, inked, rotate, seeded } from './doc.mjs';

/** Ink outline width for a coin of radius r. */
const lineOf = (r) => Math.max(2, r * 0.11);

/** A coin seen face-on: a gold disc with its edge showing below, a rim ring and a shine at the top left. */
export function coin(cx, cy, r) {
  const t = r * 0.16;
  const o = lineOf(r);
  return ellipse(cx, cy + t, r, r, inked(MIX.goldDeep, C.ink, o))
    + ellipse(cx, cy, r, r, inked(C.gold, C.ink, o))
    + ellipse(cx, cy, r * 0.72, r * 0.72, `fill="none" stroke="${MIX.goldDark}" stroke-width="${r2(r * 0.09)}"`)
    + path(`M${pt(cx - r * 0.5, cy - r * 0.1)}A${r2(r * 0.52)} ${r2(r * 0.52)} 0 0 1 ${pt(cx - r * 0.08, cy - r * 0.52)}`,
      `fill="none" stroke="${MIX.goldLight}" stroke-width="${r2(r * 0.13)}" stroke-linecap="round"`);
}

/** A row of face-on coins centred on cx. */
export function coinRow(cx, cy, count, r, gap = r * 0.5) {
  const step = 2 * r + gap;
  const x0 = cx - ((count - 1) * step) / 2;
  return Array.from({ length: count }, (_, i) => coin(x0 + i * step, cy, r)).join('');
}

/** A coin lying flat, seen from the front and a little above: an ellipse with its edge below. `tilt` turns it. */
export function flatCoin(cx, cy, r, { squash = 0.42, tilt = 0, edge = 0.22 } = {}) {
  const ry = r * squash;
  const t = r * edge;
  const o = lineOf(r) * 0.8;
  const body = path(`M${pt(cx - r, cy)}L${pt(cx - r, cy + t)}A${r2(r)} ${r2(ry)} 0 0 0 ${pt(cx + r, cy + t)}L${pt(cx + r, cy)}Z`, inked(MIX.goldDark, C.ink, o))
    + ellipse(cx, cy, r, ry, inked(C.gold, C.ink, o))
    + ellipse(cx, cy, r * 0.7, ry * 0.7, `fill="none" stroke="${MIX.goldDark}" stroke-width="${r2(r * 0.07)}"`)
    + ellipse(cx - r * 0.32, cy - ry * 0.32, r * 0.22, ry * 0.2, `fill="${MIX.goldLight}" fill-opacity="0.85"`);
  return tilt ? group(`transform="${rotate(tilt, cx, cy)}"`, body) : body;
}

/** A coin standing on its edge, seen almost side-on: a narrow upright ellipse. */
export function edgeCoin(cx, cy, r, tilt = 0) {
  const o = lineOf(r) * 0.8;
  const body = ellipse(cx + r * 0.08, cy, r * 0.3, r, inked(MIX.goldDeep, C.ink, o))
    + ellipse(cx, cy, r * 0.24, r, inked(C.gold, C.ink, o))
    + ellipse(cx - r * 0.04, cy - r * 0.3, r * 0.07, r * 0.32, `fill="${MIX.goldLight}" fill-opacity="0.85"`);
  return tilt ? group(`transform="${rotate(tilt, cx, cy)}"`, body) : body;
}

/** A stack of `count` flat coins standing on (cx, bottom). Each coin is r wide and `t` thick. */
export function coinStack(cx, bottom, r, count, { t = r * 0.24, squash = 0.4, highlight = false } = {}) {
  const ry = r * squash;
  const top = bottom - count * t;
  const o = lineOf(r) * 0.85;
  const body = path(`M${pt(cx - r, top)}L${pt(cx - r, bottom)}A${r2(r)} ${r2(ry)} 0 0 0 ${pt(cx + r, bottom)}L${pt(cx + r, top)}Z`,
    inked(MIX.goldDark, C.ink, o));
  const seams = [];
  for (let i = 1; i < count; i += 1) {
    const y = bottom - i * t;
    seams.push(`M${pt(cx - r, y)}A${r2(r)} ${r2(ry)} 0 0 0 ${pt(cx + r, y)}`);
  }
  const seamMarkup = seams.length ? path(seams.join(''), `fill="none" stroke="${MIX.goldDeep}" stroke-width="${r2(Math.max(1.5, r * 0.06))}"`) : '';
  const shine = path(`M${pt(cx - r * 0.62, top + ry * 0.6)}L${pt(cx - r * 0.62, bottom + ry * 0.55)}`,
    `fill="none" stroke="${MIX.goldLight}" stroke-opacity="0.55" stroke-width="${r2(r * 0.14)}" stroke-linecap="round"`);
  const ring = highlight ? ellipse(cx, top, r * 1.18, ry * 1.25, `fill="none" stroke="${C.vellum}" stroke-width="${r2(o * 1.3)}"`) : '';
  return body + seamMarkup + shine + flatCoin(cx, top, r, { squash, edge: 0 }) + ring;
}

/** The silhouette of a heap: its top edge as y at x, for a heap `w` wide and `h` tall standing on `base`. */
function heapTop(cx, base, w, h, x) {
  const u = Math.min(1, Math.abs(x - cx) / (w / 2));
  return base - h * (1 - u ** 2) ** 0.62;
}

/** The outline of a heap as a closed path, with a soft round top and a flat floor line. */
export function heapPath(cx, base, w, h, steps = 48) {
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const x = cx - w / 2 + (w * i) / steps;
    pts.push(pt(x, heapTop(cx, base, w, h, x)));
  }
  return `M${pts.join('L')}Z`;
}

/** Half the width of the heap at height y. */
function heapHalf(base, w, h, y) {
  const k = Math.min(1, Math.max(0, (base - y) / h));
  return (w / 2) * Math.sqrt(Math.max(0, 1 - k ** (1 / 0.62)));
}

/**
 * The pile: a heap of loose coins on the floor, about `w` wide and `h` tall, standing on `base` at cx. The heap's
 * body is the coins' shaded side. Flat coins cover it in rows from the back to the front, the outermost coin of each
 * row hangs over the edge, a few coins stand on their edge, and one stands on top. `seed` fixes where every coin
 * lands, and `coinR` sets the coin size.
 */
export function pile(cx, base, w, h, { seed = 7, coinR = null, spill = true, peak = true } = {}) {
  const rnd = seeded(seed);
  const r = coinR ?? Math.max(6, w / 14);
  const out = [path(heapPath(cx, base - r * 0.3, w * 0.9, h * 0.95), `fill="${MIX.goldDark}"`)];
  const rowH = r * 0.56;
  const rows = Math.max(2, Math.ceil((h - r * 0.4) / rowH));
  for (let j = 0; j < rows; j += 1) {
    const y = base - h + r * 0.45 + j * rowH;
    if (y > base - r * 0.32) break;
    const half = heapHalf(base, w, h, y);
    const step = r * 1.42;
    const n = Math.max(1, Math.round((2 * half) / step) + 1);
    const span = Math.max(0, 2 * half - r * 0.5);
    for (let i = 0; i < n; i += 1) {
      const x = n === 1 ? cx : cx - span / 2 + (span * i) / (n - 1) + (rnd() - 0.5) * r * 0.42;
      const yy = y + (rnd() - 0.5) * r * 0.22;
      const rr = r * (0.84 + rnd() * 0.28);
      if (rnd() < 0.08 && j > 0) out.push(edgeCoin(x, yy - rr * 0.4, rr * 0.85, (rnd() - 0.5) * 60));
      else out.push(flatCoin(x, yy, rr, { squash: 0.36 + rnd() * 0.14, tilt: (rnd() - 0.5) * 30 }));
    }
  }
  if (peak) out.push(edgeCoin(cx + r * 0.2, base - h - r * 0.35, r * 0.95, 12));
  if (spill) {
    for (const [dx, k, tilt] of [[-0.55, 0.85, -10], [-0.44, 0.7, 8], [0.47, 0.8, 6], [0.57, 0.66, -12]]) {
      out.push(flatCoin(cx + dx * w, base - r * 0.22, r * k, { squash: 0.4, tilt }));
    }
  }
  return out.join('');
}

/** A soft dark shadow under a heap or a stack, on the floor. */
export function floorShadow(cx, base, w) {
  return ellipse(cx, base + w * 0.012, w * 0.56, w * 0.07, `fill="${MIX.nightDeep}" fill-opacity="0.75"`);
}
