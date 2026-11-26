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
      throw new Error('Cannot find @resvg/resvg-js. Run pnpm install at the repository root, or install it next to this kit.', { cause });
    }
  }
}

/** SVG text to PNG bytes. `width` scales the drawing; without it the SVG's own size is used. System fonts stay off. */
export function toPng(Resvg, svg, width) {
  const opts = {
    background: undefined,
    font: { loadSystemFonts: false },
    fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
  };
  return new Resvg(svg, opts).render().asPng();
}
