import { readFileSync } from 'node:fs';
import { PICTURE_BUDGET } from '@squarehole/artwork/box-picture';
let cache, threads;
function sharp(input, options) {
  process.send?.('sharp-constructed');
  if (!Buffer.isBuffer(input) || cache !== false || threads !== 1 || options.limitInputPixels !== PICTURE_BUDGET.pixels
    || options.page !== 0 || options.pages !== 1 || options.animated !== false) throw new Error('unsafe decoder options');
  const pipeline = {
    metadata: async () => ({ format: 'webp', width: 3, height: 2 }),
    ensureAlpha: () => pipeline,
    png: () => pipeline,
    toBuffer: async () => ({ data: readFileSync(new URL('./lossless.png', import.meta.url)), info: { width: 3, height: 2 } }),
  };
  return pipeline;
}
sharp.cache = value => { cache = value; };
sharp.concurrency = value => { threads = value; };
sharp.versions = { sharp: '0.35.5' };
sharp.format = { webp: { input: { buffer: true } }, png: { output: { buffer: true } } };
export default sharp;
