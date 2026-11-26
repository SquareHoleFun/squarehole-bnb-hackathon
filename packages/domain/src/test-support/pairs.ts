/** Test-only builders for synthetic pair records derived from the handoff fixture. */
import type { PairId, PairRecord } from '../types';
import { handoffFixture } from './handoff';

export const ids = (rows: readonly Pick<PairRecord, 'pairId'>[]): string[] => rows.map((row) => row.pairId);

/** Fixture pair id by its last address byte, e.g. pid('66') -> 31337:0x…0066. */
export const pid = (suffix: string): PairId => `31337:0x${suffix.padStart(40, '0')}`;

/** A token record based on fixture item 2 (ROUND TRIP) with overrides and a unique pair id. */
export function makePair(suffix: string, overrides: Partial<PairRecord> = {}): PairRecord {
  const template = handoffFixture().items[2];
  if (!template) throw new Error('fixture item 2 missing');
  return { ...template, pairId: pid(suffix), isPlatform: false, ...overrides };
}
