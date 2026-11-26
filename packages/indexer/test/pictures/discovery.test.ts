import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { findPictureCopy, PICTURE_LIMITS, GRAPHQL_ENDPOINTS, RAW_GATEWAYS, verifyPictureHint } from '../../src/pictures/discovery';

const bytes = new TextEncoder().encode('a committed picture');
const hash = createHash('sha256').update(bytes).digest('hex');
const id = (n: number) => String(n).padStart(43, 'a');
const graph = (ids: number[]) => Response.json({ data: { transactions: { edges: ids.map(n => ({ node: { id: id(n), block: { height: n } } })) } } });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('SH-ARWEAVE-HINT pages through tied-height decoys using each index cursor', async () => {
  const cursors = new Map<string, (string | null)[]>();
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (!GRAPHQL_ENDPOINTS.includes(url)) return new Response(url.endsWith(id(202)) ? bytes : 'decoy');
    const { after = null } = JSON.parse(String(init?.body)).variables;
    cursors.set(url, [...(cursors.get(url) ?? []), after]);
    const page = after === null ? 0 : after === 'page-1' ? 1 : 2;
    expect(JSON.parse(String(init?.body)).query).toContain('after: $after');
    return Response.json({ data: { transactions: {
      pageInfo: { hasNextPage: page < 2 },
      edges: Array.from({ length: 100 }, (_, n) => ({ cursor: `page-${page + 1}`, node: { id: id(page * 100 + n), block: { height: 7 } } })),
    } } });
  });
  expect(await findPictureCopy(hash, { fetch: fetcher })).toBe(id(202));
  for (const url of GRAPHQL_ENDPOINTS) expect(cursors.get(url)).toEqual([null, 'page-1', 'page-2']);
});

it('bounds advancing and repeated cursor pages and the total unique candidates per hash', async () => {
  for (const repeated of [false, true]) {
    let pages = 0; let raw = 0;
    const fetcher = vi.fn<typeof fetch>(async input => {
      if (!GRAPHQL_ENDPOINTS.includes(String(input))) { raw++; return new Response('decoy'); }
      pages++;
      return Response.json({ data: { transactions: { pageInfo: { hasNextPage: true }, edges: Array.from({ length: 100 }, (_, n) => ({
        cursor: repeated ? 'same' : `cursor-${pages}`, node: { id: id(pages * 100 + n), block: null },
      })) } } });
    });
    expect(await findPictureCopy(hash, { fetch: fetcher })).toBeNull();
    expect(pages).toBeGreaterThan(3);
    expect(pages).toBeLessThanOrEqual(15);
    expect(raw).toBeLessThanOrEqual(1000);
  }
});

it('queries all three endpoints concurrently with exact tags, then skips 15 decoys oldest first', async () => {
  const calls: string[] = []; let graphs = 0;
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input); calls.push(url);
    if (GRAPHQL_ENDPOINTS.includes(url)) {
      graphs++;
      const body = JSON.parse(String(init?.body));
      expect(body.variables).toEqual({ hash });
      expect(body.query).toContain('first: 100'); expect(body.query).toContain('sort: HEIGHT_ASC');
      expect(body.query).toContain('name: "App-Name", values: ["Square Hole"]');
      expect(body.query).toContain('name: "SHA-256", values: [$hash]');
      await Promise.resolve(); expect(graphs).toBe(3);
      return graph(Array.from({ length: 18 }, (_, n) => 18 - n));
    }
    return new Response(url.endsWith(id(16)) || url.endsWith(id(17)) ? bytes : 'decoy');
  });
  expect(await findPictureCopy(`0x${hash.toUpperCase()}`, { fetch: fetcher })).toBe(id(16));
  expect(calls.slice(0, 3)).toEqual(GRAPHQL_ENDPOINTS);
  expect(calls.slice(3).map(url => url.split('/').at(-1))).toEqual([
    ...Array.from({ length: 15 }, (_, n) => [id(n + 1), id(n + 1)]).flat(), id(16),
  ]);
});

