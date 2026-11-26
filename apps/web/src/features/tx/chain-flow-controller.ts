/**
 * The real transaction flow (Stage C; 06-ARCHITECTURE state machine; UI-08; UI-09; ECO-07). Same surface as the demo
 * flow, so `useControlledTxFlow`, the claim store and `TxStatusPanel` drive both; every state still comes from the
 * domain `txReducer`, and the chain executor (`runChainWrite` from `@squarehole/chain/write`) supplies the events.
 *
 * - `start()` (the page's Create / Claim click) prepares and simulates for the connected browser-wallet account. A
 *   wallet on another chain gives `wrong_chain`; switching (an explicit click) re-simulates.
 * - Nothing reaches the wallet until `sign()` (the panel's "Confirm in wallet" click).
 * - Before signing, an account or chain change, or the request's deadline passing, invalidates the request and stops
 *   the preparation; a hash the wallet returns afterwards is shown as a late hash, never tracked as this request.
 * - After signing, the tracker follows the hash to finality (or reverted / replaced / timed out / unknown);
 *   `recheck()` resumes a timed-out or unknown request by its hash. Only `finalized` is success.
 */
import { TX_IDLE, isTxTerminal, parseIsoTimestamp, sameAddress, txReducer, type TxContext, type TxEvent, type TxState } from '@squarehole/domain';
import type { ChainWriteOptions, TxTracker } from '@squarehole/chain/write';
import { EMPTY_CHAIN_INFO, type ChainFlowInfo, type ChainTxSpec } from './chain-types';
import { GAS_WORDS, gasFundsLine } from './gas-words';
import type { TxFlowController, TxFlowControls, TxFlowEnvironment, TxFlowRequest, TxFlowSnapshot, TxStateListener } from './tx-flow-controller';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export const DEMO_WALLET_CANNOT_SIGN = DEMO_BUILD ? 'Connect a browser wallet to send this transaction: the sample wallet cannot sign it.' : 'Connect a browser wallet to send this transaction.';

const BEFORE_SIGNING: ReadonlySet<TxState['status']> = new Set(['preparing', 'wrong_chain', 'awaiting_signature']);

export class ChainTxFlowController implements TxFlowController {
  private readonly idle: TxState = Object.freeze({ status: 'idle' });
  private snapshot: TxFlowSnapshot = Object.freeze({ state: this.idle, switching: false, chain: EMPTY_CHAIN_INFO });
  private readonly listeners = new Set<() => void>();
  private request: TxFlowRequest & { readonly chain: ChainTxSpec };
  private env: TxFlowEnvironment;
  private readonly onState: TxStateListener | undefined;
  /** Aborts the current preparation / confirmation wait (reset, invalidation, a new start). */
  private run: AbortController | null = null;
  private confirmation: ((decision: 'send' | 'cancel') => void) | null = null;
  private tracker: TxTracker<unknown> | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private deadline: bigint | null = null;

  /** Wall-clock time (a chain deadline is real time, never the demo clock). */
  private now(): number {
    return (this.request.chain.now ?? Date.now)();
  }

