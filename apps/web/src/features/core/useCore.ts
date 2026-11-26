/**
 * React bindings for core v1 (S10a): the current data source's core deployment, its feed (one request for every card,
 * refreshed every block or so), a box, its activity and a wallet. Queries are keyed by the source and refetch on an
 * interval; nothing here touches a wallet.
 */
import { SEPOLIA_PUBLIC_RPC_URLS } from '@squarehole/chain';
import { useQuery } from '@tanstack/react-query';
import type { Address } from '@squarehole/domain';
import { useEffect, useMemo, useState } from 'react';
import { CORE_ART_GATEWAYS, CORE_ARWEAVE, CORE_INDEXER_ORIGINS, CORE_LOCAL_RPC_URL, CORE_MANIFESTS } from 'virtual:squarehole-deployments';
import { useDataSource } from '../data-source';
import { coreSourceFor, type CoreBuild, type CoreSource } from './core-build';
import { loadActivity, loadBox, loadFeed, loadWallet, type ActivityItem, type CoreBox, type CoreFeed, type CoreWallet, type Fetcher, type ReadyCore } from './core-client';
import { NO_RETRIES, failedSince, type FeedRetries } from './feed-failure';

export const BUILD_CORE: CoreBuild = Object.freeze({ manifests: CORE_MANIFESTS, localRpcUrl: CORE_LOCAL_RPC_URL, indexers: CORE_INDEXER_ORIGINS, artGateways: CORE_ART_GATEWAYS, arweave: CORE_ARWEAVE });

/** Refresh intervals: the indexer's answers about once a block; direct reads less often (they cost RPC calls). */
const FEED_MS = 6_000;
const BOX_MS = 4_000;

/** Test seams: what the build embeds and how the site fetches. */
export interface CoreSeams {
  readonly build?: CoreBuild;
  readonly fetcher?: Fetcher;
}

/** The wall clock for "Stale by age" (BC-094), one tick every few seconds (a render reads it, never Date.now itself). */
export function useClockMs(tickMs = 5_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), tickMs);
    return () => window.clearInterval(timer);
  }, [tickMs]);
  return nowMs;
}

export function useCoreSource(build: CoreBuild = BUILD_CORE): CoreSource {
  const source = useDataSource();
  return useMemo(() => coreSourceFor(source.id, build, SEPOLIA_PUBLIC_RPC_URLS[0] ?? ''), [source.id, build]);
}

/**
 * A read's state. Once a read succeeded, a later failed refresh keeps its value (`refreshError` says why it is not
 * newer): a box seen once never turns into "not found" or vanishes from the feed because one refresh failed; the page
 * marks it Stale instead (S10a review).
 */
export type Loaded<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T; readonly refreshError: string | null } | { readonly status: 'error'; readonly reason: string };

const reasonOf = (error: unknown): string => (error instanceof Error && error.message ? error.message : 'The read failed.');

/** react-query keeps the last good `data` when a refetch fails (status `error`, data kept): it is served, marked. */
export function loaded<T>(query: { readonly isPending: boolean; readonly isError: boolean; readonly data: T | undefined; readonly error: unknown }): Loaded<T> {
  if (query.data !== undefined) return { status: 'ready', value: query.data, refreshError: query.isError ? reasonOf(query.error) : null };
  if (query.isError) return { status: 'error', reason: reasonOf(query.error) };
  return { status: 'loading' };
}

/**
 * The core v1 reads (feed, box, activity, wallet) need a core v1 version: a release without one (BNB Chain testnet:
 * `versions: []`, `version1` null, SH-258) has no v1 feed, box or wallet to ask for, and none is asked.
 */
const ready = (core: CoreSource): ReadyCore | null => (core.status === 'ready' && core.version1 !== null ? core : null);

/**
 * The feed. XR2-ITEM-3D-V2 F2: a feed that never answered stays `error` through its later polls (feed-failure.ts),
 * with the reason its last failure gave (a poll under way has none), until an answer comes or the page's Retry
 * (`retries`); before, each poll put it back to `loading`. Its first read, its answers and a failed refresh after an
 * answer are as before, and so are the other reads below.
 */
export function useCoreFeed(core: CoreSource, fetcher?: Fetcher, retries: FeedRetries = NO_RETRIES): Loaded<CoreFeed> | null {
  const r = ready(core);
  const queryKey = ['core-feed', r?.network ?? 'none', r?.chainId ?? 0, r?.indexerOrigin ?? 'direct'] as const;
  const query = useQuery({
    queryKey,
    // SH-SITE-FIXES-10: the read's own deadline ends a request with no answer (core-client.ts INDEXER_DEADLINE_MS).
    // react-query's signal is left unread on purpose: a read that consumed it is cancelled whenever its last page goes
    // (query-core query.js removeObserver), and the next page, which reads the same feed, would start it over; the
    // chain fallback (many RPC calls when the indexer is down) would run twice.
    queryFn: () => loadFeed(r as ReadyCore, fetcher),
    enabled: r !== null,
    refetchInterval: r?.indexerOrigin ? FEED_MS : FEED_MS * 2,
  });
  const reason = query.data === undefined && query.isError ? reasonOf(query.error) : null;
  const [lastReason, setLastReason] = useState<string | null>(null);
  if (reason !== null && reason !== lastReason) setLastReason(reason);
  if (!r) return null;
  if (failedSince(query, queryKey, retries)) return { status: 'error', reason: reason ?? lastReason ?? 'The read failed.' };
  return query.data === undefined ? { status: 'loading' } : loaded(query);
}

export function useCoreBox(core: CoreSource, token: string | null, fetcher?: Fetcher): Loaded<CoreBox | null> | null {
  const r = ready(core);
  const query = useQuery({
    queryKey: ['core-box', r?.network ?? 'none', r?.chainId ?? 0, token ?? ''],
    queryFn: () => loadBox(r as ReadyCore, token as string, fetcher),
    enabled: r !== null && token !== null,
    refetchInterval: r?.indexerOrigin ? BOX_MS : BOX_MS * 3,
  });
  return r && token ? loaded(query) : null;
}

export function useCoreActivity(core: CoreSource, token: string | null, fetcher?: Fetcher): Loaded<readonly ActivityItem[] | null> | null {
  const r = ready(core);
  const query = useQuery({
    queryKey: ['core-activity', r?.network ?? 'none', r?.chainId ?? 0, token ?? ''],
    queryFn: () => loadActivity(r as ReadyCore, token as string, fetcher),
    enabled: r !== null && token !== null,
    refetchInterval: BOX_MS * 2,
  });
  return r && token ? loaded(query) : null;
}

export function useCoreWallet(core: CoreSource, address: Address | null, fetcher?: Fetcher): Loaded<CoreWallet> | null {
  const r = ready(core);
  const query = useQuery({
    queryKey: ['core-wallet', r?.network ?? 'none', r?.chainId ?? 0, address?.toLowerCase() ?? ''],
    queryFn: () => loadWallet(r as ReadyCore, address as Address, fetcher),
    enabled: r !== null && address !== null,
    refetchInterval: FEED_MS * 2,
  });
  return r && address ? loaded(query) : null;
}

export type { ActivityItem, CoreBox, CoreFeed, CoreWallet };
