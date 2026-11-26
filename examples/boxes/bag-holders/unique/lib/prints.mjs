import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VARIANTS } from '../../src/items.mjs';

/** Flatten only the commands used by the kit's original print strokes, in glyph units.
 * Arc endpoints are exact; curved spans use at most 30 degrees per segment.
 * Unsupported syntax fails explicitly rather than silently dropping a letter.
 */
function strokes(d) {
  const tokens = d.match(/[A-Za-z]|-?(?:\d*\.)?\d+(?:e[-+]?\d+)?/g);
  const paths = [];
  let i = 0, x = 0, y = 0, path;
  const number = () => { const n = Number(tokens[i++]); assert.ok(Number.isFinite(n), 'glyph coordinate'); return n; };
  const point = (px, py) => { x = px; y = py; path.push([x, y]); };
  while (i < tokens.length) {
    const command = tokens[i++];
    switch (command) {
      case 'M': path = []; paths.push(path); point(number(), number()); break;
      case 'L': point(number(), number()); break;
      case 'H': point(number(), y); break;
      case 'V': point(x, number()); break;
      case 'Z': point(...path[0]); break;
      case 'A': {
        let rx = number(), ry = number();
        const rotation = number(), large = number(), sweep = number(), endX = number(), endY = number();
        assert.ok(rx > 0 && ry > 0 && rotation === 0 && [0, 1].includes(large) && [0, 1].includes(sweep), 'kit arc');
        const dx = (x - endX) / 2, dy = (y - endY) / 2;
        const scale = Math.max(1, Math.hypot(dx / rx, dy / ry));
        rx *= scale; ry *= scale;
        const factor = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0,
          (rx * rx * ry * ry - rx * rx * dy * dy - ry * ry * dx * dx) / (rx * rx * dy * dy + ry * ry * dx * dx)));
        const cx = (x + endX) / 2 + factor * rx * dy / ry;
        const cy = (y + endY) / 2 - factor * ry * dx / rx;
        const start = Math.atan2((y - cy) / ry, (x - cx) / rx);
        let angle = Math.atan2((endY - cy) / ry, (endX - cx) / rx) - start;
        if (sweep && angle < 0) angle += Math.PI * 2;
        if (!sweep && angle > 0) angle -= Math.PI * 2;
        const steps = Math.ceil(Math.abs(angle) / (Math.PI / 6));
        for (let j = 1; j < steps; j++) point(cx + rx * Math.cos(start + angle * j / steps), cy + ry * Math.sin(start + angle * j / steps));
        point(endX, endY);
        break;
      }
      default: assert.fail(`unsupported kit print command: ${command}`);
    }
  }
  return paths;
}

// Read the maintained originals: no second alphabet, word list or placement table.
// Each layer carries its exact original colour, stroke width, scale and translation.
const prints = new Map(VARIANTS.map(({ n }) => {
  const svg = readFileSync(new URL(`../../art/items/variant-${n}.svg`, import.meta.url), 'utf8');
  const layers = [...svg.matchAll(/<g transform="translate\(([-.\d]+) ([-.\d]+)\) scale\(([-.\d]+)\)" fill="none" stroke="(#[\dA-F]+)" stroke-width="([.\d]+)" stroke-linecap="round" stroke-linejoin="round">(<path transform="translate\([\s\S]*?)<\/g>/g)];
  return [n, layers.map(([, tx, ty, scale, color, width, paths]) => ({
    color, width: Number(width) * Number(scale),
    paths: [...paths.matchAll(/<path transform="translate\(([-.\d]+) ([-.\d]+)\)" d="([^"]+)"\/>/g)].flatMap(([, gx, gy, d]) =>
      strokes(d).map(points => points.map(([x, y]) => [Number(tx) + (Number(gx) + x) * Number(scale), Number(ty) + (Number(gy) + y) * Number(scale)]))),
  }))];
}));

/** Raised strips with round joins and caps, matching the original stroke styling.
 * There are no redundant end walls between adjoining strips.
 */
function raisedStroke(mesh, points, width, color, front) {
  points = points.filter((p, i) => !i || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-6);
  if (points.length < 2) return;
  const closed = points[0].every((n, i) => n === points.at(-1)[i]), back = front - 2;
  const normals = points.slice(1).map((b, i) => {
    const a = points[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [-(b[1] - a[1]) / length, (b[0] - a[0]) / length];
  });
  const face = (a, b, c) => {
    mesh.triangle([...a, front], [...b, front], [...c, front], color);
    mesh.triangle([...c, back], [...b, back], [...a, back], color);
  };
  const wall = (a, b) => {
    mesh.triangle([...a, front], [...a, back], [...b, back], color);
    mesh.triangle([...a, front], [...b, back], [...b, front], color);
  };
  const sector = (p, start, angle) => {
    const steps = Math.ceil(Math.abs(angle) / (Math.PI / 4));
    const arc = Array.from({ length: steps + 1 }, (_, i) => [p[0] + width / 2 * Math.cos(start + angle * i / steps), p[1] + width / 2 * Math.sin(start + angle * i / steps)]);
    for (let i = 1; i < arc.length; i++) {
      const [a, b] = angle > 0 ? [arc[i - 1], arc[i]] : [arc[i], arc[i - 1]];
      face(p, a, b); wall(a, b);
    }
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], u = normals[i - 1].map(n => n * width / 2), v = u;
    const al = [a[0] + u[0], a[1] + u[1]], ar = [a[0] - u[0], a[1] - u[1]];
    const bl = [b[0] + v[0], b[1] + v[1]], br = [b[0] - v[0], b[1] - v[1]];
    face(al, ar, br); face(al, br, bl); wall(ar, br); wall(bl, al);
  }
  for (let i = closed ? 0 : 1; i < points.length - 1; i++) {
    const a = normals[i - 1] ?? normals.at(-1), b = normals[i];
    const turn = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
    if (Math.abs(turn) < 1e-6) continue;
    const sign = turn > 0 ? -1 : 1;
    sector(points[i], Math.atan2(a[1] * sign, a[0] * sign), turn);
  }
  if (!closed) for (const [p, normal, sign] of [[points[0], normals[0], 1], [points.at(-1), normals.at(-1), -1]]) {
    sector(p, Math.atan2(normal[1] * sign, normal[0] * sign), Math.PI);
  }
}

/** Shallow solid strokes; CHIPS keeps its ink outline under its fill. */
export function addPrint(mesh, kind, z) {
  for (const [layer, { paths, color, width }] of prints.get(kind).entries()) {
    const front = z + layer * 0.5;
    for (const points of paths) {
      raisedStroke(mesh, points, width, color, front);
    }
  }
}
