import { MAX_RAW_BLOCK_BYTES, kuboOrigin, rawCidV1, readBytes } from './pin-raw-lib.mjs';
import { blockBytes } from '../../infra/server/ipfs/gateway.mjs';
import { publicRevealList } from '../../infra/server/ipfs/content.mjs';
import { assetRecord, requireListAssets, roleMatchesMime } from '../../infra/server/ipfs/inventory.mjs';

/** Check every distinct public asset against its local export inventory. Never pins or sends transactions.
 * Loopback HTTP supports local Kubo; all other origins require HTTPS. Redirects are refused.
 */
export async function checkGateway(inventory, gateway, { fetch = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const origin = kuboOrigin(gateway);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('invalid timeout');
  // exportKit retains its records-array API; exportExamples adds the kit/CAR envelope.
  const files = Array.isArray(inventory) ? inventory : inventory?.format === 'squarehole.public-example-pins/1' ? inventory.files : null;
  if (!Array.isArray(files) || files.length === 0 || files.length > 20_000) throw new Error('invalid public asset inventory');
  const seen = new Set();
  for (const record of files) {
    if (!record || !Number.isSafeInteger(record.bytes) || record.bytes < 1 || record.bytes > MAX_RAW_BLOCK_BYTES
        || typeof record.sha256 !== 'string' || !/^0x[0-9a-f]{64}$/.test(record.sha256)
        || record.cid !== rawCidV1(record.sha256) || seen.has(record.cid)
        || !roleMatchesMime(record.role, record.mime)) throw new Error('invalid public asset record');
    seen.add(record.cid);
  }
  const lists = [];
  for (const record of files) {
    for (const method of ['GET', 'HEAD']) {
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await fetch(`${origin}/ipfs/${record.cid}`, { method, redirect: 'error', signal });
      if (response.status !== 200 || response.headers.get('content-type') !== record.mime
          || response.headers.get('content-length') !== String(record.bytes)) {
        await response.body?.cancel();
        throw new Error('gateway status, MIME or length differs from inventory');
      }
      // HEAD legitimately has no body. GET always reads the bounded stream and verifies actual content/hash.
      const bytes = method === 'HEAD' && !response.body ? Buffer.alloc(0) : await blockBytes(response, signal);
      signal.throwIfAborted();
      if (method === 'HEAD') {
        if (bytes.length) throw new Error('gateway HEAD returned a body');
      } else {
        assetRecord(bytes, record);
        if (record.mime === 'application/json') lists.push(publicRevealList(bytes));
      }
    }
  }
  requireListAssets(lists, files);
  return seen.size;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 4) throw new Error('usage');
    const inventory = JSON.parse((await readBytes(process.argv[2], 8_388_608)).toString('utf8'));
    const checked = await checkGateway(inventory, process.argv[3]);
    process.stdout.write(`Verified ${checked} public assets: GET bytes, MIME, SHA-256, HEAD lengths and public-list coverage match. Persistent pins require a separate operator check.\n`);
  } catch {
    process.stderr.write('check-gateway failed; check inventory, gateway availability and exact pinned bytes. Usage: node scripts/ipfs/check-gateway.mjs PINS_JSON GATEWAY_ORIGIN\n');
    process.exitCode = 1;
  }
}
