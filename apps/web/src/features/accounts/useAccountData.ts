/**
 * Personal reads (SH-014) over the shared query cache. Every key starts with `account`, so one invalidation refreshes
 * claims, positions and single-pair claims together (after a demo claim finalizes or a quote expires). A read failure
 * stays a failure: it is never shown as a zero balance or "nothing to claim" (06-ARCHITECTURE).
 */
import {
  canonicalPairId,
  isPairId,
  type AccountClaims,
  type AccountPositions,
  type Address,
  type ClaimView,
  type PairId,
  type PairRecord,
} from '@squarehole/domain';
import { keepPreviousData, useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { useFeedContext } from '../feed/feed-context';
import { useAccountSources } from './account-context';
import { isAccountScenario, type AccountScenario } from './account-sources';

export const ACCOUNT_QUERY_ROOT = 'account';

const ownerKey = (account: Address | null): string | null => (account === null ? null : account.toLowerCase());

export interface AccountReadOptions {
  /**
   * Keep showing the last result while a new key (e.g. another account-data scenario) is read, flagged by
   * `isPlaceholderData`, instead of dropping back to the loading state. A claim list uses it so its cards (and the
   * requests they show) stay on screen; it must not start anything from placeholder data.
   */
  readonly keepPrevious?: boolean;
}

export function useAccountClaims(account: Address | null, scenario: AccountScenario, { keepPrevious = false }: AccountReadOptions = {}): UseQueryResult<AccountClaims> {
  const { sourceFor } = useAccountSources();
  return useQuery({
    placeholderData: keepPrevious ? keepPreviousData : undefined,
    queryKey: [ACCOUNT_QUERY_ROOT, 'claims', scenario, ownerKey(account)],
    queryFn: ({ signal }) => {
      if (account === null) throw new Error('No account to read');
      return sourceFor(scenario).provider.listClaims(account, signal);
    },
    enabled: account !== null,
  });
}

export function useAccountPositions(account: Address | null, scenario: AccountScenario, { keepPrevious = false }: AccountReadOptions = {}): UseQueryResult<AccountPositions> {
  const { sourceFor } = useAccountSources();
  return useQuery({
    placeholderData: keepPrevious ? keepPreviousData : undefined,
    queryKey: [ACCOUNT_QUERY_ROOT, 'positions', scenario, ownerKey(account)],
    queryFn: ({ signal }) => {
      if (account === null) throw new Error('No account to read');
      return sourceFor(scenario).provider.listPositions(account, signal);
    },
    enabled: account !== null,
  });
}

/** One pair's claim for any account (the `?pair=` preselection when the pair is not in the account's list). */
export function useAccountClaim(
  pairId: PairId | null,
  account: Address | null,
  scenario: AccountScenario,
  { keepPrevious = false }: AccountReadOptions = {},
): UseQueryResult<ClaimView> {
  const { sourceFor } = useAccountSources();
  return useQuery({
    placeholderData: keepPrevious ? keepPreviousData : undefined,
    queryKey: [ACCOUNT_QUERY_ROOT, 'claim', scenario, ownerKey(account), pairId === null ? null : canonicalPairId(pairId)],
    queryFn: ({ signal }) => {
      if (account === null || pairId === null) throw new Error('No account or pair to read');
      return sourceFor(scenario).provider.readClaim(pairId, account, signal);
    },
    enabled: account !== null && pairId !== null,
  });
}

/** Re-reads every personal query (claims, positions, single claims). */
export function useRefreshAccountData(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: [ACCOUNT_QUERY_ROOT] }), [client]);
}

export interface PairRecords {
  readonly byId: ReadonlyMap<string, PairRecord>;
  readonly pending: boolean;
}

/** Pair records (names, symbols, asset identities) from the default demo feed source, cached for the session. */
export function usePairRecords(pairIds: readonly string[]): PairRecords {
  const { sourceFor } = useFeedContext();
  const ids = useMemo(() => [...new Set(pairIds.filter(isPairId).map((id) => canonicalPairId(id)))].sort(), [pairIds]);
  const results = useQueries({
    queries: ids.map((pairId) => ({
      queryKey: ['pair-record', pairId],
      queryFn: ({ signal }: { signal: AbortSignal }) => sourceFor('default').provider.readPair(pairId, signal),
      staleTime: Infinity,
    })),
  });
  const byId = new Map<string, PairRecord>();
  results.forEach((result, index) => {
    const id = ids[index];
    if (id !== undefined && result.data) byId.set(id, result.data);
  });
  return { byId, pending: results.some((result) => result.isPending) };
}

/** `?scenario=` for personal data (demo builds only; unknown values mean the default). */
export function useAccountScenario(): [AccountScenario, (next: AccountScenario) => void] {
  const [params, setParams] = useSearchParams();
  const { allowScenario } = useFeedContext();
  const raw = params.get('scenario');
  const scenario: AccountScenario = allowScenario && isAccountScenario(raw) ? raw : 'default';
  const setScenario = useCallback(
    (next: AccountScenario) => {
      setParams(
        (current) => {
          const out = new URLSearchParams(current);
          if (next === 'default') out.delete('scenario');
          else out.set('scenario', next);
          return out;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return [scenario, setScenario];
}

export type SelectedPair = { readonly kind: 'none' } | { readonly kind: 'invalid' } | { readonly kind: 'pair'; readonly pairId: PairId };

/** `?pair=<chainId>:<address>` preselection; malformed values are reported, never repaired. */
export function parseSelectedPair(value: string | null): SelectedPair {
  if (value === null || value === '') return { kind: 'none' };
  return isPairId(value) ? { kind: 'pair', pairId: canonicalPairId(value) } : { kind: 'invalid' };
}
