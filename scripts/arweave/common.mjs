import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export class ArchiveError extends Error {}
export const fail = (message) => { throw new ArchiveError(message); };
export const sha256 = (b) => `0x${createHash('sha256').update(b).digest('hex')}`;
export const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
export const decimal = (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < (1n << 256n);
export const hash = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v) && v !== `0x${'0'.repeat(64)}`;
export const arId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v) && Buffer.from(v, 'base64url').toString('base64url') === v;
export const arBlockHash = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{64}$/.test(v);
export const MAX_FILE = 1_048_576;

export function httpsUrl(value, originOnly = true) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || (originOnly && (u.pathname !== '/' || u.search))) throw new Error();
    return originOnly ? u.origin : u.href;
  } catch { fail('an explicit HTTPS endpoint without credentials is required'); }
}

export async function readBytes(path, limit) {
  let f;
  try {
    if (typeof path !== 'string' || !path) throw new Error();
    f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await f.stat();
    if (!info.isFile() || info.size > limit) throw new Error();
    const b = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const { bytesRead } = await f.read(b, length, b.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error();
    return b.subarray(0, length);
  } catch { fail('cannot read bounded regular file; details suppressed'); }
  finally { await f?.close(); }
}

export async function readJson(path, limit = 16_777_216) {
  try { return JSON.parse((await readBytes(path, limit)).toString('utf8')); }
  catch { fail('cannot read bounded JSON input; details suppressed'); }
}

export async function request(fetch, url, { limit = 4_194_304, ...options } = {}) {
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(60_000) });
    if (!response.ok || response.redirected) { await response.body?.cancel(); throw new Error(); }
    const chunks = []; let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > limit) throw new Error();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch { fail('HTTPS request failed (transport, status or size); details suppressed'); }
}

export async function jsonRequest(fetch, url, options) {
  try { return JSON.parse((await request(fetch, url, options)).toString('utf8')); }
  catch { fail('HTTPS JSON request failed; details suppressed'); }
}

/** CLI serializes workers. A crash leaves a lock to move aside only after review.
 * Both the new file and parent directory are fsynced before an upload can follow.
 */
export async function fileStateStore(path, task) {
  if (typeof path !== 'string' || !path) fail('state file environment variable is required');
  let lock;
  try { lock = await open(`${path}.lock`, 'wx', 0o600); }
  catch { fail('cannot acquire state lock; check running workers or crash recovery'); }
  const store = {
    load: async () => {
      try {
        const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        await f.close();
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        fail('cannot read state; preserve it for recovery');
      }
      return readJson(path, 67_108_864);
    },
    save: async (value) => {
      let pending; let directory;
      try {
        const name = `${path}.pending-${randomUUID()}`;
        pending = await open(name, 'wx', 0o600);
        await pending.writeFile(`${JSON.stringify(value)}\n`);
        await pending.sync();
        await pending.close(); pending = undefined;
        await rename(name, path);
        directory = await open(dirname(path), 'r');
        await directory.sync();
      } catch { fail('cannot save durable checkpoint; preserve pending files for recovery'); }
      finally { await pending?.close(); await directory?.close(); }
    },
  };
  try { return await task(store); }
  finally { await lock.close(); await rename(`${path}.lock`, `${path}.last-lock`); }
}
