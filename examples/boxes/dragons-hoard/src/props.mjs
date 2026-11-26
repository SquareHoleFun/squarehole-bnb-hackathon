/**
 * Story props: the stone pool (the box's own pool), the fire in an iron brazier (a burn), the chest (fee coins that
 * wait), plates, arrows, braces, the raise bar and the lettering helpers. Every shape is a flat color with an ink
 * outline. These are plain symbols drawn for this kit, not anyone's product or logo.
 */
import { C, MIX, FLAME } from './palette.mjs';
import { lettering } from './type.mjs';
import { coin, flatCoin, pile } from './coins.mjs';
import { token } from './scales.mjs';
import { r2, pt, rect, circle, ellipse, path, group, inked, vgrad, glowFill } from './doc.mjs';

/** The gilt headline look: an ink outline, a dark bevel, the gold and a thin shine, in grid units. */
export const GILT = Object.freeze([[C.ink, 0.95, 0, 0, 1], [MIX.goldDeep, 0.3, 0.24, 0.24, 1], [C.gold, 0, 0, 0, 1], [MIX.goldLight, -0.72, -0.12, -0.12, 0.9]]);

/** Lettering in one color with an ink edge, so it reads on any part of the art. (x, y) is on the cap line. */
export function label(text, { x, y, size, color = C.vellum, anchor = 'middle', sw = 1.05, edge = true }) {
  const layers = edge ? [[C.ink, 0.9, 0, 0, 1], [color, 0, 0, 0, 1]] : [[color, 0, 0, 0, 1]];
  return lettering(text, { x, y, size, sw, anchor, layers }).markup;
}

/** Gilt lettering for names and titles. */
export function gilt(text, { x, y, size, anchor = 'middle', sw = 0.95 }) {
  return lettering(text, { x, y, size, sw, anchor, layers: GILT });
}

/** The outline of a flame with three tongues, its base centred on (cx, by), `w` wide and `h` tall. */
export function flamePath(cx, by, w, h) {
  const p = (x, y) => pt(cx + x * w, by + y * h);
  return `M${p(-0.46, 0)}C${p(-0.64, -0.24)} ${p(-0.5, -0.44)} ${p(-0.33, -0.64)}`
    + `C${p(-0.3, -0.52)} ${p(-0.26, -0.45)} ${p(-0.17, -0.42)}`
    + `C${p(-0.2, -0.66)} ${p(-0.1, -0.84)} ${p(0.03, -1)}`
    + `C${p(0.09, -0.8)} ${p(0.23, -0.68)} ${p(0.2, -0.5)}`
    + `C${p(0.28, -0.56)} ${p(0.34, -0.62)} ${p(0.37, -0.74)}`
    + `C${p(0.56, -0.44)} ${p(0.62, -0.16)} ${p(0.46, 0)}Q${p(0, 0.1)} ${p(-0.46, 0)}Z`;
}

/** A fire: flames in four layers from vermilion outside to a vellum core, with a warm glow behind. */
export function fire(doc, { cx, by, w, h, glow = 0.42, outline = null }) {
  const o = outline ?? Math.max(2.5, w * 0.03);
  const layers = [[1, 0], [0.8, 0.04], [0.58, 0.08], [0.34, 0.11]];
  const aura = glow > 0 ? ellipse(cx, by - h * 0.45, w * 1.2, h * 0.85, `fill="${glowFill(doc, C.ember, glow)}"`) : '';
  return aura + layers.map(([k, up], i) => path(flamePath(cx, by - up * h, w * k, h * k),
    i === 0 ? inked(FLAME[0], C.ink, o) : `fill="${FLAME[i]}"`)).join('');
}

/**
 * An iron brazier standing on `bottom`: a foot, a stem and a bowl `w` wide, with a fire in it. `lit: false` leaves
 * glowing coals and a thread of smoke instead.
 */
