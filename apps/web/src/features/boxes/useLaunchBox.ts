/**
 * React bindings for a launch box (the Misfits, a rehearsal): the live curve (one `useLivePool` per page), the vault
 * counters, the state, the card summary, the price inputs (S, E, n, N from one block) and the market link the Market
 * counter may offer. The Demo's price inputs are computed from the Demo stream's burn with the vault math
 * (demo-vault.ts); a chain market's come from one vault read.
 */
import { fitMarketDestinations } from '@squarehole/links';
import { useMemo } from 'react';
import type { DemoScenario } from '../fit-pair/demo-chain';
import type { VaultCounters } from '../fit-pair/direct-source';
import type { FitMarketTarget } from '../fit-pair/fit-target';
import type { LiveDeps, LiveView } from '../fit-pair/live-controller';
import { resolveDestination, STATE_WORD } from '../fit-pair/MarketLinks';
import { useLivePool, useVaultCounters, type VaultState } from '../fit-pair/useLivePool';
import { capitalized } from '../fit-pair/market-names';
import { launchSummary } from './box-figure';
import type { BoxRecord, BoxState, BoxSummary } from './box-model';
import { launchBoxState } from './box-state';
import { demoVaultTotals } from './demo-vault';
import type { PriceInputs } from './price-model';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export interface MarketLinkState {
  readonly link: { readonly href: string; readonly host: string } | null;
  readonly reason: string;
}

/** The Uniswap destination as the Market counter shows it: a verified link, or MarketLinks' state word. */
export function marketLinkOf(target: FitMarketTarget, view: Pick<LiveView, 'data' | 'freshness'>): MarketLinkState {
  if (DEMO_BUILD && target.kind === 'demo') return { link: null, reason: 'No links on a local chain' };
  const destination = fitMarketDestinations({ chainId: target.chainId, token: target.token, poolId: target.poolId, demo: false }).find((d) => d.kind === 'execution');
  if (!destination) return { link: null, reason: 'No link' };
  const row = resolveDestination(destination, target, view.data, view.freshness);
  if (row.vetted) return { link: row.vetted, reason: '' };
  return { link: null, reason: capitalized(STATE_WORD[row.state === 'available' ? 'unchecked' : row.state]) };
}

/** S, E, n, N at one block: the Demo's from its stream's burn, a chain's from the vault read. */
export function priceInputsOf(target: FitMarketTarget, scenario: DemoScenario, view: Pick<LiveView, 'data'>, vault: VaultState): PriceInputs | null {
  if (DEMO_BUILD && target.kind === 'demo') {
    const burned = view.data?.state.burnedRaw ?? null;
    if (burned === null) return null;
    return { ...demoVaultTotals(scenario, burned, target.collectionSize), chainQuoteOne: null, block: null };
  }
  if (vault.status !== 'ready') return null;
  const c = vault.counters;
  if (c.supply == null || c.escrow == null || c.inside === null || c.collectionSize === null) return null;
  return { supply: c.supply, escrow: c.escrow, inside: c.inside, collectionSize: c.collectionSize, chainQuoteOne: c.quoteOne ?? null, block: c.block };
}

export interface LaunchBoxView {
  readonly view: LiveView;
  readonly vault: VaultState;
  readonly state: BoxState | null;
  readonly summary: BoxSummary;
  readonly price: PriceInputs | null;
  readonly market: MarketLinkState;
}

/** Test seams: the live transports and the vault reader (production: the browser's, `directReaderFor`). */
export interface LaunchBoxSeams {
  readonly deps?: LiveDeps;
  readonly readVault?: () => Promise<VaultCounters>;
}

/** Everything a box page needs about its launch market. */
export function useLaunchBox(record: BoxRecord, target: FitMarketTarget, scenario: DemoScenario, seams: LaunchBoxSeams = {}): LaunchBoxView {
  const view = useLivePool(target, scenario, seams.deps);
  const vault = useVaultCounters(target, scenario, seams.readVault);
  const counters = vault.status === 'ready' ? vault.counters : null;
  const state = launchBoxState(view.data, counters);
  const summary = useMemo(() => launchSummary(record, state, view.data, target, view), [record, state, view, target]);
  const price = useMemo(() => priceInputsOf(target, scenario, view, vault), [target, scenario, view, vault]);
  const market = useMemo(() => marketLinkOf(target, view), [target, view]);
  return { view, vault, state, summary, price, market };
}

/** The feed's lighter read: the live curve only (the card needs no vault read). */
export function useLaunchSummary(record: BoxRecord, target: FitMarketTarget, scenario: DemoScenario): BoxSummary {
  const view = useLivePool(target, scenario);
  const state = launchBoxState(view.data, null);
  return useMemo(() => launchSummary(record, state, view.data, target, view), [record, state, view, target]);
}
