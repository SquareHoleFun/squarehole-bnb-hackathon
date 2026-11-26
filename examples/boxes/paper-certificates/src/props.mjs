/**
 * The story's props, drawn in the same engraved manner: an outline in ink, a flat color where a child needs one to
 * tell things apart, and hatching for shade. The iron safe is the box, the scale is the box's own pool, the stove burns
 * SCRIP, the collection box marked SQUARE HOLE takes Square Hole's parts, the tin box is the closing pool, and manila
 * tags carry the few words a picture needs.
 */
import { C, MIX } from './palette.mjs';
import { box, ellipse, group, place, pt, r2, roundRect, seeded, smooth } from './doc.mjs';
import { band, fill, hatch, line, rosette, ruled, shape } from './engrave.mjs';
import { coin, coinFlat, coupon } from './coins.mjs';
import { DRAWN, letter, measure, placeDrawn } from './type.mjs';

/** The ground of a scene: plain paper, and a desk top from `floorY` down. */
export function room(doc, w, h, floorY) {
  const out = [`<rect width="${w}" height="${h}" fill="${C.paper}"/>`];
  if (floorY !== undefined) {
    out.push(
      fill(box(0, floorY, w, h - floorY), C.vellum),
      ruled(doc, box(0, floorY + 8, w, h - floorY), { x: 0, y: floorY + 10, w, h: h - floorY }, { gapStart: 7, gapEnd: 14, width: 1.2, color: MIX.paperDeep }),
      line(`M0 ${r2(floorY)}H${r2(w)}`, C.ink, 3),
    );
  }
  return out;
}

/** The thin engraved border of a scene: a double rule with a narrow guilloche band between, inset 22 px. */
export function border(w, h, color = C.ink) {
  return [
    line(roundRect(22, 22, w - 44, h - 44, 14), color, 2.4),
    band({ x: 31, y: 31, w: w - 62, h: h - 62, r: 10 }, { amp: 4, wave: 18, strands: 2, color, width: 0.9 }),
    line(roundRect(40, 40, w - 80, h - 80, 8), color, 1.4),
  ];
}

/** A sealed envelope, `w` wide, centred on (cx, cy): cream paper, a flap and a red wax seal with a question mark. */
export function envelope(cx, cy, w, rotate = 0) {
  const h = w * 0.64;
  const ow = Math.max(1.2, w * 0.03);
  const out = [
    group(place(cx, cy), [
      shape(roundRect(-w / 2, -h / 2, w, h, w * 0.04), C.paper, ow, C.ink),
      line(`M${pt(-w / 2, -h / 2)}L${pt(0, h * 0.12)}L${pt(w / 2, -h / 2)}M${pt(-w / 2, h / 2)}L${pt(-w * 0.12, 0)}M${pt(w / 2, h / 2)}L${pt(w * 0.12, 0)}`, C.ink, ow * 0.7),
      shape(ellipse(0, h * 0.1, w * 0.15), C.seal, ow * 0.8, MIX.sealDark),
    ]),
    w >= 40 ? letter('?', { x: cx, y: cy + h * 0.1 - w * 0.07, cap: w * 0.14, color: C.paper, weight: 'small' }) : null,
  ];
  return rotate ? group(`transform="rotate(${r2(rotate)} ${r2(cx)} ${r2(cy)})"`, out) : out;
}

/**
 * The box: a cast-iron safe marked 1,929, `w` wide, standing with its feet on `base` and centred on `cx`. Open, its
 * door swings to the right and shows shelves of sealed envelopes; closed, it shows the dial and the handle.
 */
