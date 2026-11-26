import { registerHooks } from 'node:module';
// Exercise the actual child entry with a constructor spy, without loading native code.
registerHooks({ resolve(specifier, context, next) {
  return specifier === 'sharp' ? { url: new URL('./sharp-spy.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
