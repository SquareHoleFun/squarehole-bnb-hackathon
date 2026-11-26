/**
 * Interactive demo transaction flow (SH-015; 06-ARCHITECTURE state machine; UI-08; ECO-07). Framework-free so it can
 * be tested without React; `useTxFlow` wraps it.
 *
 * Every state change goes through the domain `txReducer`. The mock executor script (chosen per request) supplies the
 * scripted events; the person supplies the decisions (switch network, sign, reject); the wallet supplies account and
 * chain changes; the clock supplies `deadline_passed` (the reducer has no clock). Nothing is signed or broadcast.
 *
 * - Before signing, a changed wallet account or chain, or a passed deadline, invalidates the request. A wallet that
 *   disconnects before signing drops the request back to idle (nothing was signed, there is nothing to track).
 * - After signing, wallet and clock changes no longer touch the tracked transaction (the reducer ignores them).
 * - Scripted steps are spaced `stepMs` apart so each state is visible; reset/start cancel every pending step.
 */
import {
  TX_IDLE,
  isTxTerminal,
  parseIsoTimestamp,
  sameAddress,
  txReducer,
  type Address,
  type TxContext,
  type TxEvent,
  type TxState,
} from '@squarehole/domain';
import type { MockTxScriptName } from '@squarehole/providers';
import type { ChainFlowInfo, ChainTxSpec, WalletSigner } from './chain-types';
import { txScriptProfile, type TxScriptProfile } from './tx-script';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export type TxFlowKind = 'create' | 'claim';

export interface TxFlowRequest {
  readonly kind: TxFlowKind;
  /** Names the request in the status panel, e.g. "Claim ORCHARD fee share". */
  readonly label: string;
  readonly requiredChainId: number;
  /** ISO quote deadline (claim conversions); omitted when the request has none. */
  readonly deadline?: string;
  /** Fixed mock script; when omitted the flow uses the tester's "Demo scenario" choice at start. */
  readonly script?: MockTxScriptName;
  /**
   * Stage C: a real chain request (createLaunch or a claim on the local chain or Sepolia). With it the flow runs the
   * chain executor instead of the mock script and needs a browser wallet; without it the flow stays a demo flow.
   */
  readonly chain?: ChainTxSpec;
}

export interface TxFlowEnvironment {
  readonly account: Address | null;
  readonly chainId: number | null;
  readonly switchWalletChain: (chainId: number) => Promise<void>;
  /** The "Demo scenario" choice, used when the request has no fixed script. */
  readonly scenario: MockTxScriptName;
  /** Demo clock in epoch ms (see demo-clock.ts). */
  readonly now: () => number;
  readonly stepMs: number;
  /** The connected browser wallet's signer (null for the demo wallet or when disconnected). Chain flows only. */
  readonly signer?: WalletSigner | null;
  /** False on chain data sources: a request without a chain spec never starts a demo flow (see TxFlowConfig). */
  readonly demoFlows?: boolean;
}

export interface TxFlowSnapshot {
  readonly state: TxState;
  readonly switching: boolean;
  /** Chain flows only: what was simulated, the fee estimate, wallet progress, the verified result. */
  readonly chain?: ChainFlowInfo;
}

/**
 * What the status panel, `useControlledTxFlow` and the claim store use of a flow. Implemented by the demo flow
 * (`DemoTxFlowController`, mock executor scripts) and the chain flow (`ChainTxFlowController`, the real executor).
 */
export interface TxFlowController {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => TxFlowSnapshot;
  configure(request: TxFlowRequest, env: TxFlowEnvironment): void;
  readonly start: () => void;
  readonly sign: () => void;
  readonly reject: () => void;
  readonly switchChain: () => Promise<void>;
  readonly reset: () => void;
  dispose(): void;
}

/** Controls the status panel finds for a state this flow produced (see tx-registry.ts). */
export interface TxFlowControls {
  readonly label: string;
  /** True only while the flow waits for the person to sign or reject (not while a scenario decides). */
  readonly interactive: boolean;
  /** The request has a fixed script, so the "Demo scenario" choice does not apply to it. */
  readonly scriptLocked: boolean;
  readonly sign: () => void;
  readonly reject: () => void;
  readonly switchChain: () => Promise<void>;
  /** Starts a fresh request (from a finished, timed-out or unknown state). */
  readonly retry: () => void;
  /** Drops a request that has not been signed (e.g. stuck on the wrong network). */
  readonly cancel: () => void;
  /** Chain flows only (absent for demo flows). */
  readonly chain?: ChainFlowControls;
}

