// Shared authored patches and tags in reference pixels. The same paths become SVG and solid geometry.
import { C } from '../../src/palette.mjs';
import { VARIANTS } from '../../src/items.mjs';

export const ellipse = (x, y, rx, ry, steps = 16) => Array.from({ length: steps }, (_, i) => {
  const angle = i * Math.PI * 2 / steps;
  return [x + rx * Math.cos(angle), y + ry * Math.sin(angle)];
});
export function rounded(x, y, w, h, r = 10) {
  return [[x + w - r, y + r], [x + w - r, y + h - r], [x + r, y + h - r], [x + r, y + r]].flatMap(([cx, cy], i) =>
    Array.from({ length: 4 }, (_, j) => {
      const a = (i - 1) * Math.PI / 2 + j * Math.PI / 6;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    }));
}
export const rectangle = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

// Repairs and blank tags leave the original prints and their clear space untouched.
// Tote repair sits on its pocket; paper/chips above the label; sand below its stamp.
const PLACEMENT = {
  '01': [512, 790, 0.8, 699, 650], '02': [445, 545, 0.64, 625, 505],
  '03': [512, 725, 0.85, 605, 565], '04': [500, 820, 0.65, 650, 535],
  '05': [512, 785, 1.25, 674, 650], '06': [512, 595, 0.85, 625, 760],
  '07': [465, 770, 0.8, 465, 630], '08': [512, 690, 1.1, 675, 535],
  '09': [512, 770, 0.75, 735, 680], '10': [512, 795, 1.1, 640, 500],
  '11': [512, 374, 0.6, 700, 340], '12': [512, 740, 0.9, 650, 535],
};
export function reference(traits) {
  const v = VARIANTS.find(v => v.n === traits.kind), accent = C[traits.trim];
  return { ...v, options: { ...v.bag, pocket: accent, bandColor: accent, strap: accent, dots: accent, stripe: C.canvas, net: accent } };
}

export function details(traits) {
  const [x, y, s, tx, ty] = PLACEMENT[traits.kind], accent = C[traits.trim], parts = [];
  const point = ([u, v]) => [x + u * s, y + v * s];
  const fill = (points, color = accent, ow = 8) => parts.push({ points: points.map(point), fill: color, width: ow * s });
  const stroke = (points, color = C.ink, width = 6) => parts.push({ points: points.map(point), color, width: width * s });
  switch (traits.repair) {
    case 'square': fill([[-76, -55], [65, -65], [78, 52], [-66, 60]]); break;
    case 'round': fill(ellipse(0, 0, 72, 62)); break;
    case 'twin': fill(rounded(-83, -55, 90, 105, 9)); fill(rounded(3, -32, 80, 91, 9)); break;
    case 'slash':
      fill([[-84, 30], [52, -65], [83, -27], [-53, 68]]);
      break;
    case 'ladder':
      fill(rounded(-85, -43, 170, 86, 14));
      stroke([[-67, 0], [67, 0]], C.ink, 10);
      for (let i = -2; i <= 2; i++) stroke([[i * 25, -26], [i * 25, 26]], C.canvas, 9);
      break;
    case 'corners':
      fill([[-82, -60], [18, -60], [-82, 55]]);
      fill([[82, 60], [-18, 60], [82, -55]]);
      break;
    case 'pocket':
      fill(rounded(-78, -60, 156, 120, 12));
      fill([[-78, -60], [78, -60], [67, -18], [0, 4], [-67, -18]], C.canvas);
      fill(ellipse(0, -16, 10, 10, 12), C.steel, 4);
      break;
  }
  // Seams stay on the repair itself. A diagonal darn carries larger stitches along its diagonal.
  if (traits.repair === 'slash') {
    for (let i = -2; i <= 2; i++) {
      const u = i * 22, v = -i * 16;
      stroke([[u - 12, v - 18], [u + 12, v + 18]], C.ink, 7);
      if (traits.stitch === 'crossed') stroke([[u - 18, v + 12], [u + 18, v - 12]], C.ink, 7);
    }
  } else {
    const stitches = traits.repair === 'corners' ? [[-66, -42], [-47, -42], [47, 42], [66, 42]]
      : [-45, -15, 15, 45].map(u => [u, traits.repair === 'ladder' ? 28 : 40]);
    for (const [u, v] of stitches) {
      if (traits.stitch === 'running') stroke([[u - 6, v], [u + 6, v]], C.ink, 5);
      else { stroke([[u - 5, v - 6], [u + 5, v + 6]], C.ink, 5); stroke([[u - 5, v + 6], [u + 5, v - 6]], C.ink, 5); }
    }
  }
  const tether = [[tx - 15, ty - 45], [tx + 5, ty + 5]];
  parts.push({ points: tether, color: C.ink, width: 14 }, { points: tether, color: C.canvas, width: 6 });
  const tag = traits.tag === 'round' ? ellipse(tx, ty + 38, 39, 43)
    : traits.tag === 'ticket' ? [[tx - 34, ty + 16], [tx - 15, ty - 3], [tx + 15, ty - 3], [tx + 34, ty + 16], [tx + 34, ty + 85], [tx - 34, ty + 85]]
      : [[tx - 34, ty], [tx + 34, ty], [tx + 34, ty + 88], [tx, ty + 65], [tx - 34, ty + 88]];
  parts.push({ points: tag, fill: accent, width: 8 });
  parts.push({ points: ellipse(tx, ty + 16, 6, 6, 8), fill: C.ink, width: 0 });
  return parts;
}
