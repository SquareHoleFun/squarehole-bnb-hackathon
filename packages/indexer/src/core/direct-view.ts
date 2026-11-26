/**
 * A box's view from a DIRECT read at one block (the site without the indexer; C19, S10a § 5): the same
 * `sh.core-box.v1` shape as the indexer's, built by the same builder from what the views say. What only the logs know
 * (volume, trade counts, the launch tax collected) is not known here: the view says `source: 'direct'` and the page
 * shows those as "with the indexer" instead of zeros.
 *
 * The fee split comes from the receiver's lifetime totals and the stream's (core-fees.ts reads both views alike):
 * FIT's part `toFit` (REV-16 returns included), the pool's `qToDepth` (the settlement's part above the cap included,
 * and a gift to the pool, which only the indexer can tell apart), the platform's `toPlatform` kept plus `platformHeld()`
 * before graduation, T burned `totals().tBurned` plus a refused burn still waiting (`tBurnPending()`), and the T the
 * per-Misfit stream received (its balance, claimed and burned). Browser-safe.
 */
import type { BoxRow, CoreDirectReads } from '@squarehole/chain';
import { boxView, type CoreBoxView } from './core-views';
import { CONTRACT_PHASE, initialCoreState, type CoreBoxState, type CorePhase } from './derive-core';

export class DirectViewError extends Error {
  override readonly name = 'DirectViewError';
}

export function directBoxView(row: BoxRow, reads: CoreDirectReads): CoreBoxView {
  const phase = CONTRACT_PHASE[reads.phase];
  if (phase === undefined || phase === 'failed') throw new DirectViewError(`the hook reports phase ${reads.phase}, which version 1 does not have`);
  const base = initialCoreState(row);
  const migrated = reads.migratedAtBlock > 0n;
  const t = reads.receiver.totals;
  const state: CoreBoxState = {
    ...base,
    block: reads.block,
    blockHash: reads.hash,
    timestamp: reads.timestamp,
    phase: phase as CorePhase,
    closedAtBlock: reads.closedAtBlock > 0n ? reads.closedAtBlock : null,
    migratedAtBlock: migrated ? reads.migratedAtBlock : null,
    launched: reads.sqrtPriceX96 > 0n,
    sqrtPriceX96: reads.sqrtPriceX96 > 0n ? reads.sqrtPriceX96 : null,
    tick: reads.sqrtPriceX96 > 0n ? reads.tick : null,
    liquidity: reads.liquidity,
    supply: reads.totalSupply,
    burned: reads.totalBurned,
    fees: {
      ...base.fees,
      qFit: t.toFit,
      qPlatform: t.toPlatform,
      qDepth: t.qToDepth,
      tBurned: t.tBurned + reads.receiver.tBurnPending,
      tDepth: t.tToDepth,
      tToStream: reads.stream ? reads.stream.heldT + reads.stream.claimed + reads.stream.burned : 0n,
    },
    platform: { ...base.platform, epoch: reads.receiver.platformEpoch.epoch, keptInEpoch: reads.receiver.platformEpoch.kept, credited: t.toPlatform, held: reads.receiver.platformHeld },
    depth: { ...base.depth, heldQ: reads.receiver.depthHeld.q, heldT: reads.receiver.depthHeld.t, pairedLiquidity: reads.pairedLiquidity, settled: migrated && reads.receiver.depthHeld.q === 0n && reads.receiver.depthHeld.t === 0n },
    graduation: reads.graduatedAt > 0n && migrated ? { block: reads.migratedAtBlock, timestamp: reads.graduatedAt, caller: '0x0000000000000000000000000000000000000000', poolShare: 0n, tokenDustBurned: 0n, reward: 0n, txHash: `0x${'0'.repeat(64)}` } : null,
    layout: migrated ? { askLiquidity: reads.layout.ask, bidLiquidity: reads.layout.bid, sentinelLiquidity: reads.layout.sentinel, qFromCurve: row.raise, tFromCurve: 0n, tokenPulled: 0n, qDust: 0n } : null,
    vault: reads.vault
      ? { ...base.vault, escrow: reads.vault.escrow, inside: reads.vault.inside, hidden: reads.vault.hidden, tickets: reads.vault.tickets, gateOpen: reads.vault.gateOpen, collectionSize: BigInt(row.spec.n) }
      : base.vault,
    draws: reads.tickets
      ? { ...base.draws, placeholdersTaken: reads.tickets.minted, drawsRequested: Number(reads.tickets.drawsRequested), drawsSettled: Number(reads.tickets.drawsSettled), wordStored: reads.tickets.wordStored, terminal: reads.tickets.terminal }
      : base.draws,
    stream: reads.stream ? { ...base.stream, started: reads.stream.started, claimed: reads.stream.claimed, burned: reads.stream.burned } : base.stream,
  };
  const values: Record<string, string> = {
    'hook.depthBudgetQ': reads.depthBudget.q.toString(),
    'hook.depthBudgetT': reads.depthBudget.t.toString(),
    'coordinator.poolShare': reads.poolShare.toString(),
    'receiver.platformRemaining': reads.receiver.platformEpoch.remaining.toString(),
    ...(reads.stream ? { 'stream.index': reads.stream.index.toString(), 'stream.outsideCount': reads.stream.outsideCount.toString() } : {}),
    ...(reads.vault ? { 'vault.outside': reads.vault.outside.toString() } : {}),
  };
  const view = boxView({ row, state, asOf: { block: reads.block.toString(), hash: reads.hash, timestamp: reads.timestamp.toString(), tier: 'head' }, verified: null, stale: false, audit: null });
  // The epoch now and what was kept in it, as the receiver's own view says (null before graduation, as the indexer's).
  return {
    ...view,
    platform: { ...view.platform, epoch: migrated ? reads.receiver.platformEpoch.epoch.toString() : null, keptInEpoch: reads.receiver.platformEpoch.kept.toString() },
    pool: { ...view.pool, poolShare: reads.poolShare.toString() },
    vault: { ...view.vault, outside: reads.vault ? reads.vault.outside.toString() : view.vault.outside },
    reads: values,
    readsBlock: reads.block.toString(),
    readsCurrent: true,
    source: 'direct',
  };
}
