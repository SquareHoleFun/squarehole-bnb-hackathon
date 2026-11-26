import { parentPort } from 'node:worker_threads';
import { loadResvg, toPng } from '../../examples/boxes/paper-certificates/src/render.mjs';

const Resvg = await loadResvg();
parentPort.on('message', svg => {
  try { parentPort.postMessage({ bytes: toPng(Resvg, svg) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
});
