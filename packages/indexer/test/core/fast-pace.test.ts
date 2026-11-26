/**
 * SH-259: the catch-up pace at sub-second blocks (BNB Chain testnet, 0.45 s a block). The fast pace must give the same
 * boxes, money and history as the 12-second pace, keep a reorg near the head a rollback, and keep up with the chain.
 *
 * The pace measurement runs in virtual time: every reader call waits for the next "round" (one RPC round trip), all
 * calls waiting in the same round answer together (as parallel requests do), and the chain grows by one block every
 * ROUNDS_PER_BLOCK rounds. Measured from the build machine on 25 November (hackathon/evidence/SH-259-chain97-probe.log):
 * a request to publicnode answers in about 100 to 190 ms, a block takes 450.6 ms; three rounds per block is a round trip
 * of 150 ms. A range read with anchors costs three rounds: RpcCoreReader asks every anchor together before the read
 * and again after it (core-reader.ts `agrees`).
 */
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { CoreChainIndexer, PACE_12S, PACE_FAST, paceForBlockTime, type CorePace } from '../../src/core/chain-indexer';
import { loadCoreConfig } from '../../src/core/core-config';
import type { BlockAnchor, CoreReader, LogFilter } from '../../src/core/core-reader';
import { MemoryHistory } from '../../src/history/memory-history';
import { HistoryWriter } from '../../src/history/writer';
import { World } from './core-synth';
import { boxLogsV2, listingAddedLog, receiverEventV2, requiredV2, serviceBoxV2, serviceChainV2, serviceListingV2, synthManifestV2, V2, type ScriptedCoreChain } from './scripted-core-chain';

const box = serviceBoxV2();
const token = requiredV2(box.record.contracts[1]).toLowerCase();

/** A listing at 10, the box at 100, then a payout event every seven blocks up to `last`. */
function busyWorld(last: bigint, branch = 'pace'): World {
  const world = new World(branch);
  world.block(10n, [listingAddedLog(serviceListingV2())]);
  world.block(100n, [boxLogsV2(box)]);
  for (let n = 107n; n <= last; n += 7n) world.block(n, [receiverEventV2(box, n % 2n === 0n ? 'FitPaid' : 'PlatformPaid', { amount: n })]);
  world.to(last);
  return world;
}

async function follow(chain: CoreReader, pace: CorePace, history?: HistoryWriter) {
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 100_000, pace, ...(history ? { onHistory: history.accept } : {}) });
  await indexer.start();
  await indexer.idle();
  return indexer;
}

/** Heads arrive a few blocks apart, as polling or a head feed delivers them at 0.45 s blocks. */
async function stepTo(indexer: CoreChainIndexer, chain: ScriptedCoreChain, last: bigint, steps: readonly bigint[]) {
  for (let i = 0; chain.tip < last; i += 1) {
    const next = chain.tip + (steps[i % steps.length] ?? 1n);
    chain.tip = next < last ? next : last;
    await indexer.enqueue(chain.header(chain.tip));
    await indexer.idle();
  }
}