export function safe(doc, cx, base, w, { open = true, count = 6 } = {}) {
  const h = w * 1.08;
  const x = cx - w / 2;
  const y = base - h;
  const body = roundRect(x, y + h * 0.13, w, h * 0.8, w * 0.03);
  const cornice = roundRect(x - w * 0.04, y, w * 1.08, h * 0.15, w * 0.03);
  const inner = { x: x + w * 0.1, y: y + h * 0.22, w: w * 0.8, h: h * 0.64 };
  const out = [
    shape(roundRect(x + w * 0.04, base - h * 0.08, w * 0.16, h * 0.08, 4), MIX.ironDark, 2.4, C.ink),
    shape(roundRect(x + w * 0.8, base - h * 0.08, w * 0.16, h * 0.08, 4), MIX.ironDark, 2.4, C.ink),
    shape(body, C.iron, 3, C.ink),
    hatch(doc, body, { x, y, w, h }, { angle: 90, gap: 5, width: 1.4, color: MIX.ironDark, within: box(x + w * 0.7, y, w * 0.4, h) }),
    shape(cornice, MIX.ironLight, 3, C.ink),
    line(roundRect(x + w * 0.03, y + h * 0.025, w * 0.94, h * 0.1, 3), C.gold, 1.6),
    letter('1,929', { x: cx, y: y + h * 0.04, cap: h * 0.07, color: C.gold, weight: 'text', track: 1.6 }),
    line(roundRect(x + w * 0.05, y + h * 0.18, w * 0.9, h * 0.72, 4), C.gold, 1.6),
  ];
  if (open) {
    out.push(
      shape(roundRect(inner.x, inner.y, inner.w, inner.h, 4), MIX.paperDeep, 2.4, C.ink),
      hatch(doc, roundRect(inner.x, inner.y, inner.w, inner.h, 4), inner, { angle: 45, gap: 6, width: 1, color: MIX.tagDark }),
      line(`M${pt(inner.x, inner.y + inner.h * 0.5)}H${r2(inner.x + inner.w)}`, C.ink, 3),
    );
    const per = Math.ceil(count / 2);
    for (let i = 0; i < count; i += 1) {
      const row = Math.floor(i / per);
      const col = i % per;
      const ew = (inner.w * 0.86) / per;
      out.push(envelope(inner.x + inner.w * 0.07 + ew * (col + 0.5), inner.y + inner.h * (row ? 0.78 : 0.3), ew * 0.94, (col % 2 ? 3 : -3)));
    }
    const dx = x + w;
    const door = `M${pt(dx, y + h * 0.17)}L${pt(dx + w * 0.38, y + h * 0.1)}L${pt(dx + w * 0.38, y + h * 0.98)}L${pt(dx, y + h * 0.9)}Z`;
    out.push(
      shape(door, C.iron, 3, C.ink),
      hatch(doc, door, { x: dx, y, w: w * 0.4, h }, { angle: 80, gap: 5, width: 1.3, color: MIX.ironDark }),
      line(`M${pt(dx + w * 0.05, y + h * 0.22)}L${pt(dx + w * 0.33, y + h * 0.17)}L${pt(dx + w * 0.33, y + h * 0.92)}L${pt(dx + w * 0.05, y + h * 0.86)}Z`, C.gold, 1.6),
      shape(ellipse(dx + w * 0.19, y + h * 0.48, w * 0.06, w * 0.08), MIX.ironLight, 2, C.ink),
    );
  } else {
    const [dcx, dcy, dr] = [cx, y + h * 0.48, w * 0.15];
    out.push(
      shape(ellipse(dcx, dcy, dr), MIX.ironLight, 3, C.ink),
      shape(ellipse(dcx, dcy, dr * 0.66), C.gold, 2, C.ink),
      line(Array.from({ length: 24 }, (_, i) => {
        const a = (i * Math.PI) / 12;
        return `M${pt(dcx + dr * 0.72 * Math.cos(a), dcy + dr * 0.72 * Math.sin(a))}L${pt(dcx + dr * 0.92 * Math.cos(a), dcy + dr * 0.92 * Math.sin(a))}`;
      }).join(''), C.gold, 1.4),
      shape(ellipse(dcx, dcy, dr * 0.2), MIX.ironDark, 2, C.ink),
      line(`M${pt(cx - w * 0.2, y + h * 0.72)}H${r2(cx + w * 0.2)}M${pt(cx, y + h * 0.66)}V${r2(y + h * 0.78)}`, C.ink, w * 0.035),
      line(`M${pt(cx - w * 0.2, y + h * 0.72)}H${r2(cx + w * 0.2)}M${pt(cx, y + h * 0.66)}V${r2(y + h * 0.78)}`, C.gold, w * 0.018),
    );
  }
  return out;
}

