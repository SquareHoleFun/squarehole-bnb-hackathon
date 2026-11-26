/** SH-202. Exact-byte asset recovery. This module has no wallet or reveal-send port. */
import { requireRevealAuthority } from './reveal-session';
import { rawCidV1, MAX_RAW_BLOCK_BYTES } from '@squarehole/artwork';
import { isAddress, sha256, zeroHash, type Address, type Hex } from 'viem';
import type { RevealBlock } from './reveal-items';

export type RevealAssetRole = 'image' | 'avatar' | 'model';
export type RevealAssetReason = 'ready' | 'not-finalized' | 'needs-box-file' | 'local-hash-mismatch' | 'gateway-hash-mismatch'
  | 'approval-required' | 'unknown-item' | 'not-revealed' | 'too-large' | 'bad-type' | 'hash-mismatch' | 'withheld'
  | 'rate-limited' | 'storage-full' | 'busy' | 'retry-limit' | 'retry-delay-cap' | 'invalid-response' | 'network' | 'cancelled' | 'reorg' | 'not-available' | 'transport-unavailable' | 'deferred';
export interface RevealAssetBytes { read(hash: Hex, role: RevealAssetRole): Promise<Uint8Array | null> }
export interface RevealAssetItem { readonly revealed: boolean; readonly image: Hex; readonly avatar: Hex; readonly model: Hex }
export interface RevealAssetSnapshot { readonly block: RevealBlock; readonly items: ReadonlyMap<bigint, RevealAssetItem> }
export interface RevealAssetScope { readonly chainId: number; readonly collection: Address; readonly ids: readonly bigint[] }
export type RevealAssetUpload = (scope: RevealAssetScope, id: bigint, role: RevealAssetRole, bytes: Uint8Array<ArrayBuffer>, transaction: Hex | undefined, signal: AbortSignal) => Promise<Response>;
export interface RevealAssetPorts {
  readonly fetch: typeof fetch;
  /** Absent when this build has no picture hosting transport. */
  readonly upload?: RevealAssetUpload;
  read(scope: RevealAssetScope, tag: 'latest' | 'finalized'): Promise<RevealAssetSnapshot>;
  canonical(block: RevealBlock): Promise<boolean>;
  readonly bytes: RevealAssetBytes | null;
  /** Only journaled receipt successes. The worker rechecks their finality and canonical block before POST. */
  readonly revealTransactions?: ReadonlyMap<bigint, { readonly hash: Hex; readonly block: RevealBlock }>;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  progress?(value: RevealAssetProgress): void;
}
export interface RevealAssetOutcome { readonly id: bigint; readonly role: RevealAssetRole; readonly reason: RevealAssetReason }
/** Provisional progress; only the returned result has passed the final canonical checks. */
export interface RevealAssetProgress {
  readonly completedItems: bigint; readonly totalItems: bigint; readonly outcome?: RevealAssetOutcome;
}
export interface RevealAssetsResult {
  readonly outcomes: readonly RevealAssetOutcome[];
  readonly revealed: { readonly finalized: bigint; readonly latest: bigint };
  readonly picturesReady: { readonly finalized: bigint; readonly latest: bigint };
}
export const ASSET_RETRIES = 2;
export const ASSET_DELAY_CAP_MS = 60_000;
/** One decoded asset at a time. HEAD/GET/upload share the same bounded sequential worker. */
export const ASSET_IN_FLIGHT = 1;
const roles: readonly RevealAssetRole[] = ['image', 'avatar', 'model'];
const errors: Readonly<Record<number, RevealAssetReason>> = { 401: 'approval-required', 404: 'unknown-item', 409: 'not-revealed',
  413: 'too-large', 415: 'bad-type', 422: 'hash-mismatch', 451: 'withheld', 429: 'rate-limited', 507: 'storage-full', 503: 'busy' };
const retryable = new Set([409, 429, 503]);
const validHash = (h: unknown): h is Hex => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);

