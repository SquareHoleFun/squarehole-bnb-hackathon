import { createHash } from 'node:crypto';
import { z } from 'zod';
import { arweaveIdSchema, pictureHash } from './types';

export const GRAPHQL_ENDPOINTS: readonly string[] = [
  'https://turbo-gateway.com/graphql', 'https://arweave.net/graphql', 'https://goldsky.arweave.net/graphql',
];
export const RAW_GATEWAYS: readonly string[] = ['https://turbo-gateway.com', 'https://arweave.net'];
export const PICTURE_LIMITS = Object.freeze({ bytes: 107_520 + 4096, graphBytes: 256 * 1024, pageSize: 100, pages: 5, candidates: 500, hashesPerRun: 4, requestMs: 5000, searchMs: 60_000 });
const query = `query Pictures($hash: String!, $after: String) {
  transactions(first: 100, after: $after, sort: HEIGHT_ASC, tags: [
    {name: "App-Name", values: ["Square Hole"]}, {name: "SHA-256", values: [$hash]}
  ]) { pageInfo { hasNextPage } edges { cursor node { id block { height } } } }
}`;
const graphSchema = z.object({ data: z.object({ transactions: z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }).optional(), edges: z.array(z.object({
  cursor: z.string().min(1).max(1024).optional(),
  node: z.object({ id: arweaveIdSchema, block: z.object({ height: z.number().int().nonnegative().safe() }).nullable() }),
})).max(PICTURE_LIMITS.pageSize) }) }) });

/** Deadline covers headers AND body; racing also bounds a fetch double that ignores abort. */
async function request<T>(url: string, init: RequestInit, fetcher: typeof fetch, parent: AbortSignal,
  consume: (response: Response, signal: AbortSignal) => Promise<T>, onTimeout?: () => void): Promise<T | null> {
  if (parent.aborted) return null;
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(() => { onTimeout?.(); controller.abort(); }, PICTURE_LIMITS.requestMs);
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, { ...init, signal, redirect: 'error', cache: 'no-store' });
        if (signal.aborted || response.redirected || !response.ok) { void response.body?.cancel().catch(() => undefined); return null; }
        return consume(response, signal);
      })(),
      new Promise<null>(resolve => { aborted = () => resolve(null); signal.addEventListener('abort', aborted, { once: true }); }),
    ]);
  } catch { return null; }
  finally { clearTimeout(timer); if (aborted) signal.removeEventListener('abort', aborted); controller.abort(); }
}

/** Retain no raw body: each chunk goes straight into the hash. Only small GraphQL JSON is collected. */
async function chunks(response: Response, cap: number, signal: AbortSignal, consume: (chunk: Uint8Array) => void): Promise<void> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) > BigInt(cap))) {
    void response.body?.cancel().catch(() => undefined); throw new Error('picture response too large');
  }
  if (!response.body) throw new Error('missing body');
  const reader = response.body.getReader(); let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error('picture request aborted');
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > cap) throw new Error('picture response too large');
      consume(next.value);
    }
  } finally { signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
}

/**
 * SH-285: an item's bytes at `<gateway>/raw/<id>`, as the site's reader asks for them (apps/web pictures/arweave-read.ts).
 * Both gateways answer `<gateway>/<id>` with a 302 to a sandbox host (measured 26 November 2026), and a redirect is
 * refused here, so that path found no copy at all.
 */
function pictureDigest(id: string, gateway: string, cap: number, fetcher: typeof fetch, signal: AbortSignal,
  onTimeout?: () => void): Promise<string | null> {
  return request(`${gateway}/raw/${id}`, {}, fetcher, signal, async (response, requestSignal) => {
    const digest = createHash('sha256');
    await chunks(response, cap, requestSignal, chunk => { digest.update(chunk); });
    return digest.digest('hex');
  }, onTimeout);
}

/** Hints cannot supply a host. At most two 5 s reads; no raw bytes survive verification. */
export async function verifyPictureHint(committed: string, id: string, options: { fetch?: typeof fetch; signal: AbortSignal }): Promise<boolean> {
  const hash = pictureHash(committed);
  if (!hash || !arweaveIdSchema.safeParse(id).success) return false;
  for (const gateway of RAW_GATEWAYS) {
    if (options.signal.aborted) return false;
    if (await pictureDigest(id, gateway, 128 * 1024, options.fetch ?? fetch, options.signal) === hash) return true;
  }
  return false;
}

export async function findPictureCopy(committed: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<string | null> {
  const hash = pictureHash(committed); if (!hash) return null;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), PICTURE_LIMITS.searchMs);
  const fetcher = options.fetch ?? fetch;
  try {
    const indexes = GRAPHQL_ENDPOINTS.map(url => ({ url, after: undefined as string | undefined, done: false, cursors: new Set<string>() }));
    const tried = new Set<string>();
    // One stalled raw gateway must not consume the entire search deadline.
    const timedOutGateways = new Set<string>();
    for (let page = 0; page < PICTURE_LIMITS.pages && tried.size < PICTURE_LIMITS.candidates; page++) {
      const replies = await Promise.all(indexes.map(async index => {
        if (index.done) return null;
        const reply = await request(index.url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables: { hash, after: index.after } }),
        }, fetcher, signal, async (response, requestSignal) => {
          const data: Uint8Array[] = [];
          await chunks(response, PICTURE_LIMITS.graphBytes, requestSignal, chunk => data.push(chunk));
          const json: unknown = JSON.parse(Buffer.concat(data).toString('utf8'));
          if (json && typeof json === 'object' && 'errors' in json) return null;
          const parsed = graphSchema.safeParse(json);
          return parsed.success ? parsed.data.data.transactions : null;
        });
        const after = reply?.edges.at(-1)?.cursor;
        index.done = !reply?.pageInfo?.hasNextPage || !after || index.cursors.has(after);
        if (after) { index.cursors.add(after); index.after = after; }
        return reply;
      }));
      const candidates = new Map<string, { id: string; height: number }>();
      for (const reply of replies) for (const { node } of reply?.edges ?? []) {
        if (tried.has(node.id)) continue;
        const height = node.block?.height ?? Number.MAX_SAFE_INTEGER;
        const old = candidates.get(node.id);
        if (!old || height < old.height) candidates.set(node.id, { id: node.id, height });
      }
      const ordered = [...candidates.values()].sort((a, b) => a.height - b.height || a.id.localeCompare(b.id))
        .slice(0, PICTURE_LIMITS.candidates - tried.size);
      for (const candidate of ordered) {
        tried.add(candidate.id);
        for (const gateway of RAW_GATEWAYS) {
          if (signal.aborted) return null;
          if (timedOutGateways.has(gateway)) continue;
          const actual = await pictureDigest(candidate.id, gateway, PICTURE_LIMITS.bytes, fetcher, signal,
            () => { timedOutGateways.add(gateway); });
          if (actual === hash) return candidate.id;
        }
      }
      if (indexes.every(index => index.done)) break;
    }
    return null;
  } finally { clearTimeout(timer); controller.abort(); }
}
