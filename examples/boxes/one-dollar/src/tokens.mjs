/**
 * ONE tokens: rose discs with a five-petal rosette in the middle, so a ONE never looks like the silver dollar or a
 * plain coin. A vellum-like ivory ring marks the ones that are yours. The heap stands for all the ONE there is.
 */
import { C, MIX } from './palette.mjs';
import { r2, pt, circle, ellipse, path, rgrad, seeded } from './doc.mjs';

const roseFace = (d) => rgrad(d, 'rose-face', [[0, MIX.roseLight], [0.5, C.rose], [1, MIX.roseDark]], 0.32, 0.28);
const line = (r) => r2(Math.max(1.1, r * 0.035));

/** The rosette: five round petals and a light heart, `k` the squash for a token lying flat. */
function rosette(cx, cy, r, k = 1) {
  const petals = Array.from({ length: 5 }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    return ellipse(cx + Math.cos(a) * r * 0.24, cy + Math.sin(a) * r * 0.24 * k, r * 0.2, r * 0.2 * k, `fill="${MIX.roseDeep}"`);
  }).join('');
  return petals + ellipse(cx, cy, r * 0.11, r * 0.11 * k, `fill="${MIX.roseLight}"`);
}

/** A ONE token face-on. `ring: true` draws the ivory ring that marks it as yours. */
export function token(d, cx, cy, r, { ring = false, opacity = 1 } = {}) {
  const lw = line(r);
  const body = circle(cx + r * 0.05, cy + r * 0.07, r, `fill="${MIX.roseDark}" stroke="${C.ink}" stroke-width="${lw}"`)
    + circle(cx, cy, r, `fill="${roseFace(d)}" stroke="${C.ink}" stroke-width="${lw}"`)
    + circle(cx, cy, r * 0.8, `fill="none" stroke="${MIX.roseDark}" stroke-width="${r2(Math.max(1, r * 0.07))}"`)
    + rosette(cx, cy, r)
    + path(`M${pt(cx - r * 0.66, cy - r * 0.22)}A${r2(r * 0.7)} ${r2(r * 0.7)} 0 0 1 ${pt(cx - r * 0.2, cy - r * 0.67)}`, `fill="none" stroke="${MIX.shine}" stroke-opacity="0.6" stroke-width="${r2(Math.max(1, r * 0.08))}" stroke-linecap="round"`);
  const mark = ring ? circle(cx, cy, r * 1.24, `fill="none" stroke="${C.ivory}" stroke-width="${r2(Math.max(2.5, r * 0.1))}"`) : '';
  return (opacity < 1 ? `<g opacity="${r2(opacity)}">${body}</g>` : body) + mark;
}

/** A ONE token lying flat, seen from above at a slant: `k` is how flat it looks. */
export function flatToken(d, cx, cy, r, k = 0.42) {
  const lw = line(r);
  return ellipse(cx, cy + r * 0.16, r, r * k, `fill="${MIX.roseDark}" stroke="${C.ink}" stroke-width="${lw}"`)
    + ellipse(cx, cy, r, r * k, `fill="${roseFace(d)}" stroke="${C.ink}" stroke-width="${lw}"`)
    + rosette(cx, cy, r * 0.9, k);
}

/** A row of tokens centred on cx; `each(i)` may return options for token i. */
export function tokenRow(d, cx, cy, count, r, gap, each = () => ({})) {
  const step = 2 * r + gap;
  const x0 = cx - ((count - 1) * step) / 2;
  return Array.from({ length: count }, (_, i) => token(d, x0 + i * step, cy, r, each(i))).join('');
}

/**
 * A heap of ONE tokens, `w` wide and `h` tall, its base centred on (cx, base). Rows of flat tokens cover a rose mound
 * from the back to the front, each row shifted by half a token, and a fixed seed nudges and tilts every one.
 */
export function heap(d, { cx, base, w, h, seed = 1, r = null }) {
  const rand = seeded(seed);
  const tr = r ?? w * 0.058;
  const top = base - h;
  const mound = path(`M${pt(cx - w / 2, base)}C${pt(cx - w * 0.47, base - h * 0.62)} ${pt(cx - w * 0.24, top)} ${pt(cx, top)}C${pt(cx + w * 0.24, top)} ${pt(cx + w * 0.47, base - h * 0.62)} ${pt(cx + w / 2, base)}Z`,
    `fill="${MIX.roseDark}" stroke="${C.ink}" stroke-width="${line(tr)}"`);
  const parts = [ellipse(cx, base + tr * 0.1, w * 0.56, tr * 0.7, `fill="${C.night}" fill-opacity="0.6"`), mound];
  const rows = Math.max(3, Math.round(h / (tr * 0.55)));
  // The mound's half width at a height: the same curve as its outline, so tokens never hang off the edge.
  const halfAt = (y) => {
    const f = Math.min(1, Math.max(0, (y - top) / h));
    return (w / 2) * Math.sin((Math.PI / 2) * Math.min(1, 0.04 + f * 1.15)) ** 0.7;
  };
  for (let row = 0; row <= rows; row += 1) {
    const y = top + tr * 0.32 + (row / rows) * (h - tr * 0.45);
    const half = halfAt(y) - tr * 0.75;
    if (half < tr * 0.2) {
      parts.push(flatToken(d, cx + (rand() - 0.5) * tr * 0.3, y, tr, 0.4));
      continue;
    }
    const count = Math.max(1, Math.round((2 * half) / (tr * 1.7)));
    for (let i = 0; i < count; i += 1) {
      const shift = row % 2 ? 0.25 : -0.25;
      const x = cx - half + ((i + 0.5 + shift) / count) * 2 * half + (rand() - 0.5) * tr * 0.45;
      const rr = tr * (0.88 + rand() * 0.22);
      parts.push(flatToken(d, Math.min(cx + half, Math.max(cx - half, x)), y + (rand() - 0.5) * tr * 0.22, rr, 0.34 + rand() * 0.14));
    }
  }
  return parts.join('');
}
