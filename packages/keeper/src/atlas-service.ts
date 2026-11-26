import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { atlasBook, atlasSettingsFrom, bookRates, setAtlasRates, type AtlasRatesLog } from './atlas-rates';
import type { KeeperConfig } from './config';

/**
 * SH-266: the Atlas price reading of the keeper's process, one initialisation and one step for BOTH entry points (the
 * standalone `main.ts` and the packaged service `infra/server/services/keeper.mjs`, whose cycle calls `runTick`
 * directly). Before each tick the book is read (at most every 15 s; a price is taken only when two endpoints give the
 * same answer). The band's references are saved beside the state file (written, synced, renamed, folder synced) and
 * restored at start; an existing file that cannot be read, or a save that fails, holds every valuation until a save
 * succeeds.
 * Off unless SH_KEEPER_ATLAS=1. The keeper sends nothing for Atlas: the copy into the mirror and the setter's pokes are
 * the operator's (packages/contracts/script/bnb/atlas-real.mjs).
 */
export interface AtlasService {
  beforeTick(): Promise<void>;
}

export interface AtlasServiceInput {
  readonly env: Record<string, string | undefined>;
  readonly cfg: KeeperConfig;
  readonly log: AtlasRatesLog;
  readonly now?: () => bigint;
}

/** A JSON file written whole: temporary file synced, renamed, folder synced. Loading tells absent from unreadable. */
function syncedJson(path: string): { load(): { state: 'absent' | 'ok' | 'unreadable'; value: unknown }; save(value: unknown): void } {
  return {
    load() {
      let text: string;
      try { text = readFileSync(path, 'utf8'); }
      catch (error) { return { state: (error as { code?: string }).code === 'ENOENT' ? 'absent' : 'unreadable', value: null }; }
      try { return { state: 'ok', value: JSON.parse(text) }; } catch { return { state: 'unreadable', value: null }; }
    },
    save(value) {
      const tmp = `${path}.tmp`;
      const fd = openSync(tmp, 'w', 0o600);
      try { writeSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, path);
      const dir = openSync(dirname(path), 'r');
      try { fsyncSync(dir); } finally { closeSync(dir); }
    },
  };
}

export function startAtlasService(input: AtlasServiceInput): AtlasService | null {
  const { env, cfg, log } = input;
  const settings = atlasSettingsFrom(env, cfg.chainId);
  if (!settings.enabled) return null;
  const now = input.now ?? (() => BigInt(Math.floor(Date.now() / 1000)));
  const base = cfg.stateFile + (cfg.dryRun ? '.dry' : '');
  const book = atlasBook(settings, [cfg.rpcUrl, ...(cfg.rpcFallbackUrl ? [cfg.rpcFallbackUrl] : [])]);
  const refs = syncedJson(`${base}.atlas.json`);
  const loaded = refs.load();
  // An existing file that cannot be read is not a first start: valuations wait until a save rewrites it.
  let held: string | null = loaded.state === 'unreadable' ? 'references unreadable' : null;
  if (loaded.state === 'ok') book.restore(loaded.value);
  if (held) log.warn('atlas: references unreadable, valuations wait until they are rewritten', {});
  setAtlasRates(bookRates(book, String(cfg.chainId), now, log, undefined, () => held));
  log.info('atlas prices on', { feeds: book.feeds.map(f => f.name).join(','), mainnetEndpoints: String(settings.mainnetRpcUrls.length) });
  return {
    async beforeTick() {
      await book.refresh(now());
      try { refs.save(book.references()); held = null; }
      catch { held = 'references not saved'; log.warn('atlas: references not saved, valuations wait', {}); }
    },
  };
}
