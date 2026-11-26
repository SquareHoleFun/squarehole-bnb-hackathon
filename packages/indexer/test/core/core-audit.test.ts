/**
 * BC-080 and BC-094 on the indexer: the audit compares each box with the chain at one block hash; a forced mismatch on
 * one box marks only that box Unverified (its card loses the price-built figures; the others are untouched), its repair
 * re-reads only its own logs; a box being repaired is Stale on its own card only.
 */
import { labelAddress } from '@squarehole/chain/core/test-support';
import { describe, expect, it } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import type { BlockAnchor, CoreReader, LogFilter } from '../../src/core/core-reader';
import type { RawLog } from '../../src/events';
import { getSqrtPriceAtTick } from '../../src/v4-math';
import { agreeingCalls, ev, synthBox, synthManifest, World, type SynthBox } from './core-synth';

function threeBoxes(): { w: World; boxes: SynthBox[] } {
  const w = new World();
  const boxes = [0n, 1n, 2n].map((id) => synthBox({ boxId: id, creationBlock: 12n + id }));
  w.block(10n);
  for (const box of boxes) {
    w.block(box.row.creationBlock, [
      w.created(box, [ev.initialize(box, getSqrtPriceAtTick(-30_000), -30_000), ev.mint(box, labelAddress('pool'), 10n ** 27n)]),
      [ev.swap(box, { amount0: -(10n ** 17n), amount1: 10n ** 22n, sqrtPriceX96: getSqrtPriceAtTick(-30_010), tick: -30_010, liquidity: 10n ** 20n }), ev.transfer(box, labelAddress('pool'), labelAddress('alice'), 10n ** 22n)],
      [ev.vault(box, 1n, 5n * 10n ** 20n, 4_268n, 1n)],
    ]);
  }
  w.to(60n);
  return { w, boxes };
}

describe('BC-080 / BC-094: the audit per box', () => {
  it('BC-080, BC-094: agreeing reads verify every box; a forced mismatch marks only that box Unverified, repaired alone', async () => {
    const { w, boxes } = threeBoxes();
    const chain = w.chain();
    const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifest(), auditEvery: 32 });
    await indexer.start();
    await indexer.idle();
    chain.callAnswers = agreeingCalls(indexer);
    const ok = await indexer.audit();
    expect(ok.map((r) => r.result.ok)).toEqual([true, true, true]);
    expect(indexer.feedView().cards.every((c) => c.verified === true)).toBe(true);

    // The chain now disagrees about box 1's supply (a missed burn, say): only box 1 is Unverified.
    const bad = (boxes[1] as SynthBox).row.contracts.token?.toLowerCase() as string;
    chain.callAnswers = agreeingCalls(indexer, (token, key, value) => (token === bad && key === 'token.totalSupply' ? (BigInt(value) - 1n).toString() : value));
    const rangeCalls = chain.calls;
    const results = await indexer.audit();
    expect(results.find((r) => r.token === bad && !r.result.ok)?.result.mismatches[0]).toMatch(/^token\.totalSupply: /);
    expect(indexer.metrics.boxRepairs).toBe(1);
    // The repair read the box's own logs once (one range request), and the others were never touched.
    expect(chain.calls - rangeCalls).toBe(1);
    const cards = indexer.feedView().cards;
    for (const card of cards) {
      const isBad = card.token === bad;
      expect(card.verified, card.token).toBe(!isBad);
      // An Unverified box shows no price-built figure (no FDV, no price); the others keep theirs.
      expect(card.fdvQ === null, card.token).toBe(isBad);
      expect(card.qPerT === null, card.token).toBe(isBad);
    }
    expect(indexer.boxView(bad)?.audit?.mismatches).toHaveLength(1);
  });

  it('BC-094: a box being repaired is Stale on its own card only', async () => {
    const { w, boxes } = threeBoxes();
    const chain = w.chain();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A reader whose range read of box 2's logs waits until released (a slow repair).
    const slow: CoreReader = Object.assign(Object.create(chain) as CoreReader, {
      rangeLogs: async (from: bigint, to: bigint, filter: LogFilter, anchors?: readonly BlockAnchor[]): Promise<readonly RawLog[]> => {
        if (filter.addresses.some((a) => a.toLowerCase() === (boxes[2] as SynthBox).row.contracts.hook?.toLowerCase()) && filter.addresses.length < 20) await gate;
        return chain.rangeLogs(from, to, filter, anchors);
      },
    });
    const indexer = new CoreChainIndexer({ reader: slow, manifest: synthManifest() });
    await indexer.start();
    await indexer.idle();
    const entry = indexer.boxes.get((boxes[2] as SynthBox).row.contracts.token?.toLowerCase() as string);
    if (!entry) throw new Error('no box 2');
    const repair = indexer.repairBox(entry);
    await new Promise((r) => setTimeout(r, 10));
    const stale = indexer.feedView().cards.map((c) => [c.row.record.boxId, c.stale]);
    expect(stale).toEqual([
      ['0', false],
      ['1', false],
      ['2', true],
    ]);
    release();
    await repair;
    expect(indexer.feedView().cards.every((c) => !c.stale)).toBe(true);
  });
});
