/**
 * Story props. Ice discs with columns are the stock coin, $NVDA, small chips are VRAM, the glass tank is the box's
 * own pool, the jar holds fee coins that wait, and the fire is a burn. These are plain symbols drawn for this kit,
 * not anyone's coin, product or logo. The only real name in the art is the stock's ticker, in the tube alphabet.
 */
import { C, HEAT, MIX } from './palette.mjs';
import { lettering } from './type.mjs';
import { fire } from './heat.mjs';
import { rect, circle, path, group, r2, vgrad, hgrad } from './doc.mjs';

/** Tube lettering in one color. (x, y) is the anchor at the top of the first line, `size` the cap height. */
export function label(text, { x, y, size, color = C.white, anchor = 'middle', sw = 1.1 }) {
  return lettering(text, { x, y, size, color, anchor, sw }).markup;
}

/** The hot tube letters: the same strokes drawn five times along the heat ramp. */
export const HOT_LAYERS = Object.freeze([[C.violet, 3.2, 0.35], [C.magenta, 2.3], [C.orange, 1.6], [C.amber, 1.0], [C.white, 0.45]]);

/** A plate with lettering, for places such as SQUARE HOLE or BURN. */
export function plate({ cx, cy, text, size, color = C.white, fill = C.panel }) {
  const probe = lettering(text, { x: cx, y: 0, size, color, sw: 1.1 });
  const capsH = probe.box.h + 2 * probe.box.y;
  const w = probe.box.w + size * 1.6;
  const h = capsH + size * 1.5;
  const t = lettering(text, { x: cx, y: cy - capsH / 2, size, color, sw: 1.1 });
  return rect(cx - w / 2, cy - h / 2, w, h, `rx="${r2(size * 0.45)}" fill="${fill}" stroke="${C.rim}" stroke-width="${r2(size * 0.14)}"`) + t.markup;
}

/** The stock's ticker as people write it. It is the only name the pictures letter. */
export const TICKER = '$NVDA';
/**
 * From this radius in pixels a stock coin letters the ticker under its building. The letters are 0.23 of the radius
 * tall, so at least 18.4 px. A post often shows a 1200 px scene 500 px wide, and there they are still 7.7 px tall.
 * Smaller coins show only the building. Where a scene names one, a label goes under it (`NAME_LABEL`).
 */
export const TICKER_COIN_R = 80;
/** Cap height of a name label under a small coin or chip: 28 px, as tall as the 1% labels, 11.7 px at post size. */
export const NAME_LABEL = 28;

/**
 * The stock coin, $NVDA: an ice disc with a small columned building, the plain sign for a stock. Cold on purpose.
 * A coin of radius TICKER_COIN_R or more draws the building smaller and higher and letters the ticker under it.
 */
export function stockCoin(cx, cy, r) {
  const named = r >= TICKER_COIN_R;
  const k = named ? 0.6 : 1;
  const dy = named ? -0.2 : 0;
  const e = (x, y) => `${r2(cx + x * k * r)} ${r2(cy + (y * k + dy) * r)}`;
  const roof = `M${e(-0.46, -0.16)}L${e(0, -0.46)}L${e(0.46, -0.16)}Z`;
  const cols = [-0.3, 0, 0.3].map((x) => rect(cx + (x - 0.065) * k * r, cy + (-0.1 * k + dy) * r, 0.13 * k * r, 0.36 * k * r, `fill="${MIX.iceDeep}"`)).join('');
  const ticker = named ? lettering(TICKER, { x: cx, y: cy + 0.11 * r, size: 0.23 * r, color: MIX.iceDeep, sw: 1.1 }).markup : '';
  return circle(cx, cy + r * 0.09, r, `fill="${MIX.iceDark}"`)
    + circle(cx, cy, r, `fill="${C.ice}"`)
    + circle(cx, cy, r * 0.78, `fill="none" stroke="${MIX.iceDark}" stroke-width="${r2(r * 0.08)}"`)
    + path(roof, `fill="${MIX.iceDeep}" stroke="${MIX.iceDeep}" stroke-width="${r2(r * 0.04 * k)}" stroke-linejoin="round"`)
    + cols
    + rect(cx - 0.46 * k * r, cy + (0.28 * k + dy) * r, 0.92 * k * r, 0.1 * k * r, `fill="${MIX.iceDeep}"`)
    + ticker
    + circle(cx - r * 0.5, cy - r * 0.5, r * 0.11, `fill="${MIX.iceLight}"`);
}

