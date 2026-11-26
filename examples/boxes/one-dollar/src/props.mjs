/**
 * Story props: the marble fireplace (a burn), the fountain basin (the box's own pool), the jar (fee coins that wait),
 * the brass plaque (Square Hole's parts), the envelope (a slice paid out), arrows, braces, the raise bar and the
 * lettering helpers. Thin ink lines and flat colors with soft light, like the rest of the gallery. These are plain
 * symbols drawn for this kit, not anyone's product or logo.
 */
import { C, MIX, FLAME } from './palette.mjs';
import { lettering } from './type.mjs';
import { flatCoin } from './coins.mjs';
import { flatToken } from './tokens.mjs';
import { r2, pt, rect, circle, ellipse, path, hgrad, vgrad, glowFill, roundRect, seeded } from './doc.mjs';

const thin = (w) => r2(Math.max(1.2, w * 0.008));

/** Lettering in one color with an ink edge, so it reads on any part of the art. (x, y) is on the cap line. */
export function label(text, { x, y, size, color = C.ivory, anchor = 'middle', weight = 1.1, edge = true, colorAt = null }) {
  const layers = edge ? [[C.ink, Math.max(2, size * 0.11)], [null, 0]] : [[null, 0]];
  return lettering(text, { x, y, size, anchor, weight, hair: 0.3, layers, color, colorAt }).markup;
}

/**
 * A `colorAt` that paints the ticker, a 1 that stands alone, in rose, the token's color, so the ticker stands apart from the rest of a
 * line and never takes the dollar's green.
 */
export function roseTicker(lines) {
  const list = Array.isArray(lines) ? lines : [lines];
  const marks = list.map((t) => {
    const set = new Set();
    for (const m of t.matchAll(/(?<![0-9])1(?![0-9])/g)) set.add(m.index);
    return set;
  });
  return (li, ci) => (marks[li]?.has(ci) ? C.rose : null);
}

/** The name and other big words: ivory salon capitals with a soft shadow on the wall below them. */
export function title(text, { x, y, size, color = C.ivory, anchor = 'middle', weight = 1, tracking = 0.6, colorAt = null }) {
  return lettering(text, { x, y, size, anchor, weight, hair: 0.2, tracking, color, colorAt, layers: [[C.ink, 0, size * 0.03, size * 0.05, 0.45], [null, 0]] });
}

/** A flame with a tall middle tongue and two shorter ones, its base centred on (cx, by), `w` wide and `h` tall. */
export function flamePath(cx, by, w, h) {
  const p = (x, y) => pt(cx + x * w, by - y * h);
  return `M${p(-0.5, 0)}C${p(-0.62, 0.3)} ${p(-0.45, 0.5)} ${p(-0.3, 0.68)}`
    + `C${p(-0.27, 0.56)} ${p(-0.22, 0.48)} ${p(-0.14, 0.44)}`
    + `C${p(-0.2, 0.7)} ${p(-0.08, 0.88)} ${p(0.02, 1)}`
    + `C${p(0.1, 0.84)} ${p(0.22, 0.7)} ${p(0.17, 0.48)}`
    + `C${p(0.26, 0.52)} ${p(0.31, 0.6)} ${p(0.33, 0.72)}`
    + `C${p(0.52, 0.48)} ${p(0.64, 0.24)} ${p(0.5, 0)}`
    + `C${p(0.3, -0.12)} ${p(-0.3, -0.12)} ${p(-0.5, 0)}Z`;
}

/** A fire: four layers of flame from the flame color outside to an ivory heart, with a warm glow behind. */
export function fire(d, { cx, by, w, h, glow = 0.45 }) {
  const layers = [[1, 0], [0.78, 0.05], [0.55, 0.09], [0.3, 0.12]];
  const aura = glow > 0 ? ellipse(cx, by - h * 0.45, w * 1.3, h * 0.9, `fill="${glowFill(d, C.ember, glow)}"`) : '';
  return aura + layers.map(([k, up], i) => path(flamePath(cx, by - up * h, w * k, h * k),
    i === 0 ? `fill="${FLAME[0]}" stroke="${C.ink}" stroke-width="${r2(Math.max(1.5, w * 0.025))}" stroke-linejoin="round"` : `fill="${FLAME[i]}"`)).join('');
}