export function brazier(doc, { cx, bottom, w, flameH = null, lit = true }) {
  const o = Math.max(3, w * 0.035);
  const bowlTop = bottom - w * 0.62;
  const bowlH = w * 0.26;
  const foot = path(`M${pt(cx - w * 0.3, bottom)}L${pt(cx - w * 0.16, bottom - w * 0.12)}L${pt(cx + w * 0.16, bottom - w * 0.12)}L${pt(cx + w * 0.3, bottom)}Z`, inked(MIX.iron, C.ink, o));
  const stem = rect(cx - w * 0.07, bowlTop + bowlH * 0.6, w * 0.14, bottom - w * 0.12 - (bowlTop + bowlH * 0.6), inked(MIX.iron, C.ink, o));
  const bowl = path(`M${pt(cx - w / 2, bowlTop)}C${pt(cx - w * 0.46, bowlTop + bowlH * 1.2)} ${pt(cx + w * 0.46, bowlTop + bowlH * 1.2)} ${pt(cx + w / 2, bowlTop)}Z`, inked(MIX.iron, C.ink, o))
    + path(`M${pt(cx + w * 0.12, bowlTop + bowlH * 0.82)}C${pt(cx + w * 0.3, bowlTop + bowlH * 0.7)} ${pt(cx + w * 0.42, bowlTop + bowlH * 0.4)} ${pt(cx + w * 0.46, bowlTop + bowlH * 0.08)}`, `fill="none" stroke="${C.stone}" stroke-opacity="0.5" stroke-width="${r2(o)}" stroke-linecap="round"`);
  const rim = ellipse(cx, bowlTop, w / 2, w * 0.07, inked(C.stone, C.ink, o));
  if (!lit) {
    const coals = [[-0.22, 0.2], [0, 0.24], [0.21, 0.18], [-0.1, 0.16], [0.11, 0.15]]
      .map(([dx, k]) => ellipse(cx + dx * w, bowlTop - w * 0.01, w * k * 0.55, w * k * 0.3, inked(MIX.redDark, C.ink, o * 0.7))).join('')
      + circle(cx + w * 0.03, bowlTop - w * 0.03, w * 0.045, `fill="${C.ember}" fill-opacity="0.75"`);
    const smoke = path(`M${pt(cx, bowlTop - w * 0.08)}C${pt(cx - w * 0.16, bowlTop - w * 0.34)} ${pt(cx + w * 0.18, bowlTop - w * 0.5)} ${pt(cx, bowlTop - w * 0.78)}S${pt(cx + w * 0.1, bowlTop - w * 1.08)} ${pt(cx + w * 0.02, bowlTop - w * 1.24)}`,
      `fill="none" stroke="${C.stone}" stroke-opacity="0.55" stroke-width="${r2(w * 0.04)}" stroke-linecap="round"`);
    return foot + stem + bowl + rim + coals + smoke;
  }
  const fh = flameH ?? w * 1.1;
  return fire(doc, { cx, by: bowlTop + w * 0.03, w: w * 0.86, h: fh }) + foot + stem + bowl + rim
    + ellipse(cx, bowlTop, w * 0.42, w * 0.045, `fill="${C.ember}"`);
}

/** Sparks and scale bits rising from a fire: small ember dots and broken jade pieces, smallest at the top. */
export function sparks(cx, cy, w, count = 9) {
  const spots = [[-0.32, 0.1, 1], [0.26, 0.3, 0.9], [-0.06, 0.52, 0.8], [0.4, 0.66, 0.66], [-0.4, 0.8, 0.6], [0.12, 0.98, 0.5], [-0.2, 1.16, 0.42], [0.32, 1.3, 0.34], [0.02, 1.44, 0.28]];
  return spots.slice(0, count).map(([dx, up, k], i) => {
    const x = cx + dx * w;
    const y = cy - up * w;
    const s = w * 0.07 * k + 3;
    if (i % 3 === 1) {
      return path(`M${pt(x - s, y + s * 0.6)}L${pt(x + s * 0.2, y - s)}L${pt(x + s, y + s * 0.4)}Z`, `fill="${C.jade}" fill-opacity="${r2(0.4 + k * 0.6)}" stroke="${C.ink}" stroke-width="${r2(Math.max(1.5, s * 0.25))}"`);
    }
    return circle(x, y, s * 0.6, `fill="${i % 2 ? C.gold : C.ember}" fill-opacity="${r2(0.35 + k * 0.6)}"`);
  }).join('');
}

