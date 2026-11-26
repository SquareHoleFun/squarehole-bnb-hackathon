import { parseIsoTimestamp, type Address, type ClaimView } from '@squarehole/domain';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ACCOUNT_QUERY_ROOT, useAccountSources, useRefreshAccountData } from '../accounts';
import { createTxFlowController, useControlledTxFlow, useTxFlowConfig, useTxFlowEnvironment, type TxFlow, type TxFlowRequest } from '../tx';
import { ClaimFlowStore, claimFlowKey, type ClaimFlowEntry } from './claim-flows';
import { isQuoteExpired, type StartedClaim } from './claim-model';

const ClaimFlowContext = createContext<ClaimFlowStore | null>(null);

/**
 * Owns every claim request of the app (see claim-flows.ts), above the routes, so a signed claim is not tied to the page
 * or card that started it. Needs the query client and the account sources (the demo settlement ledger).
 */
export function ClaimFlowProvider({ children }: { children: ReactNode }) {
  const { settlements } = useAccountSources();
  const client = useQueryClient();
  const [store] = useState(
    () =>
      new ClaimFlowStore({
        createController: createTxFlowController,
        record: (settlement) => settlements?.record(settlement),
        refresh: () => void client.invalidateQueries({ queryKey: [ACCOUNT_QUERY_ROOT] }),
      }),
  );
  useEffect(() => () => store.dispose(), [store]);
  return <ClaimFlowContext.Provider value={store}>{children}</ClaimFlowContext.Provider>;
}

export function useClaimFlowStore(): ClaimFlowStore {
  const store = useContext(ClaimFlowContext);
  if (!store) throw new Error('useClaimFlowStore needs <ClaimFlowProvider> (see AppProviders)');
  return store;
}

export interface ClaimFlow {
  readonly entry: ClaimFlowEntry;
  readonly flow: TxFlow;
  /** Starts a new request with what the card shows (the whole claimable entitlement; there is no amount). */
  readonly start: (started: StartedClaim) => void;
}

/** The claim flow of (account, pair) for a card: re-attaches to a signed claim, or starts idle. */
export function useClaimFlow(account: Address, pairId: string, request: TxFlowRequest): ClaimFlow {
  const store = useClaimFlowStore();
  const env = useTxFlowEnvironment();
  const key = claimFlowKey(account, pairId);
  const obtained = store.obtain(account, pairId, request, env);
  const entry = useSyncExternalStore(
    store.subscribe,
    () => store.get(key) ?? obtained,
    () => store.get(key) ?? obtained,
  );
  useEffect(() => store.attach(key), [store, key]);
  const flow = useControlledTxFlow(entry.controller, request, env);
  const start = useCallback((started: StartedClaim) => store.start(key, started), [store, key]);
  return { entry, flow, start };
}

export interface SignedClaimFilter {
  /** Leave out this account's claims (the connected account, whose own cards show them); null keeps every account. */
  readonly exceptAccount?: Address | null;
  /** Only this account's claims. */
  readonly account?: Address;
  /** Only claims on this pair (canonical id). */
  readonly pairId?: string;
}

/** Signed claims still listed (not hidden), filtered; the array is stable while its content is. */
export function useSignedClaims({ exceptAccount = null, account, pairId }: SignedClaimFilter = {}): readonly ClaimFlowEntry[] {
  const store = useClaimFlowStore();
  const signed = useSyncExternalStore(store.subscribe, store.getSigned, store.getSigned);
  return useMemo(
    () =>
      signed.filter(
        (entry) =>
          (exceptAccount === null || entry.account.toLowerCase() !== exceptAccount.toLowerCase()) &&
          (account === undefined || entry.account.toLowerCase() === account.toLowerCase()) &&
          (pairId === undefined || entry.pairId === pairId),
      ),
    [signed, exceptAccount, account, pairId],
  );
}

const MAX_TIMER_MS = 2_147_483_647;

/**
 * An expired quote is not an estimate (ADR-0008 §4 "Quote expiry", §7): at the claim's quote deadline on the demo clock
 * this re-reads the account data, and it reports the quote as expired from that moment, even before the re-read lands.
 * Used by every claim card, so `/rewards` and the pair detail card drop a stale estimate the same way.
 */
export function useQuoteExpiry(claim: ClaimView): boolean {
  const { now } = useTxFlowConfig();
  const refresh = useRefreshAccountData();
  const deadline = claim.convertibleEstimate?.deadline ?? null;
  const [lapsed, setLapsed] = useState<string | null>(null);
  useEffect(() => {
    if (deadline === null) return undefined;
    const deadlineMs = parseIsoTimestamp(deadline);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const wait = deadlineMs - now();
      if (wait >= 0) {
        timer = setTimeout(check, Math.min(wait + 1, MAX_TIMER_MS));
        return;
      }
      setLapsed(deadline);
      void refresh();
    };
    timer = setTimeout(check, Math.min(Math.max(0, deadlineMs - now()) + 1, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [deadline, now, refresh]);
  return deadline !== null && (lapsed === deadline || isQuoteExpired(claim, now()));
}
