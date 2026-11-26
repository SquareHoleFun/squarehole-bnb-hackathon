import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { SEPOLIA_REHEARSAL } from '../src/config';
import { decodeFrame, type DecodedFrame } from '../src/frame';
import type { BlockHeader } from '../src/model';
import { PoolIndexer, type PipelineOptions } from '../src/pipeline';
import { REHEARSAL_SHAPE } from '../src/shape';
import { MemoryStore } from '../src/store/memory-store';
import { tickAtSqrtPrice } from '../src/v4-math';
import type { BlockEvent, IndexerStatus, LiveSnapshot, ReorgEvent, ResyncEvent, TradersEvent } from '../src/views';
import { fakeHash, fakeHeader, loadRecordedFixture, ScriptedChain } from './scripted-chain';
import { synthSwap, txHash } from './synth';

const T = SEPOLIA_REHEARSAL;
const fixture = loadRecordedFixture();
const LIVE_SQRT = fixture.atEnd.sqrtPriceX96;
const POOL_SWAP_TEST: Address = '0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe';

interface Harness {
  readonly chain: ScriptedChain;
  readonly store: MemoryStore;
  readonly indexer: PoolIndexer;
  readonly frames: string[];
}

type Extra = Partial<Pick<PipelineOptions, 'auditEvery' | 'verifyEvery' | 'senderBudgetMs' | 'senderRetryMs'>>;

async function replayFixture(options: Extra = {}): Promise<Harness> {
  const chain = ScriptedChain.fromFixture(fixture, T);
  const store = new MemoryStore();
  const frames: string[] = [];
  await store.subscribe((m) => frames.push(m));
  const indexer = new PoolIndexer({ reader: chain, store, target: T, confirmations: 2, now: () => 1_000, ...options });
  await indexer.start();
  await indexer.idle();
  return { chain, store, indexer, frames };
}

/** Appends `count` fake blocks on `parent` (branch id `branch`); `trades` maps an offset to a synthetic buy (wei). */
function extend(chain: ScriptedChain, parent: BlockHeader, count: number, branch: number, trades: ReadonlyMap<number, bigint> = new Map(), sqrtStart = LIVE_SQRT): { headers: BlockHeader[]; sqrts: bigint[]; sqrt: bigint } {
  const headers: BlockHeader[] = [];
  const sqrts: bigint[] = [];
  let previous = parent;
  let sqrt = sqrtStart;
  for (let i = 0; i < count; i += 1) {
    const header = fakeHeader(branch, previous.number + 1n, previous.hash, previous.timestamp + 12n);
    const amount = trades.get(i);
    const logs = amount ? synthSwap(T, header, txHash(branch * 1_000 + i), 5, sqrt, true, amount) : null;
    if (logs) sqrt = logs.sqrtAfter;
    chain.addBlock(header, logs?.logs ?? []);
    headers.push(header);
    sqrts.push(sqrt);
    previous = header;
  }
  return { headers, sqrts, sqrt };
}

/** The chain's own slot0, liquidity and supply at each block (what verification reads with eth_call). */
function setTruth(chain: ScriptedChain, branch: { headers: readonly BlockHeader[]; sqrts: readonly bigint[] }): void {
  branch.headers.forEach((header, i) => {
    const sqrt = branch.sqrts[i] ?? LIVE_SQRT;
    chain.slots.set(header.hash, { sqrtPriceX96: sqrt, tick: tickAtSqrtPrice(sqrt), liquidity: REHEARSAL_SHAPE.liquidity });
    chain.supplies.set(header.hash, fixture.atEnd.totalSupply);
  });
}

function lastOf<T>(list: readonly T[]): T {
  const last = list.at(-1);
  if (last === undefined) throw new Error('empty list');
  return last;
}

const decoded = (frames: readonly string[]): DecodedFrame[] => frames.map(decodeFrame);
const blockEvents = (frames: readonly string[]): BlockEvent[] => decoded(frames).filter((f) => f.type === 'block').map((f) => JSON.parse(f.event) as BlockEvent);
const ofType = (frames: readonly string[], type: DecodedFrame['type']): DecodedFrame[] => decoded(frames).filter((f) => f.type === type);

