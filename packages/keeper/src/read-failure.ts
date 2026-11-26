import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError } from 'viem';

/** Whether a failed call was a revert (the call would do nothing), not a node that could not answer (M4). */
export function isRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return error.walk((e) => e instanceof ContractFunctionRevertedError || (e instanceof BaseError && /revert/i.test(e.details))) !== null;
}

/**
 * For the monitor view's `complete` flags: a guarded read that fell back because the node or a consistency check did
 * not answer. A revert or empty return is the chain's answer at the snapshot (an older contract without the view, no
 * code), not a missing reading.
 */
export function readFailed(error: unknown): boolean {
  if (isRevert(error)) return false;
  return !(error instanceof BaseError && error.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
}
