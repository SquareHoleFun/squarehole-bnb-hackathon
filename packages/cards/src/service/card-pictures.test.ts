/** SH-191-cards: square-slot selection, provenance and deadlines. Every read and fetch is local and injected. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PICTURE_CASES, pictureFixture } from '../../../artwork/src/picture-fixtures';
import { rawCidV1 } from '@squarehole/artwork';
import { verifiedBoxPicture } from '@squarehole/artwork/box-picture';
import { chooseSlotPicture } from '@squarehole/artwork/picture-choice';
import { nodeCardAssets } from '../engine';
import { testCardEngine as nodeCardEngine } from '../webp-test-support';
import { sha256Of } from '../share-art';
import { CARD_DESIGN, cardVersion, type ShareBox } from '../share-model';
import { loadCoreBox } from '../share-read';
import { base64, renderCardPng, type CardNode, type CardEngine } from '../share-render';
import { blankPng } from '../test-support';
import type { DiskCards } from './cache';
import { CARD_SECONDS, CardService, cardName, NO_LOGO_SECONDS } from './card-service';

vi.mock('../share-read', () => ({ loadCoreBox: vi.fn() }));
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network forbidden'); })));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const TOKEN = `0x${'19'.repeat(20)}` as const;
const URL = `/card/box/11155111/${TOKEN}.png?v=2-open`;
const LOGO = blankPng(1200, 630);
const COVER = blankPng(400, 1200);
const ASSETS = nodeCardAssets();
const uri = (bytes: Uint8Array) => `data:image/png;base64,${base64(bytes)}`;
const samePng = (actual: Uint8Array | null, expected: Uint8Array): boolean => actual !== null && Buffer.from(actual).equals(Buffer.from(expected));

async function setup({ logo = true, cover = true, blocked = [], engine }: { logo?: boolean; cover?: boolean; blocked?: ('logo' | 'cover')[]; engine?: CardEngine } = {}) {
  const logoHash = await sha256Of(LOGO);
  const coverHash = await sha256Of(COVER);
  let box: ShareBox = { chainId: 11155111, token: TOKEN, chainLabel: 'Sepolia', name: 'Pictures', ticker: 'PIC', demo: false,
    state: { kind: 'open' }, logoSha256: logo ? logoHash : null, collectionCoverSha256: cover ? coverHash : null };
  vi.mocked(loadCoreBox).mockImplementation(async () => ({ status: 'box', box, via: 'indexer' }));
  const ids = blocked.map((role) => `ipfs:${rawCidV1(role === 'logo' ? logoHash : coverHash)}`);
  const hashes = [...ids];
  const withheld = { has: (id: string) => ids.includes(id), snapshot: () => ({ version: 1 as const, hashes }) };
  const art = new Map<string, Uint8Array>([[rawCidV1(logoHash), LOGO], [rawCidV1(coverHash), COVER]]);
  const fetchArt = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    const bytes = art.get(url.split('/ipfs/')[1] ?? '');
    return bytes ? new Response(bytes.slice()) : new Response(null, { status: 404 });
  });
  const satori = vi.fn(async (tree: CardNode, options: Parameters<CardEngine['satori']>[1]) => engine ? engine.satori(tree, options) : JSON.stringify(tree));
  const png = vi.fn((svg: string) => engine ? engine.png(svg) : new TextEncoder().encode(svg));
  const stored = new Map<string, Uint8Array>();
  const disk = { get: vi.fn(async (name: string) => stored.get(name) ?? null), put: vi.fn(async (name: string, bytes: Uint8Array) => { stored.set(name, bytes); }) };
  let now = 0;
  const make = () => new CardService({
    config: () => ({ sepoliaManifest: null, localManifest: null, sepoliaRpcUrls: [], localRpcUrl: null, indexerOrigin: null }),
    readers: { fetch: vi.fn(), direct: null, indexerTimeoutMs: 1000 }, engine: { ...engine, satori, png, ...(engine?.pictureDecodes ? { pictureDecodes: engine.pictureDecodes } : {}) }, assets: ASSETS,
    generic: new Uint8Array([1]), gateways: ['https://pictures.invalid'], fetchArt,
    disk: disk as unknown as DiskCards, engineKind: 'test', withheld, now: () => now,
  });
  return { cards: make(), make, fetchArt, satori, png, disk, stored, art, logoHash, coverHash, box,
    changeBox: (next: Partial<ShareBox>) => { box = { ...box, ...next }; }, advance: (ms: number) => { now += ms; } };
}

describe('SH-191 square picture selection', () => {
  it('logo present: verified logo wins over a different verified cover', async () => {
    const f = await setup();
    const answer = await f.cards.handle('GET', URL);
    expect(JSON.stringify(f.satori.mock.calls)).toContain(uri(LOGO));
    expect(JSON.stringify(f.satori.mock.calls)).not.toContain(uri(COVER));
    expect(answer.headers['cache-control']).toBe(`public, max-age=${CARD_SECONDS}, immutable`);
    expect(f.disk.put.mock.calls[0]?.[0]).toBe(cardName(f.box, f.logoHash));
  });

  it.each(['absent', 'missing', 'wrong'] as const)('logo %s: the verified cover is drawn', async (why) => {
    const f = await setup({ logo: why !== 'absent' });
    if (why === 'missing') f.art.delete(rawCidV1(f.logoHash));
    if (why === 'wrong') f.art.set(rawCidV1(f.logoHash), COVER);
    const answer = await f.cards.handle('GET', URL);
    expect(JSON.stringify(f.satori.mock.calls)).toContain(uri(COVER));
    expect(JSON.stringify(f.satori.mock.calls)).not.toContain(uri(LOGO));
    expect(answer.headers['cache-control']).toBe(why === 'absent' ? `public, max-age=${CARD_SECONDS}, immutable` : `public, max-age=${NO_LOGO_SECONDS}`);
    expect(f.disk.put).toHaveBeenCalledTimes(why === 'absent' ? 1 : 0);
  });

  it.each(['absent', 'missing', 'wrong'] as const)('both %s: the brand mark is drawn', async (why) => {
    const f = await setup({ logo: why !== 'absent', cover: why !== 'absent' });
    if (why === 'missing') f.art.clear();
    if (why === 'wrong') { f.art.set(rawCidV1(f.logoHash), COVER); f.art.set(rawCidV1(f.coverHash), LOGO); }
    const answer = await f.cards.handle('GET', URL);
    expect(JSON.stringify(f.satori.mock.calls)).not.toContain('data:image/png');
    expect(answer.headers['x-sh-card']).toContain(why === 'absent' ? 'logo=none' : 'logo=missing');
  });

  it.each(PICTURE_CASES.filter((f) => f.outcome === 'page-picture-card-brand'))('usable $name logo stops at brand even with a different usable cover', async ({ bytes }) => {
    const engine = await nodeCardEngine('native');
    const f = await setup({ engine });
    const hash = await sha256Of(bytes);
    f.changeBox({ logoSha256: hash });
    f.art.set(rawCidV1(hash), bytes);
    for (const cards of [f.cards, f.cards, f.make()]) {
      const answer = await cards.handle('GET', URL);
      expect(answer.status).toBe(200);
      expect(samePng(answer.body, await renderCardPng(f.box, null, ASSETS, engine))).toBe(true);
      expect(answer.headers['cache-control']).toBe(`public, max-age=${NO_LOGO_SECONDS}`);
    }
    expect(JSON.stringify(f.satori.mock.calls)).not.toContain(uri(COVER));
    expect(JSON.stringify(f.satori.mock.calls)).not.toContain('data:image/webp');
    expect(f.disk.put).not.toHaveBeenCalled();
  });

  it.each(['absent', 'missing', 'drawable', 'withheld'] as const)('WebP cover with %s logo follows square priority', async (state) => {
    const engine = await nodeCardEngine('native');
    const f = await setup({ logo: state !== 'absent', blocked: state === 'withheld' ? ['logo'] : [], engine });
    if (state === 'missing') f.art.delete(rawCidV1(f.logoHash));
    const bytes = pictureFixture('lossless.webp'), hash = await sha256Of(bytes);
    f.changeBox({ collectionCoverSha256: hash });
    f.art.set(rawCidV1(hash), bytes);
    const answer = await f.cards.handle('GET', URL);
    expect(samePng(answer.body, await renderCardPng(f.box, state === 'drawable' ? { bytes: LOGO, type: 'image/png' } : state === 'withheld' ? null : { bytes, type: 'image/webp' }, ASSETS, engine))).toBe(true);
    expect(JSON.stringify(f.satori.mock.calls)).not.toContain('data:image/webp');
    expect(f.disk.put).toHaveBeenCalledTimes(state === 'drawable' || state === 'absent' ? 1 : 0);
  });

  it('failed WebP conversion stops at brand with a usable cover present', async () => {
    const native = await nodeCardEngine('native');
    const engine = { ...native, decodeWebp: async () => null };
    const f = await setup({ engine });
    const bytes = pictureFixture('lossless.webp'), hash = await sha256Of(bytes);
    f.changeBox({ logoSha256: hash });
    f.art.set(rawCidV1(hash), bytes);
    const answer = await f.cards.handle('GET', URL);
    expect(samePng(answer.body, await renderCardPng(f.box, null, ASSETS, engine))).toBe(true);
    expect(JSON.stringify(f.satori.mock.calls)).not.toContain(uri(COVER));
    expect(f.disk.put).not.toHaveBeenCalled();
    expect(answer.headers['cache-control']).toBe(`public, max-age=${NO_LOGO_SECONDS}`);
  });

  it('logo withheld with cover allowed: no logo fetch, brand card matches the neutral page slot', async () => {
    const f = await setup({ blocked: ['logo'] });
    const answer = await f.cards.handle('GET', URL);
    expect(f.fetchArt.mock.calls.map(([url]) => url)).toEqual([`https://pictures.invalid/ipfs/${rawCidV1(f.coverHash)}`]);
    expect(JSON.stringify(f.satori.mock.calls)).not.toContain(uri(COVER));
    expect(JSON.stringify(f.satori.mock.calls)).not.toContain(uri(LOGO));
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(f.disk.put).not.toHaveBeenCalled();
  });

  it.each([true, false])('cover withheld, logo available %s: never fetch or draw the cover', async (available) => {
    const f = await setup({ blocked: ['cover'] });
    if (!available) f.art.delete(rawCidV1(f.logoHash));
    await f.cards.handle('GET', URL);
    expect(f.fetchArt.mock.calls.some(([url]) => url.includes(rawCidV1(f.coverHash)))).toBe(false);
    expect(JSON.stringify(f.satori.mock.calls)).not.toContain(uri(COVER));
    expect(JSON.stringify(f.satori.mock.calls).includes(uri(LOGO))).toBe(available);
  });

  it('a withheld Arweave logo copy stops the square slot, including the allowed cover', async () => {
    const f = await setup();
    const tx = 'a'.repeat(43);
    // The production list checks the discovered copy ID before any GET for it.
    const policy = ['ar:' + tx];
    const cards = new CardService({ config: () => ({ sepoliaManifest: null, localManifest: null, sepoliaRpcUrls: [], localRpcUrl: null, indexerOrigin: null }),
      readers: { fetch: vi.fn(), direct: null, indexerTimeoutMs: 1000 }, engine: { satori: f.satori, png: f.png }, assets: ASSETS,
      generic: new Uint8Array([1]), gateways: ['https://pictures.invalid'], disk: null, engineKind: 'test',
      withheld: { has: (id) => policy.includes(id), snapshot: () => ({ version: 1, hashes: policy }) }, fetchArt: f.fetchArt });
    f.fetchArt.mockImplementation(async (url) => url.endsWith('/graphql')
      ? Response.json({ data: { transactions: { edges: [{ node: { id: tx } }] } } })
      : url.includes(rawCidV1(f.coverHash)) ? new Response(COVER) : new Response(null, { status: 404 }));
    await cards.handle('GET', URL);
    expect(f.fetchArt.mock.calls.some(([url]) => url.endsWith('/' + tx))).toBe(false);
    expect(JSON.stringify(f.satori.mock.calls)).not.toContain(uri(COVER));
  });

  it.each(['decode', 'satori', 'png'] as const)('a %s renderer failure stops at brand and never tries the usable cover', async (stage) => {
    const f = await setup(stage === 'decode' ? { engine: {
      satori: async (tree) => JSON.stringify(tree), png: (svg) => new TextEncoder().encode(svg),
      pictureDecodes: (picture) => base64(picture.bytes) !== base64(LOGO),
    } } : {});
    if (stage === 'satori') f.satori.mockImplementation(async (tree) => {
      const data = JSON.stringify(tree);
      if (data.includes(uri(LOGO))) throw new Error('cannot decode logo');
      return data;
    });
    if (stage === 'png') f.png.mockImplementation((svg) => {
      if (svg.includes(uri(LOGO))) throw new Error('cannot render logo');
      return new TextEncoder().encode(svg);
    });
    const answer = await f.cards.handle('GET', URL);
    expect(new TextDecoder().decode(answer.body ?? undefined)).not.toContain('data:image/png');
    expect(JSON.stringify(f.satori.mock.calls)).not.toContain(uri(COVER));
    expect(answer.headers['cache-control']).toBe(`public, max-age=${NO_LOGO_SECONDS}`);
    expect(f.disk.put).not.toHaveBeenCalled();
  });

  it.each(['native', 'wasm'] as const)('%s: ordinary CMYK JPEG is selected but renders brand, never the drawable cover', async (kind) => {
    const engine = await nodeCardEngine(kind);
    expect(engine.kind).toBe(kind);
    const f = await setup({ engine });
    const bytes = pictureFixture('ordinary-cmyk.jpg'), hash = await sha256Of(bytes);
    f.changeBox({ logoSha256: hash });
    f.art.set(rawCidV1(hash), bytes);
    expect(verifiedBoxPicture(bytes, hash)).not.toBeNull();
    expect(engine.pictureDecodes?.({ bytes, type: 'image/jpeg' })).toBe(false);
    expect(engine.pictureDecodes?.({ bytes: COVER, type: 'image/png' })).toBe(true);
    const answer = await f.cards.handle('GET', URL);
    expect(samePng(answer.body, await renderCardPng(f.box, null, ASSETS, engine))).toBe(true);
    expect(samePng(answer.body, await renderCardPng(f.box, { bytes: COVER, type: 'image/png' }, ASSETS, engine, false))).toBe(false);
    expect(JSON.stringify(f.satori.mock.calls)).not.toContain(uri(COVER));
    expect(f.disk.put).not.toHaveBeenCalled();
  });

  it.each(PICTURE_CASES)('page/card parity through the real service: $name', async ({ bytes, accepted, name, outcome }) => {
    const engine = await nodeCardEngine('native');
    const f = await setup({ engine });
    const hash = await sha256Of(bytes), picture = verifiedBoxPicture(bytes, hash);
    f.changeBox({ logoSha256: hash });
    f.art.set(rawCidV1(hash), bytes);
    expect(picture !== null).toBe(accepted);
    const page = chooseSlotPicture('square', { state: picture ? 'shown' : 'missing', url: picture ? hash : null },
      { state: 'shown', url: f.coverHash });
    expect(page).toEqual({ kind: 'picture', which: accepted ? 'logo' : 'cover', url: accepted ? hash : f.coverHash });
    const selected = picture ?? { bytes: COVER, type: 'image/png' as const };
    const answer = await f.cards.handle('GET', URL);
    const expected = outcome === 'page-picture-card-brand' ? null : outcome === 'same-picture' && name.endsWith('.webp')
      ? { bytes: new Uint8Array(readFileSync(new globalThis.URL(`../webp-fixtures/${name.replace('.webp', '.png')}`, import.meta.url))), type: 'image/png' as const }
      : selected;
    expect(samePng(answer.body, await renderCardPng(f.box, expected, ASSETS, engine, false))).toBe(true);
    if (accepted) expect(JSON.stringify(f.satori.mock.calls)).not.toContain(uri(COVER));
    expect(answer.headers['x-sh-card']).toContain(expected ? 'logo=yes' : 'logo=missing');
  });

  it('a missing logo recovers after one hour, even while the cover card remains in memory', async () => {
    const f = await setup();
    f.art.delete(rawCidV1(f.logoHash));
    await f.cards.handle('GET', URL);
    f.art.set(rawCidV1(f.logoHash), LOGO);
    f.advance(NO_LOGO_SECONDS * 1000);
    await f.cards.handle('GET', URL);
    expect(JSON.stringify(f.satori.mock.calls.at(-1))).toContain(uri(LOGO));
  });
});

describe('SH-191 cache identity and artwork budget', () => {
  it('one hash in both roles is fetched once', async () => {
    const f = await setup();
    f.changeBox({ collectionCoverSha256: f.logoHash });
    await f.cards.handle('GET', URL);
    expect(f.fetchArt).toHaveBeenCalledOnce();
  });

  it('two unsuccessful pictures have at most 758 fetches in total', async () => {
    const f = await setup();
    vi.useFakeTimers();
    const pages = new Map<string, number>();
    let id = 0;
    f.fetchArt.mockImplementation(async (url, init) => {
      if (!url.endsWith('/graphql')) return new Response(null, { status: 404 });
      const key = String(init?.body).match(/[a-f0-9]{64}/)?.[0] ?? '';
      const page = (pages.get(key) ?? 0) + 1;
      pages.set(key, page);
      return Response.json({ data: { transactions: { pageInfo: { hasNextPage: true },
        edges: Array.from({ length: 8 }, () => ({ cursor: `page-${page}`, node: { id: String(++id).padStart(43, 'a') } })),
      } } });
    });
    const cards = new CardService({ config: () => ({ sepoliaManifest: null, localManifest: null, sepoliaRpcUrls: [], localRpcUrl: null, indexerOrigin: null }),
      readers: { fetch: vi.fn(), direct: null, indexerTimeoutMs: 1000 }, engine: { satori: f.satori, png: f.png }, assets: ASSETS,
      generic: new Uint8Array([1]), gateways: ['https://one.invalid', 'https://two.invalid', 'https://three.invalid', 'https://four.invalid'],
      fetchArt: f.fetchArt, disk: null, engineKind: 'test' });
    expect((await cards.handle('GET', URL)).headers['x-sh-card']).toContain('logo=missing');
    expect(f.fetchArt).toHaveBeenCalledTimes(758);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cache key changes only with the chosen commitment, design/state and withholding policy', async () => {
    const f = await setup();
    const logo = cardName(f.box, f.logoHash);
    const cover = cardName(f.box, f.coverHash);
    expect(logo).not.toBe(cover);
    expect(cardName({ ...f.box, collectionCoverSha256: null }, f.logoHash)).toBe(logo);
    expect(cardName({ ...f.box, logoSha256: null }, f.coverHash)).toBe(cover);
    expect(cardName(f.box, null)).toBe(cardName({ ...f.box, logoSha256: null, collectionCoverSha256: null }, null));
    expect(cardName(f.box, f.logoHash, ['notice'])).not.toBe(logo);
    expect(cardName({ ...f.box, state: { kind: 'graduated' } }, f.logoHash)).not.toBe(logo);
    expect(CARD_DESIGN).toBe('2');
    expect(cardVersion(f.box.state)).toBe('2-open');
    expect((await f.cards.handle('GET', URL.replace('2-open', '1-open'))).headers['cache-control']).toBe('no-store');
  });

  it('disk reuse ignores an unused cover commitment but follows a chosen cover commitment', async () => {
    const f = await setup();
    await f.cards.handle('GET', URL);
    f.changeBox({ collectionCoverSha256: null });
    expect((await f.make().handle('GET', URL)).headers['x-sh-card']).toContain('card=disk');
    expect(f.satori).toHaveBeenCalledOnce();
    f.changeBox({ logoSha256: null, collectionCoverSha256: f.coverHash });
    await f.make().handle('GET', URL);
    expect(f.disk.put.mock.calls.map(([name]) => name)).toEqual([cardName(f.box, f.logoHash), cardName(f.box, f.coverHash)]);
  });

  it('a hanging second picture cannot delay a verified logo and is aborted', async () => {
    const f = await setup();
    let signal: AbortSignal | null = null;
    f.fetchArt.mockImplementation(async (url, init) => {
      if (url.includes(rawCidV1(f.logoHash))) return new Response(LOGO);
      signal = init?.signal ?? null;
      return new Promise<Response>(() => undefined);
    });
    const answer = await f.cards.handle('GET', URL);
    expect(answer.headers['x-sh-card']).toContain('logo=yes');
    expect(signal).toHaveProperty('aborted', true);
  });

  it('two stalled pictures share 12 seconds; no extra fetch survives the deadline', async () => {
    const f = await setup();
    vi.useFakeTimers();
    const signals: (AbortSignal | null | undefined)[] = [];
    f.fetchArt.mockImplementation((_url, init) => { signals.push(init?.signal); return new Promise<Response>(() => undefined); });
    // Three IPFS gateways consume 9 s; Arweave receives the last 3 s, for both candidates together.
    const cards = new CardService({ config: () => ({ sepoliaManifest: null, localManifest: null, sepoliaRpcUrls: [], localRpcUrl: null, indexerOrigin: null }),
      readers: { fetch: vi.fn(), direct: null, indexerTimeoutMs: 1000 }, engine: { satori: f.satori, png: f.png }, assets: ASSETS,
      generic: new Uint8Array([1]), gateways: ['https://one.invalid', 'https://two.invalid', 'https://three.invalid'],
      fetchArt: f.fetchArt, disk: null, engineKind: 'test' });
    let settled = false;
    const pending = cards.handle('GET', URL).then((answer) => { settled = true; return answer; });
    await vi.advanceTimersByTimeAsync(11_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).headers['x-sh-card']).toContain('logo=missing');
    expect(f.fetchArt).toHaveBeenCalledTimes(12);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
