/**
 * SH-BOX-LIFE-VIEW § 3: a v2 box's price coin by its own name, never "P". The native coin is "ETH", as Create names it;
 * a listed coin is its ERC-20 `symbol()`, read the way Create reads a listed coin's symbol
 * (features/create/v2/indexer-listings.ts: a view call over the source's RPC once the RPC has said it serves the
 * source's chain, CCIP-Read off, only a string of 1-32 characters counts, kept for the page's life). While the symbol is
 * unread, or when it cannot be read, the coin is its short address: honest, and still its identity (F123). Nothing here
 * asks a wallet or sends anything.
 */
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { decodeFunctionResult, encodeFunctionData, erc20Abi, type Address } from 'viem';
import { rpcTokenReader } from '../../create/v2/indexer-listings';
import type { TokenReader } from '../../create/v2/issuer-powers';
import type { V2Source } from './indexer-v2';
import { NATIVE_SYMBOL } from '../../data-source/native-coin';

const NATIVE = /^0x0{40}$/i;
const SYMBOL_CALL = encodeFunctionData({ abi: erc20Abi, functionName: 'symbol' });

/** "0x2cbB…f33B": a coin's address, short. */
export const shortCoinV2 = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** The name a price coin is shown by: ETH for the native coin, its symbol once read, else its short address. */
export function coinLabelV2(q: string, symbol: string | null | undefined): string {
  if (NATIVE.test(q)) return NATIVE_SYMBOL;
  return symbol ?? shortCoinV2(q);
}

/**
 * A listed coin's `symbol()`: the string when it reads as 1-32 characters; null when the call reverts, returns no data
 * or no such string. A failed read (the RPC down, another chain) rejects, so it is asked again later.
 */
export async function readCoinSymbolV2(reader: Pick<TokenReader, 'call'>, token: Address): Promise<string | null> {
  const data = await reader.call(token, SYMBOL_CALL);
  if (!data) return null;
  try {
    const symbol = decodeFunctionResult({ abi: erc20Abi, functionName: 'symbol', data });
    return symbol.length > 0 && symbol.length <= 32 ? symbol : null;
  } catch {
    return null;
  }
}

/** One query key per chain, RPC and coin: every page of the session shares one read of a coin's symbol. */
export const coinSymbolKeyV2 = (source: Pick<V2Source, 'network' | 'manifest' | 'rpc'>, coin: string) =>
  ['v2-coin-symbol', source.network, source.manifest.chainId, source.rpc, coin.toLowerCase()] as const;

/**
 * The symbols of a source's listed price coins (`coins`, any order, repeats and the native coin allowed): a function
 * from a coin to its symbol, null while unread or unreadable. Read once per coin for the page's life; a failed read is
 * retried twice (2 s, 4 s), then the short address stays. `reader`: a test seam.
 */
export function usePriceCoinSymbolsV2(source: V2Source | null, coins: readonly string[], reader?: Pick<TokenReader, 'call'>): (coin: string) => string | null {
  // A stable list for a stable set of coins (the feed hands a new array on every read).
  const wantedKey = [...new Set(coins.filter((coin) => !NATIVE.test(coin)).map((coin) => coin.toLowerCase()))].sort().join(',');
  const wanted = useMemo(() => (wantedKey ? wantedKey.split(',') : []), [wantedKey]);
  const chainReader = useMemo(() => reader ?? (source ? rpcTokenReader(source.rpc, source.manifest.chainId) : null), [reader, source]);
  const symbols = useQueries({
    queries: wanted.map((coin) => ({
      queryKey: source ? coinSymbolKeyV2(source, coin) : ['v2-coin-symbol', 'none', coin],
      queryFn: () => {
        if (!chainReader) throw new Error('No RPC for this source');
        return readCoinSymbolV2(chainReader, coin as Address);
      },
      enabled: source !== null && chainReader !== null,
      staleTime: Infinity,
      gcTime: Infinity,
      retry: 2,
      retryDelay: (attempt: number) => 2_000 * 2 ** attempt,
    })),
    // One string per answer set, so the function below changes only when a symbol does.
    combine: (results) => JSON.stringify(results.map((result) => result.data ?? null)),
  });
  return useMemo(() => {
    const read = JSON.parse(symbols) as (string | null)[];
    const byCoin = new Map(wanted.map((coin, i) => [coin, read[i] ?? null]));
    return (coin: string) => byCoin.get(coin.toLowerCase()) ?? null;
  }, [wanted, symbols]);
}