/**
 * A marble fireplace standing on `base`, `w` wide: a hearth, two pillars, a lintel and a mantel shelf around a dark
 * opening with an iron grate. `lit: false` leaves cold ash, one ember and a thread of smoke.
 */
export function fireplace(d, { cx, base, w, lit = true, flameH = null }) {
  const lw = thin(w);
  const hearthH = w * 0.05;
  const floor = base - hearthH;
  const h = w * 0.78;
  const top = floor - h;
  const ow = w * 0.6;
  const oh = h * 0.68;
  const oTop = floor - oh;
  const marble = hgrad(d, 'mantel', [[0, C.ivory], [0.6, C.ivory], [1, MIX.ivoryDark]]);
  const opening = `M${pt(cx - ow / 2, floor)}L${pt(cx - ow / 2, oTop + ow * 0.18)}A${r2(ow / 2)} ${r2(ow * 0.2)} 0 0 1 ${pt(cx + ow / 2, oTop + ow * 0.18)}L${pt(cx + ow / 2, floor)}Z`;
  const inside = vgrad(d, 'firebox', [[0, C.ink], [1, MIX.soot]]);
  const parts = [
    ellipse(cx, base, w * 0.66, w * 0.06, `fill="${MIX.floorDeep}" fill-opacity="0.7"`),
    rect(cx - w * 0.6, floor, w * 1.2, hearthH, `fill="${MIX.ivoryDark}" stroke="${C.ink}" stroke-width="${lw}"`),
    rect(cx - w / 2, top, w, h, `fill="${marble}" stroke="${C.ink}" stroke-width="${lw}"`),
    path(`M${pt(cx - w * 0.42, top + h * 0.12)}L${pt(cx - w * 0.42, floor)}M${pt(cx + w * 0.42, top + h * 0.12)}L${pt(cx + w * 0.42, floor)}`, `fill="none" stroke="${MIX.ivoryDeep}" stroke-width="${r2(Math.max(1, w * 0.008))}"`),
    rect(cx - w * 0.36, top + h * 0.06, w * 0.72, h * 0.12, `fill="none" stroke="${MIX.ivoryDeep}" stroke-width="${r2(Math.max(1, w * 0.008))}"`),
    rect(cx - w * 0.58, top - w * 0.06, w * 1.16, w * 0.06, `fill="${C.ivory}" stroke="${C.ink}" stroke-width="${lw}"`),
    rect(cx - w * 0.58, top - w * 0.012, w * 1.16, w * 0.012, `fill="${MIX.ivoryDark}"`),
    path(opening, `fill="${inside}" stroke="${C.ink}" stroke-width="${lw}"`),
  ];
  const grateY = floor - oh * 0.16;
  const grate = path(`M${pt(cx - ow * 0.36, grateY)}L${pt(cx + ow * 0.36, grateY)}`, `stroke="${MIX.iron}" stroke-width="${r2(w * 0.025)}" stroke-linecap="round"`)
    + [-0.26, -0.09, 0.09, 0.26].map((k) => path(`M${pt(cx + ow * k, grateY)}L${pt(cx + ow * k, floor - w * 0.005)}`, `stroke="${MIX.iron}" stroke-width="${r2(w * 0.018)}"`)).join('');
  if (lit) {
    const fh = flameH ?? oh * 0.85;
    parts.push(ellipse(cx, floor - oh * 0.35, ow * 0.62, oh * 0.62, `fill="${glowFill(d, C.ember, 0.55)}"`));
    parts.push(fire(d, { cx, by: grateY + w * 0.01, w: ow * 0.62, h: fh, glow: 0 }));
    parts.push(grate);
    parts.push(ellipse(cx, base + w * 0.04, w * 0.7, w * 0.1, `fill="${glowFill(d, C.ember, 0.4)}"`));
  } else {
    parts.push([-0.2, -0.05, 0.12, 0.25].map((k, i) => ellipse(cx + ow * k, grateY - w * 0.012, ow * (0.09 + (i % 2) * 0.03), w * 0.025, `fill="${MIX.ash}" stroke="${C.ink}" stroke-width="${lw}"`)).join(''));
    parts.push(circle(cx + ow * 0.02, grateY - w * 0.03, w * 0.012, `fill="${C.ember}" fill-opacity="0.85"`));
    parts.push(grate);
    parts.push(path(`M${pt(cx, grateY - w * 0.05)}C${pt(cx - w * 0.08, oTop + oh * 0.5)} ${pt(cx + w * 0.1, oTop + oh * 0.3)} ${pt(cx + w * 0.01, oTop + oh * 0.05)}`,
      `fill="none" stroke="${MIX.smoke}" stroke-opacity="0.5" stroke-width="${r2(w * 0.018)}" stroke-linecap="round"`));
  }
  return { markup: parts.join(''), mouth: { x: cx, y: oTop + oh * 0.25 }, opening: { x0: cx - ow / 2, x1: cx + ow / 2, top: oTop, bottom: floor }, top: top - w * 0.06 };
}

