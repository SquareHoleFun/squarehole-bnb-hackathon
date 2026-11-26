/**
 * R2 (review 2026-10-07): a catch-up over more than 64 blocks must reconcile the retained head before it lays a range
 * on it, and a range backfill must not commit reads from two branches. Each case ends equal to a clean index of the
 * canonical branch: feed, every box's view, recent trades and activity, and the history (ownership included).
 */
import { labelAddress } from '@squarehole/chain/core/test-support';
import { describe, expect, it } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import type { BlockAnchor, LogFilter } from '../../src/core/core-reader';
import { MemoryHistory } from '../../src/history/memory-history';
import { HistoryWriter } from '../../src/history/writer';
import type { BlockHeader } from '../../src/model';
import { getSqrtPriceAtTick } from '../../src/v4-math';
import { ev, synthBox, synthManifest, World, type SynthBox } from './core-synth';
import type { ScriptedCoreChain } from './scripted-core-chain';

const sqrtAt = (i: number): bigint => getSqrtPriceAtTick(-30_000 + i);
const swap = (box: SynthBox, i: number) => [ev.swap(box, { amount0: -(10n ** 16n) * BigInt(i), amount1: 10n ** 20n * BigInt(i), sqrtPriceX96: sqrtAt(i), tick: -30_000 + i, liquidity: 10n ** 20n }), ev.transfer(box, labelAddress('pool'), labelAddress('buyer'), 10n ** 20n * BigInt(i))];
const launch = (w: World, box: SynthBox): void => {
  w.block(box.row.creationBlock, [w.created(box, [ev.initialize(box, sqrtAt(0), -30_000), ev.mint(box, labelAddress('pool'), 10n ** 27n)])]);
};
const headerOf = (w: World, n: bigint): BlockHeader => {
  const header = w.headers.find((h) => h.number === n);
  if (!header) throw new Error(`no block ${n} on ${w.branch}`);
  return header;
};
const tokenOf = (box: SynthBox): string => (box.row.contracts.token as string).toLowerCase();

interface Followed {
  readonly indexer: CoreChainIndexer;
  readonly writer: HistoryWriter;
  readonly history: MemoryHistory;
}

async function follow(chain: ScriptedCoreChain): Promise<Followed> {
  const history = new MemoryHistory();
  const writer = new HistoryWriter(history);
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifest(), auditEvery: 1_000, onHistory: writer.accept });
  await indexer.start();
  await indexer.idle();
  return { indexer, writer, history };
}

async function expectCanonical(got: Followed, canonical: World, all: readonly SynthBox[]): Promise<void> {
  await got.indexer.idle();
  await got.writer.flush();
  const truth = await follow(canonical.chain(all));
  await truth.writer.flush();
  expect.soft(got.indexer.head()?.hash).toBe(truth.indexer.head()?.hash);
  expect.soft(got.indexer.feedView().cards.map((c) => c.token).sort()).toEqual(truth.indexer.feedView().cards.map((c) => c.token).sort());
  expect.soft(got.indexer.allRows()).toEqual(truth.indexer.allRows());
  for (const box of all) {
    const token = box.row.contracts.token as string;
    expect.soft(got.indexer.boxView(token), `box ${box.row.boxId}`).toEqual(truth.indexer.boxView(token));
    expect.soft(got.indexer.recent(token)?.trades, `box ${box.row.boxId} trades`).toEqual(truth.indexer.recent(token)?.trades);
    expect.soft(got.indexer.recent(token)?.activity, `box ${box.row.boxId} activity`).toEqual(truth.indexer.recent(token)?.activity);
  }
  const mine = await got.history.dump(synthManifest().chainId);
  const theirs = await truth.history.dump(synthManifest().chainId);
  for (const table of ['boxes', 'trades', 'activity', 'transfers', 'balances', 'items', 'candles', 'batches', 'depthEvents'] as const) expect.soft(mine[table], table).toEqual(theirs[table]);
}