describe('pipeline: replaying the recorded Sepolia rehearsal', () => {
  it('backfills from the deploy block, follows the last 32 blocks one by one, and matches the chain', async () => {
    const { chain, store, indexer, frames } = await replayFixture();
    expect(indexer.metrics.verified).toBe(true); // √P, tick, L and burned equal the chain's at block 11,812,130
    expect(indexer.head()?.number).toBe(fixture.toBlock);
    expect(chain.calls['rangeLogs']).toBe(1);
    // 32 tail blocks by bloom: most need no getLogs at all.
    expect(indexer.metrics.bloomSkips).toBeGreaterThanOrEqual(28);
    const snapshot = JSON.parse((await store.getSnapshot())?.json ?? '{}') as LiveSnapshot;
    expect(snapshot).toMatchObject({
      schema: 'sh.live-pool.v1',
      chainId: 11_155_111,
      poolId: T.poolId,
      head: { number: '11812130', hash: fixture.atEnd.hash },
      state: { retainedWei: '1484999999999999', retainedEth: '0.001484999999999999', soldRaw: '1079104076324374082820149', fillBps: 3, phase: 'CURVE_ACTIVE', burned: '1079104.076324374082820149' },
      window: { openBlock: '11812074', closeBlock: '11812106', status: 'open', nextBlockTaxPips: 0 },
      curve: { tickLower: 177_180, tickUpper: 204_060, targetWei: '4206980085000000000', raiseWei: '4216794836692248391' },
    });
    expect(snapshot.trades).toHaveLength(1);
    expect(snapshot.trades[0]).toMatchObject({ route: 'bootstrap', eth: '0.0015', trader: '0x1f1481667ef20928d55524dfe4640f96bd9b4eee' });
    expect(snapshot.activity.map((a) => a.kind)).toEqual(['window_announced', 'burn']);
    // A cold start is written quietly and announced once: no replay of old blocks to viewers, one resync.
    expect(ofType(frames, 'block')).toHaveLength(0);
    const resyncs = ofType(frames, 'resync');
    expect(resyncs).toHaveLength(1);
    expect((JSON.parse(resyncs[0]?.snapshot ?? '{}') as LiveSnapshot).head.number).toBe('11812130');
    expect((await store.getSnapshot())?.etag).toBe(resyncs[0]?.id);
    const statuses = ofType(frames, 'status').map((f) => JSON.parse(f.event) as IndexerStatus);
    expect(statuses.at(-1)).toMatchObject({ verified: true, catchingUp: false });
    expect(indexer.heartbeatInfo()).toMatchObject({ head: '11812130', publishedHead: '11812130', verified: true, catchingUp: false });
  });

  it('restarts from the store without a backfill', async () => {
    const { store, indexer } = await replayFixture();
    const chain = ScriptedChain.fromFixture(fixture, T);
    const again = new PoolIndexer({ reader: chain, store, target: T, confirmations: 2 });
    await again.start();
    expect(chain.calls['rangeLogs']).toBeUndefined();
    expect(again.latestState()).toEqual(indexer.latestState());
    expect(again.recentTrades()).toEqual(indexer.recentTrades());
    expect(again.metrics.verified).toBe(true);
  });

  it('shows the window countdown and the tax the next block would pay', async () => {
    const chain = ScriptedChain.fromFixture(fixture, T, T.openBlock + 20n); // recorded headers are contiguous from 11,812,060
    const store = new MemoryStore();
    const indexer = new PoolIndexer({ reader: chain, store, target: T, confirmations: 2 });
    await indexer.start();
    const snapshot = JSON.parse((await store.getSnapshot())?.json ?? '{}') as LiveSnapshot;
    expect(snapshot.window).toMatchObject({ status: 'router_window', nextBlock: '11812095', blocksToClose: '11', nextBlockTaxPips: 603_054, nextBlockTaxPercent: '60.3054' });
    expect(indexer.metrics.errors).toBe(0);
  });
});

