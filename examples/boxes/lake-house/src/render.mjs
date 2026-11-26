import { createRequire } from 'node:module';

/**
 * Finds @resvg/resvg-js locally: first as a normal dependency, then through the Square Hole workspace package that
 * already pins it (packages/cards, version 2.6.2). Nothing is downloaded.
 */
export async function loadResvg() {
  try {
    return (await import('@resvg/resvg-js')).Resvg;
  } catch {
    try {
      const req = createRequire(new URL('../../../../packages/cards/package.json', import.meta.url));
      return req('@resvg/resvg-js').Resvg;
    } catch (cause) {
      throw new Error('Cannot find @resvg/resvg-js. Run pnpm install at the repository root.', { cause });
    }
  }
}

/** SVG text to PNG bytes. `width` scales the drawing; without it the SVG's own size is used. System fonts stay off. */
export function toPng(Resvg, svg, width) {
  const fitTo = width ? { mode: 'width', value: width } : { mode: 'original' };
  return new Resvg(svg, { font: { loadSystemFonts: false }, fitTo }).render().asPng();
}

/** Raw RGBA pixels of a PNG, drawn once at its own size (resvg decodes it; no scaling, so no pixel changes). */
export function pngPixels(Resvg, bytes, width, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image width="${width}" height="${height}" href="data:image/png;base64,${bytes.toString('base64')}"/></svg>`;
  const img = new Resvg(svg, { font: { loadSystemFonts: false }, fitTo: { mode: 'original' } }).render();
  return { data: img.pixels, w: img.width, h: img.height };
}
