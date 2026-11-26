/**
 * SH-259, review job306 points 6 and 7 (the index): a height whose logs carry two block hashes is refused and read
 * again; a catch-up reads its headers with a fixed, small concurrency (one at the 12-second pace, as at 171c3b4e; four
 * at the fast pace). Point 5 (a restart's reconciliation) was taken out again: see the runbook's limits.
 */
import { labelAddress } from '@squarehole/chain/core/test-support';
import { describe, expect, it } from 'vitest';
import { CoreChainIndexer, PACE_12S, PACE_FAST, type CorePace } from '../../src/core/chain-indexer';
import { MemoryHistory } from '../../src/history/memory-history';
import { HistoryWriter } from '../../src/history/writer';
import type { BlockHeader } from '../../src/model';
import { getSqrtPriceAtTick } from '../../src/v4-math';
import { ev, synthBox, synthManifest, World, type SynthBox } from './core-synth';
import type { ScriptedCoreChain } from './scripted-core-chain';

const chainId = synthManifest().chainId;
const sqrtAt = (i: number): bigint => getSqrtPriceAtTick(-30_000 + i);
const swap = (box: SynthBox, i: number) => [ev.swap(box, { amount0: -(10n ** 16n) * BigInt(i), amount1: 10n ** 20n * BigInt(i), sqrtPriceX96: sqrtAt(i), tick: -30_000 + i, liquidity: 10n ** 20n }), ev.transfer(box, labelAddress('pool'), labelAddress('buyer'), 10n ** 20n * BigInt(i))];
const launch = (w: World, box: SynthBox): void => {
  w.block(box.row.creationBlock, [w.created(box, [ev.initialize(box, sqrtAt(0), -30_000), ev.mint(box, labelAddress('pool'), 10n ** 27n)])]);
};

async function run(chain: ScriptedCoreChain, history: MemoryHistory, pace?: CorePace): Promise<CoreChainIndexer> {
  const writer = new HistoryWriter(history);
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifest(), auditEvery: 1_000, onHistory: writer.accept, ...(pace ? { pace } : {}) });
  await indexer.start();
  await indexer.idle();
  await writer.flush();
  return indexer;
}

describe('job306 point 6: logs of one height from two branches are refused and read again', () => {
  it('never commits the first hash\'s logs with the others dropped', async () => {
    const box = synthBox({ boxId: 0n, creationBlock: 12n });
    const world = new World('canonical');
    world.block(1n);
    launch(world, box);
    world.block(50n, [swap(box, 1)]);
    world.to(101n);
    // A replica on another branch answers block 50 with another trade (its own hash), listed first.
    const other = world.fork(49n, 'other');
    other.block(50n, [swap(box, 7)]);
    const otherLogs = other.logs.filter((l) => l.blockNumber === 50n);
    const otherHeader = other.headers.find((h) => h.number === 50n) as BlockHeader;
    const chain = world.chain([box]);
    chain.tip = 100n;
    const rangeLogs = chain.rangeLogs.bind(chain);
    let mixed = 0;
    chain.rangeLogs = async (from, to, filter, anchors) => {
      const logs = await rangeLogs(from, to, filter, anchors);
      if (mixed > 0 || !logs.some((l) => l.blockNumber === 50n) || filter.poolIds.length === 0) return logs;
      mixed += 1;
      return [...otherLogs, ...logs];
    };
    const byHash = chain.headerByHash.bind(chain);
    chain.headerByHash = async (hash) => (hash.toLowerCase() === otherHeader.hash.toLowerCase() ? otherHeader : byHash(hash));
    const history = new MemoryHistory();
    const indexer = await run(chain, history);
    expect(mixed).toBe(1);
    expect(indexer.metrics.errors).toBe(1);
    expect(indexer.metrics.lastError).toMatch(/carry 2 block hashes; read again/);
    // Read again at the next head: the canonical trade, as a clean index has it.
    chain.tip = 101n;
    await indexer.enqueue(chain.header(101n));
    const clean = new MemoryHistory();
    await run(world.chain([box]), clean);
    expect(indexer.head()?.number).toBe(101n);
    expect((await history.dump(chainId)).trades).toEqual((await clean.dump(chainId)).trades);
  });
});

describe('job306 point 7: a catch-up reads its headers with a fixed, small concurrency', () => {
  for (const [name, pace, most] of [['12-second pace', PACE_12S, 1], ['fast pace', PACE_FAST, 4]] as const) {
    it(`${name}: at most ${most} header reads at once over 40 heights with logs`, async () => {
      const box = synthBox({ boxId: 0n, creationBlock: 12n });
      const world = new World('w');
      world.block(1n);
      launch(world, box);
      for (let i = 1; i <= 40; i += 1) world.block(20n + BigInt(i) * 3n, [swap(box, i)]);
      world.to(200n);
      const chain = world.chain([box]);
      const byHash = chain.headerByHash.bind(chain);
      let inFlight = 0, peak = 0, reads = 0;
      chain.headerByHash = async (hash) => {
        inFlight += 1; reads += 1; peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return byHash(hash);
      };
      const indexer = await run(chain, new MemoryHistory(), pace);
      expect(indexer.metrics.errors).toBe(0);
      expect(reads).toBeGreaterThanOrEqual(40);
      expect(peak).toBe(most);
    });
  }
});