describe('pipeline: heads, gaps and confirmations', () => {
  it('applies a trade at the head, keeps the confirmed state one block behind, then confirms it', async () => {
    const { chain, indexer, frames } = await replayFixture();
    const { headers } = extend(chain, chain.headerAt(fixture.toBlock), 2, 1, new Map([[0, 10n ** 17n]]));
    const [first, second] = headers as [BlockHeader, BlockHeader];
    indexer.onHead(first, 'ws', 5_000);
    await indexer.idle();
    let event = lastOf(blockEvents(frames));
    expect(event.trades).toHaveLength(1);
    expect(event.state.swapCount).toBe(2);
    expect(event.confirmed?.swapCount).toBe(1); // the head block is 1 deep, not yet confirmed (2)
    expect(event.head).toMatchObject({ source: 'ws', seenAtMs: 5_000 });
    expect(event.timing.rpcCalls).toBe(2); // no bloom on a fake header: both getLogs
    indexer.onHead(second, 'ws', 6_000);
    await indexer.idle();
    event = lastOf(blockEvents(frames));
    expect(event.trades).toHaveLength(0);
    expect(event.confirmed).toBeNull(); // null = same as state
    expect(event.state.swapCount).toBe(2);
  });

  it('ignores duplicates and older heads, and fills a gap by number', async () => {
    const { chain, indexer } = await replayFixture();
    const { headers } = extend(chain, chain.headerAt(fixture.toBlock), 6, 1, new Map([[2, 10n ** 16n]]));
    indexer.onHead(headers[0] as BlockHeader, 'ws', 1);
    await indexer.idle();
    indexer.onHead(headers[0] as BlockHeader, 'poll', 2);
    await indexer.idle();
    expect(indexer.metrics.duplicates).toBe(1);
    indexer.onHead(lastOf(headers), 'ws', 3);
    await indexer.idle();
    expect(indexer.head()?.hash).toBe(lastOf(headers).hash);
    expect(indexer.metrics.gapsFilled).toBeGreaterThanOrEqual(1);
    expect(indexer.latestState().swapCount).toBe(2);
    indexer.onHead(headers[3] as BlockHeader, 'poll', 4);
    await indexer.idle();
    expect(indexer.metrics.duplicates).toBe(2);
    const older = fakeHeader(7, (headers[2] as BlockHeader).number, fakeHash(7, 1n), 0n);
    indexer.onHead(older, 'poll', 5);
    await indexer.idle();
    expect(indexer.metrics.ignoredOld).toBe(1);
  });
});

