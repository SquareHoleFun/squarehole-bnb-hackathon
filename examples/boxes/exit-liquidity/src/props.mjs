/**
 * Story props. Amber discs are USDC, green squares with an arrow are EXIT, the glass tank is the pool,
 * the crate is the vault. These are plain symbols drawn for this kit, not anyone's coin or logo.
 */
import { C, MIX } from './palette.mjs';
import { blockCells, cellsPath, lineCells } from './type.mjs';
import { rect, circle, path, group, r2, blur, vgrad } from './doc.mjs';

/** Pixel lettering from the sign alphabet. (x, y) is the anchor point at the top of the first line. */
export function label(text, { x, y, m, color = C.mint, anchor = 'middle' }) {
  const block = blockCells(Array.isArray(text) ? text : [text]);
  const w = block.cols * m;
  const ox = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  return path(cellsPath(block.cells, m, ox, y), `fill="${color}"`);
}

/** A USDC coin. */
export function coin(cx, cy, r) {
  return circle(cx, cy + r * 0.08, r, `fill="${MIX.amberDark}"`)
    + circle(cx, cy, r, `fill="${C.amber}"`)
    + circle(cx, cy, r * 0.62, `fill="none" stroke="${MIX.amberDark}" stroke-width="${r2(r * 0.13)}"`)
    + circle(cx - r * 0.38, cy - r * 0.42, r * 0.13, `fill="${MIX.amberLight}"`);
}

/** An EXIT token: a green square with an ink arrow. */
export function tile(cx, cy, s) {
  const m = s / 8;
  const glyph = lineCells('→');
  const ox = cx - (glyph.width * m) / 2;
  const oy = cy - (glyph.rows * m) / 2;
  return rect(cx - s / 2, cy - s / 2 + s * 0.07, s, s, `rx="${r2(s * 0.18)}" fill="${C.deep}"`)
    + rect(cx - s / 2, cy - s / 2, s, s, `rx="${r2(s * 0.18)}" fill="${C.green}"`)
    + path(cellsPath(glyph.cells, m, ox, oy), `fill="${C.ink}"`);
}

/** A row of coins centred on cx. */
export function coinRow(cx, cy, count, r, gap = r * 0.5) {
  const step = 2 * r + gap;
  const x0 = cx - ((count - 1) * step) / 2;
  return Array.from({ length: count }, (_, i) => coin(x0 + i * step, cy, r)).join('');
}

/** A padlock. */
export function padlock(cx, cy, s) {
  const bw = s;
  const bh = s * 0.78;
  const sw = s * 0.16;
  const top = cy - bh / 2;
  const shackle = `M${r2(cx - bw * 0.3)} ${r2(top)}V${r2(top - s * 0.22)}A${r2(bw * 0.3)} ${r2(bw * 0.3)} 0 0 1 ${r2(cx + bw * 0.3)} ${r2(top - s * 0.22)}V${r2(top)}`;
  return path(shackle, `fill="none" stroke="${C.paper}" stroke-width="${r2(sw)}"`)
    + rect(cx - bw / 2, top, bw, bh, `rx="${r2(s * 0.12)}" fill="${C.paper}"`)
    + circle(cx, cy - bh * 0.06, s * 0.1, `fill="${C.ink}"`)
    + rect(cx - s * 0.04, cy - bh * 0.06, s * 0.08, bh * 0.28, `fill="${C.ink}"`);
}

/** The pool: a glass tank of water holding USDC and EXIT side by side. */
export function tank(doc, { x, y, w, h, level, oldLevel = null, rows = 2, lock = true }) {
  const top = y + h * (1 - level);
  const water = vgrad(doc, 'water', MIX.water, MIX.waterDeep, 0.95, 1);
  const items = [];
  const size = Math.min(w / 9, (y + h - top) / (rows * 1.6 + 0.6));
  const perRow = Math.floor((w - size) / (size * 2.1));
  for (let r = 0; r < rows; r += 1) {
    const cy = y + h - size * (0.95 + r * 1.55);
    if (cy - size / 2 < top + size * 0.3) break;
    for (let i = 0; i < perRow; i += 1) {
      const cx = x + size * 1.05 + i * size * 2.1 + (r % 2) * size * 0.5;
      if (cx + size / 2 > x + w - size * 0.3) continue;
      items.push((i + r) % 2 === 0 ? coin(cx, cy, size * 0.45) : tile(cx, cy, size * 0.82));
    }
  }
  const old = oldLevel === null ? '' : (() => {
    const oy = y + h * (1 - oldLevel);
    return rect(x + 10, oy - 2, w - 20, 4, `fill="${C.paper}" fill-opacity="0.5"`)
      + arrow({ x1: x + w + 40, y1: oy, x2: x + w + 40, y2: top + 6, color: C.mint, width: 10, head: 30 });
  })();
  return rect(x, y, w, h, `rx="18" fill="${C.mint}" fill-opacity="0.05"`)
    + rect(x, top, w, y + h - top, `rx="14" fill="${water}"`)
    + rect(x + 6, top, w - 12, 6, `fill="${C.mint}" fill-opacity="0.65"`)
    + items.join('')
    + old
    + rect(x, y, w, h, `rx="18" fill="none" stroke="${C.mint}" stroke-opacity="0.75" stroke-width="7"`)
    + rect(x + w * 0.08, y + 18, 14, h - 36, `rx="7" fill="#FFFFFF" fill-opacity="0.07"`)
    + (lock ? padlock(x + w / 2, y + h - h * 0.14, Math.min(84, w * 0.16)) : '');
}

