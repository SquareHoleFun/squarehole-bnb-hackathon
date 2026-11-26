import { afterEach, expect, it, vi } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { CoreGateway } from '../../src/core/core-gateway';
import { coreGatewaySource } from '../../src/core/core-service';
import { MemoryHistory } from '../../src/history/memory-history';
import { LinksService } from '../../src/links/links-service';
import { MemoryLinks } from '../../src/links/memory-links';
import { PictureCopiesService } from '../../src/pictures/service';
import { MemoryPictureCopies } from '../../src/pictures/store';
import { request, ResponseDouble, SIGNATURE } from '../links/fixture';
import { World, synthBox, synthManifest, ev } from '../core/core-synth';
import { boxLogsV2, serviceBoxV2, serviceChainV2, synthManifestV2 } from '../core/scripted-core-chain';
import { required } from './fixture';

afterEach(() => vi.restoreAllMocks());

async function setup(v2: boolean, persisted = true) {
  const world = new World('feed-cache');
  world.block(10n);
  const box = synthBox({ boxId: 0n, creationBlock: 12n });
  const box2 = serviceBoxV2();
  if (v2) world.block(100n, [boxLogsV2(box2)]);
  else world.block(12n, [world.created(box)]);
  world.to(101n);
  if (!v2) world.block(102n, [[ev.taxedBuy(box, box.record.creator, 19n, 1n, 101n)]]);
  else world.to(102n);
  const chain = v2 ? serviceChainV2(world, [box2]) : world.chain();
  chain.tip = 101n;
  const store = new MemoryHistory();
  const indexer = new CoreChainIndexer({ reader: chain, manifest: v2 ? synthManifestV2() : synthManifest(), auditEvery: 10_000 });
  await indexer.start(); await indexer.idle();
  const links = new LinksService(new MemoryLinks(), indexer.chainId);
  const picturesStore = new MemoryPictureCopies();
  const pictures = new PictureCopiesService(picturesStore, { fetch: async () => { throw new Error('offline'); } });
  let now = 1000;
  const { source, updated } = coreGatewaySource(indexer, chain, persisted ? store : null, 60_000, () => now, { links, pictures });
  updated();
  const gw = new CoreGateway({ source, port: 0, host: '127.0.0.1' });
  const send = async (query = '') => {
    const { req } = request(undefined, { method: 'GET', url: `/${v2 ? 'v2' : 'v1'}/feed${query}` });
    req.headers['if-none-match'] = '*'; // Feeds must still return a current body.
    const res = new ResponseDouble(); await gw.route(req, res.asResponse()); return res;
  };
  return { indexer, store, source, send, chain, links, pictures, picturesStore, box2, updated, time: (n: number) => { now = n; } };
}

it.each([false, true])('CAP-2/4: v2=%s shares 200 builds, invalidates on committed history and head, and keeps asOf current', async v2 => {
  const f = await setup(v2);
  const read = vi.spyOn(f.source, v2 ? 'v2Feed' : 'feed');
  const burst = () => Promise.all(Array.from({ length: 200 }, (_, i) => f.send(i % 2 ? `?chain=${f.source.chainId}` : '')));
  const first = required((await burst())[0]);
  expect(read).toHaveBeenCalledTimes(1);
  expect(first.status).toBe(200);
  expect(first.headers).toMatchObject({ 'cache-control': 'public, max-age=1', 'access-control-allow-origin': '*' });
  expect(first.headers['etag']).toBeUndefined();
  expect(first.json()['asOf']).toEqual(f.source.asOf?.());
  await f.store.writeBlock({ block: required(f.indexer.head()), chainId: f.source.chainId, rows: [], boxes: [] });
  await burst(); expect(read).toHaveBeenCalledTimes(2);
  // Even with no new history generation, applied heads change phases, statistics and nested card envelopes.
  f.chain.tip = 102n; await f.indexer.enqueue(f.chain.header(102n));
  const next = required((await burst())[0]);
  expect(read).toHaveBeenCalledTimes(3);
  expect(next.json()['asOf']).toMatchObject({ block: '102' });
  expect(next.json()['cards']).not.toEqual(first.json()['cards']);
  expect((next.json()['cards'] as { asOf: unknown }[]).every(c => JSON.stringify(c.asOf) === JSON.stringify(next.json()['asOf']))).toBe(true);
  await f.send(); expect(read).toHaveBeenCalledTimes(3);
  expect((await f.send('?chain=999')).status).toBe(404);
  expect(read).toHaveBeenCalledTimes(3);
});

