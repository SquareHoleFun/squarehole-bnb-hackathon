/**
 * The indexer's typed model (bigint in logic) and its JSON form (decimal strings in data, CLAUDE.md). Block numbers
 * and timestamps are decimal strings too, so a client never has to guess which fields are safe JS numbers; the only
 * JSON numbers are small bounded integers (tick, bps, pips, counts, log indexes, milliseconds).
 */
import type { Address, Hex } from 'viem';

export interface BlockHeader {
  readonly number: bigint;
  readonly hash: Hex;
  readonly parentHash: Hex;
  readonly timestamp: bigint;
  /** 256-byte logs bloom; absent in fixtures that predate it (then every block is fetched). */
  readonly logsBloom?: Hex;
}

export type HeadSource = 'ws' | 'poll' | 'backfill' | 'fixture';

/**
 * Where the launch stands, from the hook's events (FitPoolHook, ADR-0013 § 2.3b): `completed` after `CurveCompleted`
 * (a block ended at or beyond P1) until `CurveReopened` or `Migrated`. Completed is not "sold out": a block that ends
 * more than 600 ticks back inside the curve reopens it. The events are emitted by the next block's first action, so the
 * phase can trail the price by a block.
 */
export type LaunchPhase = 'curve' | 'completed' | 'migrated';

/** Outside liquidity may be added from the migration block plus this many blocks (FitLaunchShape.OPEN_DELAY_BLOCKS). */
export const OPEN_DELAY_BLOCKS = 32n;

export interface PoolState {
  readonly block: bigint;
  readonly blockHash: Hex;
  readonly timestamp: bigint;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly liquidity: bigint;
  readonly swapCount: number;
  readonly buyCount: number;
  readonly sellCount: number;
  /** Gross ETH through swaps (|amount0|, fee included on buys). Never shown on the band (BOX-SYSTEM § 4.1). */
  readonly volumeWei: bigint;
  readonly feesWei: bigint;
  readonly feesTokenRaw: bigint;
  /** Launch-window tax kept by the router (TaxedBuy.tax). */
  readonly taxWei: bigint;
  /** Tokens burned since issuance (token Transfers to 0x0): initial supply − totalSupply. */
  readonly burnedRaw: bigint;
  readonly lastTradeBlock: bigint | null;
  /** Donations or liquidity changes the hook forbids: anything but its Δ0 fee collection, its seed and its migration
   * before outside liquidity opens (migration + 32 blocks); after that, outside positions are ordinary. */
  readonly anomalies: number;
  readonly phase: LaunchPhase;
  /** The block `CurveCompleted` names (its end was at or beyond P1); null while the curve is open. */
  readonly completedBlock: bigint | null;
  /** The block of the migration (`Migrated`); null before. */
  readonly migratedBlock: bigint | null;
}

export type TradeSide = 'buy' | 'sell';

export interface Trade {
  readonly id: string;
  /** block × 100 000 + logIndex: sortable, below 2^53. */
  readonly score: number;
  readonly block: bigint;
  readonly blockHash: Hex;
  readonly timestamp: bigint;
  readonly txHash: Hex;
  readonly logIndex: number;
  readonly side: TradeSide;
  readonly route: 'launch_router' | 'bootstrap' | 'other';
  /** |Swap.amount0|: ETH paid into the pool (buy, fee included) or paid out (sell). */
  readonly ethRaw: bigint;
  /** |Swap.amount1|: tokens out (buy) or in (sell, fee included). */
  readonly tokenRaw: bigint;
  readonly feeEthRaw: bigint;
  readonly feeTokenRaw: bigint;
  /** Launch tax on top of ethRaw (router buys in the window only). */
  readonly taxRaw: bigint;
  /** TaxedBuy.buyer for a launch-router buy; otherwise the transaction's `from` (Swap.sender is a router, not the wallet). */
  readonly trader: Address | null;
  readonly recipient: Address | null;
  readonly sqrtPriceX96After: bigint;
  readonly tickAfter: number;
  readonly retainedAfterWei: bigint;
  readonly fillBpsAfter: number;
}

export type ActivityKind = 'burn' | 'flush' | 'sweep' | 'window_announced' | 'anomaly' | 'curve_completed' | 'curve_reopened' | 'migration';

export interface Activity {
  readonly id: string;
  readonly score: number;
  readonly kind: ActivityKind;
  readonly block: bigint;
  readonly blockHash: Hex;
  readonly timestamp: bigint;
  readonly txHash: Hex;
  readonly logIndex: number;
  /** burn: bootstrap | collector | executor | holder; flush/sweep/anomaly: a short tag; curve_completed and
   * curve_reopened: the block whose end decided it; migration: `bid:<L>,sentinel:<L>,ask:<L>` (amountRaw the token
   * pulled for the ask, ethRaw the curve's ETH). */
  readonly detail: string;
  readonly amountRaw: bigint;
  readonly ethRaw: bigint;
}

export const SCORE_FACTOR = 100_000;

export function scoreOf(block: bigint, logIndex: number): number {
  if (logIndex < 0 || logIndex >= SCORE_FACTOR) throw new RangeError('logIndex out of range for the score');
  const score = block * BigInt(SCORE_FACTOR) + BigInt(logIndex);
  if (score > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('score beyond 2^53');
  return Number(score);
}

/** First score of a block: everything at or above it belongs to that block or later. */
export function firstScoreOf(block: bigint): number {
  return scoreOf(block, 0);
}

// ------------------------------------------------------------------------------------------------ JSON form

export type Json<T> = T extends bigint
  ? string
  : T extends readonly (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;

/** bigint → decimal string, everything else as is (JSON.stringify replacer). */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}

const STATE_BIGINTS = ['block', 'timestamp', 'sqrtPriceX96', 'liquidity', 'volumeWei', 'feesWei', 'feesTokenRaw', 'taxWei', 'burnedRaw'] as const;

export function stateFromJson(json: string): PoolState {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  for (const key of STATE_BIGINTS) out[key] = BigInt(raw[key] as string);
  for (const key of ['lastTradeBlock', 'completedBlock', 'migratedBlock'] as const) {
    out[key] = raw[key] === null || raw[key] === undefined ? null : BigInt(raw[key] as string);
  }
  out['phase'] = raw['phase'] ?? 'curve';
  return out as unknown as PoolState;
}

const TRADE_BIGINTS = ['block', 'timestamp', 'ethRaw', 'tokenRaw', 'feeEthRaw', 'feeTokenRaw', 'taxRaw', 'sqrtPriceX96After', 'retainedAfterWei'] as const;

export function tradeFromJson(json: string): Trade {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  for (const key of TRADE_BIGINTS) out[key] = BigInt(raw[key] as string);
  return out as unknown as Trade;
}

const ACTIVITY_BIGINTS = ['block', 'timestamp', 'amountRaw', 'ethRaw'] as const;

export function activityFromJson(json: string): Activity {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  for (const key of ACTIVITY_BIGINTS) out[key] = BigInt(raw[key] as string);
  return out as unknown as Activity;
}