describe('pipeline: reorgs', () => {
  it('rolls back a replaced block with a trade and applies the new branch (depth 1)', async () => {
    const { chain, store, indexer, frames } = await replayFixture();
    const base = chain.headerAt(fixture.toBlock);
    const a = extend(chain, base, 2, 1, new Map([[1, 10n ** 17n]]));
    for (const header of a.headers) indexer.onHead(header, 'ws', 0);
    await indexer.idle();
    expect(indexer.latestState().swapCount).toBe(2);
    const droppedId = indexer.recentTrades().at(-1)?.id;
    // Branch 2 replaces the second block: no trade there, a different trade in the block after.
    const parent = a.headers[0] as BlockHeader;
    const b = extend(chain, parent, 2, 2, new Map([[1, 3n * 10n ** 16n]]));
    chain.reorgTo(b.headers.map((header) => ({ header, logs: chain.logs.get(header.hash) ?? [] })));
    indexer.onHead(lastOf(b.headers), 'ws', 0);
    await indexer.idle();
    expect(indexer.metrics.reorgs).toBe(1);
    expect(indexer.metrics.maxReorgDepth).toBe(1);
    expect(indexer.head()?.hash).toBe(lastOf(b.headers).hash);
    expect(indexer.latestState().swapCount).toBe(2);
    expect(indexer.latestState().sqrtPriceX96).toBe(b.sqrt);
    expect(indexer.recentTrades().map((t) => t.id)).not.toContain(droppedId);
    const stored = (await store.loadRecent({ trades: 50, activity: 50 })).trades.map((j) => (JSON.parse(j) as { id: string }).id);
    expect(stored).not.toContain(droppedId);
    expect(stored).toHaveLength(2);
    const reorg = ofType(frames, 'reorg')[0];
    const payload = JSON.parse(reorg?.event ?? '{}') as ReorgEvent;
    expect(payload).toMatchObject({ depth: 1, toBlock: parent.number.toString(), droppedTradeIds: [droppedId] });
    expect(payload.state.swapCount).toBe(1);
    // The reorg event moves the head back to the ancestor, with its window and confirmed state.
    expect(payload.head).toMatchObject({ number: parent.number.toString(), hash: parent.hash });
    expect(payload.window.nextBlock).toBe((parent.number + 1n).toString());
    expect(payload.finality.confirmedBlock).toBe((parent.number - 1n).toString()); // 2 confirmations: the ancestor's parent
    expect(payload).toHaveProperty('confirmed');
    // Afterwards the new branch's blocks follow as ordinary block events.
    const types = decoded(frames).map((f) => f.type);
    expect(types.slice(types.indexOf('reorg')).filter((t) => t !== 'status')).toEqual(['reorg', 'block', 'block']);
    // Every frame id is unique and the sequence rises by exactly one per frame: resume and gap detection rely on it.
    const all = decoded(frames);
    expect(new Set(all.map((f) => f.id)).size).toBe(all.length);
    for (let i = 1; i < all.length; i += 1) expect(all[i]?.seq).toBe((all[i - 1]?.seq ?? 0) + 1);
  });

  it('switches to a sibling at the same height and back', async () => {
    const { chain, indexer } = await replayFixture();
    const base = chain.headerAt(fixture.toBlock);
    const a = extend(chain, base, 1, 1, new Map([[0, 10n ** 17n]]));
    indexer.onHead(a.headers[0] as BlockHeader, 'ws', 0);
    await indexer.idle();
    const sibling = extend(chain, base, 1, 2);
    indexer.onHead(sibling.headers[0] as BlockHeader, 'poll', 0);
    await indexer.idle();
    expect(indexer.head()?.hash).toBe(sibling.headers[0]?.hash);
    expect(indexer.latestState().swapCount).toBe(1);
    // The first branch wins after all: its next block arrives, the walk-back finds block N again.
    const next = extend(chain, a.headers[0] as BlockHeader, 1, 1, new Map(), a.sqrt);
    indexer.onHead(next.headers[0] as BlockHeader, 'ws', 0);
    await indexer.idle();
    expect(indexer.metrics.reorgs).toBe(2);
    expect(indexer.latestState().swapCount).toBe(2);
  });

  it('handles a depth-3 reorg onto a longer branch', async () => {
    const { chain, indexer } = await replayFixture();
    const base = chain.headerAt(fixture.toBlock);
    const a = extend(chain, base, 5, 1, new Map([[2, 10n ** 17n], [4, 10n ** 16n]]));
    for (const header of a.headers) indexer.onHead(header, 'ws', 0);
    await indexer.idle();
    expect(indexer.latestState().swapCount).toBe(3);
    const b = extend(chain, a.headers[1] as BlockHeader, 5, 3, new Map([[0, 2n * 10n ** 17n]]));
    chain.reorgTo(b.headers.map((header) => ({ header, logs: chain.logs.get(header.hash) ?? [] })));
    indexer.onHead(lastOf(b.headers), 'ws', 0);
    await indexer.idle();
    expect(indexer.metrics.maxReorgDepth).toBe(3);
    expect(indexer.latestState().swapCount).toBe(2);
    expect(indexer.latestState().sqrtPriceX96).toBe(b.sqrt);
    expect(indexer.head()?.number).toBe(lastOf(b.headers).number);
  });

  it('rebuilds from the deploy block when the fork point is below the contiguous tail of held blocks, without replaying old blocks to viewers', async () => {
    const { chain, indexer, frames } = await replayFixture();
    const before = frames.length;
    const preRebuildHead = indexer.head()?.number ?? 0n;
    // After a cold start the indexer holds the last 32 blocks one by one (11,812,099 …) and only the log blocks
    // below them: a fork at 11,812,070 is below that contiguous tail.
    const forkParent = chain.headerAt(11_812_070n);
    const b = extend(chain, forkParent, 90, 4, new Map([[85, 10n ** 17n]]));
    chain.reorgTo(b.headers.map((header) => ({ header, logs: chain.logs.get(header.hash) ?? [] })));
    indexer.onHead(lastOf(b.headers), 'ws', 0);
    await indexer.idle();
    expect(indexer.metrics.rebuilds).toBe(1);
    expect(indexer.head()?.hash).toBe(lastOf(b.headers).hash);
    expect(indexer.latestState().swapCount).toBe(2);
    expect(indexer.latestState().sqrtPriceX96).toBe(b.sqrt);
    const after = frames.slice(before);
    // No block frame at or below the pre-rebuild head (viewers never see the curve jump back to launch state) …
    expect(blockEvents(after).every((e) => BigInt(e.head.number) > preRebuildHead)).toBe(true);
    expect(blockEvents(after)).toHaveLength(0);
    // … and exactly one resync carrying the new head's snapshot.
    const resyncs = ofType(after, 'resync');
    expect(resyncs).toHaveLength(1);
    expect((JSON.parse(resyncs[0]?.event ?? '{}') as ResyncEvent).reason).toBe('rebuild');
    expect((JSON.parse(resyncs[0]?.snapshot ?? '{}') as LiveSnapshot).head.hash).toBe(lastOf(b.headers).hash);
    const statuses = ofType(after, 'status').map((f) => JSON.parse(f.event) as IndexerStatus);
    expect(statuses[0]?.catchingUp).toBe(true);
    expect(statuses.at(-1)?.catchingUp).toBe(false);
  });
});