/** A row of stock coins centred on cx. */
export function coinRow(cx, cy, count, r, gap = r * 0.45) {
  const step = 2 * r + gap;
  const x0 = cx - ((count - 1) * step) / 2;
  return Array.from({ length: count }, (_, i) => stockCoin(x0 + i * step, cy, r)).join('');
}

/**
 * A VRAM chip: a dark rectangle with pins on its long sides and a warm spot in the middle. `heat` 0 to 4 sets how
 * many heat bands show. `angle` tilts it, in degrees.
 */
export function chip({ cx, cy, w, heat = 2, angle = 0 }) {
  const h = w * 0.6;
  const pins = [];
  const pw = w * 0.075;
  const pl = w * 0.11;
  for (let i = 0; i < 5; i += 1) {
    const px = cx - w * 0.36 + i * w * 0.18 - pw / 2;
    pins.push(rect(px, cy - h / 2 - pl, pw, pl + w * 0.04, `rx="${r2(pw * 0.3)}" fill="${C.violet}"`));
    pins.push(rect(px, cy + h / 2 - w * 0.04, pw, pl + w * 0.04, `rx="${r2(pw * 0.3)}" fill="${C.violet}"`));
  }
  const core = [];
  for (let i = 0; i <= heat; i += 1) {
    const k = 1 - i * 0.2;
    core.push(rect(cx - w * 0.3 * k, cy - h * 0.28 * k, w * 0.6 * k, h * 0.56 * k, `rx="${r2(h * 0.14 * k)}" fill="${HEAT[i]}"`));
  }
  const body = rect(cx - w / 2, cy - h / 2, w, h, `rx="${r2(w * 0.08)}" fill="${MIX.chip}" stroke="${C.rim}" stroke-width="${r2(w * 0.035)}"`)
    + core.join('')
    + circle(cx - w * 0.38, cy - h * 0.27, w * 0.035, `fill="${C.rim}"`);
  const all = pins.join('') + body;
  return angle ? group(`transform="rotate(${r2(angle)} ${r2(cx)} ${r2(cy)})"`, all) : all;
}

/** Bits of a burned chip flying up, from small to tiny. */
export function bits(cx, cy, w, count = 7) {
  const spots = [[-0.3, 0.1, 1], [0.25, 0.35, 0.85], [-0.05, 0.6, 0.7], [0.4, 0.75, 0.55], [-0.38, 0.9, 0.5], [0.1, 1.1, 0.4], [-0.18, 1.3, 0.3], [0.32, 1.45, 0.25]];
  return spots.slice(0, count).map(([dx, up, k], i) => rect(cx + dx * w - (w * 0.09 * k) / 2, cy - up * w, w * 0.09 * k + 3, w * 0.09 * k + 3, `rx="2" fill="${i % 2 ? C.amber : C.violet}" fill-opacity="${r2(0.35 + k * 0.6)}" transform="rotate(${(i * 37) % 90} ${r2(cx + dx * w)} ${r2(cy - up * w)})"`)).join('');
}

/** The box's own pool: a glass tank holding stock coins and VRAM chips side by side. */
export function tank(doc, { x, y, w, h, level = 0.62, rows = 2, items = true, chipHeat = 1 }) {
  const top = y + h * (1 - level);
  const liquid = vgrad(doc, 'pool-liquid', [[0, MIX.liquid, 0.95], [1, MIX.liquidDeep, 1]]);
  const out = [];
  if (items) {
    const size = Math.min(w / 8, (y + h - top) / (rows * 1.5 + 0.4));
    const perRow = Math.max(1, Math.floor((w - size * 0.6) / (size * 1.55)));
    for (let r = 0; r < rows; r += 1) {
      const cy = y + h - size * (0.85 + r * 1.45);
      if (cy - size / 2 < top + size * 0.25) break;
      for (let i = 0; i < perRow; i += 1) {
        const cx = x + w / 2 + (i - (perRow - 1) / 2) * size * 1.55 + (r % 2) * size * 0.35;
        if (cx + size * 0.6 > x + w || cx - size * 0.6 < x) continue;
        out.push((i + r) % 2 === 0 ? stockCoin(cx, cy, size * 0.42) : chip({ cx, cy, w: size * 0.9, heat: chipHeat }));
      }
    }
  }
  return rect(x, y, w, h, `rx="${r2(w * 0.06)}" fill="${MIX.glass}" fill-opacity="0.06"`)
    + rect(x, top, w, y + h - top, `rx="${r2(w * 0.05)}" fill="${liquid}"`)
    + rect(x + w * 0.03, top, w * 0.94, Math.max(4, h * 0.012), `fill="${MIX.glass}" fill-opacity="0.7"`)
    + out.join('')
    + rect(x, y, w, h, `rx="${r2(w * 0.06)}" fill="none" stroke="${MIX.glass}" stroke-opacity="0.8" stroke-width="${r2(Math.max(4, w * 0.014))}"`)
    + rect(x + w * 0.07, y + h * 0.06, Math.max(6, w * 0.025), h * 0.88, `rx="${r2(w * 0.012)}" fill="${MIX.shine}" fill-opacity="0.07"`);
}