/** The chain flow's extra controls for the status panel. */
export interface ChainFlowControls {
  readonly info: ChainFlowInfo;
  readonly chainName: string;
  readonly nativeSymbol: string;
  readonly explorerOrigin: string | null;
  /** "Re-check by hash" after timed_out / unknown. */
  readonly recheck: () => void;
}

export class TxSwitchDeclinedError extends Error {
  constructor(message = DEMO_BUILD ? 'The wallet declined the network switch (scenario: wrong network).' : 'The wallet declined the network switch.') {
    super(message);
    this.name = 'TxSwitchDeclinedError';
  }
}

const BEFORE_SIGNING: ReadonlySet<TxState['status']> = new Set(['preparing', 'wrong_chain', 'awaiting_signature']);
const BUSY: ReadonlySet<TxState['status']> = new Set([
  'preparing',
  'wrong_chain',
  'awaiting_signature',
  'submitted',
  'pending',
  'confirmed_unfinalized',
]);

export const isBeforeSigning = (state: TxState): boolean => BEFORE_SIGNING.has(state.status);
export const isTxBusy = (snapshot: TxFlowSnapshot): boolean => snapshot.switching || BUSY.has(snapshot.state.status);

export type TxStateListener = (state: TxState, controls: TxFlowControls) => void;

export class DemoTxFlowController implements TxFlowController {
  /** This flow's own idle object (same shape as TX_IDLE), so the panel can find the flow's label and options. */
  private readonly idle: TxState = Object.freeze({ status: 'idle' });
  private snapshot: TxFlowSnapshot = Object.freeze({ state: this.idle, switching: false });
  private readonly listeners = new Set<() => void>();
  private request: TxFlowRequest;
  private env: TxFlowEnvironment;
  private readonly onState: TxStateListener | undefined;
  private profile: TxScriptProfile | null = null;
  private run = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(request: TxFlowRequest, env: TxFlowEnvironment, onState?: TxStateListener) {
    this.request = request;
    this.env = env;
    this.onState = onState;
    onState?.(this.idle, this.controlsFor(this.idle));
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): TxFlowSnapshot => this.snapshot;

  /** Latest request options and wallet/clock environment; wallet changes become reducer events here. */
  configure(request: TxFlowRequest, env: TxFlowEnvironment): void {
    const previous = this.env;
    this.request = request;
    this.env = env;
    const accountChanged =
      previous.account === null ? env.account !== null : env.account === null || !sameAddress(previous.account, env.account);
    if (accountChanged) {
      if (env.account === null) {
        if (isBeforeSigning(this.snapshot.state)) this.reset();
      } else {
        this.dispatch({ type: 'account_changed', account: env.account });
      }
    }
    if (env.chainId !== null && env.chainId !== previous.chainId) this.dispatch({ type: 'chain_changed', chainId: env.chainId });
  }

  readonly start = (): void => {
    const { state } = this.snapshot;
    if (isTxBusy(this.snapshot)) return;
    if (this.env.demoFlows === false) return;
    const { account, chainId } = this.env;
    if (account === null || chainId === null) return;
    const ctx: TxContext = {
      kind: this.request.kind === 'create' ? 'create_launch' : 'claim',
      chainId: this.request.requiredChainId,
      account,
      deadline: this.request.deadline ?? null,
    };
    this.cancel();
    if (state.status !== 'idle') this.dispatch({ type: 'reset' });
    this.profile = txScriptProfile(this.request.script ?? this.env.scenario, ctx);
    // The real wallet chain wins; a wrong-chain scenario only overrides a wallet that is on the right chain.
    const walletChainId = chainId !== ctx.chainId ? chainId : (this.profile.scriptedWalletChainId ?? chainId);
    this.dispatch({ type: 'prepare', ctx, walletChainId });
  };

  readonly sign = (): void => {
    const { profile } = this;
    if (this.snapshot.state.status !== 'awaiting_signature' || profile === null) return;
    this.dispatch(profile.walletDeclines ? { type: 'reject' } : { type: 'sign', hash: profile.signHash });
  };

