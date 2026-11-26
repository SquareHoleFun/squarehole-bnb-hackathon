/**
 * Builds every picture in art/ from the source in src/: one SVG per piece, then its PNG, rendered locally
 * with @resvg/resvg-js (no fonts, no network). Running it twice gives the same bytes.
 *
 *   node build-art.mjs              every piece in art/
 *   node build-art.mjs --no-words   only art/reference/: the cover, the box banner and the scenes as PNGs with no
 *                                   lettering, every other shape where it always is
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadResvg, toPng } from './src/render.mjs';
import { logoSvg, avatarSvg, xBannerSvg, coverSvg, boxBannerSvg } from './src/brand.mjs';
import { VARIANTS, itemSvg } from './src/items.mjs';
import { SCENES, sceneSvg } from './src/scenes.mjs';
import { withoutWords } from './src/type.mjs';

const root = new URL('./', import.meta.url);
const at = (rel) => new URL(rel, root);

export function pieces() {
  return [
    ['art/logo', logoSvg()],
    ['art/x-avatar', avatarSvg()],
    ['art/x-banner', xBannerSvg()],
    ['art/cover', coverSvg()],
    ['art/box-banner', boxBannerSvg()],
    ...VARIANTS.map((v) => [`art/items/variant-${v.n}`, itemSvg(v)]),
    ...SCENES.map((s) => [`art/scenes/scene-${s.n}`, sceneSvg(s)]),
  ];
}

/**
 * The word-free reference pictures as [path without extension, SVG text]: the cover, the box banner and the scenes,
 * each drawn with no letters, so a picture can show the kit's world without a word in it.
 */
export function references() {
  return withoutWords(() => [
    ['art/reference/cover', coverSvg()],
    ['art/reference/box-banner', boxBannerSvg()],
    ...SCENES.map((s) => [`art/reference/scenes/scene-${s.n}`, sceneSvg(s)]),
  ]);
}

function buildReferences(Resvg) {
  for (const dir of ['art/reference', 'art/reference/scenes']) mkdirSync(at(dir), { recursive: true });
  const all = references();
  for (const [base, svg] of all) writeFileSync(at(`${base}.png`), toPng(Resvg, svg));
  process.stdout.write(`built ${all.length} word-free PNGs in art/reference/\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--no-words');
  if (unknown.length) throw new Error(`unknown option ${unknown.join(' ')}; the only option is --no-words`);
  const Resvg = await loadResvg();
  if (args.includes('--no-words')) return buildReferences(Resvg);
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
