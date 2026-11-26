/**
 * Lets these scripts run the site's own TypeScript (the Create page's modules) with Node 24's type stripping, as
 * scripts/kits/app.mjs does: extensionless relative imports resolve to `.ts` (packages/chain/scripts/register-ts.mjs)
 * and TypeScript modules are stripped on load. No transpiler, no generated copy of the site's code.
 */
import '../../../../packages/chain/scripts/register-ts.mjs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    return loaded.format === 'module-typescript'
      ? { ...loaded, format: 'module', source: stripTypeScriptTypes(String(loaded.source), { mode: 'transform' }) }
      : loaded;
  },
});
