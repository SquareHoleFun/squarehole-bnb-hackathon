import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { PictureCopiesService, createPictureCopies } from '../../src/pictures/service';
import { MemoryPictureCopies } from '../../src/pictures/store';
import { GRAPHQL_ENDPOINTS, PICTURE_LIMITS, RAW_GATEWAYS } from '../../src/pictures/discovery';

const bytes = 'picture bytes must never reach a store';
const hash = createHash('sha256').update(bytes).digest('hex');
const id = 'a'.repeat(43);
const spec = { coverSha256: `0x${hash}`, collectionCoverSha256: `0x${hash}` };
const found: typeof fetch = vi.fn(async input => GRAPHQL_ENDPOINTS.includes(String(input))
  ? Response.json({ data: { transactions: { edges: [{ node: { id, block: { height: 1 } } }] } } }) : new Response(bytes));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('deduplicates logo and cover, persists only hash/id, and a new service reuses the store without fetching', async () => {
  const store = new MemoryPictureCopies(); const put = vi.spyOn(store, 'put');
  const first = new PictureCopiesService(store, { fetch: found });
  expect(first.visible(spec)).toEqual({});
  await first.run([spec]);
  expect(put.mock.calls).toEqual([[hash, id]]);
  expect(first.visible(spec)).toEqual({ pictureCopies: { logo: { arweaveId: id }, cover: { arweaveId: id } } });
  await first.stop(); vi.mocked(found).mockClear();
  const second = new PictureCopiesService(store, { fetch: found }); await second.run([spec]);
  expect(found).not.toHaveBeenCalled(); expect(second.visible(spec)).toEqual(first.visible(spec));
  expect(second.visible({ ...spec, coverSha256: '0x' + '0'.repeat(64), collectionCoverSha256: '0x' + '1'.repeat(64) })).toEqual({});
  await second.stop();
});

it('retries absent pictures with exponential backoff and recovers after errors without overlapping runs', async () => {
  let now = 0;
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
  const service = new PictureCopiesService(new MemoryPictureCopies(), { fetch: fetcher, now: () => now });
  await Promise.all([service.run([spec]), service.run([spec])]); expect(fetcher).toHaveBeenCalledTimes(3);
  now = 59_999; await service.run([spec]); expect(fetcher).toHaveBeenCalledTimes(3);
  now = 60_000; await service.run([spec]); expect(fetcher).toHaveBeenCalledTimes(6);
  now = 179_999; await service.run([spec]); expect(fetcher).toHaveBeenCalledTimes(6);
  fetcher.mockImplementation(found); now = 180_000; await service.run([spec]);
  expect(service.visible(spec)).toHaveProperty('pictureCopies.logo.arweaveId', id);
  await service.stop();
});

it.each(RAW_GATEWAYS)('finds the 16th copy on retry while %s keeps timing out', async stalledGateway => {
  vi.useFakeTimers();
  let now = 0; let published = false;
  const candidates = Array.from({ length: 16 }, (_, n) => ({ node: {
    id: n === 15 ? id : String(n).padStart(43, 'b'), block: { height: n },
  } }));
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = String(input);
    if (GRAPHQL_ENDPOINTS.includes(url)) return Response.json({ data: { transactions: { edges: candidates } } });
    if (url.startsWith(`${stalledGateway}/`)) return new Promise<Response>(() => undefined);
    return new Response(published && url.endsWith(id) ? bytes : 'decoy');
  });
  const store = new MemoryPictureCopies(); const put = vi.spyOn(store, 'put');
  const service = new PictureCopiesService(store, { fetch: fetcher, now: () => now });
  try {
    const first = service.run([spec]);
    await vi.advanceTimersByTimeAsync(PICTURE_LIMITS.searchMs); await first;
    expect(service.visible(spec)).toEqual({});
    published = true; fetcher.mockClear();
    now = 59_999; await service.run([spec]); expect(fetcher).not.toHaveBeenCalled();
    now = 60_000;
    const retry = service.run([spec]);
    await vi.advanceTimersByTimeAsync(PICTURE_LIMITS.searchMs); await retry;
    expect(service.visible(spec)).toEqual({ pictureCopies: { logo: { arweaveId: id }, cover: { arweaveId: id } } });
    expect(put.mock.calls).toEqual([[hash, id]]);
    const rawCalls = fetcher.mock.calls.map(([input]) => String(input)).filter(url => !GRAPHQL_ENDPOINTS.includes(url));
    expect(rawCalls.filter(url => url.startsWith(`${stalledGateway}/`))).toHaveLength(1);
    expect(rawCalls.filter(url => !url.startsWith(`${stalledGateway}/`)).map(url => url.split('/').at(-1)))
      .toEqual(candidates.map(candidate => candidate.node.id));
  } finally { await service.stop(); }
  expect(vi.getTimerCount()).toBe(0);
});