  constructor(request: TxFlowRequest & { readonly chain: ChainTxSpec }, env: TxFlowEnvironment, onState?: TxStateListener) {
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

  configure(request: TxFlowRequest, env: TxFlowEnvironment): void {
    const previous = this.env;
    if (request.chain) this.request = request as TxFlowRequest & { readonly chain: ChainTxSpec };
    this.env = env;
    const accountChanged = previous.account === null ? env.account !== null : env.account === null || !sameAddress(previous.account, env.account);
    if (accountChanged) {
      if (env.account === null) {
        if (BEFORE_SIGNING.has(this.snapshot.state.status)) this.reset();
      } else {
        this.dispatch({ type: 'account_changed', account: env.account });
      }
    }
    if (env.chainId !== null && env.chainId !== previous.chainId) this.dispatch({ type: 'chain_changed', chainId: env.chainId });
    if (this.snapshot.chain?.notice && env.signer) this.patch({ notice: null });
  }

  readonly start = (): void => {
    const { state } = this.snapshot;
    if (this.snapshot.switching || (BEFORE_SIGNING.has(state.status) || state.status === 'submitted' || state.status === 'pending' || state.status === 'confirmed_unfinalized')) return;
    const { account, chainId, signer } = this.env;
    if (account === null || chainId === null) return;
    if (!signer) {
      this.patch({ notice: DEMO_WALLET_CANNOT_SIGN });
      return;
    }
    this.cancelRun();
    this.tracker?.stop();
    this.tracker = null;
    if (state.status !== 'idle') this.dispatch({ type: 'reset' });
    const { deadlineSeconds, writeChain } = this.request.chain;
    const nowMs = this.now();
    this.deadline = deadlineSeconds === null ? null : BigInt(Math.floor(nowMs / 1000) + deadlineSeconds);
    const ctx: TxContext = {
      kind: this.request.kind === 'create' ? 'create_launch' : 'claim',
      chainId: writeChain.chainId,
      account,
      deadline: this.deadline === null ? null : new Date(Number(this.deadline) * 1000).toISOString(),
    };
    this.setSnapshot({ state: this.snapshot.state, switching: false, chain: EMPTY_CHAIN_INFO });
    this.dispatch({ type: 'prepare', ctx, walletChainId: chainId });
  };

  /** "Confirm in wallet": the only path to the wallet request. */
  readonly sign = (): void => {
    if (this.snapshot.state.status !== 'awaiting_signature' || this.snapshot.chain?.walletPending) return;
    this.patch({ walletError: null });
    this.confirmation?.('send');
  };

  /** Cancels a request that has not been sent (app-side; a decline in the wallet is reported by the wallet). */
  readonly reject = (): void => {
    this.reset();
  };

  readonly switchChain = async (): Promise<void> => {
    const { state, switching } = this.snapshot;
    if (state.status !== 'wrong_chain' || switching) return;
    const target = state.ctx.chainId;
    this.setSnapshot({ ...this.snapshot, switching: true });
    try {
      await this.env.switchWalletChain(target);
    } finally {
      this.setSnapshot({ ...this.snapshot, switching: false });
    }
    // The wallet's chainChanged event reaches `configure`; a wallet that switched silently is checked here too.
    if (this.snapshot.state.status === 'wrong_chain' && this.env.chainId === target) this.dispatch({ type: 'chain_changed', chainId: target });
  };

  readonly recheck = (): void => {
    const status = this.snapshot.state.status;
    if ((status !== 'timed_out' && status !== 'unknown') || this.tracker === null) return;
    this.patch({ rechecking: true, trackerEnd: null });
    this.tracker.recheck();
  };

  readonly reset = (): void => {
    this.cancelRun();
    this.tracker?.stop();
    this.tracker = null;
    this.clearDeadline();
    const lateHash = this.snapshot.chain?.lateHash ?? null;
    this.dispatch({ type: 'reset' });
    this.setSnapshot({ state: this.snapshot.state, switching: false, chain: { ...EMPTY_CHAIN_INFO, lateHash } });
  };

  dispose(): void {
    this.cancelRun();
    this.tracker?.stop();
    this.tracker = null;
    this.clearDeadline();
  }

  private cancelRun(): void {
    this.run?.abort();
    this.run = null;
    this.confirmation?.('cancel');
    this.confirmation = null;
  }

  private patch(info: Partial<ChainFlowInfo>): void {
    this.setSnapshot({ ...this.snapshot, chain: { ...(this.snapshot.chain ?? EMPTY_CHAIN_INFO), ...info } });
  }

  private dispatch(event: TxEvent): void {
    const reduced = txReducer(this.snapshot.state, event);
    const next = reduced === TX_IDLE ? this.idle : reduced;
    if (next === this.snapshot.state) return;
    const previous = this.snapshot.state;
    this.setSnapshot({ ...this.snapshot, state: next });
    this.enter(next, previous);
  }

  private setSnapshot(snapshot: TxFlowSnapshot): void {
    this.snapshot = Object.freeze(snapshot);
    this.onState?.(this.snapshot.state, this.controlsFor(this.snapshot.state));
    this.listeners.forEach((listener) => listener());
  }

  private controlsFor(state: TxState): TxFlowControls {
    const chain = this.request.chain.writeChain;
    return Object.freeze({
      label: this.request.label,
      interactive: state.status === 'awaiting_signature',
      scriptLocked: true,
      sign: this.sign,
      reject: this.reject,
      switchChain: this.switchChain,
      retry: this.start,
      cancel: this.reset,
      chain: Object.freeze({
        info: this.snapshot.chain ?? EMPTY_CHAIN_INFO,
        chainName: chain.name,
        nativeSymbol: chain.nativeSymbol,
        explorerOrigin: chain.explorerOrigin,
        recheck: this.recheck,
      }),
    });
  }

  private enter(state: TxState, previous: TxState): void {
    if (BEFORE_SIGNING.has(state.status)) this.watchDeadline();
    else this.clearDeadline();
    if (state.status === 'preparing' && previous.status !== 'preparing') this.beginRun();
    // Leaving "before signing" for anything but a signature ends the preparation (invalidated, rejected, failed…).
    if (BEFORE_SIGNING.has(previous.status) && !BEFORE_SIGNING.has(state.status) && state.status !== 'submitted') this.cancelRun();
    if (state.status === 'wrong_chain') this.cancelRun();
    if (isTxTerminal(state) || state.status === 'confirmed_unfinalized') this.patch({ rechecking: false });
  }

  private beginRun(): void {
    this.cancelRun();
    const { account, signer } = this.env;
    const state = this.snapshot.state;
    if (account === null || !signer || state.status !== 'preparing') return;
    const run = new AbortController();
    this.run = run;
    const spec = this.request.chain;
    const deadline = this.deadline;
    const options: ChainWriteOptions<unknown> = {
      reader: spec.reader,
      chain: spec.writeChain,
      deployment: spec.deployment,
      wallet: signer.request,
      account: state.ctx.account,
      prepare: () => spec.prepare({ account: state.ctx.account, deadline }),
      signal: run.signal,
      hooks: {
        emit: (event) => this.dispatch(event),
        onPrepared: (prepared, simulation) => {
          if (!run.signal.aborted) this.patch({ details: prepared.details, simulation });
        },
        onRefusal: (refusal) => {
          if (!run.signal.aborted) this.patch({ refusalFallback: refusal.fallback });
        },
        awaitConfirmation: () =>
          new Promise((resolve) => {
            if (run.signal.aborted) return resolve('cancel');
            this.confirmation = resolve;
          }),
        onWalletPending: (pending) => this.patch({ walletPending: pending }),
        // SH-SEND-FEES: the executor's funds check and a fee that rose at the press get the page's own words.
        onWalletError: (message, reason) => this.patch({ walletError: reason === 'fee_rose' ? GAS_WORDS.feeRose : reason ? gasFundsLine(reason.chainId) : message }),
        onLateHash: (hash) => this.patch({ lateHash: hash }),
        onResult: (result) => this.patch({ result }),
        onReplacement: (replacement) => this.patch({ replacement }),
        onTrackerEnd: (end) => this.patch({ trackerEnd: end, rechecking: false }),
      },
    };
    // The executor (and viem's ABI coder) loads with the first chain request, not with the page: demo visitors never
    // download it.
    void import('@squarehole/chain/write').then(({ runChainWrite }) => (run.signal.aborted ? null : runChainWrite<unknown>(options))).then(
      (tracker) => {
        if (tracker !== null) this.tracker = tracker;
        if (this.run === run) this.run = null;
      },
      (error: unknown) => {
        if (run.signal.aborted) return;
        this.dispatch({ type: 'simulate_fail', reason: `The request could not be prepared (${error instanceof Error ? error.message : 'unknown error'}). Nothing was sent.`.slice(0, 480) });
      },
    );
  }

  private watchDeadline(): void {
    const state = this.snapshot.state;
    if (this.deadlineTimer !== null || !('ctx' in state) || state.ctx.deadline === null) return;
    const deadlineMs = parseIsoTimestamp(state.ctx.deadline);
    const check = (): void => {
      this.deadlineTimer = null;
      if (!BEFORE_SIGNING.has(this.snapshot.state.status)) return;
      const now = this.now();
      if (now < deadlineMs) {
        this.deadlineTimer = setTimeout(check, Math.min(deadlineMs - now, 2_147_483_647));
        return;
      }
      this.dispatch({ type: 'deadline_passed', at: new Date(now).toISOString() });
    };
    this.deadlineTimer = setTimeout(check, Math.max(0, Math.min(deadlineMs - this.now(), 2_147_483_647)));
  }

  private clearDeadline(): void {
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }
}