describe('pipeline: audit (additive: a log seen by hash in a canonical block is never taken away)', () => {
  it('a log a lagging backend did not return is found by the range re-read and applied', async () => {
    const { chain, indexer, frames } = await replayFixture({ auditEvery: 4 });
    const base = chain.headerAt(fixture.toBlock);
    const a = extend(chain, base, 48, 5, new Map([[3, 10n ** 17n]]));
    chain.hiddenFromBlockLogs.add(a.headers[3]?.hash as Hex);
    const before = frames.length;
    for (const header of a.headers) indexer.onHead(header, 'ws', 0);
    await indexer.idle();
    expect(indexer.metrics.auditMismatches).toBe(1);
    expect(indexer.latestState().swapCount).toBe(2);
    expect(indexer.latestState().sqrtPriceX96).toBe(a.sqrt);
    expect(indexer.head()?.hash).toBe(lastOf(a.headers).hash);
    // Re-applied quietly and announced with one resync (not a reorg: nothing on the chain was replaced).
    expect(ofType(frames.slice(before), 'reorg')).toHaveLength(0);
    expect(ofType(frames.slice(before), 'resync').map((f) => (JSON.parse(f.event) as ResyncEvent).reason)).toEqual(['audit']);
  });

  it('a range answer that lacks a log applied by hash removes nothing (the High finding)', async () => {
    const { chain, indexer, frames } = await replayFixture({ auditEvery: 4 });
    const base = chain.headerAt(fixture.toBlock);
    const a = extend(chain, base, 48, 6, new Map([[3, 10n ** 17n], [20, 10n ** 16n]]));
    chain.hiddenFromRange.add(a.headers[3]?.hash as Hex); // the backend answering the range dropped block 3's logs
    const before = frames.length;
    for (const header of a.headers) indexer.onHead(header, 'ws', 0);
    await indexer.idle();
    expect(indexer.metrics.audits).toBeGreaterThanOrEqual(5);
    expect(indexer.metrics.auditRangeBehind).toBeGreaterThanOrEqual(1);
    expect(indexer.metrics.auditMismatches).toBe(0);
    expect(indexer.latestState().swapCount).toBe(3);
    expect(indexer.latestState().sqrtPriceX96).toBe(a.sqrt);
    expect(indexer.recentTrades()).toHaveLength(3);
    const after = ofType(frames.slice(before), 'reorg').length + ofType(frames.slice(before), 'resync').length;
    expect(after).toBe(0);
  });

  it('a range answer carrying a log of another fork, at a height whose block is still canonical, changes nothing', async () => {
    const { chain, indexer } = await replayFixture({ auditEvery: 4 });
    const base = chain.headerAt(fixture.toBlock);
    const a = extend(chain, base, 48, 7, new Map([[30, 10n ** 16n]]));
    const orphan = fakeHeader(70, (a.headers[5] as BlockHeader).number, fakeHash(70, 0n), 0n);
    chain.rangeExtra.set(orphan.number, synthSwap(T, orphan, txHash(7_777), 2, LIVE_SQRT, true, 10n ** 17n).logs);
    for (const header of a.headers) indexer.onHead(header, 'ws', 0);
    await indexer.idle();
    expect(indexer.metrics.auditRangeBehind).toBeGreaterThanOrEqual(1);
    expect(indexer.metrics.auditMismatches).toBe(0);
    expect(indexer.metrics.reorgs).toBe(0);
    expect(indexer.latestState().swapCount).toBe(2);
    expect(indexer.latestState().sqrtPriceX96).toBe(a.sqrt);
  });

  it('a block that really was replaced (its hash changed by number) is followed as a reorg', async () => {
    const { chain, indexer, frames } = await replayFixture({ auditEvery: 1_000 });
    const base = chain.headerAt(fixture.toBlock);
    const a = extend(chain, base, 20, 8, new Map([[5, 10n ** 17n]]));
    for (const header of a.headers) indexer.onHead(header, 'ws', 0);
    await indexer.idle();
    // The chain replaced blocks 5 … 19 behind the indexer's back (no head of the new branch arrived yet).
    const b = extend(chain, a.headers[4] as BlockHeader, 15, 9, new Map([[0, 2n * 10n ** 17n]]));
    chain.reorgTo(b.headers.map((header) => ({ header, logs: chain.logs.get(header.hash) ?? [] })));
    await indexer.audit();
    await indexer.idle();
    expect(indexer.metrics.auditMismatches).toBe(1);
    expect(indexer.head()?.hash).toBe(lastOf(b.headers).hash);
    expect(indexer.latestState().sqrtPriceX96).toBe(b.sqrt);
    expect(indexer.latestState().swapCount).toBe(2);
    expect(ofType(frames, 'reorg')).toHaveLength(1);
  });

  it('restart, then audit: the applied log indexes come back from the store, so nothing is re-applied (Medium finding)', async () => {
    const { chain, store, indexer } = await replayFixture();
    const base = chain.headerAt(fixture.toBlock);
    const a = extend(chain, base, 30, 11, new Map([[11, 10n ** 17n]])); // a trade 19 blocks below the new head
    for (const header of a.headers) indexer.onHead(header, 'ws', 0);
    await indexer.idle();
    indexer.stop();
    const frames: string[] = [];
    await store.subscribe((m) => frames.push(m));
    const again = new PoolIndexer({ reader: chain, store, target: T, confirmations: 2, auditEvery: 1, now: () => 2_000 });
    await again.start();
    const more = extend(chain, lastOf(a.headers), 2, 11, new Map(), a.sqrt);
    for (const header of more.headers) again.onHead(header, 'ws', 0);
    await again.idle();
    expect(again.metrics.audits).toBeGreaterThanOrEqual(1);
    expect(again.metrics.auditMismatches).toBe(0);
    expect(again.metrics.auditRangeBehind).toBe(0);
    expect(ofType(frames, 'reorg')).toHaveLength(0);
    expect(ofType(frames, 'resync')).toHaveLength(0);
    expect(again.latestState().swapCount).toBe(2);
    // The frame sequence continues where the previous process stopped.
    const all = decoded(frames);
    expect(all.length).toBeGreaterThan(0);
    for (let i = 1; i < all.length; i += 1) expect(all[i]?.seq).toBe((all[i - 1]?.seq ?? 0) + 1);
  });
});

