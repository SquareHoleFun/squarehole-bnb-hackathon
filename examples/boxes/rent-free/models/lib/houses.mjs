// Authored facade coordinates follow the approved 512 px pictures. All houses use 350 px/unit.
// Depth and secondary elevations are invented for this study. The front always faces +z.
import { cross, sub } from './glb.mjs';
export const NAMES = ['Cottage', 'Townhouse', 'Bungalow', 'A-frame', 'Awning', 'Arch roof', 'Clay roof', 'Step gable', 'Lean-to', 'Clay dome', 'Dormer', 'Roof garden'];
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const ellipse = (x, y, rx, ry, n = 20) => Array.from({ length: n }, (_, i) => [x + rx * Math.cos(i * Math.PI * 2 / n), y + ry * Math.sin(i * Math.PI * 2 / n)]);
function rounded(x, y, w, h, r = 8) {
  return [[x + w - r, y + r], [x + w - r, y + h - r], [x + r, y + h - r], [x + r, y + r]].flatMap(([cx, cy], i) =>
    Array.from({ length: 4 }, (_, j) => [cx + r * Math.cos((i - 1) * Math.PI / 2 + j * Math.PI / 6), cy + r * Math.sin((i - 1) * Math.PI / 2 + j * Math.PI / 6)]));
}
const area = p => p.reduce((a, v, i) => { const b = p[(i + 1) % p.length]; return a + v[0] * b[1] - b[0] * v[1]; }, 0);
const turn = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function triangulate(p) {
  const remaining = p.map((_, i) => i), out = [];
  while (remaining.length > 3) {
    let found = false;
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[(i + remaining.length - 1) % remaining.length], b = remaining[i], c = remaining[(i + 1) % remaining.length];
      if (turn(p[a], p[b], p[c]) <= 1e-8) continue;
      if (remaining.some(j => j !== a && j !== b && j !== c && turn(p[a], p[b], p[j]) >= -1e-8 && turn(p[b], p[c], p[j]) >= -1e-8 && turn(p[c], p[a], p[j]) >= -1e-8)) continue;
      out.push([a, b, c]); remaining.splice(i, 1); found = true; break;
    }
    if (!found) throw new Error('Cannot triangulate authored polygon');
  }
  out.push(remaining);
  return out;
}

