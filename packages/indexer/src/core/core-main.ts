/**
 * Entry point of the core v1/v2 service: `pnpm --filter @squarehole/indexer start:core` (Node 24, type stripping; see
 * scripts/register-ts.mjs). Environment: core-config.ts. Logs are one JSON line each on stdout. While the manifest
 * awaits the broadcast the service idles on the gateway's address and starts once the file names a deployment (idle.ts).
 * Configured RPC URLs are logged as origins only, and console output is redacted, so a keyed URL stays out of the logs
 * (redact.ts).
 */
import { createPublicClient, fallback, http } from 'viem';
import { logLine } from '../service';
import { loadArt, DirArtStore, MemoryArtStore } from './art';
import { createOptionsDirectoryOf, idleOptionsOf } from './core-config';
import { PACE_12S } from './chain-indexer';
import { RpcCoreReader } from './core-reader';
import { startCoreService } from './core-service';
import { claimsRpcReaderV2 } from './v2/claims-reads-v2';
import { idleUntilDeployed } from './idle';
import { redactConsole, redactUrl, urlRedactor } from './redact';
import { startHistory } from '../history/history-service';
import { startLinks } from '../links/links-service';
import { Erc1271Verifier, erc1271Rpc } from './v2/links-v2';
import { createPictureCopies } from '../pictures/service';
import { boxPricesFrom } from './atlas-prices';

const csv = (value: string | undefined): string[] => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
redactConsole(urlRedactor([...csv(process.env.SH_CORE_HTTP_URLS), ...csv(process.env.SH_CORE_WS_URLS)]));
// A fatal error (viem's carry the RPC URL) is printed through the redacted console, then the process exits non-zero as
// Node would (the server's restart policy brings it back).
const fatal = (error: unknown): void => {
  console.error('[core] fatal:', error);
  process.exit(1);
};
process.on('uncaughtException', fatal);

const stopping = new AbortController();
let stopService: (() => Promise<void>) | null = null;
async function shutdown(signal: string): Promise<void> {
  if (stopping.signal.aborted) return;
  logLine('core_stopping', { signal });
  stopping.abort();
  await stopService?.();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function main(): Promise<void> {
  const createOptionsDirectory = createOptionsDirectoryOf();
  const idle = idleOptionsOf();
  const config = await idleUntilDeployed({ env: process.env, port: idle.port, host: idle.host, pollMs: idle.manifestPollMs, signal: stopping.signal, log: logLine });
  if (!config || stopping.signal.aborted) return;
  const pace = config.pace ?? PACE_12S;
  logLine('core_starting', { chainId: config.manifest.chainId, network: config.manifest.network, port: config.port, http: config.httpUrls.map(redactUrl), ws: config.wsUrls.map(redactUrl), pace: { shortGap: String(pace.shortGap), rangeTail: String(pace.rangeTail), linkedTail: String(pace.linkedTail) }, history: config.history, linksStore: config.history === 'postgres' ? 'postgres' : 'memory', artGateways: config.art.gateways.length, maxStreamsPerClient: config.maxStreamsPerClient, trustedProxies: config.trustedProxies });
  // The item route's verified pictures (art.ts). No picture check decides a listing (SH-NO-PICTURE-GATE): every box
  // that passes the code checks is listed, and the site shows a placeholder until its pictures verify.
  const artOptions = { gateways: config.art.gateways, store: config.art.dir ? new DirArtStore(config.art.dir) : new MemoryArtStore() };
  const reader = new RpcCoreReader({ urls: config.httpUrls });
  // Use the indexing endpoints for canonical, sender-aware claims reads, including refused-payee quotes.
  const claimsReader = claimsRpcReaderV2(createPublicClient({ transport: fallback(
    config.httpUrls.map(url => http(url, { timeout: 10_000, retryCount: 0, batch: false })),
    { retryCount: 0 },
  ) }));
  const history = await startHistory(config);
  const links = await startLinks(config, config.manifest.chainId).catch(async error => { await history?.close(); throw error; });
  const linksVerifier = new Erc1271Verifier(erc1271Rpc(config.httpUrls));
  // SH-266: Atlas prices for the box view (chain 97; SH_CORE_ATLAS=0 turns them off). Read here, never by the browser.
  const prices = boxPricesFrom(process.env, config.manifest.chainId, config.httpUrls);
  prices?.start();
  const service = await startCoreService({
    createOptionsDirectory,
    manifest: config.manifest,
    ...(config.setManifest ? {setManifest: config.setManifest} : {}),
    reader,
    claimsReader,
    links,
    linksVerifier,
    pictures: createPictureCopies(config),
    ...(prices ? { prices } : {}),
    port: config.port,
    host: config.host,
    wsUrls: config.wsUrls,
    pollMs: config.pollMs,
    pace,
    onHistory: history?.writer.accept ?? undefined,
    history: history?.query ?? null,
    historyHealth: history ? () => history.writer.health() : null,
    itemArt: (sha256) => loadArt(sha256, artOptions),
    maxStreamsPerClient: config.maxStreamsPerClient,
    trustedProxies: config.trustedProxies,
  }).catch(async error => { prices?.stop(); await links.stop(); await history?.close(); throw error; });
  stopService = async () => {
    await service.stop();
    prices?.stop();
    await links.stop();
    await history?.close();
  };
  logLine('core_listening', { host: config.host, port: config.port, head: service.indexer.head()?.number, boxes: service.indexer.boxes.size });
}

main().catch(fatal);