/** Fire: rings of flame, ember and a pale core, with a few tongues. Centred on cx, sitting on `base`, `w` wide. */
export function fire(cx, base, w) {
  const h = w * 1.25;
  const tongue = (dx, s) => `M${pt(cx + dx - w * 0.2 * s, base)}C${pt(cx + dx - w * 0.28 * s, base - h * 0.4 * s)} ${pt(cx + dx - w * 0.05 * s, base - h * 0.6 * s)} ${pt(cx + dx, base - h * s)}C${pt(cx + dx + w * 0.08 * s, base - h * 0.6 * s)} ${pt(cx + dx + w * 0.28 * s, base - h * 0.4 * s)} ${pt(cx + dx + w * 0.2 * s, base)}Z`;
  return [
    shape(tongue(-w * 0.26, 0.7), C.flame, 2, MIX.flameDark),
    shape(tongue(w * 0.26, 0.76), C.flame, 2, MIX.flameDark),
    shape(tongue(0, 1), C.flame, 2, MIX.flameDark),
    shape(tongue(0, 0.68), C.ember, 1.4, MIX.flameDark),
    fill(tongue(0, 0.36), MIX.fireCore),
  ];
}

/** The stove that burns SCRIP: a cast-iron pot-belly stove with its door open. `lit` shows the fire; else it is cold. */
export function stove(doc, cx, base, w, { lit = true, pipeTo = null } = {}) {
  const h = w * 1.5;
  const top = base - h;
  const body = smooth([[cx - w * 0.36, base - h * 0.14], [cx - w * 0.5, base - h * 0.42], [cx - w * 0.42, base - h * 0.7], [cx - w * 0.3, base - h * 0.8],
    [cx + w * 0.3, base - h * 0.8], [cx + w * 0.42, base - h * 0.7], [cx + w * 0.5, base - h * 0.42], [cx + w * 0.36, base - h * 0.14]]);
  const door = `M${pt(cx - w * 0.22, base - h * 0.24)}V${r2(base - h * 0.5)}A${r2(w * 0.22)} ${r2(w * 0.2)} 0 0 1 ${pt(cx + w * 0.22, base - h * 0.5)}V${r2(base - h * 0.24)}Z`;
  const pipeTop = pipeTo ?? top - w * 0.4;
  const out = [
    line(`M${pt(cx - w * 0.3, base - h * 0.14)}L${pt(cx - w * 0.38, base)}M${pt(cx + w * 0.3, base - h * 0.14)}L${pt(cx + w * 0.38, base)}M${pt(cx, base - h * 0.12)}V${r2(base)}`, C.ink, w * 0.06),
    line(`M${pt(cx - w * 0.3, base - h * 0.14)}L${pt(cx - w * 0.38, base)}M${pt(cx + w * 0.3, base - h * 0.14)}L${pt(cx + w * 0.38, base)}M${pt(cx, base - h * 0.12)}V${r2(base)}`, C.iron, w * 0.03),
    shape(box(cx - w * 0.09, pipeTop, w * 0.18, base - h * 0.84 - pipeTop), C.iron, 2.6, C.ink),
    line(`M${pt(cx - w * 0.09, top + h * 0.02)}H${r2(cx + w * 0.09)}M${pt(cx - w * 0.09, pipeTop + (top - pipeTop) * 0.5)}H${r2(cx + w * 0.09)}`, C.ink, 2.4),
    shape(roundRect(cx - w * 0.32, base - h * 0.9, w * 0.64, h * 0.1, 6), MIX.ironLight, 2.6, C.ink),
    shape(body, C.iron, 3, C.ink),
    hatch(doc, body, { x: cx - w, y: top, w: 2 * w, h }, { angle: 90, gap: 5, width: 1.4, color: MIX.ironDark, within: box(cx + w * 0.18, top, w, h) }),
    line(`M${pt(cx - w * 0.46, base - h * 0.62)}Q${pt(cx, base - h * 0.58)} ${pt(cx + w * 0.46, base - h * 0.62)}`, MIX.ironLight, 3),
    shape(roundRect(cx - w * 0.42, base - h * 0.16, w * 0.84, h * 0.06, 4), MIX.ironLight, 2.6, C.ink),
    shape(door, lit ? MIX.flameDark : MIX.ironDark, 2.6, C.ink),
  ];
  if (lit) {
    out.push(group(doc.clip(door), fire(cx, base - h * 0.24, w * 0.34)));
  } else {
    out.push(fill(`M${pt(cx - w * 0.2, base - h * 0.24)}Q${pt(cx, base - h * 0.32)} ${pt(cx + w * 0.2, base - h * 0.24)}Z`, MIX.smoke));
  }
  out.push(line(door, C.ink, 2.6));
  return out;
}

