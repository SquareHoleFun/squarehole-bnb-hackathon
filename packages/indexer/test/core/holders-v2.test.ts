import { afterEach, describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { CoreGateway } from '../../src/core/core-gateway';
import { coreGatewaySource } from '../../src/core/core-service';
import { request, ResponseDouble } from '../links/fixture';
import { World } from './core-synth';
import { boxLogsV2, eventV2, listingAddedLog, requiredV2, serviceBoxV2, serviceChainV2, serviceListingV2, synthManifestV2, V2 } from './scripted-core-chain';

const zero = '0x0000000000000000000000000000000000000000' as Address;
const alice = getAddress('0xabcdef0000000000000000000000000000000001');
const bob = getAddress('0xabcdef0000000000000000000000000000000002');
const charlie = getAddress('0xabcdef0000000000000000000000000000000003');
const unit = 10n ** 30n;
interface Page {
  schema: string; chainId: number; token: string; asOf: { block: string; hash: string; timestamp: string; tier: string };
  totalSupplyT: string; holderCount: string; holders: { address: string; balanceT: string; role: string | null }[]; next: string | null;
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

async function fixture(extra: readonly Address[] = [], empty = false) {
  const box = serviceBoxV2(); const token = requiredV2(box.record.contracts[1]);
  const world = new World('holders-v2');
  const transfer = (from: Address, to: Address, amount: bigint) => eventV2('token', 'Transfer', token, { from, to, amount });
  const contracts = [...new Set(box.record.contracts.filter(a => a !== zero))];
  world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]);
  world.block(100n, [boxLogsV2(box), ...(empty ? [] : [[
    ...contracts.map(to => transfer(zero, to, 1n)), transfer(zero, V2.poolManager, 2n),
    transfer(zero, bob, unit), transfer(zero, alice, unit), transfer(zero, charlie, unit + 1n),
    transfer(zero, box.record.creator, 10n), transfer(box.record.creator, zero, 10n),
    ...extra.map(to => transfer(zero, to, 1n)),
  ]])]);
  world.to(105n);
  const reader = serviceChainV2(world, [box]);
  const indexer = new CoreChainIndexer({ reader, manifest: synthManifestV2(), auditEvery: 10000 });
  cleanup.push(() => indexer.stop()); await indexer.start();
  const { source } = coreGatewaySource(indexer, reader, null, 60000);
  const gateway = new CoreGateway({ source, host: '127.0.0.1', port: 0 });
  const path = `/v2/boxes/${V2.chainId}/${token}`;
  async function send(suffix = '/holders', method = 'GET', prefix = path) {
    const { req } = request(undefined, { url: prefix + suffix, method }); const res = new ResponseDouble();
    await gateway.route(req, res.asResponse()); return res;
  }
  async function page(query = '') {
    const res = await send(`/holders${query}`); expect(res.status).toBe(200); return res.json() as unknown as Page;
  }
  return { box, token, world, reader, indexer, contracts, transfer, send, page };
}

