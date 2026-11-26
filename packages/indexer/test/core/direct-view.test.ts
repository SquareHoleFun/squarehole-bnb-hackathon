/**
 * A direct read as the indexer's view (S10a § 5; C19): the same `sh.core-box.v1` shape from views at one block, marked
 * `source: 'direct'`, with the fee split from the receiver's lifetime totals and the display reads; a phase version 1
 * does not have is refused.
 */
import { boxRowFromRecord, type CoreDirectReads } from '@squarehole/chain';
import { syntheticBox, labelAddress } from '@squarehole/chain/core/test-support';
import { describe, expect, it } from 'vitest';
import { directBoxView, DirectViewError } from '../../src/core/direct-view';
import { getSqrtPriceAtTick } from '../../src/v4-math';

const box = syntheticBox({ creationBlock: 100n });
const row = boxRowFromRecord(box.record, box.encodedSpec, { chainId: 11_155_111, registry: labelAddress('r'), box0Registry: labelAddress('r') });

function reads(over: Partial<CoreDirectReads> = {}): CoreDirectReads {
  return {
    block: 500n,
    hash: `0x${'5'.repeat(64)}`,
    timestamp: 1_800_000_000n,
    phase: 5,
    closedAtBlock: 300n,
    migratedAtBlock: 301n,
    layout: { ask: 1000n, bid: 1000n, sentinel: 10n },
    pairedLiquidity: 7n,
    depthBudget: { q: 3n, t: 4n },
    sqrtPriceX96: getSqrtPriceAtTick(170_000),
    tick: 170_000,
    liquidity: 1000n,
    totalSupply: 998n * 10n ** 24n,
    totalBurned: 2n * 10n ** 24n,
    poolShare: 0n,
    graduatedAt: 1_799_000_000n,
    receiver: { depthHeld: { q: 0n, t: 0n }, platformEpoch: { epoch: 1n, kept: 5n, remaining: 32n * 10n ** 18n - 5n }, totals: { toFit: 110n, toPlatform: 20n, qToDepth: 20n, tToDepth: 9n, tBurned: 99n }, platformHeld: 0n, tBurnPending: 0n },
    vault: { escrow: 10n ** 21n, inside: 4267n, hidden: 4267n, tickets: 1n, outside: 2n, gateOpen: true },
    stream: { started: true, index: 40n, outsideCount: 2n, claimed: 39n, burned: 1000n, heldT: 61n },
    tickets: { minted: 1n, wordRequested: true, wordStored: true, terminal: false, drawsRequested: 1n, drawsSettled: 1n },
    ...over,
  };
}

describe('direct view', () => {
  it('the same view shape, from one block, marked direct', () => {
    const view = directBoxView(row, reads());
    expect(view.source).toBe('direct');
    expect(view.phase).toBe('graduated');
    expect(view.asOf).toEqual({ block: '500', hash: `0x${'5'.repeat(64)}`, timestamp: '1800000000', tier: 'head' });
    expect(view.fees).toMatchObject({ qFit: '110', qPlatform: '20', qDepth: '20', tBurned: '99', tDepth: '9' });
    expect(view.platform).toMatchObject({ epoch: '1', keptInEpoch: '5' });
    // The parts no receiver total names: the stream's T (held + claimed + burned), a burn waiting, the held platform.
    expect(view.fees.tToStream).toBe((61n + 39n + 1000n).toString());
    expect(view.readsCurrent).toBe(true);
    expect(view.readsBlock).toBe('500');
    expect(view.pool.holdings).not.toBeNull();
    expect(view.reads).toMatchObject({ 'hook.depthBudgetQ': '3', 'stream.index': '40', 'stream.outsideCount': '2' });
    expect(view.vault).toMatchObject({ inside: '4267', escrow: (10n ** 21n).toString() });
    expect(view.draws).toMatchObject({ drawsSettled: 1, wordStored: true });
    // What only the logs know is not invented.
    expect(view.trading).toMatchObject({ swaps: 0, volumeQ: '0' });
    expect(view.verified).toBeNull();
  });

  it('the Fees card from a direct read: the held platform share before graduation, a refused burn as burned', async () => {
    const { feeSummary } = await import('../../src/core/core-fees');
    const before = directBoxView(row, reads({ phase: 3, closedAtBlock: 0n, migratedAtBlock: 0n, receiver: { depthHeld: { q: 2n, t: 9n }, platformEpoch: { epoch: 0n, kept: 0n, remaining: 32n * 10n ** 18n }, totals: { toFit: 11n, toPlatform: 0n, qToDepth: 2n, tToDepth: 2n, tBurned: 10n }, platformHeld: 2n, tBurnPending: 3n }, stream: { started: false, index: 0n, outsideCount: 1n, claimed: 0n, burned: 0n, heldT: 0n } }));
    const fs = feeSummary(before);
    expect(fs).toMatchObject({ qFit: 11n, qDepth: 2n, qPlatform: 2n, qPlatformHeld: 2n, qTotal: 15n, tBurned: 13n, tDepth: 2n, tToStream: 0n, tTotal: 15n });
    expect(before.platform.epoch).toBeNull();
  });

  it('before the launch: no price; a phase version 1 does not have is refused', () => {
    const upcoming = directBoxView(row, reads({ phase: 1, closedAtBlock: 0n, migratedAtBlock: 0n, sqrtPriceX96: 0n }));
    expect(upcoming.price.qPerT).toBeNull();
    expect(upcoming.fdvQ).toBeNull();
    expect(() => directBoxView(row, reads({ phase: 6 }))).toThrow(DirectViewError);
    expect(() => directBoxView(row, reads({ phase: 0 }))).toThrow(DirectViewError);
  });
});