describe('R2 F1 cross-review: requested header numbers must match before catch-up reads', () => {
  const cases = [
    { name: 'retained head, long gap', cold: false, target: 100n, requested: 68n, earlier: 20n, firstTrade: 50n, creation: 80n, tailTrade: 90n },
    { name: 'cold start, long gap', cold: true, target: 100n, requested: 68n, earlier: 20n, firstTrade: 50n, creation: 80n, tailTrade: 90n },
    { name: 'retained head, short gap', cold: false, target: 40n, requested: 21n, earlier: 20n, firstTrade: 25n, creation: 30n, tailTrade: 35n },
    { name: 'cold start, short gap', cold: true, target: 20n, requested: 10n, earlier: 9n, firstTrade: 14n, creation: 16n, tailTrade: 18n },
  ];
  for (const scenario of cases) {
    for (const failure of ['null', 'error', 'later number', 'earlier number'] as const) {
      it(`${scenario.name}: refuses ${failure} without reads or admissions, then recovers the entire tail`, async () => {
        const box0 = synthBox({ boxId: 0n, creationBlock: 12n });
        const box1 = synthBox({ boxId: 1n, creationBlock: scenario.creation });
        const all = [box0, box1];
        const world = new World('canonical');
        world.block(1n);
        launch(world, box0);
        world.block(scenario.firstTrade, [swap(box0, 1)]);
        launch(world, box1);
        world.block(scenario.tailTrade, [swap(box1, 2)]);
        world.to(scenario.target + 1n);
        const chain = world.chain(all);
        chain.tip = 20n;
        const history = new MemoryHistory();
        const writer = new HistoryWriter(history);
        let publications = 0;
        const indexer = new CoreChainIndexer({
          reader: chain, manifest: synthManifest(), auditEvery: 1_000,
          onHistory: async (message) => { publications += 1; await writer.accept(message); },
        });
        if (!scenario.cold) await indexer.start();
        await writer.flush();
        // Copy payloads as well as rows: a refusal must not mutate an existing box's projections in place.
        const snapshot = () => structuredClone({
          head: indexer.head(), rows: indexer.allRows(), tokens: [...indexer.boxes.keys()],
          cards: indexer.feedView().cards,
          views: all.map((box) => indexer.boxView(tokenOf(box))),
          recent: all.map((box) => indexer.recent(tokenOf(box))),
          blocksApplied: indexer.metrics.blocksApplied, publications,
        });
        const retained = snapshot();
        const retainedHistory = await history.dump(synthManifest().chainId);
        const readsBefore = chain.calls; // Both rangeLogs and logsByHash increment this counter.
        const byNumber = chain.headerByNumber.bind(chain);
        let injected = false;
        chain.headerByNumber = async (number) => {
          if (!injected && number === scenario.requested) {
            injected = true;
            if (failure === 'null') return null;
            if (failure === 'error') throw new Error('requested header unavailable');
            // These are genuine canonical headers, so hash anchors alone accept the wrong range boundary.
            return chain.header(failure === 'later number' ? scenario.target : scenario.earlier);
          }
          return byNumber(number);
        };
        chain.tip = scenario.target;
        if (scenario.cold) await indexer.start();
        else await indexer.enqueue(chain.header(scenario.target));

        expect(injected).toBe(true);
        expect.soft(indexer.metrics.errors, 'invalid header is reported').toBe(1);
        expect.soft(indexer.metrics.lastError).toMatch(/unavailable|not available|mismatched/);
        expect.soft(chain.calls, 'refusal precedes any log read').toBe(readsBefore);
        expect.soft(snapshot(), 'committed and admitted state is unchanged').toEqual(retained);
        await writer.flush();
        expect.soft(await history.dump(synthManifest().chainId), 'all history, including chainBlocks, is unchanged').toEqual(retainedHistory);

        chain.headerByNumber = byNumber;
        chain.tip = scenario.target + 1n;
        await indexer.enqueue(chain.header(chain.tip));
        expect.soft(indexer.metrics.errors).toBe(1);
        expect.soft(indexer.head()?.number).toBe(chain.tip);
        expect.soft(indexer.feedView().cards.map((card) => card.token).sort()).toEqual(all.map(tokenOf).sort());
        expect.soft(indexer.recent(tokenOf(box1))?.trades).toHaveLength(1);
        await expectCanonical({ indexer, writer, history }, world, all);
      });
    }
  }
});