/** The vault: a crate with signs standing inside and a counter on its front. */
export function crate(doc, { x, y, w, h, inside = ['green', 'red', 'amber', 'mint', 'green'], counter = null }) {
  const lip = h * 0.1;
  const colors = { green: C.green, red: C.red, amber: C.amber, mint: C.mint };
  const sw = (w * 0.86) / inside.length;
  const tops = inside.map((key, i) => {
    const sx = x + w * 0.07 + i * sw;
    const sh = h * (0.36 + ((i * 7) % 3) * 0.05);
    const sy = y + lip - sh * 0.62;
    return rect(sx + sw * 0.08, sy, sw * 0.84, sh, `rx="8" fill="${C.rim}"`)
      + rect(sx + sw * 0.16, sy + sh * 0.12, sw * 0.68, sh * 0.34, `rx="4" fill="${colors[key]}"`);
  }).join('');
  const planks = [0.38, 0.66].map((f) => rect(x + 8, y + lip + (h - lip) * f, w - 16, 5, `fill="${C.rim}" fill-opacity="0.55"`)).join('');
  const corners = [[x, y + lip], [x + w - 34, y + lip], [x, y + h - 34], [x + w - 34, y + h - 34]]
    .map(([cx, cy]) => rect(cx, cy, 34, 34, `rx="6" fill="${C.rim}"`)).join('');
  return rect(x + 10, y, w - 20, lip + 10, `rx="8" fill="${MIX.panel}"`)
    + tops
    + rect(x, y + lip, w, h - lip, `rx="14" fill="${C.slate}" stroke="${C.rim}" stroke-width="6"`)
    + planks
    + corners
    + (counter ?? '');
}