it('limits a cycle to four hashes and two simultaneous searches, fairly advances past failures', async () => {
  const specs = Array.from({ length: 12 }, (_, n) => ({ coverSha256: (n + 1).toString(16).padStart(64, '0'), collectionCoverSha256: '' }));
  let active = 0; let peak = 0;
  const fetcher = vi.fn<typeof fetch>(async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return Response.json({ data: { transactions: { edges: [] } } }); });
  const service = new PictureCopiesService(new MemoryPictureCopies(), { fetch: fetcher, now: () => 0 });
  await service.run(specs); expect(fetcher).toHaveBeenCalledTimes(12); expect(peak).toBe(6);
  await service.run(specs); expect(fetcher).toHaveBeenCalledTimes(24);
  await service.run(specs); expect(fetcher).toHaveBeenCalledTimes(36);
  await service.run(specs); expect(fetcher).toHaveBeenCalledTimes(36);
  await service.stop();
});

it('store failure leaves responses usable; watches retry and shutdown cancels requests and timers', async () => {
  vi.useFakeTimers();
  const store = new MemoryPictureCopies(); vi.spyOn(store, 'init').mockRejectedValueOnce(new Error('db down'));
  const fetcher = vi.fn<typeof fetch>(async () => new Promise(() => undefined));
  const service = new PictureCopiesService(store, { fetch: fetcher }); service.watch(() => [spec]);
  await vi.advanceTimersByTimeAsync(0); expect(service.visible(spec)).toEqual({});
  await vi.advanceTimersByTimeAsync(5000); expect(fetcher).toHaveBeenCalledTimes(3);
  await service.stop(); expect(vi.getTimerCount()).toBe(0);
});

it('failed persistence publishes nothing, retries at backoff, and retains no bytes', async () => {
  let now = 0;
  const store = new MemoryPictureCopies(); const put = vi.spyOn(store, 'put').mockRejectedValueOnce(new Error('store unavailable'));
  const service = new PictureCopiesService(store, { fetch: found, now: () => now });
  await service.run([spec]); expect(service.visible(spec)).toEqual({}); expect(await store.get(hash)).toBeNull();
  expect(put.mock.calls).toEqual([[hash, id]]);
  now = 60_000; await service.run([spec]); expect(service.visible(spec)).toHaveProperty('pictureCopies.logo.arweaveId', id);
  await service.stop();
});

it('keeps absent retries capped at one hour instead of stopping permanently', async () => {
  let now = 0;
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: { transactions: { edges: [] } } }));
  const service = new PictureCopiesService(new MemoryPictureCopies(), { fetch: fetcher, now: () => now });
  await service.run([spec]);
  for (const [attempt, delay] of [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000].entries()) {
    now += delay - 1; await service.run([spec]); expect(fetcher).toHaveBeenCalledTimes((attempt + 1) * 3);
    now++; await service.run([spec]); expect(fetcher).toHaveBeenCalledTimes((attempt + 2) * 3);
  }
  await service.stop();
});

it.each(['off', 'memory', 'postgres'] as const)('selects storage for SH_HISTORY=%s', async history => {
  const service = createPictureCopies({ history, pg: { host: undefined, port: undefined, user: undefined, database: 'unused' } });
  expect(service.store.kind).toBe(history === 'postgres' ? 'postgres' : 'memory'); await service.stop();
});


it('SH-ARWEAVE-HINT bounds a run to four hashes, 60 index pages and 2,000 unique candidate checks', async () => {
  const specs = Array.from({ length: 8 }, (_, n) => ({ coverSha256: (n + 1).toString(16).padStart(64, '0'), collectionCoverSha256: '' }));
  let pages = 0; let raw = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (!GRAPHQL_ENDPOINTS.includes(String(input))) { raw++; return new Response('decoy'); }
    pages++;
    const { after } = JSON.parse(String(init?.body)).variables;
    const page = after ? Number(after) : 0;
    return Response.json({ data: { transactions: { pageInfo: { hasNextPage: true }, edges: Array.from({ length: 100 }, (_, n) => ({
      cursor: String(page + 1), node: { id: String(page * 100 + n).padStart(43, 'x'), block: { height: 1 } },
    })) } } });
  });
  const service = new PictureCopiesService(new MemoryPictureCopies(), { fetch: fetcher });
  await service.run(specs);
  expect(pages).toBe(60); expect(raw).toBe(4000);
  await service.stop();
});