class House {
  triangles = [];
  constructor(base, left, right, eave, depth = 180) {
    Object.assign(this, { base, left, right, eave, front: depth / 2, back: -depth / 2 });
  }
  triangle(a, b, c, material) {
    if (Math.hypot(...cross(sub(b, a), sub(c, a))) < 1e-7) return;
    this.triangles.push({ points: [a, b, c], material });
  }
  // Closed, outward-wound extrusion with concave polygon caps.
  prism(points, back, front, material) {
    let p = points.map(([x, y]) => [x, -y]);
    p = p.filter((v, i) => Math.hypot(...sub(v, p[(i + 1) % p.length])) > 1e-7);
    p = p.filter((v, i) => Math.abs(turn(p[(i + p.length - 1) % p.length], v, p[(i + 1) % p.length])) > 1e-7);
    if (area(p) < 0) p = p.toReversed();
    const face = triangulate(p);
    for (const [a, b, c] of face) {
      this.triangle([...p[a], front], [...p[b], front], [...p[c], front], material);
      this.triangle([...p[c], back], [...p[b], back], [...p[a], back], material);
    }
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      this.triangle([...a, front], [...a, back], [...b, back], material);
      this.triangle([...a, front], [...b, back], [...b, front], material);
    }
  }
  panel(points, material, z = this.front + 3, thickness = 3) { this.prism(points, z - thickness, z, material); }
  stroke(points, width, material = 'forest', z = this.front + 7, round = false) {
    const p = points.filter((v, i) => i === 0 || Math.hypot(...sub(v, points[i - 1])) > 1e-7);
    const closed = Math.hypot(...sub(p[0], p.at(-1))) < 1e-7;
    const normals = p.slice(1).map((v, i) => { const d = sub(v, p[i]), length = Math.hypot(...d); return [-d[1] / length, d[0] / length]; });
    const offsets = p.map((_, i) => {
      const a = normals[i - 1] ?? (closed ? normals.at(-1) : normals[0]);
      const b = normals[i] ?? (closed ? normals[0] : normals.at(-1));
      const divisor = Math.max(0.25, 1 + a[0] * b[0] + a[1] * b[1]);
      return [(a[0] + b[0]) / divisor * width / 2, (a[1] + b[1]) / divisor * width / 2];
    });
    for (let i = 1; i < p.length; i++) {
      const [a, b] = [p[i - 1], p[i]];
      const u = round ? normals[i - 1].map(v => v * width / 2) : offsets[i - 1];
      const v = round ? u : offsets[i];
      this.panel([[a[0] + u[0], a[1] + u[1]], [b[0] + v[0], b[1] + v[1]], [b[0] - v[0], b[1] - v[1]], [a[0] - u[0], a[1] - u[1]]], material, z);
    }
    if (round) for (const [x, y] of p) this.panel(ellipse(x, y, width / 2, width / 2, 8), material, z + 0.1);
  }
  body(points) { this.prism(points, this.back, this.front, 'green'); }
  walls() { this.body(rect(this.left, this.eave, this.right - this.left, this.base - this.eave)); }
  baseTrim() {
    // The short ground stroke becomes a shallow foundation, with its underside exactly on y=0.
    this.prism(rounded(this.left - 22, this.base - 10, this.right - this.left + 44, 10, 4), this.back - 5, this.front + 13, 'forest');
    this.stroke([[this.left, this.leftEave ?? this.eave], [this.left, this.base - 5]], 14);
    this.stroke([[this.right, this.rightEave ?? this.eave], [this.right, this.base - 5]], 14);
  }
  window(x, y, w, h, shape = 'rect', z = this.front + 9, crossbar = true) {
    const path = inset => shape === 'round' ? ellipse(x + w / 2, y + h / 2, w / 2 - inset, h / 2 - inset, 24)
      : shape === 'diamond' ? [[x + w / 2, y + inset], [x + w - inset, y + h / 2], [x + w / 2, y + h - inset], [x + inset, y + h / 2]]
        : rounded(x + inset, y + inset, w - 2 * inset, h - 2 * inset, Math.max(2, 10 - inset));
    this.panel(path(0), 'forest', z, 6);
    this.panel(path(12), 'butter', z + 0.5, 1);
    if (crossbar) {
      this.panel(rect(x + w / 2 - 3.5, y + 10, 7, h - 20), 'forest', z + 1);
      this.panel(rect(x + 10, y + h / 2 - 3.5, w - 20, 7), 'forest', z + 1);
    }
  }
  door(x, y, w, material = 'forest', knob = false, arch = false) {
    const path = inset => arch ? [
      [x + inset, this.base - 7], ...Array.from({ length: 17 }, (_, i) => {
        const t = Math.PI + i * Math.PI / 16;
        return [x + w / 2 + (w / 2 - inset) * Math.cos(t), y + w / 2 + (w / 2 - inset) * Math.sin(t)];
      }), [x + w - inset, this.base - 7],
    ] : rounded(x + inset, y + inset, w - 2 * inset, this.base - y - inset - 5, Math.max(3, 12 - inset));
    this.panel(path(0), 'forest', this.front + 10, 6);
    if (material !== 'forest') this.panel(path(12), material, this.front + 11, 2);
    if (knob) this.panel(ellipse(x + w * (material === 'clay' ? 0.36 : 0.75), y + (this.base - y) * 0.57, 8, 8, 16), material === 'clay' ? 'forest' : 'butter', this.front + 14, 4);
  }
  chimney(x, top, bottom, width = 54) {
    this.prism(rect(x, top, width, bottom - top), 10, 65, 'forest');
    this.prism(rect(x + 9, top + 8, width - 18, bottom - top - 8), 9, 66, 'clay');
    this.prism(rounded(x - 8, top - 6, width + 16, 24, 8), 3, 72, 'forest');
    this.panel(rounded(x + 5, top + 8, width - 10, 6, 3), 'clay', 73);
    // Clay side/back faces and the dark cap remain visible from behind/above.
    this.prism(rect(x + 8, top + 10, width - 16, bottom - top - 10), 8, 58, 'clay');
  }
  gable(left, peakX, peakY, right, eave, fill = 'roof', edge = 24, bottomEdge = true) {
    const shape = [[left, eave], [peakX, peakY], [right, eave]];
    this.prism(shape, this.back - 10, this.front + 8, fill === 'clay' ? 'clay' : 'roof');
    this.panel(shape, fill, this.front + 9);
    this.stroke(bottomEdge ? [...shape, shape[0]] : shape, edge, 'forest', this.front + 12, true);
  }
  ellipsoid(x, y, z, rx, ry, rz, material) {
    const at = (ring, step) => {
      const t = ring * Math.PI / 6, a = step * Math.PI * 2 / 12;
      return [x + rx * Math.sin(t) * Math.cos(a), -y + ry * Math.cos(t), z + rz * Math.sin(t) * Math.sin(a)];
    };
    for (let ring = 0; ring < 6; ring++) for (let step = 0; step < 12; step++) {
      const a = at(ring, step), b = at(ring + 1, step), c = at(ring + 1, step + 1), d = at(ring, step + 1);
      this.triangle(a, c, b, material); this.triangle(a, d, c, material);
    }
  }
  dome(x, base, rx, ry, rz) {
    // An elliptical dome with a tilted rim: the front eave rises toward its centre, as in 10.
    // A reversed outer shell gives this curved surface the same forest silhouette as the art.
    for (const shell of [false, true]) {
      const pad = shell ? 12 : 0;
      const at = (ring, step) => {
        const t = ring * Math.PI / 12, a = step * Math.PI / 12;
        const z = (rz + pad) * Math.sin(t) * Math.sin(a);
        return [x + (rx + pad) * Math.sin(t) * Math.cos(a), -base + (ry + pad) * Math.cos(t) + 39 * z / rz, z];
      };
      const triangle = (a, b, c) => shell ? this.triangle(c, b, a, 'forest') : this.triangle(a, b, c, 'clay');
      for (let ring = 0; ring < 6; ring++) for (let step = 0; step < 24; step++) {
        const a = at(ring, step), b = at(ring + 1, step), c = at(ring + 1, step + 1), d = at(ring, step + 1);
        triangle(a, c, b); triangle(a, d, c);
      }
      for (let step = 0; step < 24; step++) {
        const a = [x, -base, 0], b = at(6, step), c = at(6, step + 1);
        if (shell) this.triangle(c, b, a, 'forest');
        else this.triangle(a, b, c, 'forest');
      }
    }
    const rim = (i, j) => {
      const a = i * Math.PI / 12, t = j * Math.PI / 3, r = 7 * Math.cos(t);
      return [x + (rx + r) * Math.cos(a), -base + 39 * Math.sin(a) + 7 * Math.sin(t), (rz + r) * Math.sin(a)];
    };
    for (let i = 0; i < 24; i++) for (let j = 0; j < 6; j++) {
      const a = rim(i, j), b = rim(i + 1, j), c = rim(i + 1, j + 1), d = rim(i, j + 1);
      this.triangle(a, c, b, 'forest'); this.triangle(a, d, c, 'forest');
    }
  }
  secondary() {
    // One small window on each side and one high back window; never repeat the front facade.
    const start = this.triangles.length;
    const cx = (this.left + this.right) / 2;
    this.window(cx - 28, this.base - 125, 56, 62, 'rect', this.front + 9);
    const sideParts = this.triangles.splice(start);
    for (const side of [-1, 1]) for (const t of sideParts) {
      const points = t.points.map(([x, y, z]) => [side < 0 ? this.left - (z - this.front) : this.right + (z - this.front), y, side * (cx - x)]);
      this.triangles.push({ material: t.material, points });
    }
    const backStart = this.triangles.length;
    this.window(cx - 28, this.base - 132, 56, 62, 'rect', this.front + 9);
    const backParts = this.triangles.splice(backStart);
    for (const t of backParts) this.triangles.push({ material: t.material, points: t.points.map(([x, y, z]) => [2 * cx - x, y, this.back - (z - this.front)]) });
  }
  finish() {
    this.secondary();
    const points = this.triangles.flatMap(t => t.points);
    const low = [0, 1, 2].map(a => Math.min(...points.map(p => p[a])));
    const high = [0, 1, 2].map(a => Math.max(...points.map(p => p[a])));
    const origin = [(low[0] + high[0]) / 2, low[1], (low[2] + high[2]) / 2];
    return this.triangles.map(t => ({ material: t.material, points: t.points.map(p => p.map((v, a) => (v - origin[a]) / 350)) }));
  }
}

