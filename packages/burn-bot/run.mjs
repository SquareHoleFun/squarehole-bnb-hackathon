// Node 24: node --experimental-transform-types packages/burn-bot/run.mjs --config <public-config.json> --dry-run
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.endsWith('.ts')
        && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw error;
    }
  },
});
try { const { main } = await import('./src/cli.ts'); await main(); }
catch {
  // RPCs, service URLs and external signer failures can carry credentials: never print their error bodies.
  process.stderr.write('Burn bot refused this cycle. Check public config, endpoint availability, signer setup and journal evidence.\n');
  process.exitCode = 1;
}
