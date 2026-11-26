/**
 * The engraver's tools. Pictures in this kit are drawn the way a plate engraver works: a shape is paper inside an ink
 * outline, and tone comes from lines, never from gradients or see-through color. Shade is parallel hatching, deep
 * shade is crosshatching, skies are ruled lines that open up toward the horizon, and the frames are guilloche: bands
 * and rosettes of interlaced curves, as on old share certificates.
 */
import { C } from './palette.mjs';
import { group, p1, pt, r2, seeded } from './doc.mjs';

/** An outlined shape: paper (or `fill`) inside an ink line. */
export const shape = (d, fill = C.paper, width = 2.4, stroke = C.ink) =>
  `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${r2(width)}" stroke-linejoin="round" stroke-linecap="round"/>`;

/** A flat fill with no outline. */
export const fill = (d, color) => `<path d="${d}" fill="${color}"/>`;

/** A line (or an outline with no fill). */
export const line = (d, color = C.ink, width = 2, extra = '') =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linecap="round" stroke-linejoin="round"${extra ? ` ${extra}` : ''}/>`;

/** A perforation: a dotted line, as torn paper has. */
export const perforation = (d, color = C.ink, width = 2.2, step = 9) =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linecap="round" stroke-dasharray="0.1 ${r2(step)}"/>`;

/** Parallel lines across a box at an angle (degrees), as path data. */
function rule(box, angle, gap, offset = 0) {
  const { x, y, w, h } = box;
  const [cx, cy] = [x + w / 2, y + h / 2];
  const reach = Math.hypot(w, h) / 2 + gap;
  const a = (angle * Math.PI) / 180;
  const [dx, dy] = [Math.cos(a), Math.sin(a)];
  const [nx, ny] = [-dy, dx];
  let d = '';
  for (let t = -reach + (offset % gap); t <= reach; t += gap) {
    const [px, py] = [cx + nx * t, cy + ny * t];
    d += `M${pt(px - dx * reach, py - dy * reach)}L${pt(px + dx * reach, py + dy * reach)}`;
  }
  return d;
}

/**
 * Hatching: parallel lines inside the path `d` (clipped), across `box`. `within` narrows it further to a second
 * path, so a shade can cover only part of a shape.
 */
export function hatch(doc, d, box, { angle = 45, gap = 6, width = 1.2, color = C.ink, within = null, offset = 0 } = {}) {
  const lines = `<path d="${rule(box, angle, gap, offset)}" fill="none" stroke="${color}" stroke-width="${r2(width)}"/>`;
  const inner = within ? group(doc.clip(within), lines) : lines;
  return group(doc.clip(d), inner);
}

/** Crosshatching: two sets of lines for a deeper shade. */
export function crosshatch(doc, d, box, { angle = 45, cross = 90, ...opts } = {}) {
  return [hatch(doc, d, box, { angle, ...opts }), hatch(doc, d, box, { angle: angle + cross, ...opts })];
}

/**
 * An engraved sky or ground: horizontal ruled lines inside `d`, closest at `box.y` and opening up to `gapEnd` at the
 * bottom of the box, as a burin rules a sky that pales toward the horizon.
 */
export function ruled(doc, d, box, { gapStart = 4, gapEnd = 9, width = 1, color = C.ink } = {}) {
  let path = '';
  let y = box.y;
  while (y <= box.y + box.h) {
    path += `M${pt(box.x, y)}H${r2(box.x + box.w)}`;
    const t = (y - box.y) / box.h;
    y += gapStart + (gapEnd - gapStart) * t;
  }
  return group(doc.clip(d), `<path d="${path}" fill="none" stroke="${color}" stroke-width="${r2(width)}"/>`);
}

/** Water: rows of short wavy strokes inside `d`. */
export function waves(doc, d, box, { gap = 10, length = 46, amp = 2.2, width = 1.2, color = C.ink, seed = 'waves' } = {}) {
  const rand = seeded(seed);
  let path = '';
  for (let y = box.y + gap / 2, row = 0; y < box.y + box.h; y += gap, row += 1) {
    for (let x = box.x - length * rand(); x < box.x + box.w; x += length * (1.15 + rand() * 0.5)) {
      const pts = [];
      for (let i = 0; i <= 8; i += 1) pts.push([x + (length * i) / 8, y + amp * Math.sin((i / 8) * Math.PI * 2 + row)]);
      path += `M${pts.map((p) => p1(...p)).join('L')}`;
    }
  }
  return group(doc.clip(d), `<path d="${path}" fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linecap="round"/>`);
}

