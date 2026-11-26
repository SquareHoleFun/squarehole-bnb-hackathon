import { mkdirSync, mkdtempSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { rawCidV1 } from '@squarehole/artwork';
import { createWithheldPictures } from '../../../indexer/src/withheld/list.mjs';
import { nodeCardAssets } from '../engine';
import { sha256Of } from '../share-art';
import { loadCoreBox, loadCoreItem } from '../share-read';
import { blankPng } from '../test-support';
import { DiskCards } from './cache';
import { CardService } from './card-service';
vi.mock('../share-read', () => ({ loadCoreBox: vi.fn(), loadCoreItem: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const TOKEN = `0x${'12'.repeat(20)}` as const;
const URL = `/card/box/11155111/${TOKEN}.png?v=2-open`;
const TX = 'A'.repeat(43);
const generic = new Uint8Array([1, 2, 3]);
async function setup(ipfs = true) {
  mkdirSync('.cache/tmp', { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp/withheld-cards-'));
  const file = join(dir, 'pictures.json'); let now = 0;
  const png = blankPng(4, 4); const hash = await sha256Of(png);
  const box = { chainId: 11155111, token: TOKEN, chainLabel: 'Sepolia', name: 'Box', ticker: 'BOX', demo: false, state: { kind: 'open' as const }, logoSha256: hash };
  vi.mocked(loadCoreBox).mockResolvedValue({ status: 'box', box, via: 'indexer' });
  const fetchArt = vi.fn(async (url: string) => url.endsWith('/graphql')
    ? Response.json({ data: { transactions: { edges: [{ node: { id: TX } }] } } }) : new Response(png));
  const engine = { satori: vi.fn(async () => '<svg/>'), png: () => blankPng(1200, 630) };
  const disk = new DiskCards(join(dir, 'cards')); const get = vi.spyOn(disk, 'get'); const put = vi.spyOn(disk, 'put');
  const list = createWithheldPictures({ file, now: () => now });
  const make = (itemPngs?: Readonly<Record<string, `0x${string}`>>) => new CardService({
    config: () => ({ sepoliaManifest: null, localManifest: null, sepoliaRpcUrls: [], localRpcUrl: null, indexerOrigin: null }),
    readers: { fetch: vi.fn(), direct: null, indexerTimeoutMs: 1000 },
    engine, assets: nodeCardAssets(), generic, gateways: ipfs ? ['https://fixture.invalid'] : [], fetchArt,
    disk, engineKind: 'test', now: () => now, withheld: list, itemPngs,
  });
  const replace = (ids: string[]) => {
    writeFileSync(join(dir, 'pending'), JSON.stringify(ids.map(id => ({ id, reason: 'illegal', since: '2026-10-28' }))));
    renameSync(join(dir, 'pending'), file); now += 10_000;
  };
  return { cards: make(), make, hash, cid: rawCidV1(hash), fetchArt, engine, get, put, replace, box };
}
it.each([true, false])('W3: a listed %s/IPFS or Arweave picture uses the brand mark without fetching it', async (ipfs) => {
  const f = await setup(ipfs); f.replace([ipfs ? `ipfs:${f.cid}` : `ar:${TX}`]);
  const answer = await f.cards.handle('GET', URL);
  expect(answer.body).not.toEqual(generic); expect(answer.headers['cache-control']).toBe('no-store');
  expect(answer.headers['x-sh-card']).toContain('logo=missing');
  expect(f.engine.satori).toHaveBeenCalledOnce(); expect(f.put).not.toHaveBeenCalled();
  expect(f.fetchArt.mock.calls.every(([url]) => url.endsWith('/graphql'))).toBe(true);
  const head = await f.cards.handle('HEAD', URL); expect(head.body).toBeNull(); expect(head.headers['cache-control']).toBe('no-store');
});
it.each([true, false])('W3: listing overrides memory and disk cards (%s/IPFS), removal restores service', async (ipfs) => {
  const f = await setup(ipfs);
  expect((await f.cards.handle('GET', URL)).body).not.toEqual(generic);
  await vi.waitFor(() => expect(f.put).toHaveResolved());
  f.replace([ipfs ? `ipfs:${f.cid}` : `ar:${TX}`]);
  expect((await f.cards.handle('GET', URL)).headers['x-sh-card']).toContain('logo=missing');
  expect((await f.make().handle('GET', URL)).headers['x-sh-card']).toContain('logo=missing');
  f.replace([]); expect((await f.make().handle('GET', URL)).body).not.toEqual(generic);
});
it('W3: a list change during rendering cannot send the old picture', async () => {
  const f = await setup();
  f.engine.satori.mockImplementationOnce(async () => { f.replace([`ipfs:${f.cid}`]); return '<svg/>'; });
  expect((await f.cards.handle('GET', URL)).body).toEqual(generic);
});
it('W3: an item is withheld by its original picture or mapped PNG, before either is fetched', async () => {
  const f = await setup(); const original = `0x${'34'.repeat(32)}` as const;
  vi.mocked(loadCoreItem).mockResolvedValue({ box: f.box, item: { revealed: true, art: { image: { sha256: original } } } } as Awaited<ReturnType<typeof loadCoreItem>>);
  const service = f.make({ [original]: f.hash });
  for (const id of [`ipfs:${rawCidV1(original)}`, `ipfs:${f.cid}`]) {
    f.replace([id]); const answer = await service.handle('GET', `/card/item/11155111/${TOKEN}/1.png`);
    expect(answer.body).toEqual(generic); expect(answer.headers['cache-control']).toBe('no-store');
  }
  expect(f.fetchArt).not.toHaveBeenCalled();
});
