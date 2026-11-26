/**
 * viem public clients for the configured chain: an ordered fallback over the configured keyless RPCs, per-request
 * timeouts, JSON-RPC request batching, and Multicall3 batching of contract reads where Multicall3 exists (Sepolia).
 * Read-only by construction: this module never creates a wallet client and never signs or sends anything.
 */
import { createPublicClient, fallback, http, type PublicClient, type Transport } from 'viem';
import { viemChain } from './config/chains';
import type { ChainConfig } from './config/config';
import { ChainDataError, ChainUnavailableError } from './errors';

export interface ChainClientOptions {
  /** Replaces the HTTP fallback transport (unit tests pass a mocked `custom` transport). */
  readonly transport?: Transport;
  /** Retries per endpoint before the fallback moves on (default 1). */
  readonly retryCount?: number;
}

export type ChainPublicClient = PublicClient;

export function createChainTransport(config: ChainConfig, retryCount = 1): Transport {
  const endpoints = config.rpcUrls.map((url) =>
    http(url, { timeout: config.requestTimeoutMs, retryCount, retryDelay: 250, batch: { batchSize: 64, wait: 8 } }),
  );
  const [only] = endpoints;
  return endpoints.length === 1 && only ? only : fallback(endpoints, { retryCount, rank: false });
}

export function createChainClient(config: ChainConfig, options: ChainClientOptions = {}): ChainPublicClient {
  const transport = options.transport ?? createChainTransport(config, options.retryCount ?? 1);
  return createPublicClient({
    chain: viemChain(config.chainId, config.rpcUrls),
    transport,
    batch: config.multicall3 ? { multicall: { batchSize: 2_048, wait: 8 } } : undefined,
    cacheTime: 1_000,
  }) as ChainPublicClient;
}

/**
 * Checks once that the endpoint serves the configured chain (a mis-pointed RPC must never feed another chain's state
 * into Sepolia or local records). Failure to answer is `ChainUnavailableError`; another chain id is `ChainDataError`.
 */
export function createChainIdGuard(client: ChainPublicClient, expected: number): () => Promise<void> {
  let verified: Promise<void> | null = null;
  return () => {
    verified ??= (async () => {
      let actual: number;
      try {
        actual = await client.getChainId();
      } catch (error) {
        verified = null;
        throw new ChainUnavailableError('The RPC did not answer eth_chainId', { cause: error });
      }
      if (actual !== expected) throw new ChainDataError('wrong_chain', `The RPC serves chain ${actual}, not ${expected}`);
    })();
    return verified;
  };
}
