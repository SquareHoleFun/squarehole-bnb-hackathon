/**
 * BC-077: reorgs across boxes on a synthetic chain. Several boxes with trades; reorgs of 1, 64 and 200 blocks, each new
 * branch WITHOUT the newest box's `BoxCreated`. The removed box leaves the feed; every other box rolls back to the
 * common ancestor (within the 128-block window) or, deeper, is rebuilt from its creation block; afterwards every box
 * equals a fresh index of the new chain (the synthetic chain's reads), and the history equals a fresh history.
 */
import { boxCollectionAbi } from '@squarehole/chain/abi';
import type { Address } from 'viem';
import { labelAddress } from '@squarehole/chain/core/test-support';
import { describe, expect, it } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { MemoryHistory } from '../../src/history/memory-history';
import { HistoryWriter } from '../../src/history/writer';
import { getSqrtPriceAtTick } from '../../src/v4-math';
import { ev, event, synthBox, synthManifest, World, type SynthBox } from './core-synth';

const TIP = 400n;
const sqrtAt = (i: number): bigint => getSqrtPriceAtTick(-30_000 + i);

/** Three boxes trading on branch `label` from block `from`; the late box exists only on branch 'a'. */
function trade(w: World, boxes: readonly SynthBox[], n: bigint, salt: number): void {
  const box = boxes[Number(n) % boxes.length] as SynthBox;
  const i = Number(n % 50n) + salt;
  w.block(n, [[ev.swap(box, { amount0: -(10n ** 16n) * BigInt(i + 1), amount1: 10n ** 20n * BigInt(i + 1), sqrtPriceX96: sqrtAt(i), tick: -30_000 + i, liquidity: 10n ** 20n }), ev.transfer(box, labelAddress('pool'), labelAddress(`buyer:${salt}`), 10n ** 20n * BigInt(i + 1))]]);
}

/** The chain on branch a, with the late box created at `lateAt` (inside the range a reorg replaces). */
function base(lateAt: bigint): { w: World; boxes: SynthBox[]; late: SynthBox } {
  const w = new World('a');
  const boxes = [synthBox({ boxId: 0n, creationBlock: 12n }), synthBox({ boxId: 1n, creationBlock: 40n }), synthBox({ boxId: 2n, creationBlock: 150n })];
  const late = synthBox({ boxId: 3n, creationBlock: lateAt });
  w.block(10n);
  for (const box of boxes) w.block(box.row.creationBlock, [w.created(box, [ev.initialize(box, sqrtAt(0), -30_000), ev.mint(box, labelAddress('pool'), 10n ** 27n)])]);
  for (let n = 151n; n <= TIP; n += 1n) {
    if (n === lateAt) w.block(lateAt, [w.created(late, [ev.initialize(late, sqrtAt(0), -30_000)])]);
    else if ((n - 151n) % 7n === 0n) trade(w, boxes, n, 0);
  }
  w.to(TIP);
  return { w, boxes, late };
}

async function fresh(w: World, all: readonly SynthBox[]): Promise<{ indexer: CoreChainIndexer; history: MemoryHistory }> {
  const history = new MemoryHistory();
  const writer = new HistoryWriter(history);
  const indexer = new CoreChainIndexer({ reader: w.chain(all), manifest: synthManifest(), onHistory: writer.accept });
  await indexer.start();
  await indexer.idle();
  await writer.flush();
  return { indexer, history };
}