/** A puff of smoke rising from (cx, cy). */
export function smoke(cx, cy, s) {
  const puff = (x, y, r) => shape(ellipse(x, y, r), MIX.smokeLight, 2, MIX.smoke);
  return [puff(cx, cy, s * 0.5), puff(cx + s * 0.4, cy - s * 0.6, s * 0.62), puff(cx - s * 0.1, cy - s * 1.3, s * 0.72)];
}

/**
 * The box's own pool: a balance scale. Price coins lie in the left pan and SCRIP coupons in the right pan, because the
 * pool holds both and swaps one for the other. Centred on `cx`, standing on `base`, `w` wide.
 */
export function scale(doc, cx, base, w, { coin = 'gold', left = 3, right = 3 } = {}) {
  const h = w * 0.9;
  const beamY = base - h * 0.92;
  const panY = base - h * 0.42;
  const pan = (px) => `M${pt(px - w * 0.2, panY)}Q${pt(px, panY + w * 0.13)} ${pt(px + w * 0.2, panY)}Z`;
  const [lx, rx] = [cx - w * 0.36, cx + w * 0.36];
  const out = [
    shape(roundRect(cx - w * 0.22, base - h * 0.06, w * 0.44, h * 0.06, 4), C.wood, 2.6, C.ink),
    shape(roundRect(cx - w * 0.14, base - h * 0.12, w * 0.28, h * 0.07, 4), MIX.woodDark, 2.6, C.ink),
    shape(box(cx - w * 0.03, beamY, w * 0.06, h * 0.81), C.steel, 2.6, C.ink),
    hatch(doc, box(cx - w * 0.03, beamY, w * 0.06, h * 0.81), { x: cx - w * 0.03, y: beamY, w: w * 0.06, h }, { angle: 90, gap: 3.4, width: 1, color: MIX.steelDark, within: box(cx, beamY, w * 0.05, h) }),
    shape(roundRect(cx - w * 0.44, beamY - h * 0.025, w * 0.88, h * 0.05, 6), C.steel, 2.6, C.ink),
    shape(`M${pt(cx, beamY - h * 0.12)}L${pt(cx + w * 0.03, beamY - h * 0.02)}H${r2(cx - w * 0.03)}Z`, C.steel, 2, C.ink),
    shape(ellipse(cx, beamY, w * 0.035), MIX.steelLight, 2.2, C.ink),
    line(`M${pt(lx, beamY)}L${pt(lx - w * 0.19, panY)}M${pt(lx, beamY)}L${pt(lx + w * 0.19, panY)}M${pt(rx, beamY)}L${pt(rx - w * 0.19, panY)}M${pt(rx, beamY)}L${pt(rx + w * 0.19, panY)}`, C.ink, 1.8, 'stroke-dasharray="5 3"'),
  ];
  for (let i = 0; i < left; i += 1) out.push(coinFlat(lx - w * 0.08 + (i % 3) * w * 0.08, panY - w * 0.015 - Math.floor(i / 3) * w * 0.04, w * 0.06, coin));
  for (let i = 0; i < right; i += 1) out.push(coupon(rx - w * 0.06 + (i % 3) * w * 0.06, panY - w * 0.03 - Math.floor(i / 3) * w * 0.04, w * 0.11, -8 + i * 7));
  out.push(
    shape(pan(lx), C.steel, 2.6, C.ink), hatch(doc, pan(lx), { x: lx - w * 0.2, y: panY, w: w * 0.4, h: w * 0.2 }, { angle: 0, gap: 3.4, width: 1, color: MIX.steelDark }),
    shape(pan(rx), C.steel, 2.6, C.ink), hatch(doc, pan(rx), { x: rx - w * 0.2, y: panY, w: w * 0.4, h: w * 0.2 }, { angle: 0, gap: 3.4, width: 1, color: MIX.steelDark }),
  );
  return out;
}

