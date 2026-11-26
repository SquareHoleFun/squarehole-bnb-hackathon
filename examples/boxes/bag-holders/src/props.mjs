/**
 * Story props. Gold discs are the price coin, tomato chips with a little bag are TOTE, the cardboard box is the box
 * where bags wait, and the small pool with a ladder is the box's own pool. These are plain symbols drawn for this
 * kit: no coin logo, no letters on the coins, no hexagons, no brand.
 */
import { C, MIX } from './palette.mjs';
import { roundRect, r2, circle, ellipse } from './doc.mjs';
import { shape, flat, line, band } from './pen.mjs';
import { shadeOf } from './bags.mjs';
import { lettering, measure } from './type.mjs';

const P = (x, y) => `${r2(x)} ${r2(y)}`;

/** The price coin: a plain gold disc with a rim, a ring and a shine. */
export function coin(cx, cy, r, ow = r * 0.16) {
  return circle(cx, cy + r * 0.14, r, `fill="${MIX.goldDark}" stroke="${C.ink}" stroke-width="${r2(ow)}"`)
    + circle(cx, cy, r, `fill="${C.gold}" stroke="${C.ink}" stroke-width="${r2(ow)}"`)
    + circle(cx, cy, r * 0.6, `fill="none" stroke="${MIX.goldDark}" stroke-width="${r2(r * 0.12)}"`)
    + ellipse(cx - r * 0.36, cy - r * 0.42, r * 0.2, r * 0.13, `fill="${MIX.goldLight}"`);
}

/** A row of coins centred on cx. */
export function coinRow(cx, cy, count, r, gap = r * 0.5, ow) {
  const step = 2 * r + gap;
  const x0 = cx - ((count - 1) * step) / 2;
  return Array.from({ length: count }, (_, i) => coin(x0 + i * step, cy, r, ow)).join('');
}

/** A tiny tote icon with the kit's V-shaped straps, for the TOTE chip. */
export function miniTote(cx, cy, s, color) {
  const w = s;
  const top = cy - s * 0.12;
  return line(`M${P(cx - w * 0.28, top + s * 0.05)}L${P(cx, top - s * 0.42)}L${P(cx + w * 0.28, top + s * 0.05)}`, color, s * 0.12)
    + flat(`M${P(cx - w * 0.5, top)}H${r2(cx + w * 0.5)}L${P(cx + w * 0.44, top + s * 0.62)}H${r2(cx - w * 0.44)}Z`, color);
}

/** TOTE, the box token: a tomato chip with a little bag on it. */
export function chip(cx, cy, s, ow = s * 0.08) {
  const h = s / 2;
  return shape(roundRect(cx - h, cy - h + s * 0.1, s, s, s * 0.22), MIX.tomatoDark, ow)
    + shape(roundRect(cx - h, cy - h, s, s, s * 0.22), C.tomato, ow)
    + miniTote(cx, cy + s * 0.06, s * 0.52, C.canvas);
}

/** A thick sticker arrow from (x1, y1) to (x2, y2), bent sideways by `bend`. */
export function arrow({ x1, y1, x2, y2, bend = 0, color = C.canvas, width = 16, head = 44, ow = 6, dash = null }) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const qx = mx + (-(y2 - y1) / len) * bend;
  const qy = my + ((x2 - x1) / len) * bend;
  const ang = Math.atan2(y2 - qy, x2 - qx);
  const bx = x2 - Math.cos(ang) * head * 0.75;
  const by = y2 - Math.sin(ang) * head * 0.75;
  const side = (k) => [bx + Math.cos(ang + (k * Math.PI) / 2) * head * 0.58, by + Math.sin(ang + (k * Math.PI) / 2) * head * 0.58];
  const [lx, ly] = side(1);
  const [rx, ry] = side(-1);
  const shaft = `M${P(x1, y1)}Q${P(qx, qy)} ${P(bx, by)}`;
  const tip = `M${P(x2, y2)}L${P(lx, ly)}L${P(rx, ry)}Z`;
  if (dash) {
    return line(shaft, C.ink, width + 2 * ow, dash) + line(shaft, color, width, dash) + shape(tip, color, ow);
  }
  return line(shaft, C.ink, width + 2 * ow) + shape(tip, color, ow) + line(shaft, color, width);
}

/** A bracket under a group, from x1 to x2, with a stem down from its middle. */
export function bracket({ x1, x2, y, color, width = 10, depth = 26, ow = 5 }) {
  const mx = (x1 + x2) / 2;
  return band(`M${P(x1, y)}V${r2(y + depth)}H${r2(x2)}V${r2(y)}M${P(mx, y + depth)}V${r2(y + depth * 1.9)}`, color, width, ow);
}

/** A plate with lettering, such as SQUARE HOLE. */
export function plate({ cx, cy, text, cap, color = C.canvas, fill = C.ink, ow = 6 }) {
  const lines = Array.isArray(text) ? text : [text];
  const m = measure(lines, cap);
  const w = m.w + cap * 1.1;
  const h = m.h + cap * 0.9;
  return shape(roundRect(cx - w / 2, cy - h / 2 + ow * 1.2, w, h, cap * 0.45), MIX.nightDeep, ow)
    + shape(roundRect(cx - w / 2, cy - h / 2, w, h, cap * 0.45), fill, ow)
    + lettering(lines, { x: cx, y: cy - m.h / 2 + 1.3 * m.unit, cap, color, outline: null });
}