it.each(['headers', 'body'] as const)('GraphQL errors and timeouts fall back; raw %s timeouts fall back too', async mode => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const cancel = vi.fn();
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input);
    if (url === GRAPHQL_ENDPOINTS[0]) { signals.push(init?.signal as AbortSignal); return new Promise<Response>(() => undefined); }
    if (url === GRAPHQL_ENDPOINTS[1]) return Response.json({ errors: [{ message: 'down' }] });
    if (url === GRAPHQL_ENDPOINTS[2]) return graph([1, 2]);
    if (url.startsWith(RAW_GATEWAYS[0] as string)) {
      signals.push(init?.signal as AbortSignal);
      if (mode === 'headers') return new Promise<Response>(() => undefined);
      return new Response(new ReadableStream({ pull: () => new Promise(() => undefined), cancel }));
    }
    if (url.endsWith(id(1))) return new Response('down', { status: 503 });
    return new Response(bytes);
  });
  const pending = findPictureCopy(hash, { fetch: fetcher });
  await vi.advanceTimersByTimeAsync(PICTURE_LIMITS.requestMs * 3);
  expect(await pending).toBe(id(2)); expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(mode === 'body' ? 1 : 0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['declared', 'streamed', 'lying'] as const)('refuses %s oversized bytes even with a matching committed hash', async mode => {
  const big = new Uint8Array(PICTURE_LIMITS.bytes + 1);
  const oversizedHash = createHash('sha256').update(big).digest('hex');
  const cancel = vi.fn();
  const fetcher: typeof fetch = vi.fn(async input => GRAPHQL_ENDPOINTS.includes(String(input)) ? graph([1]) : new Response(
    new ReadableStream({ start(controller) { controller.enqueue(big); }, cancel }),
    { headers: mode === 'streamed' ? {} : { 'Content-Length': mode === 'lying' ? '1' : String(big.length) } },
  ));
  expect(await findPictureCopy(oversizedHash, { fetch: fetcher })).toBeNull();
  expect(cancel).toHaveBeenCalledTimes(2);
});

it('checks the bounded union across indexes, rejects malformed ids, and never follows redirects', async () => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.redirect).toBe('error'); expect(init?.cache).toBe('no-store');
    const endpoint = GRAPHQL_ENDPOINTS.indexOf(String(input));
    if (endpoint >= 0) return graph(Array.from({ length: 100 }, (_, n) => endpoint * 100 + n));
    return new Response('wrong');
  });
  expect(await findPictureCopy(hash, { fetch: fetcher })).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(603);
  const malformed: typeof fetch = vi.fn(async () => Response.json({ data: { transactions: { edges: [{ node: { id: '../private', block: null } }] } } }));
  expect(await findPictureCopy(hash, { fetch: malformed })).toBeNull(); expect(malformed).toHaveBeenCalledTimes(3);
});

it('bounds total time, caps GraphQL bodies, and aborts immediately on shutdown', async () => {
  vi.useFakeTimers();
  // Requests individually complete before their timeout, but together still hit the search deadline.
  const fetcher: typeof fetch = vi.fn(async input => GRAPHQL_ENDPOINTS.includes(String(input)) ? graph(Array.from({ length: 100 }, (_, n) => n))
    : new Promise<Response>(resolve => { setTimeout(() => resolve(new Response('decoy')), 4000); }));
  let settled = false;
  const pending = findPictureCopy(hash, { fetch: fetcher }).then(result => { settled = true; return result; });
  await vi.advanceTimersByTimeAsync(PICTURE_LIMITS.searchMs - 1); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBeNull(); expect(vi.mocked(fetcher).mock.calls.length).toBeLessThan(203);
  const oversized: typeof fetch = vi.fn(async () => new Response(' '.repeat(PICTURE_LIMITS.graphBytes + 1)));
  expect(await findPictureCopy(hash, { fetch: oversized })).toBeNull();
  const stop = new AbortController(); const closing = findPictureCopy(hash, { fetch: fetcher, signal: stop.signal });
  stop.abort(); expect(await closing).toBeNull(); expect(vi.getTimerCount()).toBe(0);
});

it('SH-285: reads an item at <gateway>/raw/<id> (the bare path is a 302 to a sandbox host, and redirects are refused)', async () => {
  const reads: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (GRAPHQL_ENDPOINTS.includes(url)) return graph([5]);
    reads.push(url);
    expect(init?.redirect).toBe('error');
    return url === `${RAW_GATEWAYS[0]}/raw/${id(5)}` ? new Response(bytes) : new Response('', { status: 302, headers: { location: 'https://sandbox.example/' } });
  });
  expect(await findPictureCopy(hash, { fetch: fetcher })).toBe(id(5));
  expect(reads).toEqual([`${RAW_GATEWAYS[0]}/raw/${id(5)}`]);
  reads.length = 0;
  expect(await verifyPictureHint(hash, id(5), { fetch: fetcher, signal: new AbortController().signal })).toBe(true);
  expect(reads).toEqual([`${RAW_GATEWAYS[0]}/raw/${id(5)}`]);
});
