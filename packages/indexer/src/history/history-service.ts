/**
 * Wires the history store and writer for the core service (S10a § 4): `SH_HISTORY=off` (default), `memory`, or `postgres`
 * (a Unix socket directory in SH_HISTORY_PG_HOST keeps it off every TCP port). The gateway's activity pages and candles
 * then come from the store; without one, from the pipeline's recent rows.
 */
import type { CoreServiceConfig } from '../core/core-config';
import type { HistoryQuery } from '../core/core-service';
import { MemoryHistory } from './memory-history';
import { PgHistory } from './pg-history';
import type { HistoryStore } from './types';
import { HistoryWriter } from './writer';

export interface RunningHistory {
  readonly store: HistoryStore;
  readonly writer: HistoryWriter;
  readonly query: HistoryQuery;
  close(): Promise<void>;
}

export async function startHistory(config: Pick<CoreServiceConfig, 'history' | 'pg'>): Promise<RunningHistory | null> {
  if (config.history === 'off') return null;
  const store: HistoryStore = config.history === 'memory' ? new MemoryHistory() : new PgHistory({ host: config.pg.host, port: config.pg.port, database: config.pg.database, user: config.pg.user });
  await store.init();
  const writer = new HistoryWriter(store);
  // SH-NO-PICTURE-GATE upgrade: boxes an older indexer kept unlisted for their pictures, before the pipeline starts.
  await writer.relistPictureHidden();
  return {
    store,
    writer,
    query: { get version() { return store.version; }, activityPage: (chainId, token, options) => store.activityPage(chainId, token, options), candles: (chainId, token, interval, limit) => store.candles(chainId, token, interval, limit) },
    async close() {
      try {
        await writer.flush();
      } finally {
        writer.stop();
        await store.close();
      }
    },
  };
}
