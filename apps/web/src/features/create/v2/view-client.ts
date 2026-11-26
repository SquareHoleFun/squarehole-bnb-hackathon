/**
 * XR-CREATE-RPC-COUNT F1 (SH-CREATE-RPC-BATCHING): the public client behind the page's chain reads (`rpcTokenReader`,
 * `rpcAlchemistReads`). One fresh Create page sent 424 requests to the keyless public Sepolia RPC, one per read, and a
 * dozen loads drew HTTP 429. On that RPC its view calls now go out folded into Multicall3 `aggregate3` calls (Sepolia's
 * canonical Multicall3; at most 2,048 bytes of calldata each, gathered for 8 ms) and its requests as JSON-RPC batches
 * (at most 64 per HTTP request, gathered for 8 ms).
 *
 * Each call keeps its own answer: a call that reverts inside an aggregate is a revert (the reader's "absent"), one that
 * returns nothing is no data, and a request that fails (a rate limit, a server error, no network, an answer that is not
 * one) fails every call it carried, as it failed each of them alone before. Every other RPC (the local chain, a local
 * twin that carries Sepolia's chain id, a test's) is read one request per call, exactly as before: it may hold no
 * Multicall3. No retries, no offchain lookups (CCIP-Read).
 */
import { SEPOLIA_CHAIN_ID, SEPOLIA_PUBLIC_RPC_URLS, viemChain } from '@squarehole/chain';
import { TESTNET } from '@squarehole/chain/write/wallet';
import { createPublicClient, fallback, http, keccak256, type Hex, type PublicClient } from 'viem';

/** Multicall3 batching: calldata bytes per `aggregate3` call and the wait that gathers them. */
export const VIEW_MULTICALL = Object.freeze({ batchSize: 2_048, wait: 8 });
/** JSON-RPC batching: requests per HTTP request and the wait that gathers them. */
export const VIEW_HTTP_BATCH = Object.freeze({ batchSize: 64, wait: 8 });

/** Whether reads at `rpc` are batched: only the keyless public Sepolia RPCs (Multicall3 is there; so is the rate limit). */
export function batchedRpc(rpc: string, chainId: number): boolean {
  return chainId === SEPOLIA_CHAIN_ID && SEPOLIA_PUBLIC_RPC_URLS.includes(rpc);
}

/** The read-only client for `rpc` (`fetchFn`: a test's fetch). */
export function viewClient(rpc: string, chainId: number, fetchFn?: typeof fetch): PublicClient {
  const batched = batchedRpc(rpc, chainId);
  const transport = http(rpc, { retryCount: 0, ...(batched ? { batch: VIEW_HTTP_BATCH } : {}), ...(fetchFn ? { fetchFn } : {}) });
  if (!batched) return createPublicClient({ transport, ccipRead: false }) as PublicClient;
  return createPublicClient({ chain: viemChain(SEPOLIA_CHAIN_ID, [rpc]), transport, ccipRead: false, batch: { multicall: VIEW_MULTICALL } }) as PublicClient;
}

/** Multicall3's runtime code hash: the same bytes at the canonical address on Sepolia and BNB Chain testnet (read 25 Nov 2026). */
export const MULTICALL3_CODE_HASH = '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891';

/**
 * SH-258 round 3: the box page's read client. On BNB Chain testnet's public RPCs (`batchedRpc`: chain 97 in a BNB
 * build) its reads go out as the Create page's do: JSON-RPC batches, and view calls folded into Multicall3 once the code
 * at the profile's Multicall3 address is Multicall3's (`MULTICALL3_CODE_HASH`; until then, or if it is not, one call
 * each). The profile's other public RPC answers when the first fails (reads only: this client never sends; the wallet
 * sends). Sepolia's box page and every other RPC: one request per read, exactly as before (`plain`).
 */
export function pageClient(rpc: string, chainId: number, plain: () => PublicClient, fetchFn?: typeof fetch): PublicClient {
  if (TESTNET.name === 'sepolia' || !batchedRpc(rpc, chainId)) return plain();
  const endpoints = [rpc, ...SEPOLIA_PUBLIC_RPC_URLS.filter((url) => url !== rpc)]
    .map((url) => http(url, { retryCount: 0, batch: VIEW_HTTP_BATCH, ...(fetchFn ? { fetchFn } : {}) }));
  const transport = fallback(endpoints, { rank: false, retryCount: 0 });
  const single = createPublicClient({ chain: viemChain(SEPOLIA_CHAIN_ID, [rpc]), transport, ccipRead: false }) as PublicClient;
  const folded = createPublicClient({ chain: viemChain(SEPOLIA_CHAIN_ID, [rpc]), transport, ccipRead: false, batch: { multicall: VIEW_MULTICALL } }) as PublicClient;
  const checked = multicallChecked(rpc, single);
  // View calls wait for the one code check; every other method is the single client's.
  return new Proxy(single, {
    get(target, key, receiver) {
      if (key === 'readContract' || key === 'call') {
        return async (...args: unknown[]) => ((await checked ? folded : single)[key] as (...a: unknown[]) => unknown)(...args);
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

const multicallChecks = new Map<string, Promise<boolean>>();
/** Whether the code at the profile's Multicall3 address is Multicall3's (read once per RPC; a failed read asks again next time). */
function multicallChecked(rpc: string, client: PublicClient): Promise<boolean> {
  let check = multicallChecks.get(rpc);
  if (!check) {
    check = client.getCode({ address: TESTNET.multicall3 }).then((code) => typeof code === 'string' && keccak256(code as Hex) === MULTICALL3_CODE_HASH);
    check.catch(() => multicallChecks.delete(rpc));
    multicallChecks.set(rpc, check.catch(() => false));
  }
  return multicallChecks.get(rpc) as Promise<boolean>;
}
