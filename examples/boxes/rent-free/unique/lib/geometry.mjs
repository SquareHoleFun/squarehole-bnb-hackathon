// Convex, closed prisms only. Coordinates are the existing house study's reference pixels.
import { cross, sub } from '../../models/lib/glb.mjs';
export const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
export const oval = (x, y, rx, ry, n = 16) => Array.from({ length: n }, (_, i) => [x + rx * Math.cos(i * Math.PI * 2 / n), y + ry * Math.sin(i * Math.PI * 2 / n)]);
export function roundRect(x, y, w, h, radius = 4) {
  const r = Math.min(radius, w / 2, h / 2);
  return [[x + w - r, y + r], [x + w - r, y + h - r], [x + r, y + h - r], [x + r, y + r]].flatMap(([cx, cy], i) =>
    Array.from({ length: 4 }, (_, j) => [cx + r * Math.cos((i - 1) * Math.PI / 2 + j * Math.PI / 6), cy + r * Math.sin((i - 1) * Math.PI / 2 + j * Math.PI / 6)]));
}

export class Details {
  triangles = [];
  constructor(transform) { this.transform = transform; }
  prism(polygon, back, front, material) {
    let p = polygon.filter((p, i) => Math.hypot(...sub(p, polygon[(i + 1) % polygon.length])) > 1e-7);
    const area = p.reduce((sum, a, i) => { const b = p[(i + 1) % p.length]; return sum + a[0] * b[1] - b[0] * a[1]; }, 0);
    if (area > 0) p = p.toReversed(); // y points down in reference space, up in glTF.
    const add = (a, b, c) => {
      const points = [a, b, c].map(this.transform);
      if (Math.hypot(...cross(sub(points[1], points[0]), sub(points[2], points[0]))) > 1e-10) this.triangles.push({ points, material });
    };
    for (let i = 1; i < p.length - 1; i++) {
      add([...p[0], front], [...p[i], front], [...p[i + 1], front]);
      add([...p[i + 1], back], [...p[i], back], [...p[0], back]);
    }
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      add([...a, front], [...a, back], [...b, back]);
      add([...a, front], [...b, back], [...b, front]);
    }
  }
  panel(polygon, material, front = 24, thickness = 3) { this.prism(polygon, front - thickness, front, material); }
  box(x, y, w, h, material, front = 24, depth = 8, radius = 4) {
    this.prism(roundRect(x, y, w, h, radius), front - depth, front, material);
  }
  outlined(polygon, material, front = 28, depth = 12, inset = 0.72) {
    const center = polygon.reduce((sum, p) => [sum[0] + p[0] / polygon.length, sum[1] + p[1] / polygon.length], [0, 0]);
    this.prism(polygon, front - depth, front, 'forest');
    this.panel(polygon.map(p => p.map((v, axis) => center[axis] + (v - center[axis]) * inset)), material, front + 0.6, 1);
  }
  line(a, b, width, material = 'forest', front = 29) {
    const [dx, dy] = sub(b, a), length = Math.hypot(dx, dy);
    const x = -dy / length * width / 2, y = dx / length * width / 2;
    this.panel([[a[0] + x, a[1] + y], [b[0] + x, b[1] + y], [b[0] - x, b[1] - y], [a[0] - x, a[1] - y]], material, front);
  }
}