export const ASSET_RESPONSE_MAX_BYTES = 65_536;
export const ASSET_RESPONSE_DEADLINE_MS = 15_000;
class InvalidAssetResponse extends Error {}
/** Bound the request and entire body, including error bodies, before decoding or parsing. */
async function responseBytes(request: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal, limit: number) {
  const controller = new AbortController();
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const abort = () => { controller.abort(); rejectDeadline(new InvalidAssetResponse()); };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, ASSET_RESPONSE_DEADLINE_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (signal.aborted) abort();
    const response = await Promise.race([request(controller.signal), deadline]);
    const buffer = new Uint8Array(limit); let length = 0;
    if (response.body) {
      reader = response.body.getReader();
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) break;
        if (!value.length || length + value.length > limit) throw new InvalidAssetResponse();
        buffer.set(value, length); length += value.length;
      }
    }
    return { response, bytes: buffer.subarray(0, length) };
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort();
    // A hostile cancel implementation must not extend the deadline.
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
async function gatewayCheck(cid: string, hash: Hex, ports: RevealAssetPorts, signal: AbortSignal): Promise<RevealAssetReason> {
  const { response, bytes } = await responseBytes(signal => ports.fetch(`/ipfs/${cid}`, { method: 'GET', cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal }), signal, MAX_RAW_BLOCK_BYTES);
  if (response.status === 451) return 'withheld';
  if (response.status !== 200) return 'invalid-response';
  return sha256(bytes).toLowerCase() === hash.toLowerCase() ? 'ready' : 'gateway-hash-mismatch';
}
function retryDelay(response: Response, now: number): number | null {
  const value = response.headers.get('Retry-After');
  if (!value) return null;
  const ms = /^[0-9]+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}
async function oneAsset(scope: RevealAssetScope, id: bigint, role: RevealAssetRole, hash: Hex, ports: RevealAssetPorts, block: RevealBlock, signal: AbortSignal): Promise<RevealAssetReason> {
  try {
    if (signal.aborted) return 'cancelled';
    const upload = ports.upload;
    const cid = rawCidV1(hash);
    const { response: head } = await responseBytes(signal => ports.fetch(`/ipfs/${cid}`, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal }), signal, 0);
    if (head.status === 451) return 'withheld';
    if (head.status === 200) return await gatewayCheck(cid, hash, ports, signal);
    if (head.status !== 404) return 'invalid-response';
    if (!upload) return 'transport-unavailable';
    // No access to any file bytes until a pinned finalized read authorizes this item.
    const borrowed = await ports.bytes?.read(hash, role);
    if (!borrowed) return 'needs-box-file';
    if (borrowed.length > MAX_RAW_BLOCK_BYTES) return 'too-large';
    const bytes = new Uint8Array(borrowed); // Own the bytes before hashing or any later await.
    if (sha256(bytes).toLowerCase() !== hash.toLowerCase()) return 'local-hash-mismatch';
    for (let attempt = 0; attempt <= ASSET_RETRIES; attempt++) {
      if (signal.aborted) return 'cancelled';
      if (!await ports.canonical(block)) return 'reorg';
      const hint = ports.revealTransactions?.get(id);
      const transaction = hint && validHash(hint.hash) && hint.block.number <= block.number && await ports.canonical(hint.block) ? hint.hash : undefined;
      const { response, bytes: responseBody } = await responseBytes(signal => upload(scope, id, role, bytes, transaction, signal), signal, ASSET_RESPONSE_MAX_BYTES);
      let body: unknown;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(responseBody)) as unknown; }
      catch { throw new InvalidAssetResponse(); }
      if (!body || typeof body !== 'object') return 'invalid-response';
      if (response.status === 200) {
        if (!('cid' in body) || body.cid !== cid || !('stored' in body) || typeof body.stored !== 'boolean') return 'invalid-response';
        return await gatewayCheck(cid, hash, ports, signal);
      }
      if ('error' in body && typeof body.error === 'string' && !Object.values(errors).includes(body.error as RevealAssetReason)) return 'not-available';
      const reason = errors[response.status];
      if (!reason || !('error' in body) || body.error !== reason) return 'invalid-response';
      if (!retryable.has(response.status)) return reason;
      if (attempt === ASSET_RETRIES) return 'retry-limit';
      const delay = retryDelay(response, ports.now());
      if (delay === null) return 'invalid-response';
      // Do not retry earlier than the server asked. A long wait is left for a later visit.
      if (delay > ASSET_DELAY_CAP_MS) return 'retry-delay-cap';
      await ports.sleep(delay, signal);
    }
    return 'retry-limit';
  } catch (e) { return signal.aborted ? 'cancelled' : e instanceof InvalidAssetResponse ? 'invalid-response' : 'network'; }
}

