/** Card cache policy with fake reads/fetch only; the art source must not change it. */
import { afterEach, expect, it, vi } from 'vitest';
import { shLimit } from '../../../../vitest.timeouts.mjs';
import { nodeCardAssets, nodeCardEngine } from '../engine';
import { sha256Of } from '../share-art';
import type { ShareBox } from '../share-model';
import { loadCoreBox } from '../share-read';
import { base64, type CardEngine, type CardNode } from '../share-render';
import { blankPng } from '../test-support';
import type { DiskCards } from './cache';
import { CARD_SECONDS, CardService, NO_LOGO_SECONDS } from './card-service';

vi.mock('../share-read', () => ({ loadCoreBox: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

const PNG = blankPng(4, 4);
const TX = 'a'.repeat(43);
const TOKEN = `0x${'12'.repeat(20)}` as const;
const URL = `/card/box/11155111/${TOKEN}.png?v=2-open`;
const ASSETS = nodeCardAssets();

async function setup(artAvailable = true, realEngine?: CardEngine) {
  let now = 0;
  let available = artAvailable;
  const box: ShareBox = { chainId: 11155111, token: TOKEN, chainLabel: 'Sepolia', name: 'A box', ticker: 'BOX', demo: false, state: { kind: 'open' }, logoSha256: await sha256Of(PNG) };
  vi.mocked(loadCoreBox).mockImplementation(async () => ({ status: 'box', box, via: 'indexer' }));
  const fetchArt = vi.fn(async (url: string) => {
    if (url.endsWith('/graphql')) return Response.json({ data: { transactions: { edges: [{ node: { id: TX } }] } } });
    return available ? new Response(PNG) : new Response(null, { status: 404 });
  });
  const satori = vi.fn(async (tree: CardNode) => JSON.stringify(tree));
  const engine = realEngine ?? { satori, png: () => blankPng(1200, 630) };
  const stored = new Map<string, Uint8Array>();
  const disk = { get: vi.fn(async (key: string) => stored.get(key) ?? null), put: vi.fn(async (key: string, bytes: Uint8Array) => { stored.set(key, bytes); }) };
  const make = () => new CardService({
    config: () => ({ sepoliaManifest: null, localManifest: null, sepoliaRpcUrls: [], localRpcUrl: null, indexerOrigin: null }),
    readers: { fetch: vi.fn(), direct: null, indexerTimeoutMs: 1000 },
    engine, assets: ASSETS, generic: new Uint8Array([1]), gateways: [], fetchArt,
    disk: disk as unknown as DiskCards, engineKind: 'test', now: () => now,
  });
  return { cards: make(), make, fetchArt, disk, satori, advance: (ms: number) => { now += ms; }, publish: () => { available = true; } };
}

it('ARW-CACHE: a verified logo is drawn once, with the same immutable version, HEAD and disk reuse', async () => {
  const test = await setup();
  const answers = await Promise.all(Array.from({ length: 12 }, () => test.cards.handle('GET', URL)));
  expect(answers.every((answer) => answer.headers['x-sh-card']?.includes('logo=yes'))).toBe(true);
  expect(answers[0]?.headers['cache-control']).toBe(`public, max-age=${CARD_SECONDS}, immutable`);
  expect(test.fetchArt).toHaveBeenCalledTimes(2);
  expect(test.satori).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(test.satori.mock.calls[0])).toContain(`data:image/png;base64,${base64(PNG)}`);
  expect(test.disk.put).toHaveBeenCalledTimes(1);
  expect(test.disk.put.mock.calls[0]?.[1]).toEqual(answers[0]?.body);
  expect(test.disk.put.mock.calls[0]?.[1]).not.toEqual(PNG);
  const head = await test.cards.handle('HEAD', URL);
  expect(head.body).toBeNull();
  expect(head.headers['x-sh-card']).toContain('card=memory');
  const otherVersion = await test.cards.handle('GET', URL.replace('2-open', 'anything'));
  expect(otherVersion.headers['cache-control']).toBe('no-store');
  expect(otherVersion.body).toEqual(answers[0]?.body);
  const restarted = await test.make().handle('GET', URL);
  expect(restarted.headers['x-sh-card']).toContain('card=disk');
  expect(test.fetchArt).toHaveBeenCalledTimes(2);
  expect(test.satori).toHaveBeenCalledTimes(1);
});

it('ARW-CACHE: misses use the brand mark for an hour, stay off disk and retry on expiry', async () => {
  const test = await setup(false);
  const missing = await test.cards.handle('GET', URL);
  expect(missing.headers['x-sh-card']).toContain('logo=missing');
  expect(missing.headers['cache-control']).toBe(`public, max-age=${NO_LOGO_SECONDS}`);
  expect(test.disk.put).not.toHaveBeenCalled();
  expect(JSON.stringify(test.satori.mock.calls[0])).not.toContain('data:image/png');
  const fetches = test.fetchArt.mock.calls.length;
  expect(fetches).toBeGreaterThan(0);
  test.publish();
  test.advance(NO_LOGO_SECONDS * 1000 - 1);
  expect((await test.cards.handle('GET', URL)).headers['x-sh-card']).toContain('card=memory');
  expect(test.fetchArt).toHaveBeenCalledTimes(fetches);
  test.advance(1);
  expect((await test.cards.handle('GET', URL)).headers['x-sh-card']).toContain('logo=yes; card=drawn');
  expect(test.fetchArt).toHaveBeenCalledTimes(fetches + 2);
  expect(test.disk.put).toHaveBeenCalledTimes(1);
});

it('ARW-RENDER: Arweave bytes actually draw in the 1200 x 630 card', async () => {
  const engine = await nodeCardEngine('wasm');
  const test = await setup(true, engine);
  const answer = await test.cards.handle('GET', URL);
  expect(answer.headers['x-sh-card']).toContain('logo=yes');
  const png = answer.body ?? new Uint8Array();
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
  const pixels = engine.rgba(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630"><image width="1200" height="630" xlink:href="data:image/png;base64,${base64(png)}"/></svg>`).pixels;
  const center = (315 * 1200 + 900) * 4;
  expect([...pixels.slice(center, center + 4)]).toEqual([0, 0, 0, 255]); // committed black logo, not violet brand mark
}, shLimit(60_000));

it('ARW-CACHE: requests that time out still draw the brand mark with the existing retry policy', async () => {
  const test = await setup();
  test.fetchArt.mockImplementation(() => new Promise<Response>(() => undefined));
  vi.useFakeTimers();
  const pending = test.cards.handle('GET', URL);
  await vi.advanceTimersByTimeAsync(3000);
  const answer = await pending;
  expect(answer.headers['x-sh-card']).toContain('logo=missing; card=drawn');
  expect(answer.headers['cache-control']).toBe(`public, max-age=${NO_LOGO_SECONDS}`);
  expect(test.disk.put).not.toHaveBeenCalled();
  expect(test.fetchArt).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
