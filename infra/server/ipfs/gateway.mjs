import { createHash } from 'node:crypto';
import { MAX_RAW_BLOCK_BYTES, rawCidV1 } from '../../../scripts/ipfs/pin-raw-lib.mjs';
import { createWithheldPictures } from '../../../packages/indexer/src/withheld/list.mjs';
import { contentType } from './content.mjs';
export { imageType } from './content.mjs';

// Canonical base32 CIDv1: version 1, raw 0x55, sha2-256 0x12, 32-byte digest.
// The first digest character and final padding bits are constrained too.
const pathPattern = /^\/ipfs\/(bafkrei[a-h][a-z2-7]{50}[aeimquy4])$/;
const immutable = 'public, max-age=31536000, immutable';
const security = { 'X-Content-Type-Options': 'nosniff' };

export async function blockBytes(response, signal) {
  if (!response.body) throw new Error('missing block');
  if (Number(response.headers.get('content-length') ?? 0) > MAX_RAW_BLOCK_BYTES) {
    await response.body.cancel();
    throw new Error('oversize block');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return Buffer.concat(chunks, length);
      length += value.length;
      if (length > MAX_RAW_BLOCK_BYTES) throw new Error('oversize block');
      chunks.push(value);
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** In-memory requests/responses and an injected fetch allow offline tests without a listener.
 * Nothing supplied by a caller selects an upstream, response format, header or fetch mode.
 */
export function createArtHandler({ fetch = globalThis.fetch, withheld = createWithheldPictures() } = {}) {
  let active = 0;
  return async (request, response) => {
    const refuse = (status) => {
      response.writeHead(status, { 'Cache-Control': 'no-store', ...security });
      response.end();
    };
    if (!['GET', 'HEAD'].includes(request.method)) return refuse(405);
    const cid = pathPattern.exec(request.url)?.[1];
    if (!cid) return refuse(404);
    const listed = () => {
      if (!withheld.has(`ipfs:${cid}`)) return false;
      const body = 'Picture withheld.\n';
      response.writeHead(451, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)), ...security });
      response.end(request.method === 'HEAD' ? undefined : body);
      return true;
    };
    if (listed()) return;
    if (active >= 16) return refuse(503);
    active++;
    try {
      const signal = AbortSignal.timeout(2500);
      // HEAD must GET the same bounded block internally to verify its hash and identify MIME.
      const upstream = await fetch(`http://127.0.0.1:8080/ipfs/${cid}?format=raw`, {
        method: 'GET', redirect: 'error', signal,
        headers: { Accept: 'application/vnd.ipld.raw', 'Cache-Control': 'only-if-cached' },
      });
      if (upstream.status !== 200) {
        await upstream.body?.cancel();
        return refuse([404, 504].includes(upstream.status) ? 404 : 502);
      }
      const bytes = await blockBytes(upstream, signal);
      const hash = `0x${createHash('sha256').update(bytes).digest('hex')}`;
      if (rawCidV1(hash) !== cid) return refuse(502);
      const type = contentType(bytes);
      if (!type) return refuse(415);
      if (listed()) return;
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': String(bytes.length), 'Cache-Control': immutable, ...security });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      return refuse(502); // No upstream bodies, credentials or internal error details in public responses/logs.
    } finally {
      active--;
    }
  };
}
