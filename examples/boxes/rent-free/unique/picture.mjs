import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PALETTE } from '../models/lib/glb.mjs';
import { PIXELS_PER_UNIT } from './lib/render.mjs';
import { visibleLayers } from './lib/svg.mjs';
import { houseScene } from './lib/scene.mjs';
import { deal } from './deal.mjs';
import { isMain, requireNode, write } from './lib/io.mjs';

const require = createRequire(new URL('../../../../packages/cards/package.json', import.meta.url));
const { Resvg } = require('@resvg/resvg-js');
assert.equal(require('@resvg/resvg-js/package.json').version, '2.6.2', 'Use pinned resvg-js 2.6.2');
// One shared framing, with room for the added props; twice the review renderer's resolution.
const project = ([x, y]) => [512 + x * PIXELS_PER_UNIT * 2, 512 + (0.5 - y) * PIXELS_PER_UNIT * 2];
const fixed = n => Number(n.toFixed(4));

export function pictureSvg(traits) {
  const paths = visibleLayers(houseScene(traits)).map(layer => {
    const d = layer.polygons.map(polygon => polygon.map((p, i) => `${i ? 'L' : 'M'}${project(p).map(fixed).join(' ')}`).join('') + 'Z').join('');
    // Compound paths cancel shared triangle edges. The tiny same-colour stroke covers only antialias seams.
    return `<path d="${d}" fill="${PALETTE[layer.material]}" stroke="${PALETTE[layer.material]}" stroke-width="2" stroke-linejoin="round"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><path fill="#FFF7E6" d="M0 0H1024V1024H0Z"/>${paths.join('')}</svg>\n`;
}
export function picturePng(traits, size = 1024) {
  assert.ok(Number.isInteger(size) && size >= 1 && size <= 1024, 'image size 1 to 1024');
  return new Resvg(pictureSvg(traits), { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render().asPng();
}
if (isMain(import.meta.url)) {
  requireNode();
  const [id, out, extra] = process.argv.slice(2);
  assert.ok(id && out && !extra, 'Usage: node picture.mjs <id> <output-prefix>');
  const row = deal().find(row => row.id === id);
  assert.ok(row, 'canonical id 1 to 500');
  write(`${out}.svg`, pictureSvg(row.traits));
  write(`${out}.png`, picturePng(row.traits));
}
