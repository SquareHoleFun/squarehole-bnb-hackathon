/**
 * Loads the generated BoxSpecV1 library (src/generated/box-spec.v1.ts) and its curve helpers from plain Node, without a
 * build step: Node 22.18+ / 24 strips TypeScript types natively, and this resolve hook adds the `.ts` extension the
 * package's extension-less relative imports leave out (they are written for the bundler and vitest). Used by
 * scripts/check-spec.mjs (`pnpm box-spec:check`) and skills/square-hole-launch/scripts/*.mjs; tests import the modules
 * directly instead.
 */
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'src');
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

/** The generated library plus the curve helpers the overview uses (`boxCurve`, `curveBuyOut`, `issuanceBps`). */
export async function loadBoxSpecLibrary() {
  addTsExtension();
  const at = (file) => pathToFileURL(join(srcDir, file)).href;
  const [generated, layout, creatorBuy] = await Promise.all([
    import(at('generated/box-spec.v1.ts')),
    import(at('layout.ts')),
    import(at('creator-buy.ts')),
  ]);
  return { ...generated, boxCurve: layout.boxCurve, curveBuyOut: creatorBuy.curveBuyOut, issuanceBps: creatorBuy.issuanceBps };
}

/** Format 2 uses its independent small-raise curve and full-range graduation. V1 callers keep their frozen maths. */
export async function loadBoxSpecV2Library() {
  addTsExtension();
  const at = (file) => pathToFileURL(join(srcDir, file)).href;
  const [generated, layout, creatorBuy] = await Promise.all([
    import(at('generated/box-spec.v2.ts')), import(at('layout-v2.ts')), import(at('creator-buy.ts')),
  ]);
  return { ...generated, boxCurve: layout.boxCurve, fullRange: layout.fullRange,
    curveBuyOut: creatorBuy.curveBuyOut, issuanceBps: creatorBuy.issuanceBps };
}
