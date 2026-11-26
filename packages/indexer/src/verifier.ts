/**
 * Checks the derived state against the chain while the indexer runs: two eth_calls pinned by block hash (`extsload`
 * for √price, tick and liquidity; the token's `totalSupply()` for the burned amount). Requests are served off the
 * pipeline's queue, newest few kept, so a check never delays a block. A check whose state object was replaced in the
 * meantime (a repair or a reorg) no longer counts. A failed check flips the verdict to "unverified" at once and asks
 * the pipeline for one repair; later failures wait for that repair; after a repair that did not help (`giveUp`), no
 * more repairs until a check passes again.
 */
import type { Hex } from 'viem';
import type { ChainReader } from './chain-reader';
import type { PoolState } from './model';

export interface BlockRef {
  readonly number: bigint;
  readonly hash: Hex;
}

export interface VerifierMetrics {
  verified: boolean | null;
  verifications: number;
  verifyFailures: number;
  verifySkipped: number;
}

export interface ChainVerifierOptions {
  readonly reader: ChainReader;
  readonly issuance: bigint;
  readonly metrics: VerifierMetrics;
  readonly now: () => number;
  readonly running: () => boolean;
  /** False when a repair or a reorg replaced the state object since the check was requested. */
  readonly stillCurrent: (block: BlockRef, state: PoolState) => boolean;
  /** The verdict changed (the pipeline publishes a status frame). */
  readonly onVerdict: (verified: boolean) => void;
  /** A check failed and no repair is pending: the pipeline schedules one and calls `repairFinished` after it. */
  readonly onFailure: (block: BlockRef, state: PoolState) => void;
  /** Keeps the background loop visible to the pipeline's `idle()`. */
  readonly track: (work: Promise<unknown>) => void;
}

const QUEUE_LIMIT = 4;

export class ChainVerifier {
  /** The newest block whose state equalled the chain's: where a repair starts from. */
  lastVerified: BlockRef | null = null;
  private readonly options: ChainVerifierOptions;
  private queue: { block: BlockRef; state: PoolState }[] = [];
  private loop: Promise<void> | null = null;
  private failedAt: bigint | null = null;
  private repairPending = false;
  private gaveUp = false;
  private lastSkipWarnMs = -Infinity;

  constructor(options: ChainVerifierOptions) {
    this.options = options;
  }

  /** Queues a check of `state` at `block` (the newest few requests are kept). */
  request(block: BlockRef, state: PoolState): void {
    this.queue = [...this.queue, { block, state }].slice(-QUEUE_LIMIT);
    if (this.loop) return;
    const loop = this.run().finally(() => {
      this.loop = null;
    });
    this.loop = loop;
    this.options.track(loop);
  }

  repairFinished(): void {
    this.repairPending = false;
  }

  /** The chain still disagrees after a rebuild: stop repairing until a check passes again. */
  giveUp(): void {
    this.gaveUp = true;
  }

  private async run(): Promise<void> {
    while (this.queue.length > 0 && this.options.running()) {
      const [next, ...rest] = this.queue;
      this.queue = rest;
      if (!next) break;
      const ok = await this.check(next.block, next.state);
      if (ok === null || !this.options.stillCurrent(next.block, next.state)) continue;
      if (ok) {
        if (!this.lastVerified || next.block.number >= this.lastVerified.number) this.lastVerified = next.block;
        if (this.failedAt === null || next.block.number > this.failedAt) {
          this.failedAt = null;
          this.setVerified(true);
        }
        continue;
      }
      this.options.metrics.verifyFailures += 1;
      this.failedAt = this.failedAt === null || next.block.number > this.failedAt ? next.block.number : this.failedAt;
      this.setVerified(false);
      if (this.repairPending || this.gaveUp) continue;
      this.repairPending = true;
      this.options.onFailure(next.block, next.state);
    }
  }

  /** Checks now and records the verdict (the head after a start, a repair or a rebuild). */
  async verifyNow(block: BlockRef, state: PoolState): Promise<boolean | null> {
    const ok = await this.check(block, state);
    if (ok === true) {
      this.lastVerified = block;
      this.failedAt = null;
      this.gaveUp = false;
      this.setVerified(true);
    } else if (ok === false) {
      this.options.metrics.verifyFailures += 1;
      this.failedAt = block.number;
      this.setVerified(false);
    }
    return ok;
  }

  /** null: could not check (an RPC error, or a block the node does not have). */
  private async check(block: BlockRef, state: PoolState): Promise<boolean | null> {
    const { reader, issuance, metrics, now } = this.options;
    try {
      const [slot, supply] = await Promise.all([reader.poolSlot(block.hash), reader.totalSupply(block.hash)]);
      metrics.verifications += 1;
      const ok = slot.sqrtPriceX96 === state.sqrtPriceX96 && slot.tick === state.tick && slot.liquidity === state.liquidity && issuance - supply === state.burnedRaw;
      if (!ok) {
        console.error(`[indexer] verification failed at ${block.number}: chain √P ${slot.sqrtPriceX96} tick ${slot.tick} L ${slot.liquidity} burned ${issuance - supply}; derived √P ${state.sqrtPriceX96} tick ${state.tick} L ${state.liquidity} burned ${state.burnedRaw}`);
      }
      return ok;
    } catch (error) {
      metrics.verifySkipped += 1;
      if (now() - this.lastSkipWarnMs > 60_000) {
        this.lastSkipWarnMs = now();
        console.warn(`[indexer] verification skipped at ${block.number}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    }
  }

  private setVerified(verified: boolean): void {
    if (this.options.metrics.verified === verified) return;
    this.options.metrics.verified = verified;
    this.options.onVerdict(verified);
  }
}
