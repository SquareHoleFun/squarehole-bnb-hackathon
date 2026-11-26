/**
 * SH-218 rail 2: the selected release's switched-off options on the Create page (create-options.ts).
 *
 * Read on entry, when the tab is shown again (a read under way is cancelled first, so the new one starts after it was
 * shown), on Retry (with the release's module directory), when a check asks for a fresh answer, and a few seconds
 * before a good read's 60 are over while the tab is visible, so a healthy API leaves no gap. Reads run offline too
 * (React Query would pause them): an offline read fails at once, and line B says so.
 *
 * Permission (`fresh`): a good read younger than 60 seconds, started after this mount and after the tab was last shown,
 * in a visible tab. A local timer ends it at 60 seconds. A failed read ends it at once and nothing older ever permits.
 *
 * Marks (`document`): the list the controls are marked with. A good read of this mount; after a failure, still the last
 * good read of this mount (looks only: a failure is line B and permits nothing); before any good read, none. Every
 * mount starts from nothing (`gcTime: 0`: no read outlives the page).
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Address } from 'viem';
import type { V2Source } from '../../core/v2/indexer-v2';
import { alchemistReleaseV21, rpcAlchemistReads } from './alchemist';
import { CREATE_OPTIONS_FRESH_MS, createOptionsTargetOf, monotonicNow, readCreateOptions, type CreateOptionsDocument, type CreateOptionsRead, type CreateOptionsTarget } from './create-options';
import { createReleaseOf } from '../../core/v2/releases';

/** A good read is read again this long before its 60 seconds are over (twice the read's own five-second limit). */
export const CREATE_OPTIONS_REFRESH_LEAD_MS = 10_000;
/** The module directory's query key (Retry reads it again). */
export const MODULE_DIRECTORY_KEY = 'v2-create-options-directory';
const LIST_KEY = 'v2-create-options';

export type CreateOptionsPhase =
  /** No chain to create on (the Demo, or a build without a v2 release): no list is read and nothing is checked. */
  | 'none'
  | 'reading'
  | 'ok'
  | 'failed';

export interface CreateOptionsState {
  readonly phase: CreateOptionsPhase;
  readonly target: CreateOptionsTarget | null;
  /** The list the controls are marked with (see the header); never a permission. */
  readonly document: CreateOptionsDocument | null;
  /** The only state that permits creation (see the header). */
  readonly fresh: boolean;
  /** Read the list and the module directory again now (Retry). */
  readonly retry: () => void;
  /** A fresh list for a check about to act (a loaded settings file): this read if fresh, else a new one; null if none. */
  readonly check: () => Promise<CreateOptionsDocument | null>;
}

const subscribeVisibility = (change: () => void) => {
  document.addEventListener('visibilitychange', change);
  return () => document.removeEventListener('visibilitychange', change);
};
const visibility = () => document.visibilityState;
const serverVisibility = (): DocumentVisibilityState => 'visible';
const UNAVAILABLE: CreateOptionsRead = Object.freeze({ ok: false, startedAt: 0 });

