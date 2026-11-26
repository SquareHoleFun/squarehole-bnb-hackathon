// @vitest-environment node
/**
 * SH-ARWEAVE-PICTURES-WEB: the publisher against a fake Turbo (no network): the item it sends, the free-size refusal and
 * the fit Create shrinks to, every failure path, and that the throwaway key is never sent, logged or kept.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as accounts from 'viem/accounts';
import { decodeTagsForTests } from './test-support';
import { HEADER_LENGTH, itemSize, verifyEthDataItem } from './ans104-eth';
import { APP_NAME, TURBO_FREE_BYTES, TURBO_UPLOAD_ORIGIN, fitsFree, freeLimit, itemBytesFor, knownFreeLimit, pictureTags, publishToArweave, readFreeLimit, resetFreeLimitForTests, type PublishResult } from './arweave-publish';
import { MAX_PICTURE_BYTES } from './arweave-hosts';

vi.mock('viem/accounts', async (original) => {
  const real = await original<typeof import('viem/accounts')>();
  return { ...real, generatePrivateKey: vi.fn(real.generatePrivateKey) };
});

const png = (seed: number, size = 64) => Uint8Array.from({ length: size }, (_, i) => (i < 8 ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i] ?? 0 : (seed * 31 + i * 7) & 255));
const shaOf = (bytes: Uint8Array) => `0x${createHash('sha256').update(bytes).digest('hex')}` as const;
const UPLOAD = 'https://upload.test';

interface Sent { readonly url: string; readonly init: RequestInit | undefined }
function fakeTurbo(answer: (item: Uint8Array, index: number) => Promise<Response> | Response, info: Response | (() => Response) = () => Response.json({ freeUploadLimitBytes: TURBO_FREE_BYTES })) {
  const sent: Sent[] = [];
  let posts = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    if (url === `${UPLOAD}/info`) return typeof info === 'function' ? info() : info;
    if (url === `${UPLOAD}/v1/tx` && init?.method === 'POST') return answer(new Uint8Array(init.body as Uint8Array), posts++);
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}
const accept = async (item: Uint8Array) => Response.json({ id: (await verifyEthDataItem(item))?.id, owner: 'x', winc: '0' });

beforeEach(() => {
  resetFreeLimitForTests();
  vi.stubGlobal('fetch', () => { throw new Error('no network in unit tests'); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('publishToArweave', () => {
  it('sends each picture once as a valid type-3 item with the four tags, to Turbo’s /v1/tx, and reports Turbo’s id', async () => {
    const logo = png(1); const cover = png(2);
    const turbo = fakeTurbo(accept);
    const settled: PublishResult[] = [];
    const results = await publishToArweave([{ sha256: shaOf(logo), bytes: logo }, { sha256: shaOf(cover), bytes: cover }], { chainId: 11155111, fetcher: turbo.fetcher, upload: UPLOAD, onResult: (r) => settled.push(r) });
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(settled).toEqual(results);
    const posts = turbo.sent.filter((s) => s.init?.method === 'POST');
    expect(posts).toHaveLength(2);
    for (const [i, post] of posts.entries()) {
      expect(post.url).toBe(`${UPLOAD}/v1/tx`);
      expect(post.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', headers: { 'Content-Type': 'application/octet-stream' } });
      const item = new Uint8Array(post.init?.body as Uint8Array);
      const parsed = await verifyEthDataItem(item);
      const bytes = i === 0 ? logo : cover;
      expect(parsed?.valid).toBe(true);
      expect(Buffer.from(parsed?.data ?? [])).toEqual(Buffer.from(bytes));
      expect(decodeTagsForTests(parsed?.rawTags ?? new Uint8Array())).toEqual([
        { name: 'Content-Type', value: 'image/png' }, { name: 'App-Name', value: 'Square Hole' },
        { name: 'SHA-256', value: shaOf(bytes).slice(2) }, { name: 'Box-Chain-Id', value: '11155111' },
      ]);
      const result = results[i];
      expect(result?.ok && result.id).toBe(parsed?.id);
      expect(result?.ok && result.itemBytes).toBe(item.length);
    }
    // One throwaway key for the run: both items have the same owner.
    const owners = await Promise.all(posts.map(async (p) => Buffer.from((await verifyEthDataItem(new Uint8Array(p.init?.body as Uint8Array)))?.owner ?? []).toString('hex')));
    expect(new Set(owners).size).toBe(1);
  });

  it('never sends, logs or keeps the throwaway key; a new run makes a new one', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')];
    const turbo = fakeTurbo(accept);
    const logo = png(3);
    await publishToArweave([{ sha256: shaOf(logo), bytes: logo }], { chainId: 1, fetcher: turbo.fetcher, upload: UPLOAD });
    await publishToArweave([{ sha256: shaOf(logo), bytes: logo }], { chainId: 1, fetcher: turbo.fetcher, upload: UPLOAD });
    const generate = vi.mocked(accounts.generatePrivateKey);
    expect(generate).toHaveBeenCalledTimes(2);
    const keys = generate.mock.results.map((r) => String(r.value).slice(2).toLowerCase());
    expect(keys[0]).not.toBe(keys[1]);
    for (const { url, init } of turbo.sent) {
      const body = init?.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.alloc(0);
      for (const key of keys) {
        expect(url.toLowerCase()).not.toContain(key);
        expect(JSON.stringify(init?.headers ?? {}).toLowerCase()).not.toContain(key);
        expect(body.toString('hex')).not.toContain(key);
      }
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    expect(Object.keys(globalThis).filter((name) => /key/i.test(name) && keys.some((key) => String((globalThis as Record<string, unknown>)[name]).includes(key)))).toEqual([]);
  });

  it('refuses an item over Turbo’s free size before sending anything; reads the size from /info, else 107,520 bytes', async () => {
    const big = png(4, 2_000);
    const small = png(5);
    const turbo = fakeTurbo(accept, () => Response.json({ freeUploadLimitBytes: 1_000 }));
    const results = await publishToArweave([{ sha256: shaOf(big), bytes: big }, { sha256: shaOf(small), bytes: small }], { chainId: 1, fetcher: turbo.fetcher, upload: UPLOAD });
    expect(results[0]).toEqual({ sha256: shaOf(big), ok: false, reason: 'too-large', itemBytes: itemSize(2_000, pictureTags(big, shaOf(big), 1) ?? []) });
    expect(itemSize(2_000, pictureTags(big, shaOf(big), 1) ?? [])).toBe(HEADER_LENGTH + 2_000 + 135);
    expect(results[1]?.ok).toBe(true);
    expect(turbo.sent.filter((s) => s.init?.method === 'POST')).toHaveLength(1);
    expect(await readFreeLimit(fakeTurbo(accept, () => new Response('down', { status: 503 })).fetcher, UPLOAD)).toEqual({ limit: TURBO_FREE_BYTES, ok: false });
    expect(await readFreeLimit(fakeTurbo(accept, () => Response.json({ freeUploadLimitBytes: -1 })).fetcher, UPLOAD)).toEqual({ limit: TURBO_FREE_BYTES, ok: false });
    expect(await readFreeLimit((async () => { throw new TypeError('offline'); }) as unknown as typeof fetch, UPLOAD)).toEqual({ limit: TURBO_FREE_BYTES, ok: false });
    expect(await readFreeLimit(fakeTurbo(accept, () => Response.json({ freeUploadLimitBytes: 200_000 })).fetcher, UPLOAD)).toEqual({ limit: 200_000, ok: true });
    expect(TURBO_UPLOAD_ORIGIN).toBe('https://upload.ardrive.io');
  });

  it('refuses bytes that do not match their committed hash, and non-raster bytes, without sending them', async () => {
    const logo = png(6);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const turbo = fakeTurbo(accept);
    const results = await publishToArweave([{ sha256: shaOf(png(7)), bytes: logo }, { sha256: shaOf(svg), bytes: svg }, { sha256: '0x1234', bytes: logo }], { chainId: 1, fetcher: turbo.fetcher, upload: UPLOAD });
    expect(results.map((r) => !r.ok && r.reason)).toEqual(['mismatch', 'type', 'mismatch']);
    expect(turbo.sent.filter((s) => s.init?.method === 'POST')).toHaveLength(0);
  });

  it('reports a refusal, another id, a server error or no answer, and still sends the next picture', async () => {
    const pictures = [png(8), png(9), png(10), png(11), png(12)].map((bytes) => ({ sha256: shaOf(bytes), bytes }));
    const turbo = fakeTurbo(async (item, index) => {
      if (index === 0) return Response.json({ id: 'A'.repeat(43) });
      if (index === 1) return new Response('{"error":"no"}', { status: 500 });
      if (index === 2) throw new TypeError('connection reset');
      if (index === 3) return new Response('not json', { status: 200 });
      return accept(item);
    });
    const results = await publishToArweave(pictures, { chainId: 1, fetcher: turbo.fetcher, upload: UPLOAD });
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['refused', 'refused', 'network', 'refused', 'ok']);
  });

  it('tags: Content-Type from the bytes, never from a name; App-Name and lower-case hex', () => {
    const bytes = png(13);
    expect(pictureTags(bytes, shaOf(bytes).toUpperCase().replace('0X', '0x') as `0x${string}`, 31337)).toEqual([
      { name: 'Content-Type', value: 'image/png' }, { name: 'App-Name', value: APP_NAME }, { name: 'SHA-256', value: shaOf(bytes).slice(2) }, { name: 'Box-Chain-Id', value: '31337' },
    ]);
    expect(pictureTags(Uint8Array.from([0xff, 0xd8, 0xff, 0]), '0x00', 1)?.[0]).toEqual({ name: 'Content-Type', value: 'image/jpeg' });
    expect(pictureTags(new TextEncoder().encode('<html>'), '0x00', 1)).toBeNull();
  });
});

describe('the free fit Create shrinks to (fitsFree, freeLimit)', () => {
  it('counts the whole signed item: header, the four tags for this chain and type, then the picture', () => {
    const tags = pictureTags(png(1), shaOf(png(1)), 11155111) ?? [];
    expect(itemBytesFor(1000, 'image/png', 11155111)).toBe(itemSize(1000, tags));
    // Today's figures: a WebP on Sepolia costs 293 bytes of header and tags (as measured live in the spike).
    const overhead = itemBytesFor(0, 'image/webp', 11155111);
    expect(overhead).toBe(293);
    expect(overhead).toBe(HEADER_LENGTH + 143);
    const fits = fitsFree(11155111, 107_520);
    expect(fits(107_520 - overhead, 'image/webp')).toBe(true);
    expect(fits(107_520 - overhead + 1, 'image/webp')).toBe(false);
    // A type that is not a raster picture, nothing, or more than the reader ever reads: never fits.
    expect(fits(1000, 'image/svg+xml')).toBe(false);
    expect(fits(1000, '')).toBe(false);
    expect(fits(0, 'image/png')).toBe(false);
    expect(fitsFree(1, 10 * 1024 * 1024)(MAX_PICTURE_BYTES + 1, 'image/webp')).toBe(false);
    expect(fitsFree(1, 10 * 1024 * 1024)(MAX_PICTURE_BYTES, 'image/webp')).toBe(true);
  });

  it('asks Turbo’s /info once per page load; a failed read falls back to 107,520 and is asked again; nothing is asked before it is needed', async () => {
    expect(knownFreeLimit()).toBe(TURBO_FREE_BYTES);
    const down = vi.fn(async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    expect(await freeLimit(down)).toBe(TURBO_FREE_BYTES);
    const up = vi.fn(async (url: string) => (url === `${TURBO_UPLOAD_ORIGIN}/info` ? Response.json({ freeUploadLimitBytes: 100_000 }) : new Response(null, { status: 404 }))) as unknown as typeof fetch;
    expect(await freeLimit(up)).toBe(100_000);
    expect(await freeLimit(up)).toBe(100_000);
    expect(up).toHaveBeenCalledTimes(1);
    expect(down).toHaveBeenCalledTimes(1);
    expect(knownFreeLimit()).toBe(100_000);
  });
});

describe('SH-WITHHELD-SITE fix round af4: the refuse guard, right before each upload request', () => {
  const two = () => [png(21), png(22)].map((bytes) => ({ sha256: shaOf(bytes), bytes }));
  /** Turbo, a double: `/info` waits for `info`, the first POST's answer for `first`; it accepts every item. */
  function heldTurbo(gates: { readonly info?: Promise<void>; readonly first?: Promise<void> }) {
    const posts: Uint8Array[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${UPLOAD}/info`) { await gates.info; return Response.json({ freeUploadLimitBytes: TURBO_FREE_BYTES }); }
      if (url === `${UPLOAD}/v1/tx` && init?.method === 'POST') {
        const item = new Uint8Array(init.body as Uint8Array);
        posts.push(item);
        if (posts.length === 1) await gates.first;
        return accept(item);
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    return { fetcher, posts };
  }
  const gate = () => { let open: () => void = () => undefined; const held = new Promise<void>((resolve) => { open = resolve; }); return { held, open: () => open() }; };

  it('/info held, then a refusal: nothing is sent, and every picture settles withheld', async () => {
    const info = gate();
    const turbo = heldTurbo({ info: info.held });
    let listed = false;
    const refuse = vi.fn(async () => listed);
    const pending = publishToArweave(two(), { chainId: 1, fetcher: turbo.fetcher, upload: UPLOAD, refuse });
    await vi.waitFor(() => expect(turbo.fetcher).toHaveBeenCalledTimes(1));
    listed = true;
    info.open();
    const results = await pending;
    expect(turbo.posts).toHaveLength(0);
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['withheld', 'withheld']);
    // Asked once, right before the first request; the batch stopped there.
    expect(refuse).toHaveBeenCalledTimes(1);
  });

  it('the first answer held, then a refusal: the first went (it cannot be called back), the unsent one is not sent', async () => {
    const first = gate();
    const turbo = heldTurbo({ first: first.held });
    let listed = false;
    const refuse = vi.fn(async () => listed);
    const pending = publishToArweave(two(), { chainId: 1, fetcher: turbo.fetcher, upload: UPLOAD, refuse });
    await vi.waitFor(() => expect(turbo.posts).toHaveLength(1));
    listed = true;
    first.open();
    const results = await pending;
    expect(turbo.posts).toHaveLength(1);
    expect(results.map((r) => (r.ok ? 'ok' : r.reason))).toEqual(['ok', 'withheld']);
    expect(refuse).toHaveBeenCalledTimes(2);
  });

  it('a guard that never refuses changes nothing: both are sent', async () => {
    const turbo = heldTurbo({});
    const results = await publishToArweave(two(), { chainId: 1, fetcher: turbo.fetcher, upload: UPLOAD, refuse: async () => false });
    expect(turbo.posts).toHaveLength(2);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
  });
});