/** Resume uses fresh HEAD answers only. No persisted uploaded flag exists. */
export async function revealAssets(scope: RevealAssetScope, ports: RevealAssetPorts, signal: AbortSignal, authority: object = ports): Promise<RevealAssetsResult> {
  requireRevealAuthority(authority);
  if (!Number.isSafeInteger(scope.chainId) || scope.chainId <= 0 || !isAddress(scope.collection)
    || scope.ids.length > 10_000 || scope.ids.some(id => id < 0n) || new Set(scope.ids).size !== scope.ids.length) throw new Error('invalid-scope');
  const final = await ports.read(scope, 'finalized');
  const latest = await ports.read(scope, 'latest');
  if (!await ports.canonical(final.block) || !await ports.canonical(latest.block)) throw new Error('reorg');
  const outcomes: RevealAssetOutcome[] = [];
  let deferred = false;
  let finalized = 0n, head = 0n, readyFinal = 0n, readyLatest = 0n;
  let completedItems = 0n;
  const report = () => {
    const outcome = outcomes.at(-1);
    ports.progress?.(Object.freeze({ completedItems, totalItems: BigInt(scope.ids.length),
      ...(outcome ? { outcome: Object.freeze({ ...outcome }) } : {}) }));
  };
  report();
  for (const id of scope.ids) {
    const f = final.items.get(id), l = latest.items.get(id);
    if (!f || !l || typeof f.revealed !== 'boolean' || typeof l.revealed !== 'boolean') throw new Error('invalid-state');
    if (l.revealed) head++;
    if (!f.revealed) {
      // Do not inspect hashes, read source bytes or even HEAD a hidden item's known CID yet.
      for (const role of roles) outcomes.push({ id, role, reason: 'not-finalized' });
      completedItems++; report();
      continue;
    }
    finalized++;
    let ready = true;
    for (const role of roles) {
      if (!validHash(f[role])) throw new Error('invalid-state');
      if (f[role].toLowerCase() === zeroHash) continue;
      const reason = deferred ? 'deferred' : await oneAsset(scope, id, role, f[role], ports, final.block, signal);
      if (['retry-delay-cap', 'retry-limit', 'invalid-response', 'not-available', 'network', 'cancelled'].includes(reason)) deferred = true;
      outcomes.push({ id, role, reason });
      if (reason !== 'ready') ready = false;
    }
    if (ready) { readyFinal++; if (l.revealed && roles.every(role => l[role].toLowerCase() === f[role].toLowerCase())) readyLatest++; }
    completedItems++; report();
  }
  if (!await ports.canonical(final.block) || !await ports.canonical(latest.block)) throw new Error('reorg');
  return { outcomes, revealed: { finalized, latest: head }, picturesReady: { finalized: readyFinal, latest: readyLatest } };
}

interface AssetRange { readonly start: number; readonly end: number }
/**
 * Index only hashes and byte ranges in the Create file. No JSON.parse of the full asset file.
 * The reveal source must independently pass its bounded commitment reader. Strings written by
 * Create are plain base64; escaped base64 is refused, not silently rewritten.
 */