/** Sparks and broken bits of ONE rising from a fire: ember dots and small rose shards, smallest at the top. */
export function sparks(cx, cy, w, count = 8) {
  const spots = [[-0.3, 0.1, 1], [0.28, 0.28, 0.9], [-0.05, 0.5, 0.8], [0.38, 0.62, 0.66], [-0.38, 0.76, 0.58], [0.12, 0.94, 0.5], [-0.18, 1.12, 0.42], [0.3, 1.26, 0.34]];
  return spots.slice(0, count).map(([dx, up, k], i) => {
    const x = cx + dx * w;
    const y = cy - up * w;
    const s = w * 0.06 * k + 2.5;
    if (i % 3 === 1) return path(`M${pt(x - s, y + s * 0.5)}L${pt(x + s * 0.3, y - s)}L${pt(x + s, y + s * 0.3)}Z`, `fill="${C.rose}" fill-opacity="${r2(0.45 + k * 0.5)}" stroke="${C.ink}" stroke-width="${r2(Math.max(1, s * 0.2))}"`);
    return circle(x, y, s * 0.55, `fill="${i % 2 ? MIX.amber : C.ember}" fill-opacity="${r2(0.5 + k * 0.45)}"`);
  }).join('');
}

/**
 * The box's own pool: a round marble fountain basin `w` wide whose rim sits on `top`, full of teal water with coins
 * and ONE tokens floating in it. `items` is how many float there.
 */