export function makeHouse(variant) {
  let h;
  switch (variant) {
    case 1:
      h = new House(443, 100, 408, 266); h.walls(); h.chimney(340, 120, 228);
      h.gable(73, 256, 112, 440, 266, 'gable', 27); h.baseTrim();
      h.window(138, 301, 86, 88); h.door(266, 315, 83); break;
    case 2:
      h = new House(443, 135, 377, 102); h.walls(); h.baseTrim();
      h.prism(rounded(111, 80, 291, 38, 12), h.back - 12, h.front + 12, 'forest');
      h.window(171, 150, 86, 89); h.window(171, 272, 86, 88); h.door(272, 303, 79, 'clay', true); break;
    case 3:
      h = new House(443, 48, 435, 277); h.walls(); h.chimney(343, 160, 255);
      h.prism([[25, 277], [182, 204], [310, 204], [459, 277]], h.back - 12, h.front + 10, 'forest');
      h.stroke([[25, 277], [459, 277]], 18, 'forest', h.front + 12, true); h.baseTrim();
      h.window(81, 308, 81, 82); h.window(324, 308, 81, 82); h.door(195, 308, 76);
      h.panel([[279, 402], [326, 402], [319, 437], [286, 437]], 'forest', h.front + 25, 30);
      h.panel([[287, 410], [318, 410], [313, 432], [292, 432]], 'clay', h.front + 26);
      h.stroke([[303, 406], [300, 380]], 7, 'forest', h.front + 20);
      h.panel([[298, 397], [285, 389], [279, 378], [282, 375], [292, 379], [302, 392]], 'forest', h.front + 21);
      h.panel([[302, 397], [299, 383], [304, 369], [310, 364], [314, 369], [310, 386]], 'forest', h.front + 22); break;
    case 4:
      h = new House(409, 121, 386, 305);
      h.body([[121, 409], [121, 298], [256, 93], [389, 298], [386, 409]]); h.baseTrim();
      h.prism([[77, 344], [256, 70], [432, 344], [389, 300], [256, 106], [121, 300]], h.back - 16, h.front + 11, 'forest');
      h.stroke([[77, 344], [256, 70], [432, 344]], 28, 'forest', h.front + 12, true);
      h.window(204, 178, 100, 100, 'round'); h.door(208, 294, 93); break;
    case 5: {
      h = new House(410, 86, 415, 217); h.walls(); h.chimney(339, 83, 186);
      h.gable(67, 253, 82, 438, 218, 'green', 27, false); h.baseTrim();
      h.window(111, 252, 86, 88); h.door(246, 256, 92, 'forest', true);
      // A real projecting canopy with four rounded hanging scallops, not a flat rectangle.
      const scallops = [[214, 252], [229, 215], [359, 215], [374, 252]];
      for (let i = 0; i < 4; i++) for (let j = 0; j <= 6; j++) {
        const t = j * Math.PI / 6;
        scallops.push([354 - i * 40 + 20 * Math.cos(t), 252 + 20 * Math.sin(t)]);
      }
      h.prism(scallops, h.front + 5, h.front + 48, 'clay');
      h.stroke([...scallops, scallops[0]], 9, 'forest', h.front + 50);
      break;
    }
    case 6: {
      h = new House(410, 77, 412, 267); h.walls(); h.chimney(340, 99, 205);
      const arc = Array.from({ length: 25 }, (_, i) => { const t = Math.PI + i * Math.PI / 24; return [245 + 183 * Math.cos(t), 267 + 141 * Math.sin(t)]; });
      h.prism(arc, h.back - 9, h.front + 5, 'roof');
      h.panel(arc, 'green', h.front + 6);
      h.stroke(arc, 27, 'forest', h.front + 11); h.baseTrim();
      h.window(116, 220, 106, 106, 'round'); h.door(255, 251, 97, 'forest', true); break;
    }
    case 7:
      h = new House(464, 123, 464, 291); h.walls();
      h.gable(102, 295, 157, 487, 291, 'clay', 15); h.baseTrim();
      h.window(258, 195, 74, 74, 'diamond', h.front + 30, false);
      h.window(150, 330, 80, 84); h.window(357, 330, 80, 84); h.door(256, 340, 76); break;
    case 8: {
      h = new House(464, 113, 398, 282);
      const steps = [[105, 282], [105, 252], [134, 252], [134, 216], [168, 216], [168, 177], [201, 177], [201, 139], [232, 139], [232, 101], [278, 101], [278, 139], [309, 139], [309, 177], [343, 177], [343, 216], [377, 216], [377, 252], [406, 252], [406, 282]];
      h.walls();
      h.prism([[114, 282], [255, 117], [397, 282]], h.back, h.front - 9, 'roof');
      h.prism([[113, 464], ...steps, [398, 464]], h.front - 9, h.front, 'green');
      h.stroke(steps, 17, 'forest', h.front + 10, true); h.baseTrim();
      h.window(143, 290, 53, 117); h.window(315, 290, 53, 117); h.door(217, 318, 78); break;
    }
    case 9:
      h = new House(464, 80, 380, 224);
      h.leftEave = 215; h.rightEave = 305;
      h.body([[80, 464], [80, 215], [380, 305], [380, 464]]); h.chimney(100, 150, 209);
      h.baseTrim();
      h.prism([[61, 186], [406, 289], [406, 315], [61, 212]], h.back - 12, h.front + 12, 'forest');
      h.panel([[66, 195], [399, 293], [399, 308], [66, 209]], 'clay', h.front + 14);
      h.stroke([[61, 186], [406, 289], [406, 315], [61, 212], [61, 186]], 13, 'forest', h.front + 17, true);
      h.window(113, 307, 108, 108); h.door(255, 338, 87, 'clay'); break;
    case 10: {
      h = new House(385, 120, 448, 204, 120); h.walls(); h.chimney(373, 49, 126, 44);
      const bottom = Array.from({ length: 25 }, (_, i) => { const x = 448 - i * 328 / 24; return [x, 208 - 39 * Math.sqrt(1 - ((x - 289) / 184) ** 2)]; });
      // The green spandrel meets the rising front eave of the rounded, three-dimensional cap.
      h.prism([...bottom.toReversed(), [448, 240], [120, 240]], h.back, h.front, 'green');
      h.dome(289, 208, 184, 124, 158); h.baseTrim();
      h.window(158, 229, 126, 102); h.door(316, 238, 85); break;
    }
    case 11:
      h = new House(384, 97, 414, 211); h.walls();
      h.prism([[73, 211], [156, 85], [354, 85], [437, 211]], h.back - 12, h.front + 10, 'roof');
      h.stroke([[73, 211], [156, 85], [354, 85], [437, 211], [73, 211]], 15, 'forest', h.front + 12, true);
      h.baseTrim();
      h.prism([[188, 187], [188, 101], [256, 43], [324, 101], [324, 187]], h.front - 42, h.front + 35, 'green');
      h.stroke([[188, 187], [188, 101], [256, 43], [324, 101], [324, 187], [188, 187]], 13, 'forest', h.front + 39);
      h.window(217, 95, 80, 82, 'rect', h.front + 44); h.window(131, 244, 87, 88);
      h.door(258, 244, 94, 'butter', false, true); break;
    case 12: {
      h = new House(384, 67, 394, 162); h.walls(); h.baseTrim();
      // Three separate crowns: rounded volume behind a thin, outlined clover face.
      for (const x of [122, 228, 336]) {
        const crown = [[x - 31, 129], [x - 39, 118], [x - 40, 101], [x - 33, 91], [x - 18, 88], [x - 13, 76], [x - 5, 70], [x + 6, 70], [x + 16, 77], [x + 20, 88], [x + 32, 91], [x + 39, 102], [x + 38, 116], [x + 30, 129]];
        h.ellipsoid(x, 106, 48, 29, 24, 39, 'leaf');
        h.prism(crown, 85, 89, 'forest');
        const inner = crown.map(([a, b]) => [x + (a - x) * 0.70, 106 + (b - 106) * 0.72]);
        h.panel(inner, 'leaf', 90);
      }
      h.prism(rounded(43, 119, 377, 55, 12), h.back - 12, h.front + 12, 'forest');
      h.panel(rect(58, 133, 347, 26), 'clay', h.front + 14);
      h.window(110, 214, 101, 103); h.door(251, 232, 95, 'clay'); break;
    }
    default: throw new Error('Unknown house variant');
  }
  return h.finish();
}