/** Square Hole's parts go into a wooden collection box with a brass slot. */
export function slotBox(doc, cx, base, w) {
  const h = w * 0.8;
  const front = box(cx - w / 2, base - h, w, h);
  return [
    shape(front, C.wood, 3, C.ink),
    hatch(doc, front, { x: cx - w / 2, y: base - h, w, h }, { angle: 0, gap: 6, width: 1.2, color: MIX.woodDark }),
    line(`M${pt(cx - w / 2, base - h * 0.5)}H${r2(cx + w / 2)}`, C.ink, 2),
    shape(`M${pt(cx - w / 2, base - h)}L${pt(cx - w * 0.38, base - h * 1.18)}H${r2(cx + w * 0.62)}L${pt(cx + w / 2, base - h)}Z`, MIX.woodLight, 3, C.ink),
    shape(`M${pt(cx + w / 2, base - h)}L${pt(cx + w * 0.62, base - h * 1.18)}V${r2(base - h * 0.18)}L${pt(cx + w / 2, base)}Z`, MIX.woodDark, 3, C.ink),
    shape(roundRect(cx - w * 0.24, base - h * 1.12, w * 0.6, h * 0.1, 6), C.gold, 2.4, C.ink),
    fill(roundRect(cx - w * 0.17, base - h * 1.09, w * 0.46, h * 0.04, 2), C.ink),
  ];
}

/** A shallow wooden tray heaped with price coins. */
export function tray(doc, cx, base, w, { coin = 'gold', heap = 9 } = {}) {
  const h = w * 0.16;
  const body = `M${pt(cx - w / 2, base - h)}H${r2(cx + w / 2)}L${pt(cx + w * 0.44, base)}H${r2(cx - w * 0.44)}Z`;
  const rand = seeded(`tray-${cx}-${heap}`);
  const coins = [];
  const rows = [Math.ceil(heap * 0.45), Math.ceil(heap * 0.33), heap - Math.ceil(heap * 0.45) - Math.ceil(heap * 0.33)];
  rows.forEach((n, row) => {
    for (let i = 0; i < n; i += 1) {
      const span = w * (0.78 - row * 0.2);
      coins.push(coinFlat(cx - span / 2 + (span * (i + 0.5)) / n + (rand() - 0.5) * 4, base - h - w * 0.02 - row * w * 0.05, w * 0.085, coin));
    }
  });
  return [...coins, shape(body, C.wood, 3, C.ink), hatch(doc, body, { x: cx - w / 2, y: base - h, w, h }, { angle: 0, gap: 4, width: 1.1, color: MIX.woodDark })];
}

/**
 * A manila tag with words, hung by a string from a pin above it. (cx, cy) is the tag's centre; the tag grows to fit
 * its words. `pin` is 'up', a point [x, y] the string runs to, or null. A small `angle` (degrees) tilts the tag and its
 * words together about its centre.
 */