/** A rounded button with lettering, pressed by a pointer. */
export function button({ cx, cy, text, cap, color = C.leaf, ow = 6 }) {
  const m = measure([text], cap);
  const w = m.w + cap * 1.6;
  const h = m.h + cap * 0.9;
  return shape(roundRect(cx - w / 2, cy - h / 2 + cap * 0.22, w, h, h / 2), MIX.leafDark, ow)
    + shape(roundRect(cx - w / 2, cy - h / 2, w, h, h / 2), color, ow)
    + lettering(text, { x: cx, y: cy - m.h / 2 + 1.3 * m.unit, cap, color: C.canvas, outline: C.ink });
}

/** A pointer with its tip at (x, y), `s` tall. */
export function pointer(x, y, s, ow = s * 0.07) {
  const p = [[0, 0], [0, 1], [0.27, 0.77], [0.45, 1.13], [0.61, 1.06], [0.44, 0.71], [0.76, 0.71]];
  return shape(`M${p.map(([px, py]) => P(x + px * s, y + py * s)).join('L')}Z`, C.canvas, ow);
}

/** The box's own pool: a small swimming pool seen from above, with a ladder, waves, and a coin and a TOTE chip in it. */
export function pool({ cx, cy, w, ow = 6, things = true }) {
  const h = w * 0.66;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const rim = w * 0.08;
  const out = [];
  out.push(shape(roundRect(x, y + ow, w, h, w * 0.14), MIX.canvasDeep, ow));
  out.push(shape(roundRect(x, y, w, h, w * 0.14), C.canvas, ow));
  out.push(shape(roundRect(x + rim, y + rim, w - 2 * rim, h - 2 * rim, w * 0.08), C.aqua, ow * 0.8));
  out.push(flat(roundRect(x + rim + ow * 0.4, y + rim + ow * 0.4, w - 2 * rim - ow * 0.8, h * 0.14, w * 0.06), MIX.aquaDark, 0.7));
  const wave = (wy, x1, x2) => {
    const n = 3;
    const step = (x2 - x1) / n;
    let d = `M${P(x1, wy)}`;
    for (let i = 0; i < n; i += 1) d += `Q${P(x1 + step * (i + 0.5), wy + (i % 2 ? 1 : -1) * w * 0.025)} ${P(x1 + step * (i + 1), wy)}`;
    return line(d, MIX.aquaLight, ow * 0.6);
  };
  out.push(wave(y + h * 0.62, x + w * 0.22, x + w * 0.62), wave(y + h * 0.78, x + w * 0.4, x + w * 0.78));
  const lx = x + w * 0.74;
  const rails = [lx, lx + w * 0.12];
  out.push(...rails.map((rx) => band(`M${P(rx, y + rim + h * 0.22)}V${r2(y - h * 0.02)}A${r2(w * 0.04)} ${r2(w * 0.04)} 0 0 0 ${P(rx - w * 0.08, y - h * 0.02)}V${r2(y + rim * 0.4)}`, C.steel, w * 0.025, ow * 0.6)));
  out.push(...[0.1, 0.2].map((f) => band(`M${P(rails[0], y + rim + h * f)}H${r2(rails[1])}`, C.steel, w * 0.02, ow * 0.5)));
  if (things) out.push(coin(x + w * 0.3, y + h * 0.46, w * 0.075, ow * 0.7), chip(x + w * 0.52, y + h * 0.5, w * 0.14, ow * 0.7));
  return out.join('');
}

/**
 * The box: a cardboard box with open flaps and bags standing inside, their tops and straps showing.
 * `bags` lists the bag colors, left to right; `null` leaves a gap where a bag was taken out. `label` goes on a
 * patch on the front. `fill(cx, top, width, index)` can draw something on each bag, such as coins dropping in.
 */
