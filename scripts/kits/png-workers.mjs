import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

/** Ordered, bounded rendering: at most one PNG per worker waits in memory. Always close workers on failure/early exit. */
export async function* renderPngs(svgs, { workers = Math.min(4, availableParallelism()), svg = value => value } = {}) {
  if (!Number.isInteger(workers) || workers < 1 || workers > 8) throw new Error('workers must be an integer from 1 to 8');
  const pool = Array.from({ length: Math.min(workers, svgs.length) }, () => new Worker(new URL('./png-worker.mjs', import.meta.url)));
  const render = (worker, svg) => new Promise(resolve => {
    const done = result => {
      worker.off('message', message); worker.off('error', error); worker.off('exit', exited);
      resolve(result);
    };
    const message = result => done(result.error ? { error: new Error(result.error) } : { bytes: Buffer.from(result.bytes) });
    const error = error => done({ error });
    const exited = code => done({ error: new Error(`PNG worker exited before returning bytes (${code})`) });
    worker.once('message', message); worker.once('error', error); worker.once('exit', exited);
    worker.postMessage(svg);
  });
  try {
    const pending = pool.map((worker, i) => render(worker, svg(svgs[i])));
    for (let i = 0; i < svgs.length; i++) {
      const slot = i % pool.length, result = await pending[slot];
      if (result.error) throw result.error;
      yield result.bytes;
      if (i + pool.length < svgs.length) pending[slot] = render(pool[slot], svg(svgs[i + pool.length]));
    }
  } finally { await Promise.all(pool.map(worker => worker.terminate())); }
}