export function tag(cx, cy, text, { cap = 26, angle = 0, pin = 'up' } = {}) {
  const lines = Array.isArray(text) ? text : [text];
  const m = measure(lines, cap, { track: 1.6 });
  const w = m.w + cap * 2.8;
  const h = m.h + cap * 1.1;
  const notch = h * 0.3;
  const [x0, y0, x1, y1] = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
  const body = `M${pt(x0 + notch, y0)}H${r2(x1 - 6)}Q${pt(x1, y0)} ${pt(x1, y0 + 6)}V${r2(y1 - 6)}Q${pt(x1, y1)} ${pt(x1 - 6, y1)}H${r2(x0 + notch)}L${pt(x0, y1 - notch)}V${r2(y0 + notch)}Z`;
  const hole = [x0 + cap * 0.95, cy];
  const out = [];
  if (pin) {
    const top = pin === 'up' ? [cx, y0 - cap * 1.6] : pin;
    out.push(line(`M${pt(...hole)}L${pt(...top)}`, C.ink, 1.6), shape(ellipse(top[0], top[1], 4), MIX.steelDark, 1.6, C.ink));
  }
  out.push(
    shape(body, C.tag, 2.4, C.ink),
    shape(ellipse(hole[0], hole[1], cap * 0.32), MIX.tagDark, 1.6, C.ink),
    fill(ellipse(hole[0], hole[1], cap * 0.15), C.paper),
    letter(lines, { x: cx + cap * 0.45, y: cy - m.h / 2, cap, color: C.ink, weight: 'text', track: 1.6 }),
  );
  return angle ? group(`transform="rotate(${r2(angle)} ${r2(cx)} ${r2(cy)})"`, out) : out;
}

/**
 * The raise: a ruled bar filling with the price coin's color, `share` full (0 to 1). `state` 'full' adds a check in a
 * gold seal, 'failed' a red cross.
 */
export function raiseBar(doc, x, y, w, share, { coin = 'gold', state = null } = {}) {
  const h = 54;
  const [face, deep] = coin === 'gold' ? [C.gold, MIX.goldDark] : [C.steel, MIX.steelDark];
  const frame = roundRect(x, y, w, h, 10);
  const filled = roundRect(x + 8, y + 8, Math.max(0, (w - 16) * share), h - 16, 5);
  const out = [
    shape(frame, C.paper, 3, C.ink),
    share > 0 ? shape(filled, face, 2, deep) : null,
    share > 0 ? hatch(doc, filled, { x, y, w, h }, { angle: 60, gap: 7, width: 1.4, color: deep }) : null,
    line(Array.from({ length: 9 }, (_, i) => `M${pt(x + ((i + 1) * w) / 10, y + h)}V${r2(y + h + 12)}`).join(''), C.ink, 2),
  ];
  const [sx, sy] = [x + w + 54, y + h / 2];
  if (state === 'full') {
    out.push(shape(ellipse(sx, sy, 36), C.gold, 2.6, C.ink), line(`M${pt(sx - 16, sy + 1)}L${pt(sx - 4, sy + 13)}L${pt(sx + 17, sy - 13)}`, C.ink, 6));
  } else if (state === 'failed') {
    out.push(shape(ellipse(sx, sy, 36), C.paper, 2.6, C.seal), line(`M${pt(sx - 14, sy - 14)}L${pt(sx + 14, sy + 14)}M${pt(sx + 14, sy - 14)}L${pt(sx - 14, sy + 14)}`, C.seal, 7));
  }
  return out;
}

/**
 * An arrow from `a` to `b` that bows by `bend` px to its left: a red band in an ink edge with a pointed head. The
 * arrows show where things go; they show no amounts and no timing.
 */
export function arrow(a, b, bend = 0, width = 16) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(dx, dy);
  const [nx, ny] = [-dy / len, dx / len];
  const c = [a[0] + dx / 2 + nx * bend, a[1] + dy / 2 + ny * bend];
  // The head points along the curve's last direction, from the control point to b.
  const [tx, ty] = [b[0] - c[0], b[1] - c[1]];
  const tl = Math.hypot(tx, ty);
  const [ux, uy] = [tx / tl, ty / tl];
  const headL = width * 2.3;
  const base = [b[0] - ux * headL, b[1] - uy * headL];
  const stop = [b[0] - ux * headL * 0.8, b[1] - uy * headL * 0.8];
  const shaft = `M${pt(...a)}Q${pt(...c)} ${pt(...stop)}`;
  const head = `M${pt(...b)}L${pt(base[0] - uy * width * 1.25, base[1] + ux * width * 1.25)}L${pt(base[0] + uy * width * 1.25, base[1] - ux * width * 1.25)}Z`;
  return [
    line(shaft, C.ink, width + 5),
    line(shaft, C.seal, width),
    shape(head, C.seal, 2.6, C.ink),
  ];
}