describe('SH-259: the pace for the chain\'s block time', () => {
  it('chooses the fast pace under two seconds a block, and the 12-second pace otherwise', () => {
    expect(paceForBlockTime(450)).toBe(PACE_FAST);
    expect(paceForBlockTime(12_000)).toBe(PACE_12S);
    expect(paceForBlockTime(2_000)).toBe(PACE_12S);
    expect(() => paceForBlockTime(0)).toThrow(/block time/);
    expect(PACE_12S).toEqual({ shortGap: 64n, rangeTail: 32n, linkedTail: 0n, auditRanges: false, rangeMoneyEveryBlock: true, lagBlocks: 3n, headerReads: 1 });
    expect(PACE_FAST.headerReads).toBe(4);
    // The gateway's freshness: 3 blocks at 12 s as before; at 0.45 s about 15 s, above the measured lag (at most 16 blocks).
    expect(PACE_FAST.lagBlocks * 450n).toBeGreaterThanOrEqual(15_000n - 450n);
    expect(PACE_FAST.lagBlocks).toBeGreaterThan(16n);
  });

  it('reads the block time from SH_CORE_BLOCK_MS (default 12 s)', () => {
    const env = { SH_CORE_MANIFEST: 'fixture.json', SH_CORE_HTTP_URLS: 'http://rpc.example' };
    const read = () => JSON.stringify(synthManifestV2());
    expect(loadCoreConfig(env, read).pace).toBe(PACE_12S);
    expect(loadCoreConfig({ ...env, SH_CORE_BLOCK_MS: '450' }, read).pace).toBe(PACE_FAST);
    expect(() => loadCoreConfig({ ...env, SH_CORE_BLOCK_MS: '50' }, read)).toThrow();
  });

  it('refuses a linked tail longer than the reorg window', () => {
    expect(() => new CoreChainIndexer({ reader: serviceChainV2(busyWorld(120n), [box]), manifest: synthManifestV2(), windowBlocks: 8, pace: PACE_FAST })).toThrow(/pace/);
  });
});

describe('SH-259: the fast pace gives what the 12-second pace gives', () => {
  for (const steps of [[1n], [2n, 3n], [3n, 5n, 9n], [40n, 1n, 70n]]) {
    it(`heads ${steps.join(', ')} blocks apart: the same feed, box, money and history`, async () => {
      const last = 400n;
      const chain = serviceChainV2(busyWorld(last), [box]);
      chain.tip = 90n;
      const memory = new MemoryHistory();
      const writer = new HistoryWriter(memory);
      const fast = await follow(chain, PACE_FAST, writer);
      await stepTo(fast, chain, last, steps);
      await writer.flush();
      const truthMemory = new MemoryHistory();
      const truthWriter = new HistoryWriter(truthMemory);
      const truth = await follow(serviceChainV2(busyWorld(last), [box]), PACE_12S, truthWriter);
      await truthWriter.flush();
      expect(fast.metrics.errors).toBe(0);
      expect(fast.metrics.rebuilds).toBe(0);
      expect(fast.head()?.number).toBe(last);
      expect(fast.v2FeedView()).toEqual(truth.v2FeedView());
      expect(fast.v2BoxView(token)).toEqual(truth.v2BoxView(token));
      expect(fast.recent(token)).toEqual(truth.recent(token));
      const want = await truthMemory.dump(V2.chainId);
      // Which empty blocks are written differs by pace (a range writes the blocks with logs and its end); the rows do not.
      expect({ ...await memory.dump(V2.chainId), chainBlocks: want.chainBlocks }).toEqual(want);
    });
  }

  it('holds the newest blocks of every range linked by parent hash', async () => {
    const chain = serviceChainV2(busyWorld(300n), [box]);
    chain.tip = 280n;
    const fast = await follow(chain, PACE_FAST);
    chain.tip = 290n;
    await fast.enqueue(chain.header(290n));
    await fast.idle();
    for (let n = 281n; n <= 290n; n += 1n) expect(fast.hashAt(n)).toBe(chain.header(n).hash);
    // At the 12-second pace a range holds only its blocks with logs and its end.
    const slowChain = serviceChainV2(busyWorld(300n), [box]);
    slowChain.tip = 290n;
    const slow = await follow(slowChain, PACE_12S);
    expect(slow.hashAt(257n)).toBeUndefined();
  });
});