/**
 * The box's own pool: a wide stone basin seen from the front, holding water with coins and HOARD tokens in it.
 * (cx, top) is the middle of the rim, `w` its width and `h` the height of the basin's wall below the rim.
 */
export function pool(doc, { cx, top, w, h = null, items = 6 }) {
  const o = Math.max(3, w * 0.014);
  const wallH = h ?? w * 0.24;
  const ry = w * 0.2;
  const rim = w * 0.055;
  const bottom = top + wallH;
  const outline = `M${pt(cx - w / 2, top)}L${pt(cx - w * 0.45, bottom)}Q${pt(cx, bottom + ry * 0.75)} ${pt(cx + w * 0.45, bottom)}L${pt(cx + w / 2, top)}`;
  const wall = path(`${outline}A${r2(w / 2)} ${r2(ry)} 0 0 1 ${pt(cx - w / 2, top)}Z`, `fill="${C.stone}"`);
  const shade = path(`M${pt(cx + w * 0.2, top + ry * 0.92)}L${pt(cx + w * 0.19, bottom + ry * 0.68)}Q${pt(cx + w * 0.36, bottom + ry * 0.45)} ${pt(cx + w * 0.45, bottom)}L${pt(cx + w / 2, top)}A${r2(w / 2)} ${r2(ry)} 0 0 1 ${pt(cx + w * 0.2, top + ry * 0.92)}Z`, `fill="${MIX.stoneDark}"`);
  const seams = [-0.27, 0, 0.27].map((f) => `M${pt(cx + f * w, top + ry * Math.sqrt(1 - (2 * f) ** 2) * 0.98)}L${pt(cx + f * w * 0.97, bottom + ry * 0.75 * (1 - (2 * f * 0.97) ** 2))}`).join('');
  const water = vgrad(doc, 'pool-water', [[0, MIX.water], [1, MIX.waterDeep]]);
  const inRx = w / 2 - rim;
  const inRy = ry - rim * 0.6;
  const stuff = [];
  const n = Math.max(0, items);
  const r = w * 0.055;
  for (let i = 0; i < n; i += 1) {
    const f = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
    const x = cx + f * inRx * 0.66;
    const y = top + inRy * 0.18 - (i % 2) * inRy * 0.42 + (1 - f * f) * inRy * 0.2;
    stuff.push(i % 2 === 0 ? coin(x, y, r) : token(doc, x, y, r));
  }
  const ripples = [0.42, 0.7].map((k) => `M${pt(cx - inRx * k, top + inRy * 0.05)}Q${pt(cx, top + inRy * (0.05 + k * 0.62))} ${pt(cx + inRx * k, top + inRy * 0.05)}`).join('');
  const lip = `M${pt(cx - inRx, top + rim * 0.2)}A${r2(inRx)} ${r2(inRy)} 0 0 0 ${pt(cx + inRx, top + rim * 0.2)}L${pt(cx + w / 2, top)}A${r2(w / 2)} ${r2(ry)} 0 0 1 ${pt(cx - w / 2, top)}Z`;
  return ellipse(cx, bottom + ry * 0.5, w * 0.52, ry * 0.42, `fill="${MIX.nightDeep}" fill-opacity="0.7"`)
    + wall + shade
    + path(seams, `fill="none" stroke="${C.ink}" stroke-opacity="0.3" stroke-width="${r2(o * 0.7)}"`)
    + path(outline, `fill="none" stroke="${C.ink}" stroke-width="${r2(o)}" stroke-linejoin="round"`)
    + ellipse(cx, top, w / 2, ry, inked(MIX.stoneLight, C.ink, o))
    + ellipse(cx, top + rim * 0.2, inRx, inRy, inked(water, C.ink, o * 0.8))
    + path(ripples, `fill="none" stroke="${C.vellum}" stroke-opacity="0.25" stroke-width="${r2(o * 0.8)}" stroke-linecap="round"`)
    + stuff.join('')
    + path(lip, inked(MIX.stoneLight, C.ink, o));
}

/**
 * A wooden chest with iron bands, standing on `bottom`, `w` wide. Closed, it keeps fee coins that wait. Open, its lid
 * stands back and `coins` shows how full it is, from 0 (empty) to 1 (heaped).
 */
