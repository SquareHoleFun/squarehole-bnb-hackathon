import { formatEth } from './jobs';
import { seededRng } from './rng';

/**
 * Price pokes (F91 R17C; F96 R19G; ADR-0017 § 11): FIT's executor and every graduated box's sampler, each block while
 * spot is more than 1% from the latest sample: 100 ticks or more, since 1.0001^100 ≈ 1.01005 is already more than 1%
 * and 1.0001^99 ≈ 1.00995 is not (review round 1, L2). A sample moves at most 100 ticks
 * (`BoxPriceSampler.sol:125-147`, `EXECUTOR_MAX_OBSERVATION_STEP`), so a big move takes a poke per 100 ticks.
 * Ticks are price exponents, not amounts, so plain numbers are fine here.
 */
export const POKE_TRIGGER_TICKS = 100;
export const SAMPLE_STEP_TICKS = 100;
/** `BoxPriceSampler.CHECKPOINT_SPACING`: ceil(3,600 / 7) seconds; a top-up keeps the checkpoints fresh. */
export const TOP_UP_SECONDS = 515n;
/** About 62k gas a poke transaction (ADR-0017 § 11, round-18's 41,396 inside the call) [I]. */
export const POKE_TX_GAS = 62_000n;
export const BLOCKS_PER_DAY = 7_200;

export function pokeDue(spot: number, sample: number, lastPokeBlock: bigint | undefined, block: bigint): boolean {
  if (lastPokeBlock !== undefined && lastPokeBlock >= block) return false;
  return Math.abs(spot - sample) >= POKE_TRIGGER_TICKS;
}

export function nextSample(sample: number, spot: number): number {
  return Math.max(sample - SAMPLE_STEP_TICKS, Math.min(sample + SAMPLE_STEP_TICKS, spot));
}

/** A top-up is due once the newest checkpoint is a checkpoint spacing old (review round 1, L4: not the latest sample). */
export function topUpDue(checkpointTime: bigint, now: bigint): boolean {
  return now - checkpointTime >= TOP_UP_SECONDS;
}

/** The pokes the trigger sends over a per-block tick history, the sample starting at the first tick. */
export function countPokes(ticks: readonly number[]): number {
  let sample = ticks[0] ?? 0;
  let pokes = 0;
  for (const spot of ticks) {
    if (!pokeDue(spot, sample, undefined, 0n)) continue;
    sample = nextSample(sample, spot);
    pokes++;
  }
  return pokes;
}

/** A seeded random walk of per-block ticks with `dailyVolBps` daily volatility (log price), 12-second blocks. */
export function randomWalk(seed: number, dailyVolBps: number, blocks: number): number[] {
  const rng = seededRng(seed);
  const perBlockTicks = dailyVolBps / 10_000 / Math.sqrt(BLOCKS_PER_DAY) / Math.log(1.0001);
  const ticks: number[] = [0];
  let x = 0;
  for (let i = 1; i < blocks; i++) {
    const z = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    x += z * perBlockTicks;
    ticks.push(Math.round(x));
  }
  return ticks;
}

export interface PokeReport {
  readonly name: string;
  readonly blocks: number;
  readonly pokes: number;
  readonly pokesPerDay: number;
  readonly ethPerMonthPerBoxAt1Gwei: string;
  readonly ethPerMonthPer10BoxesAt1Gwei: string;
}

/** Pokes per day and their cost a month at 1 gwei, per box and per 10 boxes (the ticket's founder figure). */
export function pokeReport(name: string, ticks: readonly number[]): PokeReport {
  const pokes = countPokes(ticks);
  const pokesPerDay = ticks.length === 0 ? 0 : Math.round((pokes * BLOCKS_PER_DAY) / ticks.length);
  const monthWei = BigInt(pokesPerDay) * 30n * POKE_TX_GAS * 10n ** 9n;
  return {
    name,
    blocks: ticks.length,
    pokes,
    pokesPerDay,
    ethPerMonthPerBoxAt1Gwei: formatEth(monthWei),
    ethPerMonthPer10BoxesAt1Gwei: formatEth(monthWei * 10n),
  };
}
