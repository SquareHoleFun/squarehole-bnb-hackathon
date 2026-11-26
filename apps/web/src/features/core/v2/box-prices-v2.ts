/**
 * SH-306: the open box page's dollar figures. The indexer publishes `prices` (SH-266, Atlas prices it reads itself) only
 * on the single-box answer, `GET /v2/boxes/<chain>/<token>`, never on the feed's cards; the site loads every box from
 * the feed. So the open box page, and nothing else, reads its own box's answer for `prices` alone, through the tolerant
 * `usdPricesOf`, and lays them over the view it already has from the feed: once when it opens, then once a minute while
 * the tab is visible (react-query's interval waits while the tab is hidden), stopped when the page is left. The rest of
 * that answer is not read: the feed stays the page's one source of the box itself.
 * Prices are a hint: a failed, slow or malformed read changes nothing (no error, no spinner), and the freshness rule
 * stays `usdPriceFor` at the page's clock, so prices kept from an earlier read show only while still inside their limit.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Fetcher } from '../core-client';
import { withDeadline } from '../deadline';
import type { V2Snapshot, V2Source } from './indexer-v2';
import { usdPricesOf, type UsdPricesV2 } from './usd-v2';

/** How often an open box page asks again (the prices carry their own age limits, minutes long). */
export const BOX_PRICES_POLL_MS = 60_000;
/** A prices answer not here within this long counts as none. */
export const BOX_PRICES_DEADLINE_MS = 8_000;

export const boxPricesUrlV2 = (source: Pick<V2Source, 'origin' | 'manifest'>, token: string): string =>
  `${source.origin}/v2/boxes/${source.manifest.chainId}/${token.toLowerCase()}`;

/** The global fetch, called on its own (never as a method of another object). */
const pricesFetch: Fetcher = (url, init) => fetch(url, init?.signal ? { signal: init.signal } : {});

/**
 * The box's `prices` from its own answer; null when the answer has none (or none well formed). An answer that is not
 * this box's on this chain, or no answer, is an error, which the page ignores.
 */
export async function readBoxPricesV2(source: Pick<V2Source, 'origin' | 'manifest'>, token: string, fetcher: Fetcher = pricesFetch, outer?: AbortSignal): Promise<UsdPricesV2 | null> {
  const body = await withDeadline(BOX_PRICES_DEADLINE_MS, outer, async (signal) => {
    const reply = await fetcher(boxPricesUrlV2(source, token), { signal });
    if (!reply.ok) throw new Error('Box prices unavailable');
    return reply.json();
  });
  const v = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!v || v.schema !== 'sh.core-box.v2' || v.chainId !== source.manifest.chainId || typeof v.token !== 'string' || v.token.toLowerCase() !== token.toLowerCase()) {
    throw new Error('Not this box');
  }
  return usdPricesOf(v.prices) ?? null;
}

/** The view with the box's own prices laid over it; the view itself while there are none. */
export function withPricesV2(view: V2Snapshot, prices: UsdPricesV2 | null | undefined): V2Snapshot {
  return prices ? { ...view, prices } : view;
}

/** The open box page's prices read (see the header). `fetcher`: a test seam (a stable reference). */
export function useBoxPricesV2(source: V2Source, token: string, fetcher?: Fetcher): UsdPricesV2 | null {
  const query = useQuery({
    queryKey: ['v2-box-prices', source.network, source.origin, source.manifest.chainId, token.toLowerCase()],
    queryFn: ({ signal }) => readBoxPricesV2(source, token, fetcher, signal),
    refetchInterval: BOX_PRICES_POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: BOX_PRICES_POLL_MS,
    retry: false,
  });
  return query.data ?? null;
}

/** The page's view: the feed's, with the box's own prices over it once they are read. */
export function usePricedViewV2(source: V2Source, view: V2Snapshot, fetcher?: Fetcher): V2Snapshot {
  const prices = useBoxPricesV2(source, view.token, fetcher);
  return useMemo(() => withPricesV2(view, prices), [view, prices]);
}