/** A small flame burning a coupon away: the coupon, a flame on top and a curl of smoke. */
export function burningCoupon(cx, cy, w) {
  return [
    coupon(cx, cy, w, -6),
    fire(cx, cy + w * 0.08, w * 0.5),
    line(`M${pt(cx + w * 0.1, cy - w * 0.62)}C${pt(cx + w * 0.3, cy - w * 0.8)} ${pt(cx - w * 0.1, cy - w * 0.95)} ${pt(cx + w * 0.12, cy - w * 1.15)}`, MIX.smoke, 3),
  ];
}

/** The closing pool: a tin cash box with its lid open and coins inside. */
export function cashBox(doc, cx, base, w, { coin = 'gold' } = {}) {
  const h = w * 0.42;
  const front = box(cx - w / 2, base - h, w, h);
  const lid = `M${pt(cx - w / 2, base - h)}L${pt(cx - w * 0.44, base - h - w * 0.36)}H${r2(cx + w * 0.56)}L${pt(cx + w / 2, base - h)}Z`;
  const out = [shape(lid, MIX.steelLight, 3, C.ink), line(`M${pt(cx - w * 0.38, base - h - w * 0.3)}H${r2(cx + w * 0.5)}`, MIX.steelDark, 2)];
  for (let i = 0; i < 7; i += 1) out.push(coinFlat(cx - w * 0.34 + i * w * 0.11, base - h - w * 0.01, w * 0.07, coin));
  out.push(
    shape(front, C.steel, 3, C.ink),
    hatch(doc, front, { x: cx - w / 2, y: base - h, w, h }, { angle: 90, gap: 5, width: 1.2, color: MIX.steelDark, within: box(cx + w * 0.2, base - h, w, h) }),
    shape(roundRect(cx - w * 0.08, base - h * 0.62, w * 0.16, h * 0.3, 4), MIX.steelLight, 2.4, C.ink),
    shape(ellipse(cx, base - h * 0.47, w * 0.022), C.ink, 1, C.ink),
  );
  return out;
}

/**
 * A small certificate: the frame of a variant `v` in its ink, its vignette in the oval and its name, without the
 * coupons. `w` wide, centred on (cx, cy), turned by `rotate` degrees about its centre. Used on walls and banners.
 */
