import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  return specifier === 'sharp' ? { url: new URL('./native-block-sharp.mjs', import.meta.url).href, shortCircuit: true } : next(specifier, context);
} });