describe('SH-259: a reorg near the head at the fast pace', () => {
  async function reorged(pace: CorePace, forkAt: bigint, newTip: bigint) {
    const last = 300n;
    const old = busyWorld(last, 'old');
    const chain = serviceChainV2(old, [box]);
    chain.tip = 90n;
    const indexer = await follow(chain, pace);
    await stepTo(indexer, chain, last, [3n, 4n]);
    const canonical = old.fork(forkAt, 'new');
    canonical.block(forkAt + 1n, [receiverEventV2(box, 'FitPaid', { amount: 999n })]);
    canonical.to(newTip);
    chain.setBranch(canonical.headers.filter((h) => h.number > forkAt), canonical.logs.filter((l) => l.blockNumber > forkAt));
    await indexer.enqueue(chain.header(chain.tip));
    await indexer.idle();
    const truth = await follow(serviceChainV2(canonical, [box]), PACE_12S);
    return { indexer, truth };
  }

  for (const [forkAt, newTip] of [[299n, 301n], [297n, 301n], [290n, 302n]] as const) {
    it(`a fork below ${forkAt + 1n} seen at ${newTip} rolls back, no rebuild`, async () => {
      const { indexer, truth } = await reorged(PACE_FAST, forkAt, newTip);
      expect(indexer.metrics.errors).toBe(0);
      expect(indexer.metrics.reorgs).toBe(1);
      expect(indexer.metrics.rebuilds).toBe(0);
      expect(indexer.v2BoxView(token)).toEqual(truth.v2BoxView(token));
      expect(indexer.recent(token)).toEqual(truth.recent(token));
    });
  }

  it('without the linked tail the same one-block reorg is a rebuild (why the fast pace links)', async () => {
    const { indexer, truth } = await reorged({ ...PACE_FAST, linkedTail: 0n }, 300n - 2n, 300n + 1n);
    expect(indexer.metrics.rebuilds).toBe(1);
    expect(indexer.v2BoxView(token)).toEqual(truth.v2BoxView(token));
  });
});

// ------------------------------------------------------------------------------------------------ virtual-time pace

const ROUNDS_PER_BLOCK = 3;
const ROUND_MS = 150;
const CHAIN_BLOCKS_PER_SECOND = 1000 / (ROUNDS_PER_BLOCK * ROUND_MS);

