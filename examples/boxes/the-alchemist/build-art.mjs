import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { pieces } from './src/art.mjs';

// Use the existing pinned workspace renderer; no download and no system fonts.
const require = createRequire(new URL('../../../packages/cards/package.json', import.meta.url));
const { Resvg } = require('@resvg/resvg-js');
export const toPng = svg => new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng();

export function buildArt() {
  const root = new URL('./', import.meta.url);
  mkdirSync(new URL('art/scenes/', root), { recursive: true });
  for (const { base, svg } of pieces()) {
    writeFileSync(new URL(`${base}.svg`, root), svg);
    writeFileSync(new URL(`${base}.png`, root), toPng(svg));
  }
  process.stdout.write('built 10 SVG/PNG pairs; 7 scenes\n');
}
function isEntry() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (isEntry()) {
  if (process.argv.length > 2) throw new Error('unknown option; run build-art.mjs without arguments');
  buildArt();
}