/** A glass jar with a lid, holding `coins` stock coins: fee coins that wait. */
export function jar({ cx, bottom, w, h, coins = 6, lid = true }) {
  const x = cx - w / 2;
  const y = bottom - h;
  const r = w * 0.13;
  const stack = Array.from({ length: coins }, (_, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    return stockCoin(cx + (col - 1) * r * 2.15 + (row % 2) * r * 0.5, bottom - r * 1.2 - row * r * 1.55, r);
  }).join('');
  const lidMarkup = lid
    ? rect(x - w * 0.04, y - h * 0.07, w * 1.08, h * 0.09, `rx="${r2(w * 0.03)}" fill="${C.rim}"`) + rect(x + w * 0.1, y - h * 0.11, w * 0.8, h * 0.05, `rx="${r2(w * 0.02)}" fill="${MIX.steel}"`)
    : '';
  return rect(x, y, w, h, `rx="${r2(w * 0.14)}" fill="${MIX.glass}" fill-opacity="0.07"`)
    + stack
    + rect(x, y, w, h, `rx="${r2(w * 0.14)}" fill="none" stroke="${MIX.glass}" stroke-opacity="0.8" stroke-width="${r2(Math.max(4, w * 0.025))}"`)
    + rect(x + w * 0.1, y + h * 0.1, w * 0.06, h * 0.75, `rx="${r2(w * 0.03)}" fill="${MIX.shine}" fill-opacity="0.08"`)
    + lidMarkup;
}

/** A small grate on the floor with a fire on it. The fire's base sits on the grate. `lit: false` leaves it cold. */
export function burner(doc, { cx, bottom, w, level = 5, flameH = null, lit = true }) {
  const gh = w * 0.12;
  const legs = [-0.38, 0.38].map((f) => rect(cx + f * w - w * 0.035, bottom - gh * 1.6, w * 0.07, gh * 1.6, `fill="${MIX.steel}"`)).join('');
  const bars = rect(cx - w / 2, bottom - gh * 1.9, w, gh * 0.55, `rx="${r2(gh * 0.27)}" fill="${MIX.steel}"`)
    + [-0.3, -0.1, 0.1, 0.3].map((f) => rect(cx + f * w - w * 0.02, bottom - gh * 2.4, w * 0.04, gh * 0.6, `fill="${C.rim}"`)).join('');
  if (!lit) return legs + bars;
  const fh = flameH ?? w * 1.15;
  return legs + bars + fire(doc, { cx, by: bottom - gh * 1.95, w: w * 0.78, h: fh, level });
}

