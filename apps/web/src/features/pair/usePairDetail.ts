/**
 * Pair detail data (SH-012) through the shared query cache. The record (identity, metrics) and the detail (supply,
 * history, rewards, activity) are read from the same feed source as the feed page, in parallel, with the query's
 * AbortSignal. A read failure is an error state, never an empty or zero-valued page.
 */
import type { PairDetail, PairId, PairRecord } from '@squarehole/domain';
import type { MockScenario } from '@squarehole/providers';
import { useQuery } from '@tanstack/react-query';
import { useDataSource } from '../data-source';
import { CHAIN_REFRESH_MS } from '../feed/chain-markets';
import { useFeedContext } from '../feed/feed-context';

export interface PairDetailData {
  readonly record: PairRecord | null;
  /** Null when the provider has the record but no detail (or cannot read details at all). */
  readonly detail: PairDetail | null;
}

export function usePairDetail(pairId: PairId | null, scenario: MockScenario) {
  const { sourceFor } = useFeedContext();
  const { provider } = sourceFor(scenario);
  // The demo fixtures never change. A chain page left open is re-read, so its provenance (an RPC outage, Sepolia's
  // 15-minute rule) is re-evaluated instead of staying "fresh" forever.
  const chain = useDataSource().chain !== null;
  return useQuery({
    queryKey: ['pair-detail', scenario, pairId],
    enabled: pairId !== null,
    staleTime: chain ? CHAIN_REFRESH_MS : Infinity,
    refetchInterval: chain ? CHAIN_REFRESH_MS : false,
    queryFn: async ({ signal }): Promise<PairDetailData> => {
      if (pairId === null) return { record: null, detail: null };
      const readDetail = provider.readPairDetail?.bind(provider);
      const [record, detail] = await Promise.all([
        provider.readPair(pairId, signal),
        readDetail ? readDetail(pairId, signal) : Promise.resolve(null),
      ]);
      return { record, detail: record ? detail : null };
    },
  });
}
