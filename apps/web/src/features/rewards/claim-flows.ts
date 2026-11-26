/**
 * App-level claim flows (06-ARCHITECTURE "a hash is not confirmation"; ADR-0008 §4; UI-08). A claim request belongs to
 * (account, pair), not to the card that shows it: once signed, it keeps being tracked when that card unmounts (a
 * persona switch, an account-data scenario change, navigation) and a card for the same (account, pair) re-attaches to
 * it instead of offering a second claim. Finalized is still the only success: the demo ledger records the settlement
 * exactly once, when the flow finalizes, whether or not a card is on screen at that moment.
 *
 * Unsigned requests are not kept: when the last card showing one goes away, its pending steps are cancelled and it
 * is dropped (nothing was signed, so there is nothing to track). Framework-free; `claim-flow-context.tsx` wraps it.
 */
import { canonicalPairId, type Address, type TxState } from '@squarehole/domain';
import type { DemoSettlement } from '../accounts';
import { isTxBusy, type TxFlowController, type TxFlowEnvironment, type TxFlowRequest } from '../tx';
import { demoSettlementOf, type StartedClaim } from './claim-model';

export interface ClaimFlowEntry {
  readonly key: string;
  readonly account: Address;
  /** Canonical pair id. */
  readonly pairId: string;
  readonly controller: TxFlowController;
  /** What the current request was started with (null before the first request). */
  readonly started: StartedClaim | null;
  /** The current request has been signed (it has, or had, a hash): it is tracked until the page is reloaded. */
  readonly signed: boolean;
  /** The person removed this finished claim from the "still being tracked" lists. */
  readonly hidden: boolean;
}

export interface ClaimFlowStoreDeps {
  readonly createController: (request: TxFlowRequest, env: TxFlowEnvironment) => TxFlowController;
  /** Demo settlement ledger (finalized claims only). */
  readonly record: (settlement: DemoSettlement) => void;
  /** Re-reads the account data (claims, positions). */
  readonly refresh: () => void;
}

export const claimFlowKey = (account: Address, pairId: string): string => `${account.toLowerCase()}:${canonicalPairId(pairId)}`;

const hasHash = (state: TxState): state is Extract<TxState, { hash: unknown }> => 'hash' in state;

/** A revert changes nothing but the page re-reads so it shows current data; finalized consumes the claim. */
const REREAD_ON: ReadonlySet<TxState['status']> = new Set(['finalized', 'reverted']);

const NONE: readonly ClaimFlowEntry[] = Object.freeze([]);

export class ClaimFlowStore {
  private readonly deps: ClaimFlowStoreDeps;
  private readonly entries = new Map<string, ClaimFlowEntry>();
  private readonly attached = new Map<string, number>();
  private readonly watching = new Map<string, () => void>();
  private readonly settled = new WeakSet<TxState>();
  private readonly reread = new WeakSet<TxState>();
  private readonly listeners = new Set<() => void>();
  private signedList: readonly ClaimFlowEntry[] = NONE;

  constructor(deps: ClaimFlowStoreDeps) {
    this.deps = deps;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Signed claims that are not hidden, in the order they were first created. Same array while nothing in it changes. */
  readonly getSigned = (): readonly ClaimFlowEntry[] => this.signedList;

  readonly get = (key: string): ClaimFlowEntry | null => this.entries.get(key) ?? null;

  /**
   * The flow for (account, pair): the existing one (a signed claim re-attaches here) or a new idle one. Idempotent and
   * silent (it never notifies), so a card may call it while rendering.
   */
  obtain(account: Address, pairId: string, request: TxFlowRequest, env: TxFlowEnvironment): ClaimFlowEntry {
    const key = claimFlowKey(account, pairId);
    const existing = this.entries.get(key);
    if (existing) return existing;
    const entry: ClaimFlowEntry = Object.freeze({
      key,
      account,
      pairId: canonicalPairId(pairId),
      controller: this.deps.createController(request, env),
      started: null,
      signed: false,
      hidden: false,
    });
    this.entries.set(key, entry);
    return entry;
  }

  /** A card shows this flow; the returned function detaches it. The last detach drops an unsigned flow. */
  attach(key: string): () => void {
    this.attached.set(key, (this.attached.get(key) ?? 0) + 1);
    let attachedHere = true;
    return () => {
      if (!attachedHere) return;
      attachedHere = false;
      const remaining = (this.attached.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.attached.set(key, remaining);
        return;
      }
      this.attached.delete(key);
      // Deferred: a card that detaches and re-attaches in the same turn (StrictMode, a re-keyed list) keeps its flow.
      queueMicrotask(() => this.dropIfUnused(key));
    };
  }

  /** Starts a new request on this flow with what the card showed (no-op while a request is open). */
  start(key: string, started: StartedClaim): void {
    const entry = this.entries.get(key);
    if (!entry || isTxBusy(entry.controller.getSnapshot())) return;
    this.watch(entry);
    this.replace({ ...entry, started, signed: false, hidden: false });
    entry.controller.start();
  }

  /** Removes a finished signed claim from the tracked lists (an open request cannot be hidden). */
  hide(key: string): void {
    const entry = this.entries.get(key);
    if (!entry || entry.hidden || isTxBusy(entry.controller.getSnapshot())) return;
    this.replace({ ...entry, hidden: true });
  }

  /** Cancels every pending step and timer (the app unmounts). The flows can still be used afterwards. */
  dispose(): void {
    this.entries.forEach((entry) => entry.controller.dispose());
  }

  private watch(entry: ClaimFlowEntry): void {
    if (this.watching.has(entry.key)) return;
    this.watching.set(
      entry.key,
      entry.controller.subscribe(() => this.onState(entry.key)),
    );
  }

  private onState(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const { state } = entry.controller.getSnapshot();
    if (!entry.signed && hasHash(state)) this.replace({ ...entry, signed: true });
    // Finalized is the ONLY success (UI-08): only then does the demo ledger consume the claim, once.
    if (state.status === 'finalized' && entry.started !== null && !this.settled.has(state)) {
      this.settled.add(state);
      const settlement = demoSettlementOf(entry.started.claim, entry.started.action, entry.started.pair, { hash: state.hash, block: state.block });
      if (settlement !== null) this.deps.record(settlement);
    }
    if (REREAD_ON.has(state.status) && !this.reread.has(state)) {
      this.reread.add(state);
      this.deps.refresh();
    }
  }

  private dropIfUnused(key: string): void {
    if ((this.attached.get(key) ?? 0) > 0) return;
    const entry = this.entries.get(key);
    if (!entry || entry.signed) return;
    this.watching.get(key)?.();
    this.watching.delete(key);
    entry.controller.dispose();
    this.entries.delete(key);
  }

  private replace(next: ClaimFlowEntry): void {
    this.entries.set(next.key, Object.freeze(next));
    const signed = [...this.entries.values()].filter((entry) => entry.signed && !entry.hidden);
    const same = signed.length === this.signedList.length && signed.every((entry, index) => entry === this.signedList[index]);
    if (!same) this.signedList = signed.length === 0 ? NONE : Object.freeze(signed);
    this.listeners.forEach((listener) => listener());
  }
}
