/**
 * The GPU card: a plain graphics card seen from the fan side, built from parts on a module u.
 * The box itself holds no GPU, so most pictures show an empty dashed outline where one should be.
 * The same parts can build the later GPU items: `gpuParts(id)` gives every id from 1 to 1,024 its own mix.
 *
 * Card sizes in modules: 11 tall; 17 long with one fan, 28 with two, 39 with three, 28 for a blower.
 */
import { C, HEAT, MIX } from './palette.mjs';
import { rect, circle, path, group, r2 } from './doc.mjs';
import { heatGlow } from './heat.mjs';

export const CARD_H = 11;
const LENGTH = { 1: 17, 2: 28, 3: 39, blower: 28 };
const FAN_R = 4.7;
const FAN_STEP = 10.7;

/** Card length in modules for a fan count (1, 2, 3 or 'blower'). */
export const cardLength = (fans) => LENGTH[fans];

/** Fan centres along the card, in modules from its left edge. */
function fanCentres(fans) {
  if (fans === 'blower') return [LENGTH.blower - 6.2];
  const L = LENGTH[fans];
  return Array.from({ length: fans }, (_, i) => L / 2 + (i - (fans - 1) / 2) * FAN_STEP);
}

const SHROUD = {
  dark: { fill: C.panel, line: C.rim, blade: MIX.chip },
  steel: { fill: MIX.steel, line: C.rim, blade: C.panel },
  white: { fill: C.paper, line: MIX.tapeLine, blade: MIX.bladeLight },
  bare: { fill: 'none', line: C.rim, blade: MIX.chip },
};

/** One fan: a dark opening, heat bands behind the blades, seven curved blades and a hub. */
function fan(cx, cy, u, { heat, blade, hubFill, size = 1 }) {
  const R = FAN_R * u * size;
  const out = [circle(cx, cy, R * 1.04, `fill="${MIX.deepNight}" stroke="${C.rim}" stroke-width="${r2(u * 0.3)}"`)];
  for (let i = 0; i <= heat; i += 1) out.push(circle(cx, cy, R * (0.92 - i * 0.17), `fill="${HEAT[i]}"`));
  const blades = [];
  const n = 7;
  for (let i = 0; i < n; i += 1) {
    const a0 = (i / n) * Math.PI * 2;
    const pt = (a, r) => `${r2(cx + Math.cos(a) * r)} ${r2(cy + Math.sin(a) * r)}`;
    const hubR = R * 0.3;
    const tipR = R * 0.93;
    const d = `M${pt(a0, hubR)}Q${pt(a0 + 0.42, R * 0.62)} ${pt(a0 + 0.62, tipR)}A${r2(tipR)} ${r2(tipR)} 0 0 1 ${pt(a0 + 1.05, tipR)}Q${pt(a0 + 0.62, R * 0.55)} ${pt(a0 + 0.42, hubR)}Z`;
    blades.push(d);
  }
  out.push(path(blades.join(''), `fill="${blade}" fill-opacity="0.92"`));
  out.push(circle(cx, cy, R * 0.3, `fill="${hubFill}" stroke="${C.rim}" stroke-width="${r2(u * 0.2)}"`));
  out.push(circle(cx, cy, R * 0.1, `fill="${HEAT[Math.min(heat, 4)]}"`));
  return out.join('');
}

/** A strip of tape stuck across the card, with a torn look at both ends. */
function tape(x, y, len, w, angle) {
  const dashes = Array.from({ length: Math.floor(len / (w * 0.9)) }, (_, i) => rect(x + w * 0.5 + i * w * 0.9, y + w * 0.2, w * 0.08, w * 0.6, `fill="${MIX.tapeLine}" fill-opacity="0.6"`)).join('');
  const torn = `M${r2(x)} ${r2(y)}L${r2(x + len)} ${r2(y)}L${r2(x + len - w * 0.12)} ${r2(y + w * 0.3)}L${r2(x + len + w * 0.05)} ${r2(y + w * 0.62)}L${r2(x + len - w * 0.1)} ${r2(y + w)}L${r2(x)} ${r2(y + w)}L${r2(x + w * 0.14)} ${r2(y + w * 0.7)}L${r2(x - w * 0.05)} ${r2(y + w * 0.4)}Z`;
  return group(`transform="rotate(${r2(angle)} ${r2(x + len / 2)} ${r2(y + w / 2)})"`, path(torn, `fill="${MIX.tape}" fill-opacity="0.92"`), dashes);
}