/**
 * A security tint: fine wavy lines in a pale ink, each a sine wave shifted a little from the one above, so together
 * they make a moiré of lozenges. It is one small tile, `period` wide and `rows` lines tall, whose lines meet their
 * neighbours exactly, repeated over `d` as a pattern. Every row shifts the wave by a whole fraction of a turn, so the
 * tile repeats without a seam.
 */
export function lathe(doc, d, { gap = 8, amp = 3, period = 52, rows = 8, width = 0.9, color }) {
  const id = `t${color.slice(1)}${gap}${period}${rows}`.replace(/\./g, '');
  const h = gap * rows;
  let path = '';
  const steps = Math.round(period / 4);
  for (let i = 0; i < rows; i += 1) {
    const y = gap * (i + 0.5);
    path += 'M';
    for (let k = 0; k <= steps; k += 1) {
      const x = (period * k) / steps;
      path += `${k ? 'L' : ''}${pt(x, y + amp * Math.sin((2 * Math.PI * k) / steps + (2 * Math.PI * i) / rows))}`;
    }
  }
  doc.def(id, `<pattern id="${id}" width="${period}" height="${h}" patternUnits="userSpaceOnUse"><path d="${path}" fill="none" stroke="${color}" stroke-width="${r2(width)}"/></pattern>`);
  return `<path d="${d}" fill="url(#${id})"/>`;
}

/** Points along the centre line of a rounded rectangle, every `step` px, each with its outward normal. */
function frameLine(x, y, w, h, r, step) {
  const straight = (x0, y0, x1, y1) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    return { len, at: (t) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t], n: () => [(y1 - y0) / len, -(x1 - x0) / len] };
  };
  const corner = (cx, cy, a0) => ({
    len: (Math.PI / 2) * r,
    at: (t) => [cx + r * Math.cos(a0 + (Math.PI / 2) * t), cy + r * Math.sin(a0 + (Math.PI / 2) * t)],
    n: (t) => [Math.cos(a0 + (Math.PI / 2) * t), Math.sin(a0 + (Math.PI / 2) * t)],
  });
  // A frame as round as it is wide is a circle: its straight parts have no length and are left out.
  const parts = [
    straight(x + r, y, x + w - r, y), corner(x + w - r, y + r, -Math.PI / 2),
    straight(x + w, y + r, x + w, y + h - r), corner(x + w - r, y + h - r, 0),
    straight(x + w - r, y + h, x + r, y + h), corner(x + r, y + h - r, Math.PI / 2),
    straight(x, y + h - r, x, y + r), corner(x + r, y + r, Math.PI),
  ].filter((p) => p.len > 1e-6);
  const total = parts.reduce((s, p) => s + p.len, 0);
  const n = Math.max(8, Math.round(total / step));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    let s = (i / n) * total;
    for (const p of parts) {
      if (s <= p.len + 1e-9) {
        const t = p.len ? s / p.len : 0;
        // Every normal points outward: left of travel on the straight parts, away from the centre on the corners.
        out.push({ p: p.at(t), n: p.n(t), s: (i / n) * total });
        break;
      }
      s -= p.len;
    }
  }
  return { points: out, total };
}

/**
 * A guilloche band along a rounded rectangle: `strands` sine waves of the same wavelength, each shifted in phase,
 * crossing back and forth across the band's centre line. A whole number of waves fits the frame, so it closes
 * without a seam. `freq` adds a second, faster wave on top for a finer lace.
 */
