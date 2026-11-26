/**
 * Types shared by the chain transaction flow (Stage C) and the status panel. The executor itself lives in
 * `@squarehole/chain/write`; this app layer only drives it and renders its states.
 */
import type { Address, TxHash } from '@squarehole/domain';
import type {
  ChainReader,
  Eip1193Request,
  PreparedWrite,
  ReplacementInfo,
  Simulation,
  TrackerEnd,
  WriteChain,
  WriteDeployment,
  WriteDetail,
} from '@squarehole/chain/write';

/** The connected browser wallet as the chain flow needs it (never the demo wallet). */
export interface WalletSigner {
  readonly request: Eip1193Request;
  readonly walletName: string;
}

/** A real chain request: where it goes and how it is prepared for the connected account. */
export interface ChainTxSpec {
  readonly writeChain: WriteChain;
  readonly deployment: WriteDeployment;
  /** Reads for the target chain from the app's configured RPC (never the wallet's). */
  readonly reader: ChainReader;
  /** Validity before signing (claimAsT: 20 minutes; also its on-chain deadline); null when the request has none. */
  readonly deadlineSeconds: number | null;
  /** Wall clock in epoch ms (default `Date.now`; tests inject one). Deadlines are real time, never the demo clock. */
  readonly now?: () => number;
  /** Registry reads, template bounds, quotes: the call to simulate. Throws `PrepareRefusal` to refuse. */
  readonly prepare: (input: { readonly account: Address; readonly deadline: bigint | null }) => Promise<PreparedWrite<unknown>>;
}

export interface ChainFlowInfo {
  /** What the person reviews before the wallet opens (from the writer). */
  readonly details: readonly WriteDetail[] | null;
  readonly simulation: Simulation | null;
  /** The wallet has the request open. */
  readonly walletPending: boolean;
  readonly walletError: string | null;
  /** Why the request cannot start (e.g. the demo wallet is connected). */
  readonly notice: string | null;
  /** A separately labelled alternative the page may offer after a refusal (never selected automatically). */
  readonly refusalFallback: 'claim_as_q_when_sold_out' | null;
  /** A hash the wallet returned after the request was cancelled or invalidated. */
  readonly lateHash: TxHash | null;
  readonly replacement: ReplacementInfo | null;
  /** The writer's verified result, set only at finality. */
  readonly result: unknown;
  readonly trackerEnd: TrackerEnd | null;
  readonly rechecking: boolean;
}

export const EMPTY_CHAIN_INFO: ChainFlowInfo = Object.freeze({
  details: null,
  simulation: null,
  walletPending: false,
  walletError: null,
  notice: null,
  refusalFallback: null,
  lateHash: null,
  replacement: null,
  result: null,
  trackerEnd: null,
  rechecking: false,
});