describe('R2 F1: failed range headers leave no uncommitted rows', () => {
  for (const failure of ['null', 'error', 'wrong number', 'wrong hash'] as const) {
    for (const reuse of [false, true]) {
      for (const failedBlock of [50n, 55n]) {
        it(`${failure} at block ${failedBlock} after anchored reads; reused registry id=${reuse}`, async () => {
          const box0 = synthBox({ boxId: 0n, creationBlock: 12n });
          const orphan = synthBox({ boxId: 1n, creationBlock: 50n });
          const replacement = synthBox({ boxId: 1n, creationBlock: 60n, order: 'high' });
          expect(tokenOf(replacement)).not.toBe(tokenOf(orphan));
          const old = new World('old');
          old.block(10n);
          launch(old, box0);
          old.to(20n);
          // Also exercise a later failure after headers for earlier events and the creation have succeeded.
          if (failedBlock === 55n) old.block(30n, [swap(box0, 1)]);
          launch(old, orphan);
          old.block(55n, [swap(orphan, 2)]);
          old.to(100n);
          const canonical = old.fork(44n, 'canonical');
          if (reuse) {
            launch(canonical, replacement);
            canonical.block(65n, [swap(replacement, 3)]);
          }
          canonical.block(90n, [swap(box0, 4)]);
          canonical.to(101n);
          const all = [box0, orphan, replacement];
          const chain = old.chain(all);
          chain.tip = 20n;
          const got = await follow(chain);
          await got.writer.flush();
          const retainedHistory = await got.history.dump(synthManifest().chainId);
          const retainedRows = got.indexer.allRows();
          chain.tip = 100n;
          const range = chain.rangeLogs.bind(chain);
          let anchoredReads = 0;
          chain.rangeLogs = async (from, to, filter, anchors) => {
            const logs = await range(from, to, filter, anchors);
            if (anchoredReads < 2) expect(anchors).toEqual([
              { number: 68n, hash: headerOf(old, 68n).hash },
              { number: 20n, hash: headerOf(old, 20n).hash },
            ]);
            anchoredReads += 1;
            return logs;
          };
          const headerByHash = chain.headerByHash.bind(chain);
          const failedHeader = headerOf(old, failedBlock);
          let failed = false;
          chain.headerByHash = async (hash) => {
            if (!failed && hash === failedHeader.hash) {
              expect(anchoredReads).toBe(2);
              failed = true;
              chain.setBranch(canonical.headers.filter((h) => h.number > 44n), canonical.logs.filter((l) => l.blockNumber > 44n));
              if (failure === 'error') throw new Error('RPC header unavailable after reorg');
              if (failure === 'wrong number') return { ...failedHeader, number: failedBlock + 1n };
              if (failure === 'wrong hash') return headerOf(canonical, failedBlock);
              return null;
            }
            return headerByHash(hash);
          };
          await got.indexer.enqueue(headerOf(old, 100n));
          expect(failed).toBe(true);
          expect.soft(got.indexer.metrics.errors).toBe(1);
          expect.soft(got.indexer.metrics.lastError).toMatch(/range backfill: header|RPC header unavailable/);
          expect.soft(got.indexer.head()?.number).toBe(20n);
          expect.soft(got.indexer.allRows()).toEqual(retainedRows);
          expect.soft(got.indexer.allRows().every(({ row }) => row.creationBlock <= (got.indexer.head()?.number ?? 0n))).toBe(true);
          expect.soft([...got.indexer.boxes.keys()]).toEqual([tokenOf(box0)]);
          await got.writer.flush();
          expect.soft(await got.history.dump(synthManifest().chainId)).toEqual(retainedHistory);

          chain.rangeLogs = range;
          await got.indexer.enqueue(chain.header(101n));
          expect.soft(got.indexer.metrics.errors).toBe(1);
          expect.soft(got.indexer.head()?.number).toBe(101n);
          expect.soft(got.indexer.feedView().cards.map((c) => c.token).sort()).toEqual([tokenOf(box0), ...(reuse ? [tokenOf(replacement)] : [])].sort());
          await expectCanonical(got, canonical, all);
        });
      }
    }
  }

  it('a failure after a partial commit drops future rows; a later reorg rolls back committed history', async () => {
    const box0 = synthBox({ boxId: 0n, creationBlock: 12n });
    const orphan = synthBox({ boxId: 1n, creationBlock: 50n });
    const future = synthBox({ boxId: 2n, creationBlock: 60n });
    const replacement = synthBox({ boxId: 1n, creationBlock: 60n, order: 'high' });
    const old = new World('old');
    old.block(10n);
    launch(old, box0);
    old.block(30n, [swap(box0, 1)]);
    launch(old, orphan);
    launch(old, future);
    old.to(100n);
    const canonical = old.fork(44n, 'canonical');
    launch(canonical, replacement);
    canonical.block(65n, [swap(replacement, 2)]);
    canonical.to(201n);
    const all = [box0, orphan, future, replacement];
    const chain = old.chain(all);
    chain.tip = 20n;
    const history = new MemoryHistory();
    const writer = new HistoryWriter(history);
    let failed = false;
    let lastWrite: Promise<void> = Promise.resolve();
    const indexer = new CoreChainIndexer({
      reader: chain, manifest: synthManifest(), auditEvery: 1_000,
      onHistory: (message) => (lastWrite = writer.accept(message)),
    });
    // A failed history write no longer stops the head queue (R4), so the interruption follows block 50's commit itself.
    const internals = indexer as unknown as { commit: (header: BlockHeader, ...rest: unknown[]) => Promise<void> };
    const commit = internals.commit.bind(indexer);
    internals.commit = async (header, ...rest) => {
      await commit(header, ...rest);
      if (!failed && header.number === 50n) {
        failed = true;
        await lastWrite;
        await writer.flush();
        chain.setBranch(canonical.headers.filter((h) => h.number > 44n), canonical.logs.filter((l) => l.blockNumber > 44n));
        throw new Error('interrupted after committing block 50');
      }
    };
    await indexer.start();
    chain.tip = 100n;
    await indexer.enqueue(headerOf(old, 100n));
    expect(failed).toBe(true);
    expect(indexer.metrics.errors).toBe(1);
    expect(indexer.head()?.number).toBe(50n);
    expect.soft(indexer.allRows().map(({ row }) => row.creationBlock)).toEqual([12n, 50n]);
    expect.soft(indexer.boxes.has(tokenOf(future))).toBe(false);
    expect((await history.dump(synthManifest().chainId)).boxes).toHaveLength(2);

    await indexer.enqueue(chain.header(201n));
    expect(indexer.metrics.errors).toBe(1);
    expect(indexer.metrics.reorgs).toBe(1);
    expect(indexer.metrics.rebuilds).toBe(0);
    await expectCanonical({ indexer, writer, history }, canonical, all);
    expect(writer.undone).toBe(1);
  });
});