export function miniCertificate(doc, v, cx, cy, w, { rotate = 0 } = {}) {
  const k = w / 908;
  const h = 624 * k;
  const ow = Math.max(1.2, 3 * k);
  const outer = roundRect(-w / 2, -h / 2, w, h, 26 * k);
  const inner = roundRect(-w / 2 + 26 * k, -h / 2 + 26 * k, w - 52 * k, h - 52 * k, 6 * k);
  const ovalY = -h / 2 + (238 - 58) * k;
  const [sx, sy] = [-w / 2 + 148 * k, h / 2 - 90 * k];
  const from = DRAWN.length;
  const scene = v.vignette(doc, v);
  placeDrawn(from, cx, cy + ovalY, k);
  const art = group(place(cx, cy), [
    fill(roundRect(-w / 2 + 6 * k + 2, -h / 2 + 8 * k + 2, w, h, 26 * k), MIX.ironDark),
    shape(outer, C.paper, 0, C.paper),
    `<path d="${outer}${inner}" fill="${v.ink}" fill-rule="evenodd"/>`,
    group(doc.clip(`${outer}${inner}`), band({ x: -w / 2 + 13 * k, y: -h / 2 + 13 * k, w: w - 26 * k, h: h - 26 * k, r: 13 * k }, { amp: 9 * k, wave: Math.max(8, 30 * k), strands: 3, color: C.paper, width: Math.max(0.6, 1.4 * k) })),
    line(outer, v.ink, ow),
    shape(ellipse(0, ovalY, 206 * k, 134 * k), C.paper, ow, v.ink),
    group(place(0, ovalY, { scale: k }), group(doc.clip(ellipse(0, 0, 196, 124)), scene), line(ellipse(0, 0, 196, 124), v.ink, 2.6)),
    v.special
      ? [shape(ellipse(sx, sy, 46 * k), C.gold, ow, MIX.goldDark), rosette(sx, sy, { R: 40, rr: 14, dd: 12, size: 34 * k, color: MIX.goldDark, width: Math.max(0.6, k * 1.2), samples: 50 })]
      : [shape(ellipse(sx, sy, 46 * k), C.seal, ow, MIX.sealDark), line(ellipse(sx, sy, 32 * k), MIX.sealLight, Math.max(0.6, 1.2 * k))],
  ]);
  const weight = w > 400 ? 'display' : 'text';
  const words = [
    letter(v.company[0], { x: cx, y: cy - h / 2 + (386 - 58) * k, cap: (v.cap?.[0] ?? 54) * k, color: v.ink, weight, wide: 1.04, track: 1.5 }),
    letter(v.company[1], { x: cx, y: cy - h / 2 + (460 - 58) * k, cap: (v.cap?.[1] ?? 36) * k, color: v.ink, weight, track: 1.8 }),
  ];
  return rotate ? group(`transform="rotate(${r2(rotate)} ${r2(cx)} ${r2(cy)})"`, [art, words]) : [art, words];
}

/** A gilt picture frame around a small certificate: a certificate out of the box, at home on someone's wall. */
export function framed(doc, v, cx, cy, w) {
  const h = w * (624 / 908);
  const pad = w * 0.09;
  const outer = roundRect(cx - w / 2 - pad, cy - h / 2 - pad, w + 2 * pad, h + 2 * pad, 6);
  const inner = box(cx - w / 2 - pad * 0.35, cy - h / 2 - pad * 0.35, w + pad * 0.7, h + pad * 0.7);
  return [
    line(`M${pt(cx, cy - h / 2 - pad - 60)}L${pt(cx - w * 0.3, cy - h / 2 - pad)}M${pt(cx, cy - h / 2 - pad - 60)}L${pt(cx + w * 0.3, cy - h / 2 - pad)}`, C.ink, 2),
    shape(ellipse(cx, cy - h / 2 - pad - 60, 6), MIX.steelDark, 2, C.ink),
    `<path d="${outer}${inner}" fill="${C.gold}" fill-rule="evenodd" stroke="${C.ink}" stroke-width="3"/>`,
    hatch(doc, `${outer}${inner}`, { x: cx - w, y: cy - h, w: 2 * w, h: 2 * h }, { angle: 45, gap: 6, width: 1.2, color: MIX.goldDark, within: box(cx, cy - h, w, 2 * h) }),
    shape(inner, C.paper, 2, C.ink),
    miniCertificate(doc, v, cx, cy, w * 0.94),
  ];
}

/** A few coins in a slanting row, falling into something. */
export function fallingCoins(doc, cx, cy, kind, n, r = 22) {
  return Array.from({ length: n }, (_, i) => coin(doc, cx - (n - 1) * r * 0.9 + i * r * 1.8, cy + i * r * 0.9, r, kind));
}

/** A shallow dish, where a certificate's coupons wait for its owner. */
export function dish(cx, cy, w) {
  return [
    shape(`M${pt(cx - w / 2, cy)}Q${pt(cx, cy + w * 0.2)} ${pt(cx + w / 2, cy)}Z`, C.vellum, 3, C.ink),
    line(`M${pt(cx - w * 0.4, cy + w * 0.03)}Q${pt(cx, cy + w * 0.14)} ${pt(cx + w * 0.4, cy + w * 0.03)}`, MIX.paperDeep, 2),
  ];
}