describe('pipeline: verification against the chain while running', () => {
  it('drift that the audit did not catch is found by the chain check and repaired from the last verified block', async () => {
    const { chain, indexer, frames } = await replayFixture({ auditEvery: 1_000, verifyEvery: 4 });
    const base = chain.headerAt(fixture.toBlock);
    const a = extend(chain, base, 8, 12, new Map([[1, 10n ** 17n]]));
    setTruth(chain, a);
    // Both the per-block read and the range read lag for the trade block; only the two-endpoint by-hash read sees it.
    chain.hiddenFromBlockLogs.add(a.headers[1]?.hash as Hex);
    chain.hiddenFromRange.add(a.headers[1]?.hash as Hex);
    const before = frames.length;
    for (const header of a.headers) indexer.onHead(header, 'ws', 0);
    await indexer.idle();
    expect(indexer.metrics.verifyFailures).toBeGreaterThanOrEqual(1);
    expect(indexer.metrics.repairs).toBe(1);
    expect(indexer.metrics.rebuilds).toBe(0);
    expect(indexer.metrics.verified).toBe(true);
    expect(indexer.latestState().swapCount).toBe(2);
    expect(indexer.latestState().sqrtPriceX96).toBe(a.sqrt);
    const after = frames.slice(before);
    const statuses = ofType(after, 'status').map((f) => (JSON.parse(f.event) as IndexerStatus).verified);
    expect(statuses[0]).toBe(false); // viewers are told at once …
    expect(statuses.at(-1)).toBe(true); // … and again once it is right
    expect(ofType(after, 'resync').map((f) => (JSON.parse(f.event) as ResyncEvent).reason)).toEqual(['verification']);
    expect(indexer.heartbeatInfo().verified).toBe(true);
  });

  it('checks the state just before each trade block, where a missed swap still shows (a later swap would hide it)', async () => {
    const { chain, indexer } = await replayFixture({ auditEvery: 1_000, verifyEvery: 1_000 });
    const base = chain.headerAt(fixture.toBlock);
    const a = extend(chain, base, 4, 13, new Map([[1, 10n ** 17n], [3, 10n ** 16n]]));
    setTruth(chain, a);
    chain.hiddenFromBlockLogs.add(a.headers[1]?.hash as Hex);
    chain.hiddenFromRange.add(a.headers[1]?.hash as Hex);
    for (const header of a.headers) indexer.onHead(header, 'ws', 0);
    await indexer.idle();
    expect(indexer.metrics.verifyFailures).toBeGreaterThanOrEqual(1);
    expect(indexer.metrics.repairs).toBe(1);
    expect(indexer.latestState().swapCount).toBe(3); // the counters are right again, not only the price
    expect(indexer.metrics.verified).toBe(true);
  });
});