/**
 * A GPU card with its top-left shroud corner at (x, y) and module u.
 * fans: 1, 2, 3 or 'blower'. shroud: dark, steel, white or bare. heat: 0 to 4. fix: clean, tape, zip or missing.
 * accent: a stripe color. glow: the heat the card throws on the wall (0 for none).
 */
export function gpu(doc, { x, y, u, fans = 2, shroud = 'dark', heat = 2, fix = 'clean', accent = C.magenta, glow = 0.3 }) {
  const L = LENGTH[fans] * u;
  const H = CARD_H * u;
  const s = SHROUD[shroud];
  const out = [];
  if (glow > 0) out.push(heatGlow(doc, x + L / 2, y + H / 2, L * 0.72, H * 1.3, HEAT[Math.min(heat + 1, 3)], glow));
  // Bracket: the metal plate at the left end, with vent slots and the tab that screws into a case.
  out.push(rect(x - 1.7 * u, y - 1.1 * u, 1.3 * u, H + 3.4 * u, `rx="${r2(0.3 * u)}" fill="${MIX.steel}"`));
  for (let i = 0; i < 4; i += 1) out.push(rect(x - 1.35 * u, y + (1.2 + i * 2.2) * u, 0.6 * u, 1.4 * u, `rx="${r2(0.3 * u)}" fill="${MIX.deepNight}"`));
  // Board edge and gold fingers.
  out.push(rect(x + 0.6 * u, y + H - 0.4 * u, L - 1.4 * u, 1.2 * u, `fill="${MIX.chip}"`));
  const fingers = [];
  for (let i = 0; i < 17; i += 1) fingers.push(rect(x + (3.2 + i * 0.62) * u, y + H + 0.8 * u, 0.42 * u, 1.3 * u, `fill="${C.amber}" fill-opacity="0.85"`));
  out.push(fingers.join(''));
  // Power plug on the top edge.
  out.push(rect(x + L - 7.4 * u, y - 1.3 * u, 3.6 * u, 1.6 * u, `rx="${r2(0.25 * u)}" fill="${MIX.steel}"`));
  out.push(rect(x + L - 6.9 * u, y - 0.95 * u, 2.6 * u, 0.5 * u, `fill="${MIX.deepNight}"`));
  // Shroud, or bare fins.
  if (shroud === 'bare') {
    const fins = [];
    for (let fx = x + 0.8 * u; fx < x + L - 0.6 * u; fx += 0.9 * u) fins.push(rect(fx, y + 0.5 * u, 0.32 * u, H - 1.1 * u, `fill="${C.rim}"`));
    out.push(rect(x, y + 0.3 * u, L, H - 0.6 * u, `rx="${r2(0.6 * u)}" fill="${MIX.chip}"`), fins.join(''));
  } else {
    out.push(rect(x, y, L, H, `rx="${r2(1.6 * u)}" fill="${s.fill}" stroke="${s.line}" stroke-width="${r2(0.35 * u)}"`));
    out.push(rect(x + 1.6 * u, y + 0.9 * u, L - 3.2 * u, 0.4 * u, `rx="${r2(0.2 * u)}" fill="${accent}"`));
    out.push(rect(x + 1.6 * u, y + H - 1.3 * u, (L - 3.2 * u) * 0.35, 0.4 * u, `rx="${r2(0.2 * u)}" fill="${accent}" fill-opacity="0.7"`));
  }
  const cy = y + H / 2;
  const centres = fanCentres(fans);
  const size = fans === 'blower' ? 0.82 : 1;
  if (fans === 'blower') {
    // A blower card: a closed shroud with a grille and one small fan at the far end.
    for (let i = 0; i < 6; i += 1) out.push(rect(x + (2.4 + i * 2.6) * u, y + 3.1 * u, 1.4 * u, H - 6.2 * u, `rx="${r2(0.5 * u)}" fill="${MIX.deepNight}" fill-opacity="0.85"`));
  }
  centres.forEach((fx, i) => {
    const missing = fix === 'missing' && i === centres.length - 1;
    const fcx = x + fx * u;
    if (missing) {
      const R = FAN_R * u * size;
      out.push(circle(fcx, cy, R * 1.04, `fill="${MIX.deepNight}" stroke="${C.rim}" stroke-width="${r2(u * 0.3)}"`));
      out.push(tape(fcx - R * 1.15, cy - u * 0.9, R * 2.3, u * 1.8, 38), tape(fcx - R * 1.15, cy - u * 0.9, R * 2.3, u * 1.8, -38));
    } else {
      out.push(fan(fcx, cy, u, { heat, blade: s.blade, hubFill: shroud === 'white' ? C.paper : C.panel, size }));
    }
  });
  if (fix === 'tape') out.push(tape(x + L * 0.18, y + H * 0.38, L * 0.62, u * 1.9, -9));
  if (fix === 'zip') {
    for (const f of [0.08, 0.92]) {
      const zx = x + L * f;
      out.push(rect(zx - 0.35 * u, y - 0.9 * u, 0.7 * u, H + 1.8 * u, `rx="${r2(0.35 * u)}" fill="${C.paper}" fill-opacity="0.9"`));
      out.push(rect(zx - 0.7 * u, y - 1.5 * u, 1.4 * u, 1.1 * u, `rx="${r2(0.25 * u)}" fill="${C.paper}"`));
    }
  }
  return { markup: out.join(''), box: { x: x - 1.7 * u, y: y - 1.3 * u, w: L + 1.7 * u, h: H + 3.4 * u }, fans: centres.map((fx) => [x + fx * u, cy]) };
}

