/**
 * Loads packages/artwork's TypeScript from plain Node without a build step: Node 22.18+ / 24 strips types natively, and
 * this resolve hook adds the `.ts` extension the package's extension-less relative imports leave out (they are written
 * for the bundler and vitest). The same hook as packages/box-spec/scripts/lib/load-generated.mjs.
 */
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const artworkSrc = join(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), 'packages/artwork/src');
let hooked = false;

function addTsExtension() {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (error) {
        const relative = specifier.startsWith('./') || specifier.startsWith('../');
        const fromTs = context.parentURL?.endsWith('.ts') ?? false;
        if (relative && fromTs && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
}

/** Imports packages/artwork/src/<file> (a .ts path relative to src). */
export async function importArtwork(file) {
  addTsExtension();
  return import(pathToFileURL(join(artworkSrc, file)).href);
}