export function chest({ cx, bottom, w, open = false, coins = 0, seed = 21 }) {
  const o = Math.max(3, w * 0.022);
  const bh = w * 0.5;
  const top = bottom - bh;
  const x = cx - w / 2;
  const lidH = w * 0.26;
  const bands = [0.17, 0.83].map((f) => rect(x + f * w - w * 0.045, top, w * 0.09, bh, inked(MIX.iron, C.ink, o * 0.8))).join('');
  const planks = path([0.33, 0.66].map((k) => `M${pt(x + o, top + bh * k)}L${pt(x + w - o, top + bh * k)}`).join(''), `fill="none" stroke="${MIX.woodDark}" stroke-width="${r2(o * 0.8)}"`);
  const body = rect(x, top, w, bh, `rx="${r2(w * 0.03)}" ${inked(MIX.wood, C.ink, o)}`) + planks + bands;
  const lock = rect(cx - w * 0.07, top - w * 0.02, w * 0.14, w * 0.15, `rx="${r2(w * 0.015)}" ${inked(MIX.iron, C.ink, o * 0.8)}`)
    + circle(cx, top + w * 0.04, w * 0.022, `fill="${C.gold}"`) + rect(cx - w * 0.008, top + w * 0.045, w * 0.016, w * 0.04, `fill="${C.gold}"`);
  if (!open) {
    const lid = path(`M${pt(x, top)}L${pt(x, top - lidH * 0.45)}Q${pt(x, top - lidH)} ${pt(cx, top - lidH)}Q${pt(x + w, top - lidH)} ${pt(x + w, top - lidH * 0.45)}L${pt(x + w, top)}Z`, inked(MIX.wood, C.ink, o));
    const lidBands = [0.17, 0.83].map((f) => path(`M${pt(x + f * w - w * 0.045, top)}L${pt(x + f * w - w * 0.045, top - lidH * (f < 0.5 ? 0.78 : 0.78))}L${pt(x + f * w + w * 0.045, top - lidH * 0.84)}L${pt(x + f * w + w * 0.045, top)}Z`, inked(MIX.iron, C.ink, o * 0.8))).join('');
    return body + lid + lidBands + rect(x, top - o * 0.5, w, w * 0.035, inked(MIX.iron, C.ink, o * 0.8)) + lock;
  }
  const lidBack = path(`M${pt(x + w * 0.02, top - w * 0.02)}L${pt(x - w * 0.02, top - lidH * 1.7)}Q${pt(cx, top - lidH * 2.05)} ${pt(x + w * 1.02, top - lidH * 1.7)}L${pt(x + w * 0.98, top - w * 0.02)}Z`, inked(MIX.woodDark, C.ink, o));
  const lidRim = path(`M${pt(x - w * 0.02, top - lidH * 1.7)}Q${pt(cx, top - lidH * 2.05)} ${pt(x + w * 1.02, top - lidH * 1.7)}`, `fill="none" stroke="${MIX.iron}" stroke-width="${r2(w * 0.05)}" stroke-linecap="round"`);
  const inside = rect(x + o, top - w * 0.02, w - 2 * o, w * 0.07, `fill="${MIX.woodDark}"`);
  const heap = coins > 0 ? pile(cx, top + w * 0.05, w * 0.92, w * 0.32 * coins, { seed, coinR: w * 0.06, spill: false, peak: false }) : '';
  return lidBack + lidRim + inside + heap + body + rect(x, top - o * 0.5, w, w * 0.035, inked(MIX.iron, C.ink, o * 0.8)) + lock;
}

/** A stone plate with gilt-edged corners and lettering, for names such as SQUARE HOLE. */
export function plate({ cx, cy, text, size, color = C.vellum }) {
  const probe = lettering(text, { x: cx, y: 0, size, sw: 1.05, measure: true });
  const capsH = probe.box.h + 2 * probe.box.y;
  const w = probe.box.w + size * 1.9;
  const h = capsH + size * 1.7;
  const o = Math.max(3, size * 0.12);
  return rect(cx - w / 2, cy - h / 2, w, h, `rx="${r2(size * 0.3)}" ${inked(C.lapis, C.ink, o)}`)
    + rect(cx - w / 2 + size * 0.35, cy - h / 2 + size * 0.35, w - size * 0.7, h - size * 0.7, `rx="${r2(size * 0.18)}" fill="none" stroke="${C.gold}" stroke-opacity="0.65" stroke-width="${r2(o * 0.55)}"`)
    + label(text, { x: cx, y: cy - capsH / 2, size, color, edge: false });
}

