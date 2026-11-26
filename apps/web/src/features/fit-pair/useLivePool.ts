/**
 * React bindings for the live curve and the vault counters. One controller per mounted page (target + scenario); it
 * starts on mount and stops on unmount, so leaving the page closes the stream and every timer.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { DemoScenario } from './demo-chain';
import { createDemoStream } from './demo-live';
import { demoVaultPlan } from './demo-vault-plan';
import { directReaderFor, type VaultCounters } from './direct-source';
import type { FitMarketTarget } from './fit-target';
import { LivePoolController, type LiveDeps, type LiveView, type SnapshotAnswer, type StreamLike } from './live-controller';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

const browserClock = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number): unknown => window.setTimeout(fn, ms),
  clearTimeout: (handle: unknown) => window.clearTimeout(handle as number),
};

async function fetchSnapshot(url: string, etag: string | null): Promise<SnapshotAnswer> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(url, { headers: etag ? { 'If-None-Match': etag } : {}, signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    return {
      status: response.status,
      etag: response.headers.get('ETag'),
      indexer: response.headers.get('X-SH-Indexer'),
      body: response.status === 200 ? await response.text() : null,
    };
  } finally {
    window.clearTimeout(timer);
  }
}

/** The dependencies a real page uses: the browser's EventSource and fetch, or the Demo stream. */
export function browserLiveDeps(target: FitMarketTarget, scenario: DemoScenario): LiveDeps {
  const direct = directReaderFor(target);
  if (DEMO_BUILD && target.kind === 'demo') {
    return { ...browserClock, openStream: () => createDemoStream(target, scenario, browserClock), fetchSnapshot: null, readDirect: null };
  }
  const hasIndexer = target.indexerOrigin !== null;
  return {
    ...browserClock,
    openStream: hasIndexer && typeof EventSource !== 'undefined' ? (url: string): StreamLike => new EventSource(url) : null,
    fetchSnapshot: hasIndexer ? fetchSnapshot : null,
    readDirect: direct ? () => direct.readCurve() : null,
  };
}

export function useLivePool(target: FitMarketTarget, scenario: DemoScenario, deps?: LiveDeps): LiveView {
  const controller = useMemo(() => new LivePoolController(target, deps ?? browserLiveDeps(target, scenario)), [target, scenario, deps]);
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

/**
 * Vault counters of the Demo scenarios (invented; labelled Demo on the page). A placeholder is a ticket: it leaves the
 * count inside, like `MisfitsVault.openTickets` (n falls by k); after graduation 22 of the 112 are back inside. The same
 * plan drives the Demo price picture (boxes/demo-vault.ts). N is the Demo market's own edition size.
 */
export function demoVaultCounters(scenario: DemoScenario, collectionSize: bigint): VaultCounters {
  const plan = demoVaultPlan(scenario);
  return Object.freeze({
    source: 'demo',
    block: null,
    inside: collectionSize - plan.takes + plan.returns,
    collectionSize,
    gateOpen: plan.graduated,
    placeholdersTaken: plan.takes,
  });
}

export const VAULT_REFRESH_MS = 30_000;

export type VaultState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly counters: VaultCounters; readonly failed: boolean }
  | { readonly status: 'unavailable'; readonly reason: string };

/** The vault counters: Demo values, or a direct read every 30 s (the indexer does not carry them). */
export function useVaultCounters(target: FitMarketTarget, scenario: DemoScenario, read?: () => Promise<VaultCounters>): VaultState {
  const reader = useMemo(() => (DEMO_BUILD && target.kind === 'demo' ? null : (read ?? directReaderFor(target)?.readVault ?? null)), [target, read]);
  const [chainState, setChainState] = useState<VaultState>({ status: 'loading' });
  useEffect(() => {
    if (reader === null) return undefined;
    let active = true;
    let timer: number | null = null;
    const load = async () => {
      try {
        const counters = await reader();
        if (active) setChainState({ status: 'ready', counters, failed: false });
      } catch (error) {
        if (!active) return;
        setChainState((previous) =>
          previous.status === 'ready'
            ? { ...previous, failed: true }
            : { status: 'unavailable', reason: error instanceof Error && error.message ? error.message : 'The vault could not be read.' },
        );
      }
      if (active) timer = window.setTimeout(() => void load(), VAULT_REFRESH_MS);
    };
    void load();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [reader]);
  if (DEMO_BUILD && target.kind === 'demo') return { status: 'ready', counters: demoVaultCounters(scenario, target.collectionSize), failed: false };
  if (reader === null) return { status: 'unavailable', reason: 'This market has no RPC to read the vault from.' };
  return chainState;
}