export function useCreateOptions(source: V2Source | null): CreateOptionsState {
  const queryClient = useQueryClient();
  const target = useMemo(() => (source ? createOptionsTargetOf(source) : null), [source]);
  const url = target?.url ?? null;
  const shown = useSyncExternalStore(subscribeVisibility, visibility, serverVisibility) === 'visible';
  // Only a read started since this mount, and since the tab was last shown, permits (monotonic clock).
  const [since, setSince] = useState(monotonicNow);
  // The start of the read whose 60 seconds are over (the local timer's verdict).
  const [expired, setExpired] = useState<number | null>(null);
  // The last good list of this mount, for the marks after a failure (never a permission).
  const [lastGood, setLastGood] = useState<{ readonly url: string; readonly document: CreateOptionsDocument } | null>(null);
  const query = useQuery({
    queryKey: [LIST_KEY, url],
    // The signal lets a newer read cancel one under way (React Query then drops its late answer). A source with no
    // single release has no list: that is a failed read, never a pass.
    queryFn: ({ signal }): Promise<CreateOptionsRead> => (target ? readCreateOptions(target, undefined, undefined, signal) : Promise.resolve({ ...UNAVAILABLE, startedAt: monotonicNow() })),
    enabled: source !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    // Offline, a paused read would leave Create off with no line; this one fails at once instead (line B).
    networkMode: 'always',
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const { refetch } = query;
  const read = source ? query.data ?? null : null;
  if (read?.ok && url !== null && read.startedAt >= since && (lastGood?.document !== read.document || lastGood.url !== url)) setLastGood({ url, document: read.document });

  // Shown again: the read under way (if any) is cancelled and a new one started, so it counts.
  useEffect(() => {
    if (!source) return;
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      setSince(monotonicNow());
      void queryClient.cancelQueries({ queryKey: [LIST_KEY, url] }).then(() => refetch());
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [source, queryClient, url, refetch]);

  // A good read: read again shortly before its 60 seconds end (keeping its permission until the answer), and end its
  // permission at 60 seconds whatever the new read does.
  const startedAt = read?.ok ? read.startedAt : null;
  useEffect(() => {
    if (startedAt === null) return;
    const left = startedAt + CREATE_OPTIONS_FRESH_MS - monotonicNow();
    const again = window.setTimeout(() => { if (document.visibilityState === 'visible') void refetch(); }, Math.max(0, left - CREATE_OPTIONS_REFRESH_LEAD_MS));
    const end = window.setTimeout(() => setExpired(startedAt), Math.max(0, left));
    return () => { window.clearTimeout(again); window.clearTimeout(end); };
  }, [startedAt, refetch]);

  const fresh = read !== null && read.ok && shown && expired !== read.startedAt && read.startedAt >= since;
  const phase: CreateOptionsPhase = !source ? 'none' : read === null || (!read.ok && query.isFetching) ? 'reading' : read.ok ? 'ok' : 'failed';
  const marks = read?.ok ? read.document : lastGood !== null && lastGood.url === url ? lastGood.document : null;
  const retry = useCallback(() => {
    void refetch();
    void queryClient.invalidateQueries({ queryKey: [MODULE_DIRECTORY_KEY] });
  }, [refetch, queryClient]);
  const check = useCallback(async (): Promise<CreateOptionsDocument | null> => {
    if (!source) return null;
    if (fresh && read?.ok) return read.document;
    const again = await refetch();
    const answer = again.data;
    return answer?.ok && document.visibilityState === 'visible' ? answer.document : null;
  }, [source, fresh, read, refetch]);
  return { phase, target, document: source ? marks : null, fresh, retry, check };
}

/**
 * The selected release's module directory as its receiver names it (alchemist.ts `alchemistReleaseV21`, the same read
 * the Alchemist's rows are checked with); asked only while a draft names a module row.
 */
export function releaseModuleDirectory(source: V2Source): Promise<Address> {
  return alchemistReleaseV21(rpcAlchemistReads(source.rpc, source.manifest.chainId), source).then((release) => release.directory);
}

export type ModuleDirectoryState = { readonly state: 'none' | 'reading' | 'failed' } | { readonly state: 'ready'; readonly directory: Address };

/** The page's copy of the module directory, for marking The Alchemist's choice and the draft's check (not the send's). */
export function useModuleDirectory(source: V2Source | null, needed: boolean): ModuleDirectoryState {
  const query = useQuery({
    queryKey: [MODULE_DIRECTORY_KEY, source?.network, source?.manifest.chainId, (source ? createReleaseOf(source.manifest)?.registry.address : undefined)],
    queryFn: () => {
      if (!source) throw new Error('V2 chain unavailable');
      return releaseModuleDirectory(source);
    },
    enabled: source !== null && needed,
    retry: false,
    staleTime: 60_000,
  });
  if (!source || !needed) return { state: 'none' };
  if (query.data) return { state: 'ready', directory: query.data };
  return { state: query.isError ? 'failed' : 'reading' };
}