/** A thick arrow with an ink edge from (x1, y1) to (x2, y2), bent sideways by `bend`. */
export function arrow({ x1, y1, x2, y2, bend = 0, color = C.vellum, width = 12, head = 34, dash = null, opacity = 1 }) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const qx = mx + (-(y2 - y1) / len) * bend;
  const qy = my + ((x2 - x1) / len) * bend;
  const ang = Math.atan2(y2 - qy, x2 - qx);
  const bx = x2 - Math.cos(ang) * head * 0.8;
  const by = y2 - Math.sin(ang) * head * 0.8;
  const side = (s) => [bx + Math.cos(ang + (s * Math.PI) / 2) * head * 0.52, by + Math.sin(ang + (s * Math.PI) / 2) * head * 0.52];
  const [lx, ly] = side(1);
  const [rx, ry] = side(-1);
  const line = `M${pt(x1, y1)}Q${pt(qx, qy)} ${pt(bx, by)}`;
  const tip = `M${pt(x2, y2)}L${pt(lx, ly)}L${pt(rx, ry)}Z`;
  const edge = Math.max(2.5, width * 0.32);
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
  return group(opacity < 1 ? `opacity="${r2(opacity)}"` : '',
    path(line, `fill="none" stroke="${C.ink}" stroke-width="${r2(width + 2 * edge)}" stroke-linecap="round"${dashAttr}`),
    path(tip, `fill="${C.ink}" stroke="${C.ink}" stroke-width="${r2(2 * edge + width * 0.3)}" stroke-linejoin="round"`),
    path(line, `fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linecap="round"${dashAttr}`),
    path(tip, `fill="${color}" stroke="${color}" stroke-width="${r2(width * 0.3)}" stroke-linejoin="round"`));
}

/** A brace under a group of things, from x1 to x2, with its tip pointing down at the middle. */
export function brace({ x1, x2, y, color, width = 8, depth = 24 }) {
  const mx = (x1 + x2) / 2;
  const d = `M${pt(x1, y)}V${r2(y + depth)}H${r2(x2)}V${r2(y)}M${pt(mx, y + depth)}V${r2(y + depth * 1.9)}`;
  return path(d, `fill="none" stroke="${C.ink}" stroke-width="${r2(width + 6)}" stroke-linecap="round" stroke-linejoin="round"`)
    + path(d, `fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linecap="round" stroke-linejoin="round"`);
}

/** The raise bar: a rounded outline filled to `level` (0 to 1), with a check mark beside it when full. */
export function raiseBar({ x, y, w, h, level = 1 }) {
  const o = Math.max(3, h * 0.14);
  const inner = h - 2 * o - 4;
  const check = level >= 1
    ? path(`M${pt(x + w + h * 0.5, y + h * 0.52)}L${pt(x + w + h * 0.85, y + h * 0.88)}L${pt(x + w + h * 1.55, y + h * 0.08)}`, `fill="none" stroke="${C.ink}" stroke-width="${r2(o * 3.4)}" stroke-linecap="round" stroke-linejoin="round"`)
      + path(`M${pt(x + w + h * 0.5, y + h * 0.52)}L${pt(x + w + h * 0.85, y + h * 0.88)}L${pt(x + w + h * 1.55, y + h * 0.08)}`, `fill="none" stroke="${C.jade}" stroke-width="${r2(o * 2)}" stroke-linecap="round" stroke-linejoin="round"`)
    : '';
  return rect(x, y, w, h, `rx="${r2(h / 2)}" ${inked(C.night, C.ink, o * 2.2)}`)
    + rect(x, y, w, h, `rx="${r2(h / 2)}" fill="none" stroke="${C.vellum}" stroke-width="${r2(o)}"`)
    + rect(x + o + 2, y + o + 2, (w - 2 * o - 4) * level, inner, `rx="${r2(inner / 2)}" fill="${C.gold}"`)
    + check;
}

export { coin, flatCoin, token };
