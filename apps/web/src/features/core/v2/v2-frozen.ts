/**
 * What the v2 box page reads from M1-00's freeze (wave 1 builds on the frozen interfaces, tickets § 4), mirrored from
 * packages/contracts/src/box-v2/interfaces/IBoxCoordinatorV2.sol and pinned against it by v2-frozen.test.ts: the
 * failure causes, the gate's cap and the two entries that close a box. Both entries take no argument and are open to
 * anyone, so their calldata is the selector alone.
 */
import { toFunctionSelector, type Hex } from 'viem';

/** `FailCause` (IBoxCoordinatorV2.sol), by value. */
export const FAIL_CAUSE = Object.freeze({ None: 0, Deadline: 1, ClosedPastCap: 2, GraduationTimedOut: 3 } as const);

/** Why a v2 box closed: its deadline passed with the curve open, or its gate still held 14 days after its open. */
export type FailCauseName = 'deadline' | 'closed-past-cap' | 'graduation-timed-out';

export function failCauseOf(value: number): FailCauseName | null {
  if (value === FAIL_CAUSE.Deadline) return 'deadline';
  if (value === FAIL_CAUSE.ClosedPastCap) return 'closed-past-cap';
  if (value === FAIL_CAUSE.GraduationTimedOut) return 'graduation-timed-out';
  return null;
}

/** `GATE_CAP_SECONDS`: 14 days after `openAt()` a box still closed may be closed by anyone. */
export const GATE_CAP_SECONDS = 1_209_600n;

/** `fail()` from the deadline while the curve is open; `failClosed()` from the gate's cap while the gate holds. */
export const CLOSE_SIGNATURES = Object.freeze({ fail: 'fail()', failClosed: 'failClosed()' } as const);

export type CloseCall = keyof typeof CLOSE_SIGNATURES;

export const closeCallData = (call: CloseCall): Hex => toFunctionSelector(CLOSE_SIGNATURES[call]);
