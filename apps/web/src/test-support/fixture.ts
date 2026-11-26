/** Test-only access to the bundled demo fixture records (the provider package does not export the JSON). */
import type { PairRecord } from '@squarehole/domain';
import fixture from '../../../../packages/providers/src/fixtures/feed.json';

export const FIXTURE_ASOF = fixture.asOf;
export const FIXTURE_PAIRS = fixture.items as unknown as readonly PairRecord[];

export function fixturePair(name: string): PairRecord {
  const pair = FIXTURE_PAIRS.find((p) => p.name === name);
  if (!pair) throw new Error(`fixture pair ${name} missing`);
  return pair;
}

/** Fixture pair id by its last address byte, e.g. pairIdOf('66') → 31337:0x…0066. */
export const pairIdOf = (suffix: string): string => `31337:0x${suffix.padStart(40, '0')}`;