export function pool(d, { cx, top, w, items = 4, seed = 3 }) {
  const lw = thin(w);
  const rim = w * 0.14;
  const bowlB = top + w * 0.3;
  const marble = hgrad(d, 'basin', [[0, C.ivory], [0.6, C.ivory], [1, MIX.ivoryDark]]);
  const water = vgrad(d, 'water', [[0, C.teal], [1, MIX.tealDark]]);
  const rand = seeded(seed);
  const parts = [
    ellipse(cx, top + w * 0.56, w * 0.5, w * 0.06, `fill="${MIX.floorDeep}" fill-opacity="0.7"`),
    rect(cx - w * 0.24, top + w * 0.47, w * 0.48, w * 0.07, `fill="${MIX.ivoryDark}" stroke="${C.ink}" stroke-width="${lw}"`),
    rect(cx - w * 0.08, bowlB - w * 0.02, w * 0.16, w * 0.2, `fill="${marble}" stroke="${C.ink}" stroke-width="${lw}"`),
    path(`M${pt(cx - w / 2, top)}C${pt(cx - w / 2, top + w * 0.2)} ${pt(cx - w * 0.28, bowlB)} ${pt(cx - w * 0.15, bowlB)}L${pt(cx + w * 0.15, bowlB)}C${pt(cx + w * 0.28, bowlB)} ${pt(cx + w / 2, top + w * 0.2)} ${pt(cx + w / 2, top)}Z`,
      `fill="${marble}" stroke="${C.ink}" stroke-width="${lw}"`),
    ellipse(cx, top, w / 2, rim, `fill="${C.ivory}" stroke="${C.ink}" stroke-width="${lw}"`),
    ellipse(cx, top + w * 0.008, w * 0.44, rim * 0.78, `fill="${water}" stroke="${MIX.tealDeep}" stroke-width="${lw}"`),
    ellipse(cx - w * 0.06, top + w * 0.01, w * 0.26, rim * 0.42, `fill="none" stroke="${MIX.tealLight}" stroke-opacity="0.6" stroke-width="${r2(Math.max(1, w * 0.008))}"`),
    ellipse(cx + w * 0.1, top + w * 0.02, w * 0.12, rim * 0.2, `fill="none" stroke="${MIX.tealLight}" stroke-opacity="0.45" stroke-width="${r2(Math.max(1, w * 0.007))}"`),
  ];
  const r = w * 0.055;
  for (let i = 0; i < items; i += 1) {
    const a = (i / Math.max(1, items)) * Math.PI * 2 + rand() * 0.6;
    const x = cx + Math.cos(a) * w * 0.25;
    const y = top + w * 0.01 + Math.sin(a) * rim * 0.42;
    parts.push(i % 2 ? flatToken(d, x, y, r, 0.38) : flatCoin(d, x, y, r, 0.38));
  }
  return parts.join('');
}

/**
 * A glass jar with a brass lid, standing on `base`, `w` wide, with fee coins inside up to `level` (0 to 1). `open`
 * leans the lid against the jar.
 */
export function jar(d, { cx, base, w, level = 0.7, open = false, seed = 9 }) {
  const lw = r2(Math.max(1.5, w * 0.012));
  const h = w * 1.15;
  const top = base - h;
  const neck = w * 0.1;
  const rand = seeded(seed);
  const glass = vgrad(d, 'jar-glass', [[0, MIX.glass, 0.16], [1, MIX.glass, 0.08]]);
  const body = roundRect(cx - w / 2, top + neck, w, h - neck, w * 0.16);
  const parts = [ellipse(cx, base, w * 0.6, w * 0.06, `fill="${MIX.floorDeep}" fill-opacity="0.7"`)];
  // Coins inside, lying in rows from the bottom up.
  const r = w * 0.1;
  const rows = Math.round(level * 7);
  for (let row = 0; row < rows; row += 1) {
    const y = base - w * 0.08 - row * r * 0.72;
    for (let i = 0; i < 4; i += 1) parts.push(flatCoin(d, cx - w * 0.3 + i * w * 0.2 + (rand() - 0.5) * r * 0.5 + (row % 2) * r * 0.4, y, r, 0.4));
  }
  parts.push(path(body, `fill="${glass}" stroke="${C.ivory}" stroke-opacity="0.85" stroke-width="${lw}"`));
  parts.push(rect(cx - w * 0.36, top, w * 0.72, neck + w * 0.02, `fill="${glass}" stroke="${C.ivory}" stroke-opacity="0.85" stroke-width="${lw}"`));
  parts.push(path(`M${pt(cx - w * 0.36, top + neck + w * 0.12)}L${pt(cx - w * 0.36, base - w * 0.16)}`, `fill="none" stroke="${MIX.shine}" stroke-opacity="0.4" stroke-width="${r2(w * 0.045)}" stroke-linecap="round"`));
  if (open) {
    // The lid lies on the floor beside the jar, seen from above at a slant.
    const lx = cx + w * 0.85;
    const ly = base - w * 0.05;
    parts.push(ellipse(lx, ly + w * 0.035, w * 0.4, w * 0.11, `fill="${MIX.brassDark}" stroke="${C.ink}" stroke-width="${lw}"`),
      ellipse(lx, ly, w * 0.4, w * 0.11, `fill="${C.brass}" stroke="${C.ink}" stroke-width="${lw}"`),
      ellipse(lx, ly, w * 0.3, w * 0.075, `fill="none" stroke="${MIX.brassLight}" stroke-opacity="0.7" stroke-width="${r2(Math.max(1, w * 0.012))}"`));
  } else {
    parts.push(rect(cx - w * 0.4, top - w * 0.1, w * 0.8, w * 0.11, `fill="${C.brass}" stroke="${C.ink}" stroke-width="${lw}" rx="${r2(w * 0.03)}"`),
      rect(cx - w * 0.36, top - w * 0.08, w * 0.72, w * 0.025, `fill="${MIX.brassLight}" fill-opacity="0.7"`));
  }
  return parts.join('');
}

