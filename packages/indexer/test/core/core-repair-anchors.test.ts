/**
 * R5: honest endpoints sharing creation can still omit every event after their fork unless replay is anchored. Since
 * SH-NO-PICTURE-GATE no box is listed late (the late-admission replay is gone); a box's repair replays the same way.
 */
import { labelAddress } from '@squarehole/chain/core/test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import type { BlockAnchor } from '../../src/core/core-reader';
import { MemoryHistory } from '../../src/history/memory-history';
import { HistoryWriter } from '../../src/history/writer';
import { getSqrtPriceAtTick } from '../../src/v4-math';
import { ev, synthBox, synthManifest, World } from './core-synth';
import type { ScriptedCoreChain } from './scripted-core-chain';

const CHAIN = synthManifest().chainId;
const POOL = labelAddress('pool');
const HOLDER = labelAddress('holder');
const cleanup: (() => void)[] = [];

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
  vi.restoreAllMocks();
});

function branches(last: bigint) {
  const canonical = new World();
  const box = synthBox({ boxId: 0n, creationBlock: 12n });
  canonical.block(10n);
  canonical.block(12n, [canonical.created(box, [
    ev.initialize(box, getSqrtPriceAtTick(-30_000), -30_000), ev.mint(box, POOL, 10n ** 27n),
  ])]);
  canonical.to(20n);
  const stale = canonical.fork(20n, 'stale');
  stale.to(last);
  for (const n of [30n, 90n, 150n]) {
    if (n > last) break;
    canonical.block(n, [[
      ev.swap(box, { amount0: -(10n ** 17n), amount1: 10n ** 22n, sqrtPriceX96: getSqrtPriceAtTick(-30_010), tick: -30_010, liquidity: 10n ** 20n }),
      ev.transfer(box, POOL, HOLDER, 10n ** 22n),
    ]]);
  }
  canonical.to(last);
  return { canonical, stale, token: (box.row.contracts.token as string).toLowerCase() };
}

async function start(world: World) {
  const chain = world.chain();
  const store = new MemoryHistory();
  const writer = new HistoryWriter(store);
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifest(), auditEvery: 1_000, onHistory: writer.accept });
  cleanup.push(() => { indexer.stop(); writer.stop(); });
  await indexer.start();
  await writer.flush();
  return { chain, store, writer, indexer };
}

/** Headers remain canonical. Log reads try an honest stale endpoint first, just like RpcCoreReader's fallback. */
function staleFirst(chain: ScriptedCoreChain, stale: ScriptedCoreChain, fallback = true) {
  const canonicalRead = chain.rangeLogs.bind(chain);
  const calls: { from: bigint; to: bigint; anchors: readonly BlockAnchor[] }[] = [];
  const endpoints = { fallback, refused: 0, calls };
  chain.rangeLogs = async (from, to, filter, anchors = []) => {
    calls.push({ from, to, anchors: [...anchors] });
    try {
      return await stale.rangeLogs(from, to, filter, anchors);
    } catch (error) {
      endpoints.refused += 1;
      if (!endpoints.fallback) throw error;
      return canonicalRead(from, to, filter, anchors);
    }
  };
  return endpoints;
}

function expectAnchors(call: { anchors: readonly BlockAnchor[] }, chain: ScriptedCoreChain, head: bigint): void {
  expect(call.anchors).toEqual(expect.arrayContaining([
    { number: head, hash: chain.header(head).hash },
    { number: 12n, hash: chain.header(12n).hash },
  ]));
}

async function expectCanonical(run: Awaited<ReturnType<typeof start>>, world: World, token: string): Promise<void> {
  await run.writer.flush();
  const control = await start(world);
  expect(run.indexer.recent(token)).toEqual(control.indexer.recent(token));
  expect(run.indexer.boxView(token)).toEqual(control.indexer.boxView(token));
  expect(run.indexer.feedView()).toEqual(control.indexer.feedView());
  const got = await run.store.dump(CHAIN);
  const want = await control.store.dump(CHAIN);
  expect(want.trades.length).toBeGreaterThan(0);
  expect(want.transfers.length).toBe(want.trades.length + 1); // creation mint plus each later transfer
  expect(want.balances).toHaveLength(2);
  // Range backfill can omit empty chain_blocks; every application table must match, including ownership and candles.
  expect({ ...got, chainBlocks: want.chainBlocks }).toEqual(want);
}

describe('R5 / BC-094: repair range anchors', () => {
  it('refolds from the canonical endpoint instead of silently erasing post-fork trades', async () => {
    const { canonical, stale, token } = branches(40n);
    const run = await start(canonical);
    const entry = run.indexer.boxes.get(token);
    if (!entry) throw new Error('box missing');
    const endpoints = staleFirst(run.chain, stale.chain());

    await run.indexer.repairBox(entry);
    await expectCanonical(run, canonical, token);
    expect(endpoints.refused).toBe(1);
    expect(endpoints.calls).toHaveLength(1);
    for (const call of endpoints.calls) expectAnchors(call, run.chain, 40n);
  });

  it('refuses repair without an agreeing endpoint, preserves committed state, and can retry', async () => {
    const { canonical, stale, token } = branches(40n);
    const run = await start(canonical);
    const entry = run.indexer.boxes.get(token);
    if (!entry) throw new Error('box missing');
    const states = entry.states;
    const trades = entry.trades;
    const activity = entry.activity;
    const view = run.indexer.boxView(token);
    const history = await run.store.dump(CHAIN);
    const endpoints = staleFirst(run.chain, stale.chain(), false);

    await expect(run.indexer.repairBox(entry)).rejects.toThrow(/not on block 40/);
    expect(entry.states).toBe(states);
    expect(entry.trades).toBe(trades);
    expect(entry.activity).toBe(activity);
    expect(entry.repairing).toBe(false);
    expect(run.indexer.boxView(token)).toEqual(view);
    await run.writer.flush();
    expect(await run.store.dump(CHAIN)).toEqual(history);
    endpoints.fallback = true;
    await run.indexer.repairBox(entry);
    await expectCanonical(run, canonical, token);
  });
});