class Rounds {
  enabled = false;
  /** HTTP requests: views at one block hash in one round are one Multicall3 request, as RpcCoreReader sends them. */
  calls = 0;
  private batched = new Set<string>();
  private waiting: (() => void)[] = [];
  wait(rounds = 1, batch?: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (batch === undefined) this.calls += 1;
    else if (!this.batched.has(batch)) { this.batched.add(batch); this.calls += 1; }
    let chain = Promise.resolve();
    for (let i = 0; i < rounds; i += 1) chain = chain.then(() => new Promise<void>((resolve) => this.waiting.push(resolve)));
    return chain;
  }
  /** One round trip: everything waiting answers. */
  release(): void {
    this.batched.clear();
    const now = this.waiting.splice(0);
    for (const resolve of now) resolve();
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function timed(chain: ScriptedCoreChain, rounds: Rounds): CoreReader {
  return {
    chainId: () => chain.chainId(),
    latestHeader: async () => { await rounds.wait(); return chain.latestHeader(); },
    headerByNumber: async (n: bigint) => { await rounds.wait(); return chain.headerByNumber(n); },
    headerByHash: async (hash: Hex) => { await rounds.wait(); return chain.headerByHash(hash); },
    logsByHash: async (hash: Hex, filter: LogFilter) => { await rounds.wait(); return chain.logsByHash(hash, filter); },
    rangeLogs: async (from: bigint, to: bigint, filter: LogFilter, anchors: readonly BlockAnchor[] = []) => {
      await rounds.wait(anchors.length > 0 ? 3 : 1);
      return chain.rangeLogs(from, to, filter, anchors);
    },
    codeAt: async (address: Address, hash: Hex) => { await rounds.wait(); return chain.codeAt(address, hash); },
    callAt: async (to: Address, data: Hex, hash: Hex) => { await rounds.wait(1, hash.toLowerCase()); return chain.callAt(to, data, hash); },
    finality: () => chain.finality(),
  };
}

/**
 * The indexer follows to `start`, then the chain grows one block every ROUNDS_PER_BLOCK rounds for `total` rounds and
 * each new head is handed to the indexer as the head feed would. Returns the lag at the end and the blocks per second
 * the indexer applied while it had a backlog (`backlog` blocks behind at the start).
 */
async function race(pace: CorePace, { backlog, total }: { backlog: bigint; total: number }) {
  const start = 200n;
  const last = start + backlog + BigInt(Math.ceil(total / ROUNDS_PER_BLOCK)) + 2n;
  const chain = serviceChainV2(busyWorld(last), [box]);
  chain.tip = start;
  const rounds = new Rounds();
  const indexer = await follow(timed(chain, rounds), pace);
  rounds.enabled = true;
  chain.tip = start + backlog;
  void indexer.enqueue(chain.header(chain.tip));
  let caughtUpAt: number | null = null;
  let maxLagAfter = 0n;
  for (let round = 1; round <= total; round += 1) {
    if (round % ROUNDS_PER_BLOCK === 0) {
      chain.tip += 1n;
      void indexer.enqueue(chain.header(chain.tip));
    }
    await settle();
    rounds.release();
    await settle();
    const lag = chain.tip - (indexer.head()?.number ?? 0n);
    if (caughtUpAt === null && lag <= 8n) caughtUpAt = round;
    if (caughtUpAt !== null && lag > maxLagAfter) maxLagAfter = lag;
  }
  rounds.enabled = false;
  rounds.release();
  indexer.stop();
  const applied = (indexer.head()?.number ?? 0n) - start;
  const seconds = ((caughtUpAt ?? total) * ROUND_MS) / 1000;
  const backlogRate = caughtUpAt === null ? Number(applied) / seconds : Number(backlog + BigInt(Math.floor(caughtUpAt / ROUNDS_PER_BLOCK))) / seconds;
  const requestsPerSecond = rounds.calls / ((total * ROUND_MS) / 1000);
  return { lag: chain.tip - (indexer.head()?.number ?? 0n), caughtUpAt, maxLagAfter, backlogRate, requestsPerSecond, errors: indexer.metrics.errors };
}

describe('SH-259: keeping up at 0.45 s blocks (virtual time, 150 ms a round trip)', () => {
  it('the fast pace works off a 600-block backlog at more than three times the chain\'s pace and then stays within 12 blocks', async () => {
    const fast = await race(PACE_FAST, { backlog: 600n, total: 900 });
    const slow = await race(PACE_12S, { backlog: 600n, total: 900 });
    console.warn(`[SH-259 pace] chain ${CHAIN_BLOCKS_PER_SECOND.toFixed(2)} blocks/s; fast pace: backlog worked off at ${fast.backlogRate.toFixed(1)} blocks/s, caught up after ${fast.caughtUpAt} rounds, lag at most ${fast.maxLagAfter} blocks after, ${fast.requestsPerSecond.toFixed(1)} requests/s; 12-second pace: ${slow.backlogRate.toFixed(1)} blocks/s, caught up ${slow.caughtUpAt === null ? 'never' : `after ${slow.caughtUpAt} rounds`}, lag at the end ${slow.lag} blocks, ${slow.requestsPerSecond.toFixed(1)} requests/s`);
    expect(fast.errors).toBe(0);
    expect(fast.caughtUpAt).not.toBeNull();
    expect(fast.backlogRate).toBeGreaterThanOrEqual(3 * CHAIN_BLOCKS_PER_SECOND);
    // 8 measured on 25 November (3.6 s at 0.45 s blocks); the bound leaves room for small changes in read order.
    expect(fast.maxLagAfter).toBeLessThanOrEqual(12n);
    // Within what publicnode answered in a burst from the machine (about 90 requests a second, SH-259 probe log).
    expect(fast.requestsPerSecond).toBeLessThan(30);
    // The reason for the change: block by block, the 12-second pace falls behind a 0.45 s chain for good.
    expect(slow.lag).toBeGreaterThan(fast.lag + 32n);
  }, 60_000);
});
