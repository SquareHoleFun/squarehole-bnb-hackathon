// SH-AUDIT-B0-U9 (Fable): module resolution hooks for the generator (see AuditU9FableGenRegister.mjs).
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// packages/contracts/test/box/audit/U9/gen -> packages/box-spec/src/index.ts
const BOX_SPEC_INDEX = pathToFileURL(resolvePath(here, '../../../../../../box-spec/src/index.ts')).href;

export async function resolve(specifier, context, next) {
  if (/^(viem|zod)(\/|$)/.test(specifier)) return next(specifier, { ...context, parentURL: BOX_SPEC_INDEX });
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]s$|\.json$/.test(specifier) && context.parentURL) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    for (const ext of ['.ts', '.mts', '/index.ts']) {
      if (existsSync(base + ext)) return next(pathToFileURL(base + ext).href, context);
    }
  }
  return next(specifier, context);
}
