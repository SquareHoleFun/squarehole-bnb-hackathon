import type { Address } from 'viem';

/** Every job the keeper runs (tickets § 2, M1-51). `jobs.ts` holds each one's row; the ours list comes from there. */
export type JobName =
  | 'backupStart'
  | 'backupFix'
  | 'drandGraduationBounty'
  | 'drandPostRound'
  | 'drandWithdrawBounty'
  | 'drandRequestWord'
  | 'drandAcceptWord'
  | 'drandSettle'
  | 'itemSync'
  | 'itemResidue'
  | 'pileLoadSeed'
  | 'pileReturnSeed'
  | 'holderSettle'
  | 'holderResidue'
  | 'shopBurn'
  | 'shopReturn'
  | 'buyBack'
  | 'moveToPile'
  | 'executeModule'
  | 'shopFees'
  | 'eatPriceCoin'
  | 'burnPending'
  | 'claimReward'
  | 'routerSweep'
  | 'royaltyFlush' | 'royaltySweep' | 'royaltyRefresh' | 'royaltyObserve'
  | 'sellFees'
  | 'collect'
  | 'deepen'
  | 'fail'
  | 'failClosed'
  | 'graduate'
  | 'receiverPayFit'
  | 'receiverPayPlatform'
  | 'poke'
  | 'executorExecute'
  | 'executorTopUp';

/** One call the plan proposes: the job, a key for the keeper's memory, the target and the function with its arguments. */
export interface Candidate {
  readonly job: JobName;
  /** Terminal-head deadline served by this drand call, in unix seconds. */
  readonly drandDeadline?: bigint;
  /** Native ETH transferred by this call, in addition to gas. */
  readonly value?: bigint;
  readonly key: string;
  readonly to: Address;
  readonly fn: string;
  readonly args: readonly unknown[];
  readonly boxId?: bigint;
  readonly version?: 1 | 2;
  /** Shared pool identity for deepen/buyBack/shopFees/sellFees. */
  readonly pool?: Address;
  readonly retryAfterBlocks?: bigint;
  readonly settlesGraduation?: boolean;
  /**
   * V2 batching floor in raw units of the call's own asset (collect: P; T residue burns: T), rechecked against the
   * pending simulation before reserving gas.
   */
  readonly minAmountRaw?: bigint;
  /**
   * Set by a reader when this call of a reserved job is routine per-box maintenance: a purchased-T holder tranche or
   * a T residue burn. No claim waits on it, so it takes the ordinary F111 income caps and never the protected
   * reserve (SH-V21-FIX-KEEPER-INDEX). It can only remove reserve access, never grant it.
   */
  readonly ordinary?: true;
  /** Authenticated immutable journal producers for the pending-state sync recheck. */
  readonly syncSources?: readonly [Address, Address];
  /**
   * `collect` only (RC6RR2-MONEY-1, RC6RR2-HP-1): closed sources wait behind the receiver's cursors where this collect
   * cannot reach them, so it is worth sending below `minAmountRaw`, as unblocking work, and again on the next block.
   */
  readonly cursorLag?: true;
  /** `sellFees` only: the box has trade-batch sources, so a sent press makes its collect due on the next block. */
  readonly sourced?: true;
  /**
   * `sellFees` only (RC6RR2-HP-3): a page selling less than this much raw P (a hundredth of the hook's step minimum)
   * is griefer-sized dust that pays a few raw P, admitted as unblocking work rather than under F111.
   */
  readonly lowValueBelow?: bigint;
}

/**
 * A call simulated against the pending block: `ok` when it would do something (no revert, no wait, no skip), the
 * tip it would pay valued in wei (null: none or unknown) and the gas estimate.
 */
export interface Sim {
  readonly ok: boolean;
  readonly tipWei: bigint | null;
  readonly estimate: bigint;
  /** Actual paid raw P from this pending collect/sellFees result, never projected proceeds. */
  readonly paidTipRaw?: bigint;
  /** False when pending block reads cannot pair the start simulation with its gas estimate. */
  readonly startBlockPaired?: boolean;
  /** Separate F182 valuation, bound by the adapter to this box, call and keeper. */
  readonly startTipWei?: bigint | null;
  /**
   * `sellFees` only: the step consumes waiting T for zero P, a FIFO page of raw-wei seller sources (ADR-0017 C9 af1
   * F2). This pending simulation mark admits the press to the separate daily unblocking gas allowance (LIM-4).
   */
  readonly zeroOutput?: true;
  /**
   * Set by `interpret` when the call is admitted only as unblocking work outside F111 (second release review): a
   * `collect` below its batching floor sent for the cursors, or a `sellFees` page worth less than a hundredth of the
   * box's step minimum.
   */
  readonly unblocking?: true;
}
