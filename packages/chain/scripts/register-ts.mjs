/**
 * Lets Node 24 run this package's TypeScript directly (built-in type stripping; no transpiler dependency). The
 * workspace sources import each other without file extensions (bundler resolution, as the app and vitest expect);
 * Node's own resolver does not try extensions, so this hook retries a relative, extensionless specifier with `.ts`
 * and then `/index.ts`. Usage: `node --import ./scripts/register-ts.mjs src/main.ts`.
 */
import { registerHooks } from 'node:module';

const RELATIVE = /^\.{1,2}\//;
const HAS_EXTENSION = /\.[cm]?[jt]sx?$|\.json$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!RELATIVE.test(specifier) || HAS_EXTENSION.test(specifier)) return nextResolve(specifier, context);
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context);
        } catch {
          // try the next candidate
        }
      }
      throw error;
    }
  },
});