export async function boxFileAssetBytes(file: Blob): Promise<RevealAssetBytes> {
  if (file.size > 256 * 1024 * 1024) throw new Error('file-byte-limit');
  let indexed: Promise<RevealAssetBytes> | undefined;
  // File selection itself reads no asset content. The finalized-item gate calls read().
  return { read: async (hash, role) => (await (indexed ??= indexBoxAssetBytes(file))).read(hash, role) };
}
async function indexBoxAssetBytes(file: Blob): Promise<RevealAssetBytes> {
  const entries = new Map<string, AssetRange>();
  let depth = 0, quoted = false, escaped = false, text = '', start = 0, position = 0;
  let rootKey = '', key = '', section = '', row: { hash?: string; range?: AssetRange } | null = null;
  let expectingKey = true, skip = false;
  for (let offset = 0; offset < file.size; offset += 65_536) {
    const chunk = new Uint8Array(await file.slice(offset, offset + 65_536).arrayBuffer());
    for (const byte of chunk) {
      const pos = position++;
      if (quoted) {
        if (escaped) {
          if (row && depth === 3 && key === 'base64' && !expectingKey) throw new Error('noncanonical-base64');
          escaped = false; if (!skip) text += String.fromCharCode(byte); continue;
        }
        if (byte === 92) { escaped = true; if (!skip) text += '\\'; continue; }
        if (byte !== 34) { if (!skip) { text += String.fromCharCode(byte); if (text.length > 2048) throw new Error('asset-field-limit'); } continue; }
        quoted = false;
        if (depth === 1 && expectingKey) rootKey = JSON.parse(`"${text}"`) as string;
        if (row && depth === 3) {
          if (expectingKey) key = JSON.parse(`"${text}"`) as string;
          else if (key === 'sha256') row.hash = JSON.parse(`"${text}"`) as string;
          else if (key === 'base64') row.range = { start, end: pos };
        }
        continue;
      }
      if (byte === 34) { quoted = true; escaped = false; text = ''; start = pos + 1; skip = !(depth === 1 && expectingKey) && !(row && depth === 3 && (expectingKey || key === 'sha256')); continue; }
      if (byte === 123 || byte === 91) {
        if (depth === 1 && byte === 91 && (rootKey === 'pictures' || rootKey === 'models')) section = rootKey;
        if (depth === 2 && byte === 123 && section) row = {};
        depth++; expectingKey = true;
      } else if (byte === 125 || byte === 93) {
        if (depth === 3 && row) {
          if (!validHash(row.hash) || !row.range || row.range.end - row.range.start > Math.ceil(MAX_RAW_BLOCK_BYTES / 3) * 4) throw new Error('invalid-asset-entry');
          const index = `${section}:${row.hash.toLowerCase()}`;
          // Create can reuse an item picture as its logo/cover. Keep one range for that hash.
          if (!entries.has(index)) entries.set(index, row.range);
          if (entries.size > 30_000) throw new Error('asset-count-limit');
          row = null;
        }
        if (depth === 2) section = '';
        depth--;
      } else if (byte === 58) expectingKey = false;
      else if (byte === 44) expectingKey = true;
    }
  }
  if (depth !== 0 || quoted || escaped) throw new Error('invalid-asset-file');
  return { async read(hash, role) {
    const range = entries.get(`${role === 'model' ? 'models' : 'pictures'}:${hash.toLowerCase()}`);
    if (!range) return null;
    const length = range.end - range.start;
    if (length % 4 !== 0) throw new Error('invalid-base64');
    const bytes = new Uint8Array(length / 4 * 3);
    let used = 0;
    // At most 64 KiB of base64 and 48 KiB of binary string alongside one decoded asset.
    for (let from = range.start; from < range.end; from += 65_536) {
      const text = await file.slice(from, Math.min(from + 65_536, range.end)).text();
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || (from + 65_536 < range.end && text.includes('='))) throw new Error('invalid-base64');
      const binary = atob(text);
      for (let i = 0; i < binary.length; i++) bytes[used++] = binary.charCodeAt(i);
    }
    return bytes.subarray(0, used);
  } };
}