  readonly reject = (): void => {
    this.dispatch({ type: 'reject' });
  };

  /** Asks the wallet to switch to the request's chain. Rejects with the wallet's error (or TxSwitchDeclinedError). */
  readonly switchChain = async (): Promise<void> => {
    const { state, switching } = this.snapshot;
    if (state.status !== 'wrong_chain' || switching) return;
    if (this.profile?.switchAccepted === false) throw new TxSwitchDeclinedError();
    const run = this.run;
    const target = state.ctx.chainId;
    this.setSnapshot({ state, switching: true });
    try {
      // A wrong-chain scenario on a wallet that is really on the right chain: the demo wallet takes one step.
      if (this.env.chainId === target) await this.pause();
      else await this.env.switchWalletChain(target);
    } finally {
      if (run === this.run) this.setSnapshot({ state: this.snapshot.state, switching: false });
    }
    if (run === this.run) this.dispatch({ type: 'chain_changed', chainId: target });
  };

  readonly reset = (): void => {
    this.cancel();
    this.profile = null;
    this.dispatch({ type: 'reset' });
  };

  /** Cancels pending steps and timers (unmount). The flow can still be used afterwards. */
  dispose(): void {
    this.cancel();
  }

  private cancel(): void {
    this.run += 1;
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.clearDeadline();
    if (this.snapshot.switching) this.setSnapshot({ state: this.snapshot.state, switching: false });
  }

  private dispatch(event: TxEvent): void {
    const reduced = txReducer(this.snapshot.state, event);
    const next = reduced === TX_IDLE ? this.idle : reduced;
    if (next === this.snapshot.state) return;
    this.setSnapshot({ state: next, switching: this.snapshot.switching });
    this.enter(next);
  }

  private setSnapshot(snapshot: TxFlowSnapshot): void {
    this.snapshot = Object.freeze(snapshot);
    this.onState?.(this.snapshot.state, this.controlsFor(this.snapshot.state));
    this.listeners.forEach((listener) => listener());
  }

  private controlsFor(state: TxState): TxFlowControls {
    const { profile } = this;
    return Object.freeze({
      label: this.request.label,
      interactive:
        state.status === 'awaiting_signature' && profile !== null && !profile.walletDeclines && profile.whileAwaitingSignature.length === 0,
      scriptLocked: this.request.script !== undefined,
      sign: this.sign,
      reject: this.reject,
      switchChain: this.switchChain,
      retry: this.start,
      cancel: this.reset,
    });
  }

  /** Side effects of entering a state: scripted steps and the deadline watch. */
  private enter(state: TxState): void {
    const { profile } = this;
    if (isBeforeSigning(state)) this.watchDeadline(state);
    else this.clearDeadline();
    if (profile === null) return;
    if (state.status === 'preparing') this.play([profile.simulation]);
    else if (state.status === 'awaiting_signature' && profile.walletDeclines) this.play([{ type: 'reject' }]);
    else if (state.status === 'awaiting_signature') this.play(profile.whileAwaitingSignature);
    else if (state.status === 'submitted') this.play(profile.afterSigning);
  }

  /** Dispatches `events` one per step, in order, unless the run is cancelled first. */
  private play(events: readonly TxEvent[]): void {
    const [first, ...rest] = events;
    if (first === undefined) return;
    const run = this.run;
    this.later(this.env.stepMs, () => {
      if (run !== this.run) return;
      this.dispatch(first);
      if (run === this.run && !isTxTerminal(this.snapshot.state)) this.play(rest);
    });
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => this.later(this.env.stepMs, resolve));
  }

  private later(ms: number, callback: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, ms);
    this.timers.add(timer);
  }

  private watchDeadline(state: TxState): void {
    if (this.deadlineTimer !== null || !('ctx' in state) || state.ctx.deadline === null) return;
    const deadlineMs = parseIsoTimestamp(state.ctx.deadline);
    const run = this.run;
    const check = (): void => {
      this.deadlineTimer = null;
      if (run !== this.run) return;
      const now = this.env.now();
      if (now < deadlineMs) {
        this.deadlineTimer = setTimeout(check, deadlineMs - now);
        return;
      }
      this.dispatch({ type: 'deadline_passed', at: new Date(now).toISOString() });
    };
    this.deadlineTimer = setTimeout(check, Math.max(0, deadlineMs - this.env.now()));
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }
}