// Gaps of 64 (block by block), 65 and 80 (a range), and 180 (past the 128-block window).
const TARGETS = [84n, 85n, 100n, 200n];

describe('R2: a long gap after an orphaned head', () => {
  for (const target of TARGETS) {
    it(`the review's counterexample: a creation in the orphaned blocks leaves the feed (head 20 -> ${target})`, async () => {
      const old = new World('old');
      const orphan = synthBox({ boxId: 0n, creationBlock: 19n });
      old.block(10n);
      old.block(19n, [old.created(orphan)]);
      old.to(20n);
      const chain = old.chain();
      const got = await follow(chain);
      expect(got.indexer.feedView().cards).toHaveLength(1);

      const canonical = old.fork(18n, `canonical${target}`);
      canonical.to(target);
      chain.setBranch(canonical.headers.filter((b) => b.number > 18n), []);
      await got.indexer.enqueue(chain.header(target));
      expect(got.indexer.metrics.errors).toBe(0);
      expect(got.indexer.head()?.number).toBe(target);
      expect(got.indexer.feedView().cards).toHaveLength(0);
      await expectCanonical(got, canonical, [orphan]);
    });

    it(`box 0's case: a trade in the orphaned head, mined again one block later, is counted once (head 20 -> ${target})`, async () => {
      const box = synthBox({ boxId: 0n, creationBlock: 12n });
      const a = new World('a');
      a.block(10n);
      launch(a, box);
      a.block(20n, [swap(box, 1)]);
      const chain = a.chain([box]);
      const got = await follow(chain);
      expect(got.indexer.recent(box.row.contracts.token as string)?.trades).toHaveLength(1);

      const b = a.fork(19n, `b${target}`);
      b.block(21n, [swap(box, 1)]);
      b.to(target);
      chain.setBranch(b.headers.filter((h) => h.number > 19n), b.logs.filter((l) => l.blockNumber > 19n));
      await got.indexer.enqueue(chain.header(target));
      expect(got.indexer.metrics.errors).toBe(0);
      expect(got.indexer.recent(box.row.contracts.token as string)?.trades).toHaveLength(1);
      await expectCanonical(got, b, [box]);
    });

    it(`an orphaned box's registry key does not hide a canonical box with the same id (head 20 -> ${target})`, async () => {
      const old = new World('old');
      const orphan = synthBox({ boxId: 0n, creationBlock: 19n });
      // The same id on the canonical branch, created later, with another token.
      const reused = synthBox({ boxId: 0n, creationBlock: 50n, order: 'high' });
      expect(tokenOf(reused)).not.toBe(tokenOf(orphan));
      old.block(10n);
      old.block(19n, [old.created(orphan)]);
      old.to(20n);
      const chain = old.chain([orphan, reused]);
      const got = await follow(chain);
      expect(got.indexer.feedView().cards.map((c) => c.token)).toEqual([tokenOf(orphan)]);

      const canonical = old.fork(18n, `reuse${target}`);
      canonical.block(50n, [canonical.created(reused)]);
      canonical.to(target);
      chain.setBranch(canonical.headers.filter((b) => b.number > 18n), canonical.logs.filter((l) => l.blockNumber > 18n));
      await got.indexer.enqueue(chain.header(target));
      expect(got.indexer.metrics.errors).toBe(0);
      expect(got.indexer.feedView().cards.map((c) => c.token)).toEqual([tokenOf(reused)]);
      expect(got.indexer.allRows().map((r) => r.row.creationBlock)).toEqual([50n]);
      await expectCanonical(got, canonical, [orphan, reused]);
    });
  }

  it('a long gap on a head that is still canonical rolls nothing back (head 20 -> 100, a new box inside the range)', async () => {
    const box0 = synthBox({ boxId: 0n, creationBlock: 12n });
    const box1 = synthBox({ boxId: 1n, creationBlock: 40n });
    const a = new World('a');
    a.block(10n);
    launch(a, box0);
    launch(a, box1);
    a.block(50n, [swap(box0, 1)]);
    a.block(60n, [swap(box1, 2)]);
    a.block(90n, [swap(box0, 3)]);
    a.to(100n);
    const chain = a.chain([box0, box1]);
    chain.tip = 20n;
    const got = await follow(chain);
    chain.tip = 100n;
    await got.indexer.enqueue(chain.header(100n));
    expect(got.indexer.metrics.errors).toBe(0);
    expect(got.indexer.metrics.reorgs).toBe(0);
    expect(got.indexer.metrics.rebuilds).toBe(0);
    await expectCanonical(got, a, [box0, box1]);
  });

  it('a long gap whose fork lies below the held window rebuilds every box and ends on the canonical branch', async () => {
    const box = synthBox({ boxId: 0n, creationBlock: 12n });
    const a = new World('a');
    a.block(10n);
    launch(a, box);
    a.block(100n, [swap(box, 1)]);
    a.block(200n, [swap(box, 2)]);
    a.to(300n);
    const chain = a.chain([box]);
    const got = await follow(chain);
    expect(got.indexer.recent(box.row.contracts.token as string)?.trades).toHaveLength(2);

    // The window holds blocks above 172; the branch replaces everything from 151.
    const b = a.fork(150n, 'deep');
    b.block(220n, [swap(box, 3)]);
    b.to(400n);
    chain.setBranch(b.headers.filter((h) => h.number > 150n), b.logs.filter((l) => l.blockNumber > 150n));
    await got.indexer.enqueue(chain.header(400n));
    expect(got.indexer.metrics.errors).toBe(0);
    expect(got.indexer.metrics.rebuilds).toBe(1);
    await expectCanonical(got, b, [box]);
  });

  it('a reorg below the retained head after it was found canonical refuses the range; the next head ends on the canonical branch', async () => {
    const old = new World('old');
    const orphan = synthBox({ boxId: 0n, creationBlock: 19n });
    old.block(10n);
    old.block(19n, [old.created(orphan)]);
    old.to(100n);
    const chain = old.chain();
    chain.tip = 20n;
    const got = await follow(chain);
    chain.tip = 100n;
    const canonical = old.fork(18n, 'late');
    canonical.to(101n);
    // The chain still holds the old block 20 when the head is checked, and moves to the canonical branch (forked at
    // 18) just before the range's end (block 68) is read: the range continues the old head, so it must be refused.
    const old20 = headerOf(old, 20n).hash;
    const live = chain.headerByNumber.bind(chain);
    chain.headerByNumber = async (n: bigint) => {
      if (n === 68n && chain.canonical.get(20n) === old20) chain.setBranch(canonical.headers.filter((h) => h.number > 18n), []);
      return live(n);
    };
    await got.indexer.enqueue(headerOf(canonical, 100n));
    expect(got.indexer.metrics.errors).toBe(1);
    expect(got.indexer.metrics.lastError).toMatch(/not on block 20 /);
    expect(got.indexer.head()?.hash).toBe(old20);

    await got.indexer.enqueue(chain.header(101n));
    expect(got.indexer.metrics.errors).toBe(1);
    expect(got.indexer.feedView().cards).toHaveLength(0);
    await expectCanonical(got, canonical, [orphan]);
  });
});