/** A brass plaque with words on it, centred on (cx, cy): Square Hole's three parts. */
export function plaque({ cx, cy, text, size }) {
  const lines = Array.isArray(text) ? text : [text];
  const gap = 4.6;
  const s = size / 10;
  const textW = lettering(lines, { x: cx, y: 0, size, weight: 1.1, hair: 0.3, lineGap: gap, measure: true }).box.w;
  const textH = (lines.length * 10 + (lines.length - 1) * gap) * s;
  const w = textW + size * 1.8;
  const h = textH + size * 1.5;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const lw = r2(Math.max(1.5, size * 0.07));
  const words = lettering(lines, { x: cx, y: cy - textH / 2, size, color: C.ink, weight: 1.1, hair: 0.3, lineGap: gap }).markup;
  return rect(x + size * 0.15, y + size * 0.2, w, h, `fill="${C.ink}" fill-opacity="0.4" rx="${r2(size * 0.25)}"`)
    + rect(x, y, w, h, `fill="${C.brass}" stroke="${C.ink}" stroke-width="${lw}" rx="${r2(size * 0.25)}"`)
    + rect(x + size * 0.28, y + size * 0.28, w - size * 0.56, h - size * 0.56, `fill="none" stroke="${MIX.brassDark}" stroke-width="${r2(Math.max(1, size * 0.06))}" rx="${r2(size * 0.15)}"`)
    + path(`M${pt(x + size * 0.3, y + size * 0.18)}L${pt(x + w - size * 0.3, y + size * 0.18)}`, `stroke="${MIX.brassLight}" stroke-opacity="0.8" stroke-width="${r2(Math.max(1, size * 0.08))}"`)
    + words;
}

/**
 * An open ivory envelope centred on (cx, cy), `w` wide: where a slice goes when it is taken. `inside` is drawn
 * between its back and its front pocket, so strips of the bill can stand in it and show above its edge.
 */
export function envelope({ cx, cy, w, inside = '' }) {
  const h = w * 0.64;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const lw = r2(Math.max(1.5, w * 0.014));
  const flap = `M${pt(x, y)}L${pt(cx, y - h * 0.42)}L${pt(x + w, y)}Z`;
  const pocket = `M${pt(x, y + h * 0.16)}L${pt(cx, cy + h * 0.14)}L${pt(x + w, y + h * 0.16)}L${pt(x + w, y + h)}L${pt(x, y + h)}Z`;
  return rect(x + w * 0.04, y + w * 0.05, w, h, `fill="${C.ink}" fill-opacity="0.4"`)
    + path(flap, `fill="${MIX.ivoryDark}" stroke="${C.ink}" stroke-width="${lw}" stroke-linejoin="round"`)
    + rect(x, y, w, h, `fill="${MIX.ivoryDeep}" stroke="${C.ink}" stroke-width="${lw}"`)
    + inside
    + path(pocket, `fill="${C.ivory}" stroke="${C.ink}" stroke-width="${lw}" stroke-linejoin="round"`)
    + path(`M${pt(x, y + h)}L${pt(cx, cy + h * 0.24)}L${pt(x + w, y + h)}`, `fill="none" stroke="${MIX.ivoryDark}" stroke-width="${lw}"`);
}