describe('BC-077: reorgs across boxes', () => {
  for (const depth of [1, 64, 200]) {
    it(`BC-077: a ${depth}-block reorg that removes the newest box's BoxCreated`, async () => {
      const { w, boxes, late } = base(TIP - BigInt(depth) + 1n);
      const all = [...boxes, late];
      const chain = w.chain(all);
      const history = new MemoryHistory();
      const writer = new HistoryWriter(history);
      const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifest(), onHistory: writer.accept });
      // Follow branch a to its tip, the last 140 blocks one by one (so the window holds them).
      chain.tip = TIP - 140n;
      await indexer.start();
      for (let n = TIP - 139n; n <= TIP; n += 1n) {
        chain.tip = n;
        await indexer.enqueue(chain.header(n));
      }
      await indexer.idle();
      expect(indexer.feedView().cards).toHaveLength(4);

      // Branch b: the same chain up to the ancestor, then other trades and no late box; one block longer.
      const ancestor = TIP - BigInt(depth);
      const b = w.fork(ancestor, `b${depth}`);
      for (let n = ancestor + 1n; n <= TIP + 1n; n += 1n) if ((n - ancestor) % 5n === 1n) trade(b, boxes, n, 7);
      b.to(TIP + 1n);
      const branch = b.headers.filter((h) => h.number > ancestor);
      chain.setBranch(branch, b.logs.filter((l) => l.blockNumber > ancestor));
      await indexer.enqueue(chain.header(TIP + 1n));
      await indexer.idle();
      await writer.flush();

      expect(indexer.metrics.errors).toBe(0);
      if (depth > 128) expect(indexer.metrics.rebuilds).toBeGreaterThanOrEqual(1);
      else expect(indexer.metrics.maxReorgDepth).toBe(depth);
      // The late box left the feed; the others equal a fresh index of branch b.
      const feed = indexer.feedView();
      expect(feed.cards.map((c) => c.row.record.boxId).sort()).toEqual(['0', '1', '2']);
      const truth = await fresh(b, all);
      for (const box of boxes) {
        const token = box.row.contracts.token as string;
        expect(indexer.boxView(token), `box ${box.row.boxId}`).toEqual(truth.indexer.boxView(token));
        expect(indexer.recent(token)?.trades.map((t) => t.id)).toEqual(truth.indexer.recent(token)?.trades.slice(-500).map((t) => t.id));
      }
      // History: undone above the ancestor (or wiped and rebuilt), then equal to a fresh history of branch b.
      const mine = await history.dump(synthManifest().chainId);
      const theirs = await truth.history.dump(synthManifest().chainId);
      for (const table of ['boxes', 'trades', 'activity', 'transfers', 'balances', 'items', 'candles'] as const) expect(mine[table], table).toEqual(theirs[table]);
      expect(mine.boxes.some((r) => r.includes(`"boxId":"3"`))).toBe(false);
    });
  }
});


describe('MF23-1: canonical reveal records', () => {
  it('indexes traits and all three CIDs, removes an orphan reveal, and survives a restart', async () => {
    const w = new World('reveal');
    const box = synthBox({ boxId: 0n, creationBlock: 12n });
    const token = box.row.contracts.token as string;
    w.block(10n);
    w.block(12n, [w.created(box)]);
    w.to(13n);
    const chain = w.chain([box]);
    const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifest() });
    await indexer.start();
    expect(indexer.itemView(token, 1n)).toMatchObject({ revealed: false, art: null, traits: [] });
    const imageHash = `0x${'12'.repeat(32)}`;
    const avatarHash = `0x${'34'.repeat(32)}`;
    const modelHash = `0x${'56'.repeat(32)}`;
    w.block(14n, [[event(boxCollectionAbi, box.row.contracts.collection as Address, 'Revealed', { id: 1n, traitsPacked: 1n, imageHash, avatarHash, modelHash })]]);
    const revealed = w.headers.filter((h) => h.number > 13n);
    chain.setBranch(revealed, w.logs.filter((l) => l.blockNumber > 13n));
    await indexer.enqueue(chain.header(14n));
    const item = indexer.itemView(token, 1n);
    expect(item).toMatchObject({ revealed: true, traitsPacked: '1', art: { image: { sha256: imageHash }, avatar: { sha256: avatarHash }, model: { sha256: modelHash } } });
    expect(item?.traits.length).toBeGreaterThan(0);
    expect(item?.art?.image?.cid).toMatch(/^bafkrei/);
    const restarted = new CoreChainIndexer({ reader: w.chain([box]), manifest: synthManifest() });
    await restarted.start();
    expect(restarted.itemView(token, 1n)).toEqual(item);
    const fork = w.fork(13n, 'unrevealed');
    fork.to(15n);
    chain.setBranch(fork.headers.filter((h) => h.number > 13n), []);
    await indexer.enqueue(chain.header(15n));
    expect(indexer.itemView(token, 1n)).toMatchObject({ revealed: false, art: null, traits: [] });
    expect(indexer.itemView(token, 0n)).toBeNull();
    indexer.stop();
    restarted.stop();
  });
});
