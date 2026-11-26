/**
 * One write from preparation to a tracked hash: the single code path the app's transaction flow and the anvil
 * integration test both use. The caller owns the domain reducer (it has already dispatched `prepare`) and decides when
 * the wallet may be asked: `awaitConfirmation` resolves on the person's own click ("Confirm in wallet"), so nothing
 * reaches the wallet without an explicit action (UI-09).
 *
 *   preparing:          prepare() (registry reads, quote) → simulateWrite → simulate_fail(reason) | simulate_ok
 *   awaiting_signature: awaitConfirmation() → submitWrite → reject (4001) | chain_changed / account_changed (the
 *                       wallet moved; the reducer invalidates) | wallet error (shown; the person may try again)
 *   submitted…:         sign(hash) → TxTracker (returned so the caller can re-check or stop it)
 */
import type { Address, TxEvent, TxHash } from '@squarehole/domain';
import type { WriteChain } from './chains';
import type { WriteDeployment } from './deployment';
import type { Eip1193Request } from './eip1193';
import {
  InsufficientGasFundsError, TxTracker, WalletContextChangedError, WalletRejectedError, WalletRequestError, feeEstimateOf, readFeeEstimate, simulateWrite,
  submitWrite, type ReplacementInfo, type SendFees, type Simulation, type TrackerEnd,
} from './executor';
import { NotSendableError } from './calls';
import { PrepareRefusal, type PreparedWrite } from './prepared';
import type { ChainReader } from './rpc';
import { cleanText, errorMessage } from './eip1193';

export interface ChainWriteHooks<R> {
  /** Domain events for the caller's `txReducer`. */
  readonly emit: (event: TxEvent) => void;
  readonly onPrepared?: (prepared: PreparedWrite<R>, simulation: Simulation) => void;
  /** The preparation refusal, when a separately labelled alternative exists (e.g. the sold-out Q fallback). */
  readonly onRefusal?: (refusal: PrepareRefusal) => void;
  /** Resolves when the person clicks "Confirm in wallet" ('send') or cancels ('cancel'). */
  readonly awaitConfirmation: () => Promise<'send' | 'cancel'>;
  readonly onWalletPending?: (pending: boolean) => void;
  /**
   * A line about the wallet request (the executor's own words, never UI copy), and, for the two a page words itself,
   * why: 'gas_funds' (the account cannot pay gasLimit × maxFeePerGas + value; `chainId` names its coin) or 'fee_rose'
   * (the fee read at the press is above the one shown; the new fee is shown, and nothing was sent).
   */
  readonly onWalletError?: (message: string, reason?: WalletErrorReason) => void;
  /** A hash that arrived after the request was cancelled or invalidated (the wallet prompt stayed open). */
  readonly onLateHash?: (hash: TxHash) => void;
  readonly onResult?: (result: R) => void;
  readonly onReplacement?: (replacement: ReplacementInfo) => void;
  readonly onTrackerEnd?: (end: TrackerEnd) => void;
}

export type WalletErrorReason = 'fee_rose' | { readonly kind: 'gas_funds'; readonly chainId: number };

/** Each field the higher of the two: never below what was shown, never below the network's fee now. */
const higherFees = (a: SendFees, b: SendFees): SendFees => ({
  maxFeePerGas: a.maxFeePerGas > b.maxFeePerGas ? a.maxFeePerGas : b.maxFeePerGas,
  maxPriorityFeePerGas: a.maxPriorityFeePerGas > b.maxPriorityFeePerGas ? a.maxPriorityFeePerGas : b.maxPriorityFeePerGas,
});