/** The empty place where a GPU should be: a dashed outline over an empty slot. */
export function emptyGpu({ x, y, u, fans = 2, color = C.violet, opacity = 0.7 }) {
  const L = LENGTH[fans] * u;
  const H = CARD_H * u;
  const dash = `stroke-dasharray="${r2(1.4 * u)} ${r2(1.1 * u)}"`;
  const line = `fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${r2(0.4 * u)}" stroke-linecap="round" ${dash}`;
  const fansMarkup = fanCentres(fans).map((fx) => circle(x + fx * u, y + H / 2, FAN_R * u, line)).join('');
  return rect(x, y, L, H, `rx="${r2(1.6 * u)}" ${line}`) + fansMarkup;
}

/** A slot on a board: where a card's gold fingers would go. */
export function slot({ x, y, len, u }) {
  return rect(x, y, len, 1.6 * u, `rx="${r2(0.4 * u)}" fill="${C.panel}" stroke="${C.rim}" stroke-width="${r2(0.25 * u)}"`)
    + rect(x + 0.6 * u, y + 0.55 * u, len - 1.2 * u, 0.5 * u, `fill="${MIX.deepNight}"`)
    + rect(x + len - 0.2 * u, y - 0.5 * u, 1.2 * u, 2.6 * u, `rx="${r2(0.3 * u)}" fill="${MIX.steel}"`);
}

/**
 * The later GPU items: every id from 1 to 1,024 gets one mix of five parts with four choices each (4^5 = 1,024).
 * The id is shuffled by a fixed, reversible rule first, so neighbouring ids look different and every mix appears
 * exactly once across 1,024 ids. Each choice appears on exactly 256 GPUs. No part is rarer than another.
 */
export const GPU_TRAITS = Object.freeze({
  fans: Object.freeze([1, 2, 3, 'blower']),
  shroud: Object.freeze(['dark', 'steel', 'white', 'bare']),
  heat: Object.freeze([1, 2, 3, 4]),
  fix: Object.freeze(['clean', 'tape', 'zip', 'missing']),
  accent: Object.freeze(['ice', 'violet', 'magenta', 'amber']),
});
export const GPU_COUNT = 1024;

/** The fixed shuffle: id 1 to 1,024 maps to a 10-bit code, each code exactly once. */
export function gpuCode(id) {
  if (!Number.isInteger(id) || id < 1 || id > GPU_COUNT) throw new RangeError('GPU id must be a whole number from 1 to 1024');
  let x = ((id - 1) * 717 + 321) & 1023;
  x ^= x >> 5;
  return x;
}

/** The parts of GPU number `id`. */
export function gpuParts(id) {
  const code = gpuCode(id);
  const pick = (name, shift) => GPU_TRAITS[name][(code >> shift) & 3];
  return { id, code, fans: pick('fans', 0), shroud: pick('shroud', 2), heat: pick('heat', 4), fix: pick('fix', 6), accent: C[pick('accent', 8)] };
}
