/**
 * Builds every picture in art/ from the source in src/: one SVG per piece, then its PNG, rendered locally with
 * @resvg/resvg-js (no fonts, no network). The gold edition's pieces go to art/, the paper edition's to art/paper/; the
 * mark, the hidden picture and the twelve certificates are shared. Running it twice gives the same bytes.
 *
 *   node build-art.mjs              every piece in art/
 *   node build-art.mjs --no-words   only art/reference/: each edition's cover, box banner and scenes as PNGs with no
 *                                   lettering, every other shape where it always is
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadResvg, toPng } from './src/render.mjs';
import { avatarSvg, boxBannerSvg, coverSvg, logoSvg, xBannerSvg } from './src/brand.mjs';
import { EDITIONS } from './src/edition.mjs';
import { hiddenSvg } from './src/hidden.mjs';
import { VARIANTS, itemSvg } from './src/items.mjs';
import { SCENES, sceneSvg } from './src/scenes.mjs';
import { DRAWN, withoutWords } from './src/type.mjs';

const root = new URL('./', import.meta.url);
const at = (rel) => new URL(rel, root);

/** Every piece as [path without extension, width, height, a function that builds its SVG text]. */
export function builders() {
  const perEdition = Object.values(EDITIONS).flatMap((e) => [
    [`${e.dir}/x-banner`, 1500, 500, () => xBannerSvg(e)],
    [`${e.dir}/cover`, 1200, 630, () => coverSvg(e)],
    [`${e.dir}/box-banner`, 2400, 600, () => boxBannerSvg(e)],
    ...SCENES.map((s) => [`${e.dir}/scenes/scene-${s.n}`, 1200, 1200, () => sceneSvg(s, e)]),
  ]);
  return [
    ['art/logo', 1024, 1024, () => logoSvg()],
    ['art/x-avatar', 400, 400, () => avatarSvg()],
    ['art/hidden', 1024, 1024, () => hiddenSvg()],
    ...VARIANTS.map((v) => [`art/items/variant-${v.n}`, 1024, 1024, () => itemSvg(v)]),
    ...perEdition,
  ];
}

/** Every piece as [path without extension, SVG text], each built with a fresh record of its lettering. */
export function pieces() {
  return builders().map(([base, , , build]) => {
    DRAWN.length = 0;
    return [base, build()];
  });
}

/**
 * The word-free reference pictures as [path without extension, SVG text]: each edition's cover, box banner and scenes,
 * drawn with no lettering, so a picture can show the kit's world without a word in it. The gold edition's go to
 * art/reference/, the paper edition's to art/reference/paper/.
 */
export function references() {
  return withoutWords(() => Object.values(EDITIONS).flatMap((e) => {
    const dir = e.dir.replace(/^art/, 'art/reference');
    return [
      [`${dir}/cover`, coverSvg(e)],
      [`${dir}/box-banner`, boxBannerSvg(e)],
      ...SCENES.map((s) => [`${dir}/scenes/scene-${s.n}`, sceneSvg(s, e)]),
    ];
  }));
}

function buildReferences(Resvg) {
  for (const dir of ['art/reference', 'art/reference/scenes', 'art/reference/paper', 'art/reference/paper/scenes']) mkdirSync(at(dir), { recursive: true });
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
  for (const dir of ['art', 'art/items', 'art/scenes', 'art/paper', 'art/paper/scenes']) mkdirSync(at(dir), { recursive: true });
  const all = pieces();
  for (const [base, svg] of all) {
    writeFileSync(at(`${base}.svg`), svg);
    writeFileSync(at(`${base}.png`), toPng(Resvg, svg));
  }
  writeFileSync(at('art/logo-48.png'), toPng(Resvg, logoSvg(), 48));
  process.stdout.write(`built ${all.length} SVG and PNG pairs and art/logo-48.png\n`);
}

if (import.meta.main) await main();
