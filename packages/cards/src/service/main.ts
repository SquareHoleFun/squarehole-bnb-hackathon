/**
 * The card service's process (infra/server/compose.yaml `cards`; locally `pnpm --filter @squarehole/cards start`):
 * reads its configuration (config.ts), starts the renderer and draws one sample card as a self-check before it
 * listens (a broken renderer or a missing font stops it here, and Docker restarts it), then answers on SH_CARDS_HOST:
 * SH_CARDS_PORT. Read-only HTTP: no key, no wallet, no transaction.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { nodeCardAssets, nodeCardEngine } from '../engine';
import { renderCardPng } from '../share-render';
import { chainShareReader } from '../share-direct';
import type { ShareBox } from '../share-model';
import { DiskCards } from './cache';
import { CardService } from './card-service';
import { itemPngsOf, serviceConfig } from './config';
import { manifestFile } from './manifest';

const INDEXER_TIMEOUT_MS = 2000;
const RPC_TIMEOUT_MS = 3000;

const info = (line: string): void => void process.stdout.write(`cards: ${line}\n`);
const report = (what: string, error: unknown): void => console.error(`cards: ${what}:`, error instanceof Error ? error.message : String(error));

/** The self-check's card: invented, never served. */
const SAMPLE: ShareBox = {
  chainId: 11_155_111,
  token: `0x${'0'.repeat(40)}`,
  chainLabel: 'Sepolia',
  name: 'Self check',
  ticker: 'CHECK',
  demo: false,
  state: { kind: 'open' },
  logoSha256: null,
};

async function main(): Promise<void> {
  const config = serviceConfig(process.env);
  const engine = await nodeCardEngine(config.engine);
  info(engine.webpDrawing ? 'WebP drawing on' : 'WebP drawing off; decoder unavailable; WebP pictures use the brand card');
  const assets = nodeCardAssets(config.assetsDir);
  const generic = new Uint8Array(readFileSync(config.genericPath));
  if (generic[0] !== 0xff || generic[1] !== 0xd8) throw new Error(`${config.genericPath} is not a JPEG`);
  const started = performance.now();
  const sample = await renderCardPng(SAMPLE, null, assets, engine);
  const checkMs = Math.round(performance.now() - started);
  const sepolia = manifestFile(config.manifestPath);
  const local = config.localManifestPath === null ? null : JSON.parse(readFileSync(config.localManifestPath, 'utf8')) as unknown;
  const service = new CardService({
    config: () => ({ sepoliaManifest: sepolia(), localManifest: local, sepoliaRpcUrls: config.rpcUrls, localRpcUrl: config.localRpcUrl, indexerOrigin: config.indexerOrigin }),
    readers: { fetch: (url, init) => fetch(url, init), direct: chainShareReader(RPC_TIMEOUT_MS), indexerTimeoutMs: INDEXER_TIMEOUT_MS },
    engine,
    assets,
    generic,
    gateways: config.artGateways,
    itemPngs: itemPngsOf(config.itemPngManifestPath ? readFileSync(config.itemPngManifestPath, 'utf8') : undefined),
    // The fixed gateways only: a redirect elsewhere is refused (the bytes are checked against the spec anyway).
    fetchArt: (url, init) => fetch(url, { ...init, redirect: 'error' }),
    disk: config.cacheDir === null ? null : new DiskCards(config.cacheDir, 4000, report),
    engineKind: engine.kind,
    onError: report,
  });

  const server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    service.handle(method, request.url ?? '/').then(
      (answer) => {
        response.writeHead(answer.status, answer.headers);
        response.end(answer.body ?? undefined);
      },
      (error: unknown) => {
        report('answer', error);
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end(method === 'HEAD' ? undefined : 'error\n');
      },
    );
  });
  // Nothing here reads a request body; slow or idle clients are cut off.
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  server.listen(config.port, config.host, () => {
    info(`listening on ${config.host}:${config.port}; resvg ${engine.kind}; self-check card ${sample.byteLength} B in ${checkMs} ms; indexer ${config.indexerOrigin ?? 'none'}; manifest ${config.manifestPath ?? 'none'}; art gateways ${config.artGateways.length}; disk cache ${config.cacheDir ?? 'none'}`);
  });
  const stop = (signal: string) => {
    info(`${signal}: closing`);
    const children = service.close();
    server.close(() => { void children.then(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((error: unknown) => {
  report('start', error);
  process.exit(1);
});