/** A burn: a small bin with pixel flames, and EXIT squares breaking into bits above it. */
export function burner(doc, { cx, bottom, w }) {
  const h = w * 0.62;
  const top = bottom - h;
  const bin = `M${r2(cx - w / 2)} ${r2(top)}H${r2(cx + w / 2)}L${r2(cx + w * 0.4)} ${r2(bottom)}H${r2(cx - w * 0.4)}Z`;
  const px = w / 14;
  const flameRows = [
    [6, 7], [5, 6, 7, 8], [4, 5, 6, 7, 8, 9], [3, 4, 5, 6, 7, 8, 9, 10], [2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  ];
  const flames = flameRows.map((cols, r) => cols.map((c) => {
    const inner = c >= 5 && c <= 8 && r >= 2;
    const color = r < 2 ? C.amber : inner ? C.amber : r < 4 ? MIX.flame : C.red;
    return rect(cx - w / 2 + c * px, top - (flameRows.length - r) * px, px, px, `fill="${color}"`);
  }).join('')).join('');
  const bits = [[-0.2, 2.6, 1], [0.12, 3.2, 0.8], [0.32, 2.2, 0.9], [-0.36, 3.6, 0.6], [0.05, 4.3, 0.5], [0.42, 3.9, 0.45], [-0.08, 5.1, 0.35]]
    .map(([dx, up, a]) => rect(cx + dx * w - px * 0.6, top - (flameRows.length + up) * px, px * 1.2 * a + px * 0.3, px * 1.2 * a + px * 0.3, `fill="${C.green}" fill-opacity="${a}"`)).join('');
  return group(`filter="${blur(doc, px * 1.6)}" opacity="0.7"`, flames)
    + flames
    + bits
    + path(bin, `fill="${C.slate}" stroke="${C.rim}" stroke-width="6" stroke-linejoin="round"`)
    + [0.3, 0.5, 0.7].map((f) => rect(cx - w * 0.28, top + h * f, w * 0.56, 6, `rx="3" fill="${C.rim}"`)).join('');
}

/** A mouse pointer with its tip at (x, y), `s` tall. */
export function pointer(x, y, s) {
  const pts = [[0, 0], [0, 1], [0.27, 0.77], [0.45, 1.13], [0.61, 1.06], [0.44, 0.71], [0.76, 0.71]];
  const d = `M${pts.map(([px, py]) => `${r2(x + px * s)} ${r2(y + py * s)}`).join('L')}Z`;
  return path(d, `fill="${C.paper}" stroke="${C.ink}" stroke-width="${r2(s * 0.06)}" stroke-linejoin="round"`);
}

/** A rounded button with pixel lettering. */
export function button({ cx, cy, text, m, color = C.green, ink = C.ink }) {
  const block = blockCells([text]);
  const w = (block.cols + 6) * m;
  const h = (block.rows + 4) * m;
  return rect(cx - w / 2, cy - h / 2 + m * 0.8, w, h, `rx="${r2(m * 2)}" fill="${C.deep}"`)
    + rect(cx - w / 2, cy - h / 2, w, h, `rx="${r2(m * 2)}" fill="${color}"`)
    + label(text, { x: cx, y: cy - (block.rows * m) / 2, m, color: ink });
}

/** A plate with pixel lettering, for places such as SQUARE HOLE. */
export function plate({ cx, cy, text, m, color = C.paper }) {
  const block = blockCells(Array.isArray(text) ? text : [text]);
  const w = (block.cols + 6) * m;
  const h = (block.rows + 5) * m;
  return rect(cx - w / 2, cy - h / 2, w, h, `rx="${r2(m * 1.6)}" fill="${C.slate}" stroke="${C.rim}" stroke-width="${r2(m * 0.8)}"`)
    + label(text, { x: cx, y: cy - (block.rows * m) / 2, m, color });
}

/** A thick arrow from (x1, y1) to (x2, y2), bent sideways by `bend`. */
export function arrow({ x1, y1, x2, y2, bend = 0, color = C.mint, width = 12, head = 36, dash = null, opacity = 1 }) {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const qx = mx + (-(y2 - y1) / len) * bend;
  const qy = my + ((x2 - x1) / len) * bend;
  const ang = Math.atan2(y2 - qy, x2 - qx);
  const bx = x2 - Math.cos(ang) * head * 0.8;
  const by = y2 - Math.sin(ang) * head * 0.8;
  const side = (s) => [bx + Math.cos(ang + s * Math.PI / 2) * head * 0.55, by + Math.sin(ang + s * Math.PI / 2) * head * 0.55];
  const [lx, ly] = side(1);
  const [rx, ry] = side(-1);
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
  return group(`opacity="${opacity}"`,
    path(`M${r2(x1)} ${r2(y1)}Q${r2(qx)} ${r2(qy)} ${r2(bx)} ${r2(by)}`, `fill="none" stroke="${color}" stroke-width="${r2(width)}" stroke-linecap="round"${dashAttr}`),
    path(`M${r2(x2)} ${r2(y2)}L${r2(lx)} ${r2(ly)}L${r2(rx)} ${r2(ry)}Z`, `fill="${color}" stroke="${color}" stroke-width="${r2(width * 0.4)}" stroke-linejoin="round"`));
}

/** A bracket under a group of things, from x1 to x2, with its tip pointing down at the middle. */
export function bracket({ x1, x2, y, color, width = 8, depth = 26 }) {
  const mx = (x1 + x2) / 2;
  return path(`M${r2(x1)} ${r2(y)}V${r2(y + depth)}H${r2(x2)}V${r2(y)}M${r2(mx)} ${r2(y + depth)}V${r2(y + depth * 1.9)}`,
    `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`);
}

/** A little shelf under a sign that holds its USDC credit, chained to the sign. */
export function tray({ cx, top, w, coins = 0, chainFrom = null }) {
  const r = w * 0.09;
  const stack = Array.from({ length: coins }, (_, i) => coin(cx - w * 0.22 + (i % 3) * w * 0.22, top - r * 0.9 - Math.floor(i / 3) * r * 0.7, r)).join('');
  const links = chainFrom === null ? '' : [cx - w * 0.36, cx + w * 0.36].map((lx) => rect(lx - 3, chainFrom, 6, top - chainFrom, `fill="${C.rim}"`)).join('');
  return links + stack + rect(cx - w / 2, top, w, w * 0.12, `rx="${r2(w * 0.04)}" fill="${C.rim}"`)
    + rect(cx - w / 2 + 6, top + w * 0.12, w - 12, w * 0.05, `fill="${C.slate}"`);
}
