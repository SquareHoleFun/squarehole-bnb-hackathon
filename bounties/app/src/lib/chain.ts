import { limitedFetch, READ_TIMEOUT_MS } from './limiter';
import { createPublicClient, defineChain, fallback, http, type Chain, type PublicClient } from 'viem';
import type { AppConfig } from './config';

/** The one chain this page reads and writes: BNB Chain Testnet (97), the platform's names (testnet-profile.ts). */
export const CHAIN_ID = 97;

export function chainFor(config: Pick<AppConfig, 'rpcUrls' | 'explorer'>): Chain {
  return defineChain({
    id: CHAIN_ID,
    name: 'BNB Chain Testnet',
    nativeCurrency: { name: 'BNB', symbol: 'tBNB', decimals: 18 },
    rpcUrls: { default: { http: config.rpcUrls } },
    blockExplorers: { default: { name: 'BscScan', url: config.explorer } },
    testnet: true,
  });
}

/** No request leaves for a host outside the file's endpoints: redirects are refused (and no off-chain lookups, below). */
const NO_REDIRECT = { redirect: 'error' } as const;

/**
 * Reads go to the first endpoint; a refused or failed request goes on to the next endpoint in the list at once (after
 * the page's pause, lib/limiter.ts). When every endpoint failed, the round is tried once more. SH-303: once, not three
 * times: the limiter already spaces the reads, and a failing read reaches its screen (the numbers' age) within seconds. `config.rpcUrls` here is the list `checkReadChain` admitted. CCIP Read
 * (a contract asking the page to fetch from a gateway it names) is off.
 */
export function publicClientFor(config: AppConfig): PublicClient {
  // SH-303: every read waits for the page's one limiter (a refused read pauses all of them, growing), and is told back
  // The batch is sent at the end of the moment the reads are asked in (no wait): a page's read is a chain of dependent
  // reads, and a 40 ms wait per step made a screen show a step seconds late (four.spec at the end of a sale).
  // One retry budget per read: each endpoint one try (its own retryCount would win over the fallback's), then the
  // whole list once more: at most two tries per endpoint.
  const transports = config.rpcUrls.map((u) => http(u, { batch: true, retryCount: 0, timeout: READ_TIMEOUT_MS, fetchOptions: NO_REDIRECT, fetchFn: limitedFetch() }));
  return createPublicClient({
    chain: chainFor(config),
    ccipRead: false,
    transport: fallback(transports, { retryCount: 1, retryDelay: 400 }),
  });
}

/**
 * Every read endpoint that answers must be on chain 97 (else the page refuses to start, naming the first that is
 * not). The answer is the endpoints that answered 97, in the file's order: only they read for this page. One that did
 * not answer is not used until a reload asks it again.
 */
export async function checkReadChain(config: AppConfig): Promise<{ ok: true; rpcUrls: string[] } | { ok: false; problem: string }> {
  const admitted: string[] = [];
  for (const u of config.rpcUrls) {
    try {
      const id = await createPublicClient({ ccipRead: false, transport: http(u, { retryCount: 2, retryDelay: 400, fetchOptions: NO_REDIRECT }) }).getChainId();
      if (id !== CHAIN_ID) return { ok: false, problem: `the read endpoint ${new URL(u).host} is on chain ${id}, not 97` };
      admitted.push(u);
    } catch {
      continue;
    }
  }
  return admitted.length ? { ok: true, rpcUrls: admitted } : { ok: false, problem: 'no read endpoint answered' };
}

export const txUrl = (config: AppConfig, hash: string) => `${config.explorer}/tx/${hash}`;
export const addressUrl = (config: AppConfig, address: string) => `${config.explorer}/address/${address}`;

/** 0x1234…abcd */
export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** The native coin's symbol on the page: "BNB", as on the platform's pages (the wallet's own symbol stays "tBNB"). */
export function nativeSymbol(_config?: unknown): string {
  return 'BNB';
}
