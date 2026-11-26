import { Doc, rect } from '../../src/doc.mjs';
import { cardLines } from '../../src/items.mjs';
import { lettering, measure } from '../../src/type.mjs';
import { C, MIX } from '../../src/palette.mjs';
import { loadResvg } from '../../src/render.mjs';

const Resvg = await loadResvg();
const stencils = new Map();

// Sample the kit's own stencil, including its bridges, at the original 26 px cap height.
// Merge filled pixels into rectangles (two front-facing triangles each). The GLB contains
// geometry only: no font, texture, alternate alphabet or runtime raster dependency.
function stencil(rank) {
  if (stencils.has(rank)) return stencils.get(rank);
  const lines = cardLines(rank), h = measure(lines, 26).h + 26 * 1.4;
  const fit = Math.min(26, 26 * 260 / measure(lines, 26).w);
  const d = new Doc(300, Math.ceil(h), '', '');
  d.add(rect(0, 0, 300, Math.ceil(h), 'fill="#ffffff"'));
  d.add(lettering(d, lines, { x: 150, y: (h - measure(lines, fit).h) / 2 + 2, cap: fit, color: C.ink }));
  const rendered = new Resvg(d.toString(), { font: { loadSystemFonts: false } }).render();
  const pixels = rendered.pixels, used = new Uint8Array(rendered.width * rendered.height), rectangles = [];
  const at = (x, y) => y * rendered.width + x;
  const ink = (x, y) => x < rendered.width && y < rendered.height && !used[at(x, y)] && pixels[at(x, y) * 4] < 128;
  for (let y = 0; y < rendered.height; y++) for (let x = 0; x < rendered.width; x++) {
    if (!ink(x, y)) continue;
    let w = 1, height = 1;
    while (ink(x + w, y)) w++;
    while (y + height < rendered.height && Array.from({ length: w }, (_, i) => ink(x + i, y + height)).every(Boolean)) height++;
    for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < w; dx++) used[at(x + dx, y + dy)] = 1;
    rectangles.push([x, y, w, height]);
  }
  const result = { h, rectangles };
  stencils.set(rank, result);
  return result;
}

export function rankPlate(m, rank) {
  const { h, rectangles } = stencil(rank);
  const cx = -.20, bottom = .21, top = bottom + h * .001, z = .32;
  // A low mess table below the ration hand keeps the plate clear of every character trait.
  m.box(cx, bottom - .012, z - .045, .36, .02, .15, C.white, .004);
  for (const x of [cx - .14, cx + .14]) m.box(x, .103, z - .06, .018, .194, .018, C.crate, .003);
  m.prism([[cx - .15, top], [cx + .15, top], [cx + .144, top + .010], [cx - .144, top + .010]], z - .025, z - .002, MIX.paperShade, .003);
  m.prism([[cx - .158, bottom], [cx + .158, bottom], [cx + .15, top], [cx - .15, top]], z - .025, z, C.paper, .004);
  m.box(cx, top - .010, z + .001, .272, .006, .002, C.khaki, 0);
  for (const [x, y, w, height] of rectangles) {
    const x0 = cx + (x - 150) * .001, x1 = x0 + w * .001;
    const y1 = top - y * .001, y0 = y1 - height * .001, front = z + .003;
    m.tri([x0, y0, front], [x1, y0, front], [x1, y1, front], C.ink);
    m.tri([x0, y0, front], [x1, y1, front], [x0, y1, front], C.ink);
  }
}
