/**
 * Illustrative block clock for the local demo chain (31337): block n is mined at GENESIS + 12 s x n. The same clock
 * is used by scripts/gen-claims-fixture.py; fixtures-m23.test.ts checks both agree. Not a real chain.
 *
 * The SH-004 feed `stale` scenario predates this clock and keeps its own illustrative block number ('4200').
 */
import { parseIsoTimestamp } from '@squarehole/domain';

export const DEMO_BLOCK_CLOCK = Object.freeze({ genesis: '2026-09-20T00:00:00Z', blockSeconds: 12 });

const GENESIS_MS = parseIsoTimestamp(DEMO_BLOCK_CLOCK.genesis);
const BLOCK_MS = DEMO_BLOCK_CLOCK.blockSeconds * 1000;

/** Block number (decimal string) of the demo block mined at `at`; throws RangeError off the clock. */
export function demoBlockAt(at: string): string {
  const elapsed = parseIsoTimestamp(at) - GENESIS_MS;
  if (elapsed < 0 || elapsed % BLOCK_MS !== 0) throw new RangeError(`${at} is not on the demo block clock`);
  return String(elapsed / BLOCK_MS);
}