describe('R2: a range backfill reads one branch', () => {
  /** Box 0 at 12 on both branches; branch a also creates box 1 at 50 and trades it; branch b forks at 44 without it. */
  function worlds(): { a: World; b: World; box0: SynthBox; box1: SynthBox } {
    const box0 = synthBox({ boxId: 0n, creationBlock: 12n });
    const box1 = synthBox({ boxId: 1n, creationBlock: 50n });
    const a = new World('a');
    a.block(10n);
    launch(a, box0);
    a.to(20n);
    const b = a.fork(20n, 'b');
    a.block(30n, [swap(box0, 2)]);
    launch(a, box1);
    a.block(55n, [swap(box1, 3)]);
    a.to(100n);
    // b shares a's blocks up to 44 (box 0's trade at 30 included), then its own.
    for (const h of a.headers) if (h.number > 20n && h.number <= 44n) b.headers.push(h);
    for (const l of a.logs) if (l.blockNumber > 20n && l.blockNumber <= 44n) b.logs.push(l);
    b.block(60n, [swap(box0, 4)]);
    b.to(101n);
    return { a, b, box0, box1 };
  }

  /**
   * The listed range reads (by call number) go first to `stale`, an endpoint still on the other branch, and fall over
   * to the live chain only when it refuses, as the RPC reader's endpoint rotation does.
   */
  function staleRangeReads(chain: ScriptedCoreChain, stale: ScriptedCoreChain, which: ReadonlySet<number>): void {
    const live = chain.rangeLogs.bind(chain);
    let calls = 0;
    chain.rangeLogs = async (from: bigint, to: bigint, filter: LogFilter, anchors?: readonly BlockAnchor[]) => {
      calls += 1;
      if (!which.has(calls)) return live(from, to, filter, anchors);
      try {
        return await stale.rangeLogs(from, to, filter, anchors);
      } catch {
        return live(from, to, filter, anchors);
      }
    };
  }

  it('a registry read from an endpoint still on the orphaned branch does not admit its box', async () => {
    const { a, b, box0, box1 } = worlds();
    // The node knows both branches by hash (orphans stay reachable), b is canonical.
    const chain = a.chain([box0, box1]);
    chain.tip = 20n;
    const got = await follow(chain);
    chain.setBranch(b.headers.filter((h) => h.number > 44n), b.logs.filter((l) => l.blockNumber > 44n));
    staleRangeReads(chain, a.chain([box0, box1]), new Set([1]));
    await got.indexer.enqueue(chain.header(101n));
    expect(got.indexer.metrics.errors).toBe(0);
    expect(got.indexer.feedView().cards.map((c) => c.row.record.boxId)).toEqual(['0']);
    await expectCanonical(got, b, [box0, box1]);
  });

  it('a cold start whose box read comes from the orphaned branch ends on the canonical one', async () => {
    const { a, b, box0, box1 } = worlds();
    const chain = a.chain([box0, box1]);
    chain.setBranch(b.headers.filter((h) => h.number > 44n), b.logs.filter((l) => l.blockNumber > 44n));
    // Call 1 reads the registries (canonical: box 0 only), call 2 the boxes' logs from the stale endpoint.
    staleRangeReads(chain, a.chain([box0, box1]), new Set([2]));
    const got = await follow(chain);
    expect(got.indexer.metrics.errors).toBe(0);
    await expectCanonical(got, b, [box0, box1]);
  });

  it('a reorg between the registry read and the box read admits nothing; the next head ends on the canonical branch', async () => {
    const { a, b, box0, box1 } = worlds();
    const chain = a.chain([box0, box1]);
    chain.tip = 20n;
    const got = await follow(chain);
    chain.tip = 100n;
    const live = chain.rangeLogs.bind(chain);
    let calls = 0;
    chain.rangeLogs = async (from: bigint, to: bigint, filter: LogFilter, anchors?: readonly BlockAnchor[]) => {
      calls += 1;
      // Branch a (box 1 at 50) answers the registry read; b replaces it from 45 before the boxes' logs are read.
      if (calls === 2) chain.setBranch(b.headers.filter((h) => h.number > 44n), b.logs.filter((l) => l.blockNumber > 44n));
      return live(from, to, filter, anchors);
    };
    await got.indexer.enqueue(headerOf(a, 100n));
    expect(got.indexer.metrics.errors).toBe(1);
    expect(got.indexer.metrics.lastError).toMatch(/not on block 68 /);
    expect(got.indexer.allRows().map((r) => r.row.boxId)).toEqual([0n]);
    expect(got.indexer.head()?.number).toBe(20n);
    await got.indexer.enqueue(chain.header(101n));
    await expectCanonical(got, b, [box0, box1]);
  });
});
