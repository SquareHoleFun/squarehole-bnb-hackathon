/**
 * Renders art/logo-48.png, the mark at 48 x 48, from art/logo.png with @resvg/resvg-js, so anyone can see that the
 * house still reads at that size. It is the only brand picture this script makes. Everything else in art/ is the image set the
 * founder approved, kept byte for byte. No network, no fonts.
 *
 *   node preview.mjs      writes art/logo-48.png
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const root = new URL('./', import.meta.url);

/**
 * Finds @resvg/resvg-js locally: first as a normal dependency, then through the Square Hole workspace package that
 * already pins it (packages/cards, version 2.6.2). Nothing is downloaded.
 */
export async function loadResvg() {
  try {
    return (await import('@resvg/resvg-js')).Resvg;
  } catch {
    try {
      const req = createRequire(new URL('../../../packages/cards/package.json', import.meta.url));
      return req('@resvg/resvg-js').Resvg;
    } catch (cause) {
      throw new Error('Cannot find @resvg/resvg-js. Run pnpm install at the repository root, or add it here.', { cause });
    }
  }
}

/** The mark drawn at `size` pixels: art/logo.png placed in a bare SVG of its own size, then scaled by resvg. */
export function logoAt(Resvg, size = 48) {
  const png = readFileSync(new URL('art/logo.png', root));
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<image width="${w}" height="${h}" href="data:image/png;base64,${png.toString('base64')}"/></svg>`;
  return new Resvg(svg, { font: { loadSystemFonts: false }, fitTo: { mode: 'width', value: size } }).render().asPng();
}

if (import.meta.main) {
  writeFileSync(new URL('art/logo-48.png', root), logoAt(await loadResvg()));
  process.stdout.write('wrote art/logo-48.png\n');
}