describe('ACT-2: live v2 holders', () => {
  it('serves exact balances, deterministic order, every named role and the snapshot asOf', async () => {
    const f = await fixture(); const page = await f.page();
    const snapshot = (await f.send('')).json();
    expect(page).toMatchObject({ schema: 'sh.core-holders.v2', chainId: V2.chainId, token: f.token.toLowerCase(),
      asOf: snapshot.asOf, totalSupplyT: snapshot.supply, holderCount: String(f.contracts.length + 4), next: null });
    expect(page.asOf.block).toBe('105'); // empty heads advance asOf, too
    expect(page.holders.slice(0, 4)).toEqual([
      { address: charlie.toLowerCase(), balanceT: String(unit + 1n), role: null },
      { address: alice.toLowerCase(), balanceT: String(unit), role: null },
      { address: bob.toLowerCase(), balanceT: String(unit), role: null },
      { address: V2.poolManager.toLowerCase(), balanceT: '2', role: 'pool' },
    ]);
    const row = requiredV2(f.indexer.boxesV2.get(f.token.toLowerCase())).row;
    for (const [role, address] of Object.entries(row.contracts)) {
      if (address && address !== zero) expect(page.holders.find(h => h.address === address.toLowerCase())?.role).toBe(role);
    }
    expect(page.holders.slice(4).map(h => h.address)).toEqual(f.contracts.map(a => a.toLowerCase()).sort());
    expect(page.holders.some(h => h.address === zero || h.address === f.box.record.creator.toLowerCase())).toBe(false);
    expect(page.holders.reduce((sum, h) => sum + BigInt(h.balanceT), 0n).toString()).toBe(page.totalSupplyT);
    expect((snapshot.statistics as { holderCount: string }).holderCount).toBe(page.holderCount);
  });

  it.each([1, 2, 200])('pages the same snapshot at limit=%s without gaps or repeats, even across tied balances', async limit => {
    const extra = Array.from({ length: 205 }, (_, i) => `0x${(BigInt(i) + 0x100000n).toString(16).padStart(40, '0')}` as Address);
    const f = await fixture(extra); const holders: Page['holders'] = []; let after: string | null = null;
    do {
      const page = await f.page(`?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      expect(page.holders.length).toBeLessThanOrEqual(limit);
      expect(page.asOf).toEqual((await f.send('')).json().asOf);
      holders.push(...page.holders); after = page.next;
      expect(holders.length).toBeLessThanOrEqual(extra.length + f.contracts.length + 4);
    } while (after);
    expect(holders).toHaveLength(extra.length + f.contracts.length + 4);
    expect(new Set(holders.map(h => h.address)).size).toBe(holders.length);
    expect(holders.slice(4).map(h => h.address)).toEqual([...extra, ...f.contracts].map(a => a.toLowerCase()).sort());
  });

  it('empty supply has an empty terminal page', async () => {
    const f = await fixture([], true);
    expect(await f.page()).toMatchObject({ totalSupplyT: '0', holderCount: '0', holders: [], next: null });
  });

  it('shares CORS, no-store and route errors; validates bounded limits and cursors', async () => {
    const f = await fixture(); const res = await f.send(); expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({ 'access-control-allow-origin': '*', 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' });
    for (const query of ['limit=0', 'limit=201', 'limit=-1', 'limit=1.5', 'limit=no', 'after=', 'after=x', `after=${'a'.repeat(1000)}`]) {
      const bad = await f.send(`/holders?${query}`); expect(bad.status).toBe(400); expect(bad.headers['cache-control']).toBe('no-store');
    }
    expect((await f.send('/holders', 'POST')).status).toBe(405);
    expect((await f.send('/holders', 'OPTIONS')).status).toBe(204);
    expect((await f.send('/holders', 'GET', `/v2/boxes/1/${f.token}`)).status).toBe(404);
    expect((await f.send('/holders', 'GET', `/v2/boxes/${V2.chainId}/bad`)).status).toBe(400);
    expect((await f.send('/holders', 'GET', `/v2/boxes/${V2.chainId}/${alice}`)).status).toBe(404);
    expect((await f.send('/holders/extra')).status).toBe(404);
  });

  it('rejects a cursor after a new head, then returns the fresh snapshot balances', async () => {
    const f = await fixture(); const old = await f.page('?limit=1');
    if (old.next === null) throw new Error('fixture needs a next page');
    f.world.block(106n, [[f.transfer(charlie, bob, 1n)]]);
    f.reader.setBranch(f.world.headers.filter(h => h.number === 106n), f.world.logs.filter(l => l.blockNumber === 106n)); await f.indexer.enqueue(f.reader.header(106n));
    const stale = await f.send(`/holders?after=${encodeURIComponent(old.next)}`);
    expect(stale.status).toBe(409); expect(stale.headers['cache-control']).toBe('no-store');
    const current = await f.page('?limit=1');
    expect(current.holders[0]?.address).toBe(bob.toLowerCase());
    expect(current.asOf).toEqual((await f.send('')).json().asOf);
  });

  it('a same-height reorg invalidates the cursor and rolls balances back with the snapshot', async () => {
    const f = await fixture(); const old = await f.page('?limit=1');
    if (old.next === null) throw new Error('fixture needs a next page');
    const fork = f.world.fork(104n, 'holders-fork'); fork.block(105n, [[f.transfer(charlie, bob, 2n)]]);
    f.reader.setBranch(fork.headers.filter(h => h.number === 105n), fork.logs.filter(l => l.blockNumber === 105n)); await f.indexer.enqueue(f.reader.header(105n));
    const res = await f.send(`/holders?after=${encodeURIComponent(old.next)}`); expect(res.status).toBe(409);
    const page = await f.page('?limit=1'); expect(page.asOf.block).toBe(old.asOf.block); expect(page.asOf.hash).not.toBe(old.asOf.hash);
    expect(page.asOf).toEqual((await f.send('')).json().asOf);
    expect(page.holders[0]).toMatchObject({ address: bob.toLowerCase(), balanceT: String(unit + 2n) });
  });
});