export function band({ x, y, w, h, r }, { amp, wave = 24, strands = 4, freq = 0, color = C.ink, width = 1 }) {
  const { points, total } = frameLine(x, y, w, h, r, 3);
  const cycles = Math.max(1, Math.round(total / wave));
  let path = '';
  for (let k = 0; k < strands; k += 1) {
    const phase = (2 * Math.PI * k) / strands;
    path += `M${points.map(({ p, n, s }) => {
      const a = (2 * Math.PI * cycles * s) / total + phase;
      const off = amp * (freq ? 0.72 * Math.sin(a) + 0.28 * Math.sin(freq * a) : Math.sin(a));
      return p1(p[0] + n[0] * off, p[1] + n[1] * off);
    }).join('L')}Z`;
  }
  return `<path d="${path}" fill="none" stroke="${color}" stroke-width="${r2(width)}"/>`;
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/**
 * A rosette: a hypotrochoid, the curve a pen draws in a gear of radius `rr` rolling inside a ring of radius `R`, at
 * `dd` from the gear's centre. R and rr are whole numbers, so the curve closes after rr / gcd(R, rr) turns. `size`
 * scales it to px.
 */
export function rosette(cx, cy, { R, rr, dd, size, rotate = 0, color = C.ink, width = 0.8, samples = 100 }) {
  const turns = rr / gcd(R, rr);
  const n = samples * turns;
  const scale = size / (R - rr + dd);
  const [c, s] = [Math.cos((rotate * Math.PI) / 180), Math.sin((rotate * Math.PI) / 180)];
  let d = '';
  for (let i = 0; i < n; i += 1) {
    const t = (i / samples) * 2 * Math.PI;
    const px = ((R - rr) * Math.cos(t) + dd * Math.cos(((R - rr) / rr) * t)) * scale;
    const py = ((R - rr) * Math.sin(t) - dd * Math.sin(((R - rr) / rr) * t)) * scale;
    d += `${i ? 'L' : 'M'}${p1(cx + px * c - py * s, cy + px * s + py * c)}`;
  }
  return `<path d="${d}Z" fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linejoin="round"/>`;
}

/** A ring of `teeth` scallops around a circle, as path data: the edge of a foil seal or a coupon's rosette. */
export function scallops(cx, cy, r, teeth, depth) {
  const pts = [];
  for (let i = 0; i < teeth * 2; i += 1) {
    const a = (Math.PI * i) / teeth;
    const rad = i % 2 ? r - depth : r;
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return `M${pts.map((p) => pt(...p)).join('L')}Z`;
}

/**
 * A signature: a run of cursive loops, like a quick hand writing a name, with a taller first loop and a swash under
 * it. The loops are a stretched trochoid, the curve a point on a rolling wheel draws. Each loop gets its own height
 * and width from a seeded random source and leans right as it rises, so every signature is different and never
 * changes.
 */
export function scribble(x, y, w, h, seed, { color = C.ink, width = 1.6 } = {}) {
  const rand = seeded(seed);
  const loops = 5 + Math.floor(rand() * 3);
  const heights = Array.from({ length: loops + 1 }, (_, i) => (i === 0 ? 1.1 : 0.4 + rand() * 0.45));
  const widths = Array.from({ length: loops + 1 }, () => 0.75 + rand() * 0.55);
  const unit = (w * 0.86) / widths.slice(0, loops).reduce((a, b) => a + b, 0);
  const base = y + h * 0.62;
  let d = '';
  let x0 = x;
  for (let loop = 0; loop < loops; loop += 1) {
    const step = (unit * widths[loop]) / (2 * Math.PI);
    const hh = h * 0.5 * heights[loop];
    for (let k = loop ? 1 : 0; k <= 24; k += 1) {
      const t = (k / 24) * 2 * Math.PI;
      const rise = hh * (1 - Math.cos(t)) * 0.9;
      // A slant: the higher the pen, the further right, as in quick handwriting.
      const px = x0 + step * t - step * 1.7 * Math.sin(t) + rise * 0.35;
      d += `${d ? 'L' : 'M'}${p1(px, base - rise)}`;
    }
    x0 += step * 2 * Math.PI;
  }
  d += `M${pt(x - w * 0.02, y + h * 0.92)}C${pt(x + w * 0.3, y + h * 1.12)} ${pt(x + w * 0.62, y + h * 0.8)} ${pt(x + w * 1.02, y + h * 0.9)}`;
  return line(d, color, width);
}
