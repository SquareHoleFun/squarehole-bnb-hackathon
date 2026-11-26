// Hidden-surface ordering for flat SVG projection. A BSP splits intersecting surfaces before painting;
// sorting whole triangles by average depth fails on the approved dome's curved rim and green spandrel.
import { cross, sub, dot, unit } from '../../models/lib/glb.mjs';
const EPS = 1e-8;

function split(polygon, normal, offset) {
  const distances = polygon.points.map(p => dot(normal, p) - offset);
  const front = distances.some(d => d > EPS), back = distances.some(d => d < -EPS);
  if (!front && !back) return { coplanar: [polygon] };
  if (!back) return { front: [polygon] };
  if (!front) return { back: [polygon] };
  const near = [], far = [];
  for (let i = 0; i < polygon.points.length; i++) {
    const a = polygon.points[i], b = polygon.points[(i + 1) % polygon.points.length];
    const da = distances[i], db = distances[(i + 1) % distances.length];
    if (da >= -EPS) near.push(a);
    if (da <= EPS) far.push(a);
    if (da > EPS && db < -EPS || da < -EPS && db > EPS) {
      const ratio = da / (da - db), p = a.map((v, axis) => v + (b[axis] - v) * ratio);
      near.push(p); far.push(p);
    }
  }
  return { front: [{ ...polygon, points: near }], back: [{ ...polygon, points: far }] };
}

export function visibleLayers(triangles) {
  const polygons = triangles.filter(t => cross(sub(t.points[1], t.points[0]), sub(t.points[2], t.points[0]))[2] > 1e-10);
  const ordered = [];
  function visit(list) {
    if (!list.length) return;
    // Prefer a large plane: most facade surfaces remain whole and curved faces split only where necessary.
    let plane = list[0], largest = 0;
    for (const p of list) {
      const area = Math.hypot(...cross(sub(p.points[1], p.points[0]), sub(p.points[2], p.points[0])));
      if (area > largest) { plane = p; largest = area; }
    }
    const normal = unit(cross(sub(plane.points[1], plane.points[0]), sub(plane.points[2], plane.points[0])));
    const offset = dot(normal, plane.points[0]);
    const front = [], back = [], coplanar = [];
    for (const polygon of list) {
      const halves = split(polygon, normal, offset);
      front.push(...(halves.front ?? [])); back.push(...(halves.back ?? [])); coplanar.push(...(halves.coplanar ?? []));
    }
    // Every retained plane faces +z, so an orthographic +z viewer sees its front child last.
    visit(back);
    const byMaterial = new Map();
    for (const p of coplanar) {
      if (!byMaterial.has(p.material)) byMaterial.set(p.material, []);
      byMaterial.get(p.material).push(p.points);
    }
    for (const [material, polygons] of byMaterial) ordered.push({ material, polygons });
    visit(front);
  }
  visit(polygons);
  return ordered;
}