it.each([false, true])('CAP-4: v2=%s attaches the live envelope on a cache hit and refuses a superseded build', async v2 => {
  const f = await setup(v2); const original = v2 ? required(f.source.v2Feed) : f.source.feed;
  const read = vi.spyOn(f.source, v2 ? 'v2Feed' : 'feed');
  await f.send();
  const current = { ...required(f.source.asOf?.()), tier: 'finalized' as const };
  const envelope = vi.spyOn(f.source, 'asOf').mockReturnValue(current);
  const hit = await f.send();
  expect(hit.json()['asOf']).toEqual(current); expect(read).toHaveBeenCalledTimes(1);
  envelope.mockRestore();
  await f.store.writeBlock({ block: required(f.indexer.head()), chainId: f.source.chainId, rows: [], boxes: [] });
  // A repair begins after the projection was captured, before the cache's serialization microtask resumes.
  const entry = required(v2 ? [...f.indexer.boxesV2.values()][0] : [...f.indexer.boxes.values()][0]);
  const superseded = () => { const old = original(); entry.repairing = true; return old; };
  read.mockImplementationOnce(superseded as typeof original);
  const answers = await Promise.all(Array.from({ length: 200 }, () => f.send()));
  for (const answer of answers) expect(answer.json()['cards']).toEqual(expect.arrayContaining([expect.objectContaining({ stale: true })]));
  expect(read).toHaveBeenCalledTimes(3); // original, superseded, exactly one fresh shared build
});

it.each([false, true])('CAP-2: v2=%s marks stalled cards stale and recovers without a head/history change', async v2 => {
  const f = await setup(v2, false); const read = vi.spyOn(f.source, v2 ? 'v2Feed' : 'feed');
  await f.send(); await f.send(); expect(read).toHaveBeenCalledTimes(1);
  f.time(61_001);
  const stale = await f.send(); await f.send();
  expect(stale.json()['cards']).toEqual(expect.arrayContaining([expect.objectContaining({ stale: true })]));
  expect(read).toHaveBeenCalledTimes(2);
  f.updated();
  expect((await f.send()).json()['cards']).toEqual(expect.arrayContaining([expect.objectContaining({ stale: false })]));
  await f.send(); expect(read).toHaveBeenCalledTimes(3);
});

it('CAP-2: v2 links, verified picture copies and audit/repair changes invalidate without history or head changes', async () => {
  const f = await setup(true); const read = vi.spyOn(f.source, 'v2Feed');
  const token = required(f.box2.record.contracts[1]).toLowerCase();
  await f.send();
  await f.links.save({ chainId: f.source.chainId, token, signer: f.box2.record.creator, website: 'https://example.org', x: '', telegram: '',
    issuedAt: '123', signature: SIGNATURE, signerKind: 'eoa', verifiedBlock: '101' });
  expect((await f.send()).json()['cards']).toEqual(expect.arrayContaining([expect.objectContaining({ links: expect.objectContaining({ website: 'https://example.org' }) })]));
  await f.send(); expect(read).toHaveBeenCalledTimes(2);
  const hash = f.box2.spec.coverSha256.slice(2); const id = 'a'.repeat(43);
  await f.picturesStore.put(hash, id);
  await f.pictures.run([f.box2.spec]);
  expect((await f.send()).json()['cards']).toEqual(expect.arrayContaining([expect.objectContaining({ pictureCopies: expect.objectContaining({ logo: { arweaveId: id } }) })]));
  await f.send(); expect(read).toHaveBeenCalledTimes(3);
  const entry = required(f.indexer.boxesV2.get(token)); entry.repairing = true; entry.verified = false;
  expect((await f.send()).json()['cards']).toEqual(expect.arrayContaining([expect.objectContaining({ stale: true, verified: false })]));
  await f.send(); expect(read).toHaveBeenCalledTimes(4);
  entry.repairing = false;
  expect((await f.send()).json()['cards']).toEqual(expect.arrayContaining([expect.objectContaining({ stale: false })]));
  await f.send(); expect(read).toHaveBeenCalledTimes(5);
});
