import { createRequire } from 'node:module';

/**
 * The renderer: @resvg/resvg-js, found locally. First as a dependency of the kit itself, then through the Square Hole
 * workspace package that pins it (packages/cards, 2.6.2). Nothing is downloaded and no system font is loaded, so the
 * same SVG always gives the same pixels.
 */
export async function loadResvg() {
  try {
    return (await import('@resvg/resvg-js')).Resvg;
  } catch {
    try {
      const local = createRequire(new URL('../../../../packages/cards/package.json', import.meta.url));
      return local('@resvg/resvg-js').Resvg;
    } catch (cause) {
      throw new Error('@resvg/resvg-js is missing. Run pnpm install at the repository root, or install it next to the kit.', { cause });
    }
  }
}

const OPTIONS = { font: { loadSystemFonts: false } };

/** SVG text to PNG bytes, at the SVG's own size or scaled to `width` px. */
export function toPng(Resvg, svg, width) {
  const fitTo = width ? { mode: 'width', value: width } : { mode: 'original' };
  return new Resvg(svg, { ...OPTIONS, fitTo }).render().asPng();
}

/** The raw RGBA pixels of an SVG at its own size, for the pixel checks. */
export function pixels(Resvg, svg) {
  const image = new Resvg(svg, { ...OPTIONS, fitTo: { mode: 'original' } }).render();
  return { data: image.pixels, w: image.width, h: image.height };
}