export interface ChainWriteOptions<R> {
  readonly reader: ChainReader;
  readonly chain: WriteChain;
  readonly deployment: WriteDeployment;
  readonly wallet: Eip1193Request;
  readonly account: Address;
  readonly prepare: () => Promise<PreparedWrite<R>>;
  readonly hooks: ChainWriteHooks<R>;
  /** Aborted when the caller resets or the request is invalidated before signing. */
  readonly signal: AbortSignal;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const MAX_REASON = 480;

/** Runs one write; resolves with the started tracker, or null when nothing was sent. */
export async function runChainWrite<R>(options: ChainWriteOptions<R>): Promise<TxTracker<R> | null> {
  const { reader, chain, deployment, wallet, account, hooks, signal } = options;
  const emit = (event: TxEvent) => {
    if (!signal.aborted) hooks.emit(event);
  };

  let prepared: PreparedWrite<R>;
  try {
    prepared = await options.prepare();
  } catch (error) {
    if (signal.aborted) return null;
    if (error instanceof PrepareRefusal) {
      hooks.onRefusal?.(error);
      emit({ type: 'simulate_fail', reason: cleanText(error.message, MAX_REASON) });
    } else {
      emit({ type: 'simulate_fail', reason: cleanText(`The request could not be prepared: ${errorMessage(error)}. Nothing was sent.`, MAX_REASON) });
    }
    return null;
  }
  if (signal.aborted) return null;

  const simulated = await simulateWrite(reader, chain, prepared.call, account);
  if (signal.aborted) return null;
  if (!simulated.ok) {
    emit({ type: 'simulate_fail', reason: cleanText(simulated.reason, MAX_REASON) });
    return null;
  }
  hooks.onPrepared?.(prepared, simulated.simulation);
  emit({ type: 'simulate_ok' });
  // The simulation as shown now: its fee is raised (and shown again) when a press finds the network's fee went up.
  let shown = simulated.simulation;

  for (;;) {
    const decision = await hooks.awaitConfirmation();
    if (signal.aborted || decision === 'cancel') return null;
    // Review wf_c1aec23f-2c4: the fee is read again at each press and the send carries the higher of it and the shown
    // one, so a send after a long wait or a retry is not stuck under the base fee. A higher fee than shown is shown
    // first, and waits for another press.
    let fee: SendFees;
    try {
      const fresh = await readFeeEstimate(reader, chain.chainId, shown.gasEstimate, shown.gasLimit);
      if (signal.aborted) return null;
      if (shown.fee === null || fresh.maxFeePerGas > shown.fee.maxFeePerGas) {
        const raised = shown.fee === null ? fresh : feeEstimateOf(fresh.baseFeePerGas, higherFees(shown.fee, fresh), shown.gasEstimate, shown.gasLimit);
        shown = Object.freeze({ ...shown, fee: raised });
        hooks.onPrepared?.(prepared, shown);
        hooks.onWalletError?.('The network fee went up. Check it and confirm again.', 'fee_rose');
        continue;
      }
      fee = higherFees(shown.fee, fresh);
    } catch (error) {
      if (signal.aborted) return null;
      hooks.onWalletError?.(`The network fee could not be read (${errorMessage(error)}); nothing was sent.`);
      continue;
    }
    hooks.onWalletPending?.(true);
    let hash: TxHash;
    let startBlock: bigint;
    let nonceHint: bigint | null;
    try {
      startBlock = await reader.blockNumber();
      nonceHint = await reader.getTransactionCount(account, 'pending').catch(() => null);
      // SH-SEND-FEES: the fee is the higher of the shown and the press's own read (above).
      hash = await submitWrite({ wallet, deployment, call: prepared.call, expectedLedger: prepared.expectedLedger, from: account, gasLimit: shown.gasLimit,
        feeReader: reader, fee });
    } catch (error) {
      hooks.onWalletPending?.(false);
      if (signal.aborted) return null;
      if (error instanceof WalletRejectedError) {
        emit({ type: 'reject' });
        return null;
      }
      if (error instanceof WalletContextChangedError) {
        if (error.change === 'chain' && error.walletChainId !== null) emit({ type: 'chain_changed', chainId: error.walletChainId });
        else hooks.onWalletError?.(error.message);
        if (error.change === 'chain') return null;
        continue;
      }
      if (error instanceof InsufficientGasFundsError) {
        hooks.onWalletError?.(error.message, { kind: 'gas_funds', chainId: error.chainId });
        continue;
      }
      if (error instanceof WalletRequestError || error instanceof NotSendableError) {
        hooks.onWalletError?.(error.message);
        continue;
      }
      hooks.onWalletError?.(`The request could not be sent: ${errorMessage(error)}`);
      continue;
    }
    hooks.onWalletPending?.(false);
    if (signal.aborted) {
      hooks.onLateHash?.(hash);
      return null;
    }
    emit({ type: 'sign', hash });
    const tracker = new TxTracker<R>({
      reader,
      chain,
      hash,
      from: account,
      startBlock,
      verify: prepared.verify,
      nonceHint,
      call: { to: prepared.call.to, data: prepared.call.data },
      emit: (event) => hooks.emit(event),
      onResult: hooks.onResult,
      onReplacement: hooks.onReplacement,
      onEnd: hooks.onTrackerEnd,
      now: options.now,
      sleep: options.sleep,
    });
    tracker.start();
    return tracker;
  }
}
