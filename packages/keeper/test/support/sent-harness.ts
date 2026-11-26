/**
 * SH-249: the live entries' wiring for tests (main.ts and infra/server/services/keeper.mjs): a real StateStore with its
 * journal and both sidecars, and the durable saved-transaction record attached to the adapter. On the line's src (the
 * control runs) the store has no record and the adapter nothing to attach: the wiring then degrades to the journal alone.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ViemChain } from '../../src/chain';
import type { KeeperState, RunConfig } from '../../src/run';
import { StateStore } from '../../src/state';
import * as sent from '../../src/sent';
import { dummy, type QuietWiring } from './sent-quiet';
import { addr } from './v2';

/** The entries' identity format: chain id, keeper, registry, box 0 coordinator. */
export const IDENTITY = `11155111:${dummy.address.toLowerCase()}:${addr(10)}:`;
type Optional = { loadSent?: (s: KeeperState) => unknown; saveSent?: (r: unknown) => void };

/** One keeper process on `dir`: load the books, attach the record, checkpoint through the store. */
export function openProcess(dir: string, chain: ViemChain) {
  const store = new StateStore(join(dir, 'keeper.json'), IDENTITY);
  const state = store.load();
  const s = store as unknown as Optional;
  const track = (chain as unknown as { track?: (b: unknown) => void }).track;
  const Book = (sent as unknown as { SentBook?: new (r: unknown, w: (r: unknown) => void) => unknown }).SentBook;
  if (s.loadSent && s.saveSent && track && Book) track.call(chain, new Book(s.loadSent(state), e => s.saveSent?.(e)));
  const checkpoint: RunConfig['checkpoint'] = async (next, now) => { store.save(next, now); };
  return { store, state, checkpoint };
}

export function durableWiring(dir: string): QuietWiring {
  return { wire(chain) { const p = openProcess(dir, chain); return { state: p.state, checkpoint: p.checkpoint }; } };
}

/** The disk as a process that died now would leave it: every book file, without the lock. */
export function crashCopy(dir: string): string {
  const copy = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'sent-crash-'));
  for (const name of readdirSync(dir)) {
    if (name.includes('.lock') || name.endsWith('.pending')) continue;
    if (existsSync(join(dir, name))) copyFileSync(join(dir, name), join(copy, name));
  }
  return copy;
}
