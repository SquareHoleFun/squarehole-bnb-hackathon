/**
 * Entry point: `pnpm --filter @squarehole/indexer start` (Node 24, native type stripping; see scripts/register-ts.mjs).
 * Environment: see `loadServiceConfig` (SH_POOL_TARGET sepolia-full|sepolia-rehearsal, SH_INDEXER_PORT 5393, SH_STORE
 * redis|memory, SH_REDIS_URL redis://127.0.0.1:5395/0, SH_WS_URLS, SH_HTTP_URLS, SH_CONFIRMATIONS, SH_ROLE
 * all|indexer|gateway, SH_DISABLE_WS).
 */
import { loadServiceConfig } from './config';
import { logLine, startService } from './service';

const config = loadServiceConfig();
logLine('starting', { target: config.target.id, role: config.role, store: config.store, port: config.port, ws: config.wsUrls, http: config.httpUrls, pool: config.target.poolId });
const service = await startService(config);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logLine('stopping', { signal });
  await service.stop();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
