import { readFile, writeFileSync } from 'node:fs';
// Opening a FIFO with no writer blocks a real libuv worker, as a stuck native decoder would.
function sharp() {
  const pipeline = {
    metadata: async () => ({ format: 'webp', width: 3, height: 2 }),
    ensureAlpha: () => pipeline,
    png: () => pipeline,
    toBuffer: () => {
      readFile(process.env.SH_WEBP_FIFO, () => {});
      writeFileSync(process.env.SH_WEBP_READY, String(process.pid));
      return new Promise(() => {});
    },
  };
  return pipeline;
}
sharp.cache = () => {};
sharp.concurrency = () => {};
export default sharp;
