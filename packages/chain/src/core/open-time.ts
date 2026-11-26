/**
 * Opening at a clock time (BoxSpec field 15 `openAt`, docs/design/open-at-clock-time.md): the rules the hook, the launch
 * router and the tickets apply, for the indexer and the site. Unix seconds as bigint.
 *
 * - The open: the spec's `openAt` when it is after the creation block's time, else that time + 1, the block after the
 *   creation (`openAt` 0 is Now; a creation that lands at or after the picked time opens in the next block too).
 * - The window: `block.timestamp` in [openAt, openAt + WINDOW_SECONDS); a block's tax step is
 *   (block.timestamp − openAt) / TAX_STEP_SECONDS, 0 … 31 (BoxLaunchRouter `taxPips(step)`).
 * - When the open is seen: in the first block whose timestamp is at or after `openAt`. Since the Merge every Ethereum
 *   block's timestamp is genesis + slot × 12, so that block comes at the first slot time at or after `openAt`. On
 *   mainnet the slots fall 11 seconds into each 12 (genesis 1,606,824,023 mod 12 = 11): a box set for 18:00:00 UTC
 *   opens in the block of 18:00:11. Sepolia's slots fall on whole multiples of 12 (genesis 1,655,733,600).
 */
import { TAX_STEP_SECONDS, WINDOW_SECONDS, WINDOW_STEPS } from '@squarehole/box-spec';

/** One Ethereum slot (seconds). */
export const SLOT_SECONDS = 12n;

/** Beacon chain genesis times by chain id: block timestamps are genesis + slot × 12 since the Merge. */
export const SLOT_GENESIS_TIME: Readonly<Record<number, bigint>> = Object.freeze({ 1: 1_606_824_023n, 11_155_111: 1_655_733_600n });

/** The open the contracts record for a spec's `openAt` and the creation block's time (Now and a reached time: + 1). */
export function effectiveOpenAt(specOpenAt: bigint | number, creationTime: bigint): bigint {
  const at = BigInt(specOpenAt);
  return at > creationTime ? at : creationTime + 1n;
}

/** The end of the launch window (BoxHook.windowEndsAt): openAt + WINDOW_SECONDS. */
export const windowEndsAtOf = (openAt: bigint): bigint => openAt + WINDOW_SECONDS;

/**
 * The time of the first block at or after `at`: the first slot time at or after it when the chain's slots are known
 * (`slotGenesis`), else `at` itself (a local chain mines on demand). Before genesis: `at`.
 */
export function firstBlockTimeAtOrAfter(at: bigint, slotGenesis: bigint | null): bigint {
  if (slotGenesis === null || at <= slotGenesis) return at;
  const offset = (at - slotGenesis) % SLOT_SECONDS;
  return offset === 0n ? at : at + SLOT_SECONDS - offset;
}

/** The tax step (0 … WINDOW_STEPS − 1) of a block at `time`, or null outside the window [openAt, openAt + 384). */
export function windowStepAt(openAt: bigint, time: bigint): number | null {
  if (time < openAt || time >= openAt + WINDOW_SECONDS) return null;
  const step = (time - openAt) / TAX_STEP_SECONDS;
  return step < WINDOW_STEPS ? Number(step) : null;
}