/**
 * An arrow from (x1, y1) to (x2, y2) with an ink edge. `bend` curves it to one side, or `via` sets the point the
 * curve leans toward; `dash` makes it dashed (for things that fall), `head` is the size of its point.
 */
export function arrow({ x1, y1, x2, y2, bend = 0, via = null, color = C.ivory, width = 8, head = 24, dash = null }) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const [cx, cy] = via ?? [mx + (-(y2 - y1) / len) * bend, my + ((x2 - x1) / len) * bend];
  const tx = x2 - cx;
  const ty = y2 - cy;
  const tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl;
  const uy = ty / tl;
  const bx = x2 - ux * head * 0.85;
  const by = y2 - uy * head * 0.85;
  const shaft = `M${pt(x1, y1)}Q${pt(cx, cy)} ${pt(bx, by)}`;
  const edge = Math.max(2, width * 0.3);
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
  const tip = `M${pt(x2, y2)}L${pt(bx - uy * head * 0.55, by + ux * head * 0.55)}L${pt(bx + uy * head * 0.55, by - ux * head * 0.55)}Z`;
  return path(shaft, `fill="none" stroke="${C.ink}" stroke-width="${r2(width + edge * 2)}" stroke-linecap="round"${dashAttr}`)
    + path(shaft, `fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linecap="round"${dashAttr}`)
    + path(tip, `fill="${color}" stroke="${C.ink}" stroke-width="${r2(edge)}" stroke-linejoin="round"`);
}

/** A bracket under a group of things, from x1 to x2 at y, with a tick in the middle pointing down. */
export function brace({ x1, x2, y, color = C.ivory, width = 5, depth = 18 }) {
  const mid = (x1 + x2) / 2;
  const d = `M${pt(x1, y)}L${pt(x1, y + depth / 2)}L${pt(x2, y + depth / 2)}L${pt(x2, y)}M${pt(mid, y + depth / 2)}L${pt(mid, y + depth)}`;
  return path(d, `fill="none" stroke="${C.ink}" stroke-width="${r2(width + 4)}" stroke-linecap="round" stroke-linejoin="round"`)
    + path(d, `fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linecap="round" stroke-linejoin="round"`);
}

/** The raise: an ivory outline filled with silver up to `level`, and an ivory check mark once it is full. */
export function raiseBar({ x, y, w, h, level = 1 }) {
  const lw = r2(Math.max(2, h * 0.08));
  const fill = Math.max(0, Math.min(1, level));
  const check = fill >= 1 ? path(`M${pt(x + w + h * 0.5, y + h * 0.52)}L${pt(x + w + h * 0.85, y + h * 0.88)}L${pt(x + w + h * 1.55, y + h * 0.05)}`, `fill="none" stroke="${C.ink}" stroke-width="${r2(h * 0.3)}" stroke-linecap="round" stroke-linejoin="round"`)
    + path(`M${pt(x + w + h * 0.5, y + h * 0.52)}L${pt(x + w + h * 0.85, y + h * 0.88)}L${pt(x + w + h * 1.55, y + h * 0.05)}`, `fill="none" stroke="${C.ivory}" stroke-width="${r2(h * 0.17)}" stroke-linecap="round" stroke-linejoin="round"`) : '';
  return rect(x, y, w, h, `fill="${C.night}" stroke="${C.ink}" stroke-width="${r2(lw * 2)}" rx="${r2(h / 2)}"`)
    + rect(x + lw, y + lw, (w - 2 * lw) * fill, h - 2 * lw, `fill="${C.silver}" rx="${r2((h - 2 * lw) / 2)}"`)
    + rect(x, y, w, h, `fill="none" stroke="${C.ivory}" stroke-width="${lw}" rx="${r2(h / 2)}"`)
    + check;
}
