import { SET_MAX_PAGE } from './spec';

/** Section 4.9 transaction defaults. Commitment pages retain their independent 32-entry maximum. */
export const SET_LOAD_BATCH = 16;
export const SET_RETURN_BATCH = 16;
export const SET_PICK_BATCH = 32;
export const SET_RELEASE_BATCH = 32;

/** Retry sizing only: at one item the caller must stop or retry explicitly, never loop unconditionally. */
export function smallerBatch(size: number): number {
  if (!Number.isInteger(size) || size < 1 || size > SET_MAX_PAGE) throw new RangeError('batch must be 1..32');
  return Math.max(1, Math.floor(size / 2));
}
