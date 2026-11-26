import assert from 'node:assert/strict';
import { C } from '../../src/palette.mjs';
import { cross, sub } from '../../../rent-free/models/lib/glb.mjs';
import { ellipse } from './details.mjs';

const turn = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function triangulate(points) {
  const indices = points.map((_, i) => i), faces = [];
  while (indices.length > 3) {
    const ear = indices.findIndex((b, i) => {
      const a = indices[(i + indices.length - 1) % indices.length], c = indices[(i + 1) % indices.length];
      return turn(points[a], points[b], points[c]) > 1e-7 && !indices.some(j => j !== a && j !== b && j !== c
        && turn(points[a], points[b], points[j]) >= -1e-7 && turn(points[b], points[c], points[j]) >= -1e-7 && turn(points[c], points[a], points[j]) >= -1e-7);
    });
    assert.ok(ear >= 0, 'simple polygon');
    faces.push([indices[(ear + indices.length - 1) % indices.length], indices[ear], indices[(ear + 1) % indices.length]]);
    indices.splice(ear, 1);
  }
  return [...faces, indices];
}

/** Reference x/y pixels, z depth in the same units. Geometry, including outlines, is baked. */
export class Mesh {
  triangles = [];
  triangle(a, b, c, color) {
    const points = [a, b, c].map(([x, y, z]) => [x, -y, z]);
    if (Math.hypot(...cross(sub(points[1], points[0]), sub(points[2], points[0]))) < 1e-6) return;
    // Reflecting y changes handedness.
    this.triangles.push({ points: [points[2], points[1], points[0]], color });
  }
  prism(points, back, front, color) {
    points = points.filter((p, i) => Math.hypot(p[0] - points[(i + 1) % points.length][0], p[1] - points[(i + 1) % points.length][1]) > 1e-6);
    points = points.filter((p, i) => Math.abs(turn(points[(i + points.length - 1) % points.length], p, points[(i + 1) % points.length])) > 1e-6);
    const area = points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0);
    const p = area < 0 ? points.toReversed() : points;
    for (const [a, b, c] of triangulate(p)) {
      this.triangle([...p[a], front], [...p[b], front], [...p[c], front], color);
      this.triangle([...p[c], back], [...p[b], back], [...p[a], back], color);
    }
    p.forEach((a, i) => {
      const b = p[(i + 1) % p.length];
      this.triangle([...a, front], [...a, back], [...b, back], color);
      this.triangle([...a, front], [...b, back], [...b, front], color);
    });
  }
  line(points, width, color, z, depth = 3) {
    points = points.filter((p, i) => !i || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-6);
    if (points.length < 2) return;
    const closed = points[0].every((n, i) => n === points.at(-1)[i]);
    const normals = points.slice(1).map((b, i) => {
      const a = points[i], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
      return [-dy / length, dx / length];
    });
    // Adjacent segments share their miter: square-ended strips leave visible wedges.
    const offsets = points.map((_, i) => {
      const a = normals[i - 1] ?? (closed ? normals.at(-1) : normals[0]);
      const b = normals[i] ?? (closed ? normals[0] : normals.at(-1));
      const scale = width / (2 * Math.max(0.25, 1 + a[0] * b[0] + a[1] * b[1]));
      return [(a[0] + b[0]) * scale, (a[1] + b[1]) * scale];
    });
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], u = offsets[i - 1], v = offsets[i];
      this.prism([[a[0] + u[0], a[1] + u[1]], [a[0] - u[0], a[1] - u[1]], [b[0] - v[0], b[1] - v[1]], [b[0] + v[0], b[1] + v[1]]], z - depth, z, color);
    }
  }
  band(points, width, color, z = 85, outline = 7) {
    this.line(points, width + 2 * outline, C.ink, z, 12);
    this.line(points, width, color, z + 1, 1);
  }
  panel(points, color, z, outline = 8, depth = 3) {
    this.prism(points, z - depth, z, color);
    if (outline) this.line([...points, points[0]], outline, C.ink, z + 1, 3);
  }
  body(points, color, depth, outline = 10) {
    this.prism(points, -depth / 2, depth / 2, color);
    this.line([...points, points[0]], outline, C.ink, depth / 2 + 1, 5);
    this.line([...points, points[0]], outline, C.ink, -depth / 2 + 2, 5);
    return depth / 2 + 5;
  }
  ellipsoid(x, y, z, rx, ry, rz, color) {
    // The inverted shell is actual outline geometry, visible from all viewpoints.
    for (const shell of [false, true]) {
      const pad = shell ? 5 : 0;
      const at = (ring, step) => {
        const t = ring * Math.PI / 6, a = step * Math.PI / 5;
        return [x + (rx + pad) * Math.sin(t) * Math.cos(a), y + (ry + pad) * Math.cos(t), z + (rz + pad) * Math.sin(t) * Math.sin(a)];
      };
      for (let r = 0; r < 6; r++) for (let s = 0; s < 10; s++) {
        const a = at(r, s), b = at(r + 1, s), c = at(r + 1, s + 1), d = at(r, s + 1);
        if (shell) { this.triangle(a, b, c, C.ink); this.triangle(a, c, d, C.ink); }
        else { this.triangle(a, c, b, color); this.triangle(a, d, c, color); }
      }
    }
  }
  hook() {
    const arc = Array.from({ length: 9 }, (_, i) => {
      const a = Math.PI - i * Math.PI / 8;
      return [512 + 26 * Math.cos(a), 259 + 26 * Math.sin(a)];
    });
    this.band([[486, 160], [486, 259], ...arc.slice(1), [538, 236]], 18, C.steel, 102, 9);
    this.panel(ellipse(486, 160, 21, 21, 12), C.steel, 105, 8, 18);
  }
  finish() {
    const all = this.triangles.flatMap(t => t.points);
    const low = [0, 1, 2].map(axis => Math.min(...all.map(p => p[axis])));
    const high = [0, 1, 2].map(axis => Math.max(...all.map(p => p[axis])));
    const origin = [(low[0] + high[0]) / 2, low[1], (low[2] + high[2]) / 2];
    return this.triangles.map(t => ({ ...t, points: t.points.map(p => p.map((n, axis) => (n - origin[axis]) / 760)) }));
  }
}
