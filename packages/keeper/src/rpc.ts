import { HttpRequestError, fallback, http, type HttpTransportConfig, type Transport } from 'viem';
import type { KeeperConfig } from './config';

type Notice = 'rpc fallback in use' | 'rpc fallback refused';

/**
 * How long a primary with a fallback rests after a transport failure. viem's fallback asks the primary first on every
 * request, and a hanging primary costs its whole timeout and retries each time (the server: 15 s and one retry), so
 * without a rest a tick of sequential reads outlives the service's cycle limit before the fallback can finish it.
 */
export const RPC_PRIMARY_REST_MS = 300_000;

/** Shared endpoint cooldown, including publicnode's JSON-RPC rate limit with no Retry-After. */
function retryable(error: unknown): boolean {
  for (let e = error as { name?: string; status?: number; code?: number; cause?: unknown } | undefined, depth = 0;
    e && depth < 12; e = e.cause as typeof e, depth++) {
    if (e.name === 'TimeoutError' || e.status === 429 || (e.status !== undefined && e.status >= 500) || e.code === -32005) return true;
  }
  return false;
}

export function rpcBackoff(error: unknown, failures: number, now = Date.now(), random = Math.random): number {
  let retryAfter = 0;
  for (let e = error as { headers?: Headers; cause?: unknown } | undefined, depth = 0; e && depth < 12; e = e.cause as typeof e, depth++) {
    const value = e.headers?.get('Retry-After');
    if (!value) continue;
    const ms = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    if (Number.isFinite(ms)) retryAfter = Math.max(retryAfter, ms);
  }
  return Math.max(retryAfter, Math.ceil(Math.min(60_000, 2000 * 2 ** Math.min(failures - 1, 8)) * (1 + random() / 4)));
}

/** No answer from the endpoint: viem's http transport timed out or the HTTP request failed (network or status). */
function unanswered(error: unknown): boolean {
  for (let e = error as { name?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 8; e = e.cause as typeof e, depth++) {
    if (e.name === 'TimeoutError' || e.name === 'HttpRequestError') return true;
  }
  return false;
}

/** Candidate batching and diagnostic requests have independent endpoint checks and failure state. */
export function keeperTransport(
  cfg: Pick<KeeperConfig, 'rpcUrl' | 'rpcFallbackUrl' | 'chainId'>,
  options: Pick<HttpTransportConfig, 'batch' | 'retryCount' | 'timeout'>,
  onFallback: (message: Notice) => void,
): Transport {
  const candidate = checkedTransport(cfg, options, onFallback);
  // viem batches by URL across clients: a separate client alone does not isolate a slow header reply.
  const diagnosticTransport = checkedTransport(cfg, { ...options, batch: false }, onFallback);
  return parameters => {
    const transport = candidate(parameters);
    return { ...transport, value: { ...transport.value, diagnosticTransport } };
  };
}

/** Check each endpoint before using it. A wrong chain is refused until this process restarts. */
function checkedTransport(
  cfg: Pick<KeeperConfig, 'rpcUrl' | 'rpcFallbackUrl' | 'chainId'>,
  options: Pick<HttpTransportConfig, 'batch' | 'retryCount' | 'timeout'>,
  onFallback: (message: Notice) => void,
): Transport {
  let lastUse: number | undefined;
  const checked = (url: string, backup: boolean, rests: boolean): Transport => {
    let refused = false;
    let check: Promise<string> | undefined;
    let restingUntil = 0;
    let coolingUntil = 0;
    let failures = 0;
    return parameters => {
      const transport = http(url, { ...options, retryCount: 0, onFetchResponse(response) {
        if (response.status === 429 || response.status >= 500) {
          throw new HttpRequestError({ url, status: response.status, headers: response.headers });
        }
      } })(parameters);
      const requestWithBackoff = (async (...parameters: Parameters<typeof transport.request>) => {
        const [args, requestOptions] = parameters;
        for (let attempt = 0; ; attempt++) {
          // Concurrent reads share one deadline. A batch of 429s must not multiply the exponent.
          while (Date.now() < coolingUntil) await new Promise(resolve => setTimeout(resolve, Math.min(2_147_483_647, coolingUntil - Date.now())));
          const began = Date.now();
          try {
            const result = await transport.request(args, { ...requestOptions, retryCount: 0 });
            if (began >= coolingUntil) failures = 0;
            return result;
          } catch (error) {
            if (!retryable(error) || (options.retryCount ?? 1) === 0) throw error;
            if (began >= coolingUntil) failures++;
            coolingUntil = Math.max(coolingUntil, Date.now() + rpcBackoff(error, failures));
            if (attempt >= (options.retryCount ?? 1)) throw error;
          }
        }
      }) as typeof transport.request;
      const request = (async (...parameters: Parameters<typeof transport.request>) => {
        const [args, requestOptions] = parameters;
        if (refused) throw new Error('rpc on another chain');
        // A plain error: viem's fallback moves on to the next endpoint at once.
        if (rests && Date.now() < restingUntil) throw new Error('rpc primary resting');
        try {
          const firstCheck = check === undefined;
          check ??= (async () => {
            const id = await requestWithBackoff({ method: 'eth_chainId' });
            if (BigInt(id as string) !== BigInt(cfg.chainId)) {
              refused = true;
              onFallback('rpc fallback refused');
              throw new Error('rpc on another chain');
            }
            return id as string;
          })().catch(error => { check = undefined; throw error; });
          const id = await check;
          const answer = firstCheck && args.method === 'eth_chainId' ? id : await requestWithBackoff(args, requestOptions);
          if (backup) {
            const now = Date.now();
            if (lastUse === undefined || now - lastUse >= 3_600_000) {
              lastUse = now; onFallback('rpc fallback in use');
            }
          }
          return answer;
        } catch (error) {
          // A node that answered, even with a JSON-RPC error, is not resting.
          if (rests && unanswered(error)) restingUntil = Date.now() + RPC_PRIMARY_REST_MS;
          throw error;
        }
      }) as typeof transport.request;
      return { ...transport, request };
    };
  };
  const backup = cfg.rpcFallbackUrl && cfg.rpcFallbackUrl !== cfg.rpcUrl ? cfg.rpcFallbackUrl : null;
  const primary = checked(cfg.rpcUrl, false, Boolean(backup));
  return backup ? fallback([primary, checked(backup, true, false)], { retryCount: 0 }) : primary;
}
