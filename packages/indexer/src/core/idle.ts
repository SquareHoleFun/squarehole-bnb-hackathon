/**
 * The core service before core v1 is deployed on its chain: the manifest says `awaiting-broadcast` (Sepolia's committed
 * placeholder), so there is nothing to index. Instead of exiting (a restart loop on a server), the service idles on the
 * gateway's address and reads the manifest again every `SH_CORE_MANIFEST_POLL_MS`; once the file names a deployment,
 * the idle gateway closes and core-main.ts starts the indexer on that configuration. Replacing the file is enough.
 *
 * The idle gateway is read-only, with core-gateway.ts's CORS, and guesses nothing:
 *
 *   GET /healthz   200 `{ok: true, state: 'awaiting-broadcast', ...}` (the service does what it should: wait), or 503
 *                  `{ok: false, state: 'config-invalid', reason}` when the replaced file (or the configuration it
 *                  completes) is refused; the service keeps idling and logs why
 *   GET /v1/...    503 "awaiting deploy" with Retry-After: the site reads the chain instead (C19)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CoreNotDeployedError, loadCoreConfig, type CoreServiceConfig } from './core-config';

export type IdleState =
  | { readonly state: 'awaiting-broadcast'; readonly chainId: number; readonly network: CoreNotDeployedError['network'] }
  | { readonly state: 'config-invalid'; readonly reason: string };

export interface IdleGateway {
  address(): { readonly host: string; readonly port: number };
  stop(): Promise<void>;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'If-None-Match' };

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
}

function chainWords(state: IdleState): string {
  return state.state === 'awaiting-broadcast' && state.network === 'sepolia' ? 'Sepolia' : 'this chain';
}

function route(req: IncomingMessage, res: ServerResponse, state: IdleState): void {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'read-only' });
  const path = new URL(req.url ?? '/', 'http://gateway').pathname;
  if (path === '/healthz') {
    if (state.state === 'awaiting-broadcast') {
      return send(res, 200, { ok: true, state: state.state, chainId: state.chainId, network: state.network, asOf: null, following: false, reason: `Core v1 is not on ${chainWords(state)} yet: waiting for the deployment manifest`, history: null });
    }
    return send(res, 503, { ok: false, state: state.state, asOf: null, following: false, reason: state.reason, history: null });
  }
  if (path === '/v1' || path.startsWith('/v1/')) {
    const error = state.state === 'awaiting-broadcast' ? `awaiting deploy: Core v1 is not on ${chainWords(state)} yet, nothing to index` : 'awaiting deploy: the configuration was refused (see /healthz)';
    return send(res, 503, { error, state: state.state }, { 'Retry-After': '60' });
  }
  return send(res, 404, { error: 'not found' });
}

/** The idle gateway on `host:port`; `state()` is read on every request. */
export async function startIdleGateway(options: { readonly port: number; readonly host: string; readonly state: () => IdleState }): Promise<IdleGateway> {
  const server: Server = createServer((req, res) => {
    try {
      route(req, res, options.state());
    } catch (error) {
      if (!res.headersSent) send(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  return {
    address() {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('idle gateway not listening');
      return { host: address.address, port: address.port };
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface IdleOptions {
  readonly env: Record<string, string | undefined>;
  readonly read?: (path: string) => string;
  readonly port: number;
  readonly host: string;
  readonly pollMs: number;
  /** Ends the wait (shutdown): the idle gateway closes and the promise resolves null. */
  readonly signal?: AbortSignal;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
  /** Called once the idle gateway listens (tests read the port of `port: 0` from it). */
  readonly onListening?: (address: { readonly host: string; readonly port: number }) => void;
}

/**
 * Idles until the manifest names a deployment and returns that configuration (null when `signal` aborts first). The
 * first state is read before listening: a manifest that is already deployed returns at once, without a gateway, and
 * anything but `awaiting-broadcast` or a deployment at the start throws, as `loadCoreConfig` does.
 */
export async function idleUntilDeployed(options: IdleOptions): Promise<CoreServiceConfig | null> {
  const log = options.log ?? (() => undefined);
  const attempt = (): { readonly config: CoreServiceConfig } | { readonly idle: IdleState } => {
    try {
      return { config: options.read ? loadCoreConfig(options.env, options.read) : loadCoreConfig(options.env) };
    } catch (error) {
      if (error instanceof CoreNotDeployedError) return { idle: { state: 'awaiting-broadcast', chainId: error.chainId, network: error.network } };
      return { idle: { state: 'config-invalid', reason: error instanceof Error ? error.message : String(error) } };
    }
  };
  const first = attempt();
  if ('config' in first) return first.config;
  if (first.idle.state !== 'awaiting-broadcast') throw new Error(first.idle.reason);
  if (options.signal?.aborted) return null;

  let state: IdleState = first.idle;
  const gateway = await startIdleGateway({ port: options.port, host: options.host, state: () => state });
  log('core_idle', { state: state.state, chainId: first.idle.chainId, network: first.idle.network, host: options.host, port: gateway.address().port, pollMs: options.pollMs });
  options.onListening?.(gateway.address());

  return new Promise<CoreServiceConfig | null>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const finish = (value: CoreServiceConfig | null): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void gateway.stop().then(() => resolve(value));
    };
    const onAbort = (): void => finish(null);
    const poll = (): void => {
      const next = attempt();
      if ('config' in next) {
        log('core_manifest_deployed', { chainId: next.config.manifest.chainId, network: next.config.manifest.network });
        finish(next.config);
        return;
      }
      if (next.idle.state !== state.state || (next.idle.state === 'config-invalid' && state.state === 'config-invalid' && next.idle.reason !== state.reason)) {
        log('core_idle', next.idle.state === 'config-invalid' ? { state: next.idle.state, reason: next.idle.reason } : { state: next.idle.state, chainId: next.idle.chainId, network: next.idle.network });
      }
      state = next.idle;
      timer = setTimeout(poll, options.pollMs);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(poll, options.pollMs);
  });
}
