/**
 * The gallery: a claret wall with panelled wainscot, a dark floor, a spotlight from above and a thin ivory frame. Every
 * picture in the kit is a view of this one room.
 */
import { C, MIX } from './palette.mjs';
import { r2, pt, rect, ellipse, path, vgrad, glowFill, blur } from './doc.mjs';

/**
 * The wall from the top of the picture down to `floor`, and the floor below it. `panels` draws the wainscot: a chair
 * rail and moulded panels `panelH` tall above the floor. `dim` darkens the room for the night scene.
 */
export function room(d, W, H, { floor, panels = true, panelH = null, dim = false }) {
  const wall = vgrad(d, `wall-${dim ? 'dim' : 'lit'}`, dim
    ? [[0, MIX.wallDeep], [0.6, MIX.wallLow], [1, MIX.wallDeep]]
    : [[0, MIX.wallDeep], [0.45, C.claret], [0.8, C.claret], [1, MIX.wallLow]]);
  const ground = vgrad(d, 'floor', [[0, C.night], [1, MIX.floorDeep]]);
  const out = [rect(0, 0, W, floor, `fill="${wall}"`), rect(0, floor, W, H - floor, `fill="${ground}"`)];
  // Floorboards: level seams that open up toward the front, so the floor reads as lying flat.
  for (let i = 1; i <= 4; i += 1) {
    const y = floor + (H - floor) * ((i / 5) ** 1.5);
    out.push(rect(0, y, W, Math.max(1, (H - floor) * 0.006), `fill="${MIX.wallDeep}" fill-opacity="0.5"`));
  }
  out.push(rect(0, floor - 2, W, Math.max(3, H * 0.005), `fill="${MIX.rail}" fill-opacity="0.65"`));
  if (panels) {
    const ph = panelH ?? (floor * 0.24);
    const top = floor - ph;
    const rail = Math.max(6, ph * 0.07);
    out.push(rect(0, top - rail, W, rail, `fill="${MIX.rail}"`), rect(0, top - rail, W, Math.max(1.5, rail * 0.22), `fill="${MIX.wallHigh}"`),
      rect(0, top, W, Math.max(1.5, rail * 0.3), `fill="${MIX.wallDeep}" fill-opacity="0.8"`));
    const base = Math.max(8, ph * 0.12);
    out.push(rect(0, floor - base, W, base, `fill="${MIX.wallLow}"`), rect(0, floor - base, W, Math.max(1.5, base * 0.15), `fill="${MIX.rail}" fill-opacity="0.7"`));
    const n = Math.max(2, Math.round(W / (ph * 1.6)));
    const pw = W / n;
    const m = Math.max(10, ph * 0.16);
    for (let i = 0; i < n; i += 1) {
      const x = i * pw + m * 0.6;
      const y = top + m;
      const w = pw - m * 1.2;
      const h = ph - m * 2 - base * 0.6;
      out.push(rect(x, y, w, h, `fill="${MIX.wallLow}" fill-opacity="0.45"`),
        path(`M${pt(x, y + h)}L${pt(x, y)}L${pt(x + w, y)}`, `fill="none" stroke="${MIX.wallDeep}" stroke-width="${r2(Math.max(1.5, m * 0.14))}"`),
        path(`M${pt(x + w, y)}L${pt(x + w, y + h)}L${pt(x, y + h)}`, `fill="none" stroke="${MIX.rail}" stroke-opacity="0.75" stroke-width="${r2(Math.max(1.5, m * 0.12))}"`));
    }
  }
  return out.join('');
}

/** The dark edges of the room, so the light in the middle reads as a spotlight. */
export function vignette(d, W, H, strength = 0.55) {
  const id = `vignette-${Math.round(strength * 100)}`;
  const fill = d.def(id, `<radialGradient id="${id}" cx="0.5" cy="0.45" r="0.75"><stop offset="0.55" stop-color="${MIX.wallDeep}" stop-opacity="0"/><stop offset="1" stop-color="${MIX.wallDeep}" stop-opacity="${r2(strength)}"/></radialGradient>`);
  return rect(0, 0, W, H, `fill="${fill}"`);
}

/**
 * A spotlight: a small black lamp at (x, y1) and a soft cone of light from it that opens to `wBottom` at `y2`.
 * `strength` is the light's opacity at the top of the cone; `lamp: false` leaves only the light.
 */
export function spotlight(d, { x, x2 = x, y1 = 0, y2, wTop, wBottom, strength = 0.2, lamp: withLamp = true }) {
  const id = `beam-${Math.round(strength * 100)}`;
  const fill = vgrad(d, id, [[0, MIX.light, strength], [0.75, MIX.light, strength * 0.4], [1, MIX.light, 0]]);
  const beam = path(`M${pt(x - wTop / 2, y1)}L${pt(x + wTop / 2, y1)}L${pt(x2 + wBottom / 2, y2)}L${pt(x2 - wBottom / 2, y2)}Z`,
    `fill="${fill}" filter="${blur(d, Math.max(4, wBottom * 0.05))}"`);
  const lamp = path(`M${pt(x - wTop * 0.7, y1)}L${pt(x + wTop * 0.7, y1)}L${pt(x + wTop * 0.45, y1 + wTop * 0.55)}L${pt(x - wTop * 0.45, y1 + wTop * 0.55)}Z`, `fill="${C.ink}"`)
    + ellipse(x, y1 + wTop * 0.55, wTop * 0.45, wTop * 0.12, `fill="${MIX.light}" fill-opacity="0.85"`);
  return withLamp ? beam + lamp : beam;
}

/** A soft round glow of warm light, for the pool a spotlight leaves on the wall or the floor. */
export function glow(d, cx, cy, rx, ry, strength = 0.3) {
  return ellipse(cx, cy, rx, ry, `fill="${glowFill(d, MIX.light, strength)}"`);
}

/**
 * The frame every picture sits in: a thin ivory rule `inset` from the edge with a second, fainter one inside it, and a
 * small square at each corner. `cut` leaves out the bottom-left corner up to (cut.x, cut.y) for the X avatar.
 */
export function frame({ w, h, inset = 28, gap = 10, weight = 3, cut = null }) {
  const outer = [inset, inset, w - inset, h - inset];
  const inner = [inset + gap, inset + gap, w - inset - gap, h - inset - gap];
  const rule = ([x0, y0, x1, y1], width, opacity) => {
    const pts = cut
      ? [[cut.x, y1], [x1, y1], [x1, y0], [x0, y0], [x0, cut.y]]
      : [[x0, y1], [x1, y1], [x1, y0], [x0, y0], [x0, y1]];
    return path(`M${pts.map(([x, y]) => pt(x, y)).join('L')}`, `fill="none" stroke="${C.ivory}" stroke-opacity="${opacity}" stroke-width="${r2(width)}" stroke-linejoin="miter"`);
  };
  const s = weight * 3.2;
  const corners = [[outer[0], outer[1]], [outer[2], outer[1]], [outer[2], outer[3]], [outer[0], outer[3]]]
    .filter(([x, y]) => !cut || !(x === outer[0] && y === outer[3]))
    .map(([x, y]) => rect(x - s / 2, y - s / 2, s, s, `fill="${C.ivory}" fill-opacity="0.7"`)).join('');
  return rule(outer, weight, 0.62) + rule(inner, weight * 0.5, 0.3) + corners;
}