describe('pipeline: traders', () => {
  function tradeBlock(chain: ScriptedChain, parent: BlockHeader, withRouterBuy: boolean, others: number): { header: BlockHeader; buyer: Address; senders: Address[] } {
    const header = fakeHeader(20, parent.number + 1n, parent.hash, parent.timestamp + 12n);
    const buyer: Address = '0x000000000000000000000000000000000000b0b1';
    const logs = [];
    let sqrt = LIVE_SQRT;
    let logIndex = 1;
    if (withRouterBuy) {
      const s = synthSwap(T, header, txHash(900), logIndex, sqrt, true, 10n ** 16n, { tax: 10n ** 15n, buyer });
      logs.push(...s.logs);
      sqrt = s.sqrtAfter;
      logIndex += 10;
      chain.senders.set(txHash(900), '0x0000000000000000000000000000000000e1a700'); // a relayer: not the trader
    }
    const senders: Address[] = [];
    for (let i = 0; i < others; i += 1) {
      const s = synthSwap(T, header, txHash(901 + i), logIndex, sqrt, true, 10n ** 16n, { sender: POOL_SWAP_TEST });
      logs.push(...s.logs);
      sqrt = s.sqrtAfter;
      logIndex += 10;
      const from = `0x${(0xc0c0 + i).toString(16).padStart(40, '0')}` as Address;
      chain.senders.set(txHash(901 + i), from);
      senders.push(from);
    }
    chain.addBlock(header, logs);
    return { header, buyer, senders };
  }

  it('a router buy names TaxedBuy.buyer with no lookup; other swaps in a block share one block read', async () => {
    const { chain, indexer } = await replayFixture();
    const callsBefore = { tx: chain.calls['txSender'] ?? 0, block: chain.calls['blockSenders'] ?? 0 };
    const { header, buyer, senders } = tradeBlock(chain, chain.headerAt(fixture.toBlock), true, 3);
    indexer.onHead(header, 'ws', 0);
    await indexer.idle();
    expect(indexer.recentTrades().slice(-4).map((t) => t.trader)).toEqual([buyer, ...senders].map((a) => a.toLowerCase()));
    expect((chain.calls['blockSenders'] ?? 0) - callsBefore.block).toBe(1);
    expect((chain.calls['txSender'] ?? 0) - callsBefore.tx).toBe(0);
    expect(indexer.metrics.senderBlockCalls).toBe(1);
  });

  it('a slow sender lookup does not hold the block back; the trader follows in a traders frame', async () => {
    const { chain, store, indexer, frames } = await replayFixture({ senderBudgetMs: 20 });
    chain.senderDelayMs = 150;
    const { header, senders } = tradeBlock(chain, chain.headerAt(fixture.toBlock), false, 1);
    indexer.onHead(header, 'ws', 0);
    await indexer.idle();
    const block = lastOf(blockEvents(frames));
    expect(block.head.number).toBe(header.number.toString());
    expect(block.trades[0]?.trader).toBeNull();
    const traders = ofType(frames, 'traders');
    expect(traders).toHaveLength(1);
    const event = JSON.parse(traders[0]?.event ?? '{}') as TradersEvent;
    expect(event).toMatchObject({ block: header.number.toString(), blockHash: header.hash, traders: [{ trader: senders[0]?.toLowerCase() }] });
    expect(indexer.recentTrades().at(-1)?.trader).toBe(senders[0]?.toLowerCase());
    const stored = (await store.loadRecent({ trades: 5, activity: 5 })).trades.map((j) => JSON.parse(j) as { trader: string | null });
    expect(stored.at(-1)?.trader).toBe(senders[0]?.toLowerCase());
    const snapshot = JSON.parse((await store.getSnapshot())?.json ?? '{}') as LiveSnapshot;
    expect(snapshot.trades[0]?.trader).toBe(senders[0]?.toLowerCase());
    expect((await store.getSnapshot())?.etag).toBe(traders[0]?.id); // a changed snapshot gets a new ETag
  });

  it('a failed lookup is retried, not stored as "no trader" for good', async () => {
    const { chain, indexer, frames } = await replayFixture({ senderBudgetMs: 200, senderRetryMs: [10, 10] });
    chain.senderFailures = 2; // rate-limited twice, then it answers
    const { header, senders } = tradeBlock(chain, chain.headerAt(fixture.toBlock), false, 2);
    indexer.onHead(header, 'ws', 0);
    await indexer.idle();
    expect(lastOf(blockEvents(frames)).trades.map((t) => t.trader)).toEqual([null, null]);
    expect(indexer.recentTrades().slice(-2).map((t) => t.trader)).toEqual(senders.map((a) => a.toLowerCase()));
    expect(indexer.metrics.senderFailures).toBe(2);
    expect(ofType(frames, 'traders')).toHaveLength(1);
  });
});
