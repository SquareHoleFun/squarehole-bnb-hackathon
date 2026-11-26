/**
 * Box 0's fee ledgers (S10a review): the parts of its split that no BatchSplit field reports are counted, so the Fees
 * card adds up to what the receiver split, before and after graduation:
 *
 * - its 2/15 platform share before graduation, held by the receiver (qFit × 2/11 per batch), then through the cap at
 *   the settlement (PlatformCredited kept + GraduationSettled.platformToDepth into the pool);
 * - after graduation the 13/15 T that funds the per-Misfit stream (StreamFunded, or StreamNotifyFailed);
 * - the platform's "this month" is the epoch now (30 days from graduation), never more than its all-time total;
 * - the audit compares every one of these with the receiver's own ledgers (`totals()`, `platformHeld()`, …).
 */
import { BOX_0_MISFITS } from '@squarehole/box-spec';
import { labelAddress, labelHash } from '@squarehole/chain/core/test-support';
import type { Address, Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { compareAudit, derivedValues, type AuditReads } from '../../src/core/audit';
import type { CoreEvent } from '../../src/core/core-events';
import { feeSummary } from '../../src/core/core-fees';
import { boxView, platformNow, poolShareOf } from '../../src/core/core-views';
import { applyCoreBlock, initialCoreState, type CoreBoxState } from '../../src/core/derive-core';
import type { BlockHeader } from '../../src/model';
import { synthBox } from './core-synth';

const box = synthBox({ boxId: 0n, creationBlock: 100n });
const row = box.row;
const other = synthBox({ boxId: 1n, creationBlock: 100n, spec: { ...BOX_0_MISFITS, tokenSymbol: 'KITE' } }).row;
const DAY = 86_400n;
const T0 = 1_800_000_000n;
let logIndex = 0;

function e(source: CoreEvent['source'], name: string, args: Record<string, unknown>, n: bigint): CoreEvent {
  const hash = labelHash(`fees:${n}`);
  return { source, name, args, address: (row.contracts[source as keyof typeof row.contracts] ?? row.poolManager) as Address, ref: { blockNumber: n, blockHash: hash, txHash: labelHash(`fees:tx:${n}`), txIndex: 0, logIndex: logIndex++ } };
}

function header(n: bigint, timestamp: bigint): BlockHeader {
  return { number: n, hash: labelHash(`fees:${n}`) as Hex, parentHash: labelHash(`fees:${n - 1n}`) as Hex, timestamp };
}

const split = (n: bigint, s: { qFit: bigint; qDepth: bigint; qPlatform: bigint; tDepth: bigint; tBurned: bigint }) => e('receiver', 'BatchSplit', { qReward: 0n, tReward: 0n, tFit: 0n, ...s }, n);

/** Box 0's life in fees: a batch before graduation, the settlement and its split, a stream batch, a failed notice. */
function life(): { states: CoreBoxState[]; u: bigint; v: bigint; w: bigint; z: bigint; k: bigint; x: bigint; y: bigint } {
  const u = 1_000_003n; // the pre-graduation batch's Q fifteenth
  const v = 7_000_001n; // its T fifteenth
  const w = 2_000_000n; // the settlement split's Q fifteenth
  const z = 3_000_000n; // its T fifteenth
  const k = 5_000_000n; // a later batch's T fifteenth
  const x = 11n; // the held share's part above the cap (sent to depth at the settlement)
  const y = 13n; // the settlement split's platform part above the cap
  let s = initialCoreState(row);
  const states: CoreBoxState[] = [];
  const apply = (n: bigint, t: bigint, events: CoreEvent[]) => {
    s = applyCoreBlock(s, header(n, t), events, row).state;
    states.push(s);
  };
  apply(100n, T0, [e('hook', 'PoolLaunched', { tickLower: 0, tickUpper: 60, liquidity: 1n, sqrtPriceX96: 1n, tokenDeposited: 1n }, 100n), e('token', 'Transfer', { from: '0x0000000000000000000000000000000000000000', to: row.contracts.coordinator, amount: 5n * 10n ** 26n }, 100n)]);
  // Before graduation: Q 11/15 FIT + 2/15 depth (held) + 2/15 platform (held, BatchSplit.qPlatform 0); T 13/15 burned.
  apply(110n, T0 + 120n, [e('receiver', 'Collected', { caller: labelAddress('k'), tipTo: labelAddress('k'), q: 15n * u, t: 15n * v, qToReserve: 0n, tip: 0n }, 110n), split(110n, { qFit: 11n * u, qDepth: 2n * u, qPlatform: 0n, tDepth: 2n * v, tBurned: 13n * v })]);
  // Graduation and the settlement: the held share through the cap (kept + to depth), then the last fees' split.
  apply(120n, T0 + 240n, [
    e('coordinator', 'Graduated', { caller: labelAddress('k'), blockNumber: 120n, poolShare: 1n, tokenDustBurned: 0n, reward: 0n }, 120n),
    e('receiver', 'PlatformCredited', { epoch: 0n, kept: 2n * u - x, toDepth: x, keptInEpoch: 2n * u - x }, 120n),
    e('receiver', 'GraduationSettled', { fitReleased: 11n * u, platformKept: 2n * u - x, platformToDepth: x, creatorQ: 0n, creatorT: 0n }, 120n),
    e('receiver', 'PlatformCredited', { epoch: 0n, kept: 2n * w - y, toDepth: y, keptInEpoch: 2n * u - x + 2n * w - y }, 120n),
    split(120n, { qFit: 11n * w, qDepth: 2n * w + y, qPlatform: 2n * w - y, tDepth: 2n * z, tBurned: 0n }),
    e('receiver', 'StreamFunded', { stream: row.contracts.itemStream, amount: 13n * z }, 120n),
  ]);
  // After graduation, a T-only batch whose stream notice failed: the T was still redeemed to the stream.
  apply(130n, T0 + 360n, [split(130n, { qFit: 0n, qDepth: 0n, qPlatform: 0n, tDepth: 2n * k, tBurned: 0n }), e('receiver', 'StreamNotifyFailed', { stream: row.contracts.itemStream, amount: 13n * k }, 130n)]);
  return { states, u, v, w, z, k, x, y };
}

const asOf = (s: CoreBoxState) => ({ block: s.block.toString(), hash: s.blockHash, timestamp: s.timestamp.toString(), tier: 'head' as const });
const viewOf = (s: CoreBoxState) => boxView({ row, state: s, asOf: asOf(s), verified: null, stale: false, audit: null });

describe('box 0 fee ledgers (the Fees card adds up; S10a review)', () => {
  it('before graduation: the platform 2/15 is held (qFit × 2/11), and every part sums to the batch', () => {
    const { states, u, v } = life();
    const before = states[1] as CoreBoxState;
    expect(before.platform.held).toBe(2n * u);
    const fs = feeSummary(viewOf(before));
    expect(fs).toMatchObject({ qFit: 11n * u, qDepth: 2n * u, qPlatform: 2n * u, qPlatformHeld: 2n * u, tDepth: 2n * v, tBurned: 13n * v, tToStream: 0n });
    expect(fs.qTotal).toBe(15n * u);
    expect(fs.tTotal).toBe(15n * v);
    // Nothing kept for the Safe yet, so nothing kept "this month" either.
    expect(viewOf(before).platform).toMatchObject({ credited: '0', held: (2n * u).toString(), epoch: null, keptInEpoch: '0' });
  });

  it('at the settlement: the held share moves to the platform (kept) and the pool (above the cap); the stream gets the 13/15 T', () => {
    const { states, u, v, w, z, x, y } = life();
    const settled = states[2] as CoreBoxState;
    expect(settled.platform.held).toBe(0n);
    const view = viewOf(settled);
    const fs = feeSummary(view);
    expect(fs.qPlatform).toBe(2n * u - x + (2n * w - y));
    expect(fs.qPlatformHeld).toBe(0n);
    expect(fs.qDepth).toBe(2n * u + x + 2n * w + y);
    expect(fs.qTotal).toBe(15n * u + 15n * w);
    expect(fs.tToStream).toBe(13n * z);
    expect(fs.tTotal).toBe(15n * v + 15n * z);
    // "This month" never exceeds the all-time platform figure (the review's 0.0041 · this month 0.0054).
    expect(BigInt(view.platform.keptInEpoch)).toBeLessThanOrEqual(fs.qPlatform);
    expect(view.platform).toMatchObject({ epoch: '0', keptInEpoch: (2n * u - x + 2n * w - y).toString() });
  });

  it('after graduation: a failed stream notice still counts as streamed; the epoch rolls with the clock', () => {
    const { states, v, z, k } = life();
    const last = states[3] as CoreBoxState;
    const fs = feeSummary(viewOf(last));
    expect(fs.tToStream).toBe(13n * z + 13n * k);
    expect(fs.tTotal).toBe(15n * v + 15n * z + 15n * k);
    // 31 days after graduation: epoch 1, nothing kept in it yet (the contract's platformEpoch() says the same).
    const later = { ...last, timestamp: T0 + 240n + 31n * DAY };
    expect(platformNow(later)).toEqual({ epoch: 1n, kept: 0n });
    expect(viewOf(later).platform).toMatchObject({ epoch: '1', keptInEpoch: '0' });
  });

  it('a depth call that only converts adds nothing: the last add is a paired add\'s block (S10a review)', () => {
    const { states } = life();
    let s = states[3] as CoreBoxState;
    const deepened = (n: bigint, kind: number) => e('hook', 'Deepened', { poolId: row.poolId, kind, tickLower: 0, tickUpper: 0, liquidity: kind === 1 ? 77n : 0n, qUsed: 5n, tUsed: kind === 1 ? 9n : 0n, tip: 1n }, n);
    s = applyCoreBlock(s, header(483n, T0 + 1_000n), [e('hook', 'DepthConverted', { poolId: row.poolId, qIn: 5n, tOut: 40n, referenceTick: 0, sqrtPriceBeforeX96: 1n, sqrtPriceAfterX96: 1n }, 483n), deepened(483n, 2)], row).state;
    expect(s.depth).toMatchObject({ adds: 0, conversions: 1, lastAddBlock: null, pairedLiquidity: 0n });
    s = applyCoreBlock(s, header(799n, T0 + 9_000n), [e('hook', 'DepthConverted', { poolId: row.poolId, qIn: 5n, tOut: 40n, referenceTick: 0, sqrtPriceBeforeX96: 1n, sqrtPriceAfterX96: 1n }, 799n), deepened(799n, 1)], row).state;
    expect(s.depth).toMatchObject({ adds: 1, conversions: 2, lastAddBlock: 799n, pairedLiquidity: 77n });
  });

  it('the pool share waiting is the coordinator\'s T balance until graduation, then 0', () => {
    const { states } = life();
    expect(poolShareOf(row, states[1] as CoreBoxState)).toBe(5n * 10n ** 26n);
    expect(poolShareOf(row, states[2] as CoreBoxState)).toBe(0n);
  });

  it('another box\'s T total is its pool share × 15/2 (its other T fields overlap by its stream)', () => {
    const s = applyCoreBlock(initialCoreState(other), header(110n, T0), [e('receiver', 'BatchSplit', { qReward: 10n, qFit: 3n, qDepth: 2n, qPlatform: 0n, tReward: 70n, tFit: 21n, tDepth: 14n, tBurned: 70n }, 110n)], other).state;
    const fs = feeSummary(boxView({ row: other, state: s, asOf: asOf(s), verified: null, stale: false, audit: null }));
    expect(fs.qTotal).toBe(15n);
    expect(fs.tTotal).toBe(105n);
  });

  it('BC-080: the audit compares the fee ledgers with the receiver ledgers and catches a difference', () => {
    const { states, u, w, x, y } = life();
    const s = states[3] as CoreBoxState;
    const d = derivedValues(s, row);
    expect(d).toMatchObject({
      'receiver.toPlatform': (2n * u - x + 2n * w - y).toString(),
      'receiver.platformHeld': '0',
      'receiver.toFit': (11n * u + 11n * w).toString(),
      'receiver.qToDepth': (2n * u + x + 2n * w + y).toString(),
      'coordinator.poolShare': '0',
    });
    const values: Record<string, string> = Object.fromEntries(Object.entries(d).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const reads: AuditReads = { block: s.block, hash: s.blockHash, values };
    expect(compareAudit(s, reads, row).ok).toBe(true);
    // The chain kept less for the platform than the events say (a missed PlatformCredited, say): Unverified.
    const off = compareAudit(s, { ...reads, values: { ...values, 'receiver.toPlatform': '1' } }, row);
    expect(off.ok).toBe(false);
    expect(off.mismatches[0]).toMatch(/^receiver\.toPlatform: /);
    // Before graduation the held share is compared with platformHeld().
    const before = states[1] as CoreBoxState;
    expect(derivedValues(before, row)['receiver.platformHeld']).toBe((2n * u).toString());
  });
});