/** A thick arrow from (x1, y1) to (x2, y2), bent sideways by `bend`. */
export function arrow({ x1, y1, x2, y2, bend = 0, color = C.white, width = 12, head = 36, dash = null, opacity = 1 }) {
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

/** A brace under a group of things, from x1 to x2, with its tip pointing down at the middle. */
export function brace({ x1, x2, y, color, width = 8, depth = 26 }) {
  const mx = (x1 + x2) / 2;
  return path(`M${r2(x1)} ${r2(y)}V${r2(y + depth)}H${r2(x2)}V${r2(y)}M${r2(mx)} ${r2(y + depth)}V${r2(y + depth * 1.9)}`,
    `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"`);
}

/** A small six-point ice crystal: the sign for cold. */
export function crystal(cx, cy, r, color = C.ice) {
  const arms = [0, 60, 120].map((a) => {
    const t = (a * Math.PI) / 180;
    return `M${r2(cx - Math.cos(t) * r)} ${r2(cy - Math.sin(t) * r)}L${r2(cx + Math.cos(t) * r)} ${r2(cy + Math.sin(t) * r)}`;
  }).join('');
  return path(arms, `fill="none" stroke="${color}" stroke-width="${r2(r * 0.28)}" stroke-linecap="round"`);
}

/**
 * The heat camera's frame: four corner marks, and a heat scale on the right edge with a flame at the hot end and an
 * ice crystal at the cold end. `level` (0 to 1) places the scale's pointer. Pass `scale: false` to leave it out,
 * and name corners in `skip` ('top-left', 'top-right', 'bottom-left', 'bottom-right') to leave them out.
 */
export function hud(doc, { w, h, inset = 28, len = 54, weight = 6, scale = true, level = 0.8, scaleH = null, skip = [] }) {
  const c = `fill="none" stroke="${C.violet}" stroke-opacity="0.55" stroke-width="${weight}" stroke-linecap="round" stroke-linejoin="round"`;
  const corners = [
    ['top-left', `M${inset} ${inset + len}V${inset}H${inset + len}`],
    ['top-right', `M${w - inset - len} ${inset}H${w - inset}V${inset + len}`],
    ['bottom-left', `M${inset} ${h - inset - len}V${h - inset}H${inset + len}`],
    ['bottom-right', `M${w - inset - len} ${h - inset}H${w - inset}V${h - inset - len}`],
  ].filter(([name]) => !skip.includes(name)).map(([, d]) => path(d, c)).join('');
  if (!scale) return corners;
  const bh = scaleH ?? h * 0.42;
  const bw = Math.max(10, w * 0.011);
  const bx = w - inset - bw - len * 0.2;
  const by = (h - bh) / 2;
  const ramp = vgrad(doc, 'heat-scale', [[0, C.white], [0.25, C.amber], [0.5, C.orange], [0.75, C.magenta], [1, C.violet]]);
  const py = by + bh * (1 - level);
  const pointer = path(`M${r2(bx - bw * 0.3)} ${r2(py)}L${r2(bx - bw * 1.3)} ${r2(py - bw * 0.7)}L${r2(bx - bw * 1.3)} ${r2(py + bw * 0.7)}Z`, `fill="${C.white}"`);
  return corners
    + rect(bx, by, bw, bh, `rx="${r2(bw / 2)}" fill="${ramp}"`)
    + pointer
    + fireIcon(doc, bx + bw / 2, by - bw * 1.1, bw * 1.5)
    + crystal(bx + bw / 2, by + bh + bw * 1.6, bw * 0.75);
}

/** A tiny flame without its glow, for icons. */
function fireIcon(doc, cx, by, w) {
  return fire(doc, { cx, by, w, h: w * 1.3, level: 4, glow: 0 });
}

/** A heat camera's spot meter: a ring with four ticks around a hot point. */
export function reticle(cx, cy, r, color = C.white) {
  const t = r * 0.45;
  const ticks = `M${r2(cx)} ${r2(cy - r - t)}V${r2(cy - r + t * 0.4)}M${r2(cx)} ${r2(cy + r - t * 0.4)}V${r2(cy + r + t)}M${r2(cx - r - t)} ${r2(cy)}H${r2(cx - r + t * 0.4)}M${r2(cx + r - t * 0.4)} ${r2(cy)}H${r2(cx + r + t)}`;
  return circle(cx, cy, r, `fill="none" stroke="${color}" stroke-opacity="0.85" stroke-width="${r2(Math.max(3, r * 0.09))}"`)
    + path(ticks, `fill="none" stroke="${color}" stroke-opacity="0.85" stroke-width="${r2(Math.max(3, r * 0.09))}" stroke-linecap="round"`);
}

/** The room: a dark wall, a darker floor and its edge. */
export function room(doc, { w, h, floorY }) {
  const wall = vgrad(doc, `wall-${h}`, [[0, MIX.wallTop], [1, C.night]]);
  return rect(0, 0, w, h, `fill="${wall}"`)
    + rect(0, floorY, w, h - floorY, `fill="${MIX.deepNight}"`)
    + rect(0, floorY, w, 4, `fill="${C.rim}" fill-opacity="0.8"`);
}

/** A horizontal heat bar, cool on the left and hot on the right, for showing that something warms up. */
export function heatBar(doc, { x, y, w, h }) {
  const ramp = hgrad(doc, 'heat-bar', [[0, C.violet], [0.3, C.magenta], [0.6, C.orange], [0.85, C.amber], [1, C.white]]);
  return rect(x, y, w, h, `rx="${r2(h / 2)}" fill="${ramp}"`);
}

export { HEAT };