export function box({ x, y, w, h, ow = 7, bags = [C.canvas, C.tomato, C.gold, C.aqua, C.leaf], label = null, cap = null, fill = null }) {
  const lip = h * 0.08;
  const out = [];
  out.push(shape(`M${P(x + w * 0.02, y)}L${P(x - w * 0.06, y - h * 0.22)}L${P(x + w * 0.4, y - h * 0.26)}L${P(x + w * 0.46, y)}Z`, MIX.kraftDark, ow));
  out.push(shape(`M${P(x + w * 0.98, y)}L${P(x + w * 1.06, y - h * 0.22)}L${P(x + w * 0.6, y - h * 0.26)}L${P(x + w * 0.54, y)}Z`, MIX.kraftDark, ow));
  const bw = (w * 0.9) / bags.length;
  const tilt = [-6, 4, -3, 5, -4, 3];
  bags.forEach((color, i) => {
    if (color === null) return;
    const bx = x + w * 0.05 + i * bw + bw / 2;
    const ww = bw * 0.98;
    const bh = ww * (0.95 + ((i * 7) % 3) * 0.08);
    const by = y - bh * (0.42 + ((i * 5) % 3) * 0.05);
    const sw = Math.max(3, ww * 0.075);
    const strap = (half, rise, yy) => `M${P(bx - half, yy)}C${P(bx - half * 1.05, yy - rise)} ${P(bx + half * 1.05, yy - rise)} ${P(bx + half, yy)}`;
    const parts = band(strap(ww * 0.36, ww * 0.62, by + sw), shadeOf(color), sw, ow * 0.6)
      + shape(roundRect(bx - ww / 2, by, ww, bh, ww * 0.06), color, ow * 0.85)
      + flat(roundRect(bx - ww / 2 + ow * 0.4, by + ow * 0.4, ww - ow * 0.8, bh * 0.12, ww * 0.03), shadeOf(color))
      + band(strap(ww * 0.26, ww * 0.55, by + bh * 0.16), color, sw, ow * 0.6)
      + (fill ? fill(bx, by, ww, i) : '');
    out.push(`<g transform="rotate(${tilt[i % tilt.length]} ${P(bx, y + h * 0.3)})">${parts}</g>`);
  });
  out.push(shape(`M${P(x, y)}H${r2(x + w)}V${r2(y + h)}H${r2(x)}Z`, C.kraft, ow));
  out.push(flat(`M${P(x + ow / 2, y + ow / 2)}H${r2(x + w - ow / 2)}V${r2(y + lip)}H${r2(x + ow / 2)}Z`, MIX.kraftDark));
  out.push(line(`M${P(x, y + lip)}H${r2(x + w)}`, C.ink, ow * 0.6));
  out.push(flat(`M${P(x + w * 0.44, y + lip)}H${r2(x + w * 0.56)}V${r2(y + h - ow / 2)}H${r2(x + w * 0.44)}Z`, MIX.kraftLight, 0.55));
  out.push(shape(`M${P(x, y)}L${P(x - w * 0.07, y + h * 0.1)}L${P(x + w * 0.05, y + h * 0.1)}L${P(x + w * 0.06, y)}Z`, MIX.kraftLight, ow));
  out.push(shape(`M${P(x + w, y)}L${P(x + w * 1.07, y + h * 0.1)}L${P(x + w * 0.95, y + h * 0.1)}L${P(x + w * 0.94, y)}Z`, MIX.kraftLight, ow));
  if (label) {
    const c = cap ?? h * 0.16;
    const m = measure([label], c);
    const pw = m.w + c * 0.9;
    const ph = m.h + c * 0.5;
    const px = x + w / 2 - pw / 2;
    const py = y + h * 0.5 - ph / 2;
    out.push(shape(roundRect(px, py, pw, ph, c * 0.25), C.canvas, ow * 0.8));
    out.push(lettering(label, { x: x + w / 2, y: py + (ph - m.h) / 2 + 1.3 * m.unit, cap: c, color: C.ink, outline: null }));
  }
  return out.join('');
}

/** A glass jar with coins waiting in it; an open jar has no lid. */
export function jar({ cx, bottom, w, h, coins = 9, ow = 6, open = false }) {
  const x = cx - w / 2;
  const top = bottom - h;
  const out = [];
  out.push(shape(roundRect(x, top + h * 0.12, w, h * 0.88, w * 0.16), MIX.aquaLight, ow));
  const r = w * 0.12;
  for (let i = 0; i < coins; i += 1) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    out.push(coin(x + w * (0.25 + col * 0.25) + (row % 2) * r * 0.4, bottom - r * 1.4 - row * r * 1.25, r, ow * 0.7));
  }
  out.push(flat(roundRect(x + w * 0.1, top + h * 0.22, w * 0.08, h * 0.6, w * 0.04), MIX.white, 0.6));
  const lid = shape(roundRect(x - w * 0.04, top, w * 1.08, h * 0.15, w * 0.05), C.steel, ow)
    + line(`M${P(x + w * 0.06, top + h * 0.075)}H${r2(x + w * 0.94)}`, MIX.steelDark, ow * 0.6);
  if (!open) out.push(lid);
  return out.join('');
}

/** The raise bar, filled to `fill` (0 to 1), with a check mark when it is full. */
export function raiseBar({ x, y, w, h, fill, ow = 6 }) {
  const out = [shape(roundRect(x, y, w, h, h / 2), C.canvas, ow)];
  if (fill > 0) out.push(shape(roundRect(x, y, Math.max(h, w * fill), h, h / 2), C.leaf, ow));
  if (fill >= 1) {
    const s = h * 0.9;
    const cx = x + w + s * 0.95;
    const cy = y + h / 2;
    out.push(circle(cx, cy, s * 0.75, `fill="${C.leaf}" stroke="${C.ink}" stroke-width="${r2(ow)}"`));
    out.push(band(`M${P(cx - s * 0.35, cy)}L${P(cx - s * 0.08, cy + s * 0.28)}L${P(cx + s * 0.38, cy - s * 0.3)}`, C.canvas, s * 0.16, ow * 0.6));
  }
  return out.join('');
}
