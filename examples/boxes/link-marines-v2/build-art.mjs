/**
 * Builds every picture in art/ from the source in src/: one SVG per piece, then its PNG, rendered locally
 * with @resvg/resvg-js (no fonts, no network). Running it twice gives the same bytes.
 *
 *   node build-art.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadResvg, toPng } from './src/render.mjs';
import { logoSvg, avatarSvg, xBannerSvg, coverSvg, boxBannerSvg } from './src/brand.mjs';
import { VARIANTS, itemSvg } from './src/items.mjs';
import { SCENES, sceneSvg } from './src/scenes.mjs';

const root = new URL('./', import.meta.url);
const at = (rel) => new URL(rel, root);

/** Every piece as [path without extension, a function that builds its SVG text]. */
export function builders() {
  return [
    ['art/logo', () => logoSvg()],
    ['art/x-avatar', () => avatarSvg()],
    ['art/x-banner', () => xBannerSvg()],
    ['art/cover', () => coverSvg()],
    ['art/box-banner', () => boxBannerSvg()],
    ...VARIANTS.map((v) => [`art/items/variant-${v.n}`, () => itemSvg(v)]),
    ...SCENES.map((s) => [`art/scenes/scene-${s.n}`, () => sceneSvg(s)]),
  ];
}

/** Every piece as [path without extension, SVG text]. */
export function pieces() {
  return builders().map(([base, build]) => [base, build()]);
}

async function main() {
  const Resvg = await loadResvg();
  for (const dir of ['art', 'art/items', 'art/scenes']) mkdirSync(at(dir), { recursive: true });
  const all = pieces();
  for (const [base, svg] of all) {
    writeFileSync(at(`${base}.svg`), svg);
    writeFileSync(at(`${base}.png`), toPng(Resvg, svg));
  }
  writeFileSync(at('art/logo-48.png'), toPng(Resvg, logoSvg(), 48));
  process.stdout.write(`built ${all.length} SVG + PNG pairs and art/logo-48.png\n`);
}

if (import.meta.main) await main();
