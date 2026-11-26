import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, decodeState, encodeState } from '../../src/state';
import type { KeeperState } from '../../src/run';

/** Reopen both real books under the same exclusive lock, as a process restart does. */
export function restartStarts(state: KeeperState): KeeperState {
  if (!state.incomeSpend?.some(s => s.start)) return decodeState(encodeState(state, 'start'), 'start');
  const file = join(mkdtempSync(join(tmpdir(), 'keeper-starts-')), 'state');
  const first = new StateStore(file, 'start');
  try { first.save(state, 0n); } finally { first.close(); }
  const second = new StateStore(file, 'start');
  try { return second.load(); } finally { second.close(); }
}
