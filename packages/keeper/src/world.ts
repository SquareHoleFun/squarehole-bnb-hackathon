import type { Address } from 'viem';
import type { M2Scan, M2Work } from './m2';
import type { M3Work } from './m3';
import type { MonitorReadings } from './monitor';
import type { Candidate } from './types';

/** CQ11 state, read from each box's own immutable parts, never the current listing raise. */
export interface V2State {
  readonly rewardsPendingP?: bigint;
  /**
   * `rewardsPendingByKind()` (holders, buyers' items, sellers' items), read only while `rewardsPendingP` is positive:
   * buyBack buys from one kind at a time, each against STEP_MIN_Q. Absent: not read, unreadable or an older receiver.
   */
  readonly rewardsPendingByKind?: readonly [bigint, bigint, bigint];
  readonly rewardBurnPendingT?: bigint;
  readonly m2?: readonly M2Work[];
  readonly m3?: readonly M3Work[];
  readonly router: Address;
  readonly q: Address;
  /** Native P = 18; unavailable or unsupported ERC-20 decimals = null. Never a price. */
  readonly qDecimals: number | null;
  readonly closedAt: bigint;
  readonly lastProtocolBlock: bigint;
  readonly depthBudget: bigint;
  readonly graduationSettled: boolean;
  readonly buyBackP: bigint;
  /** V2.1 raw P waiting to burn/lock. Missing/null is unknown; old non-eat choices read zero. */
  /** Raw pending P by immutable module side; null/absent reads schedule nothing. */
  readonly modulePendingP?: readonly [bigint | null, bigint | null];
  readonly pilePendingP?: bigint | null;
  readonly shopPendingP?: bigint | null;
  readonly eatPendingP?: bigint | null;
  readonly tBurnPending: bigint;
  /** Only rewardOf(the keeper), not another graduator's money. */
  readonly reward: bigint;
  readonly pot: bigint;
  readonly tLeft: bigint;
  readonly royalty?: {
    readonly address: Address; readonly eth: bigint; readonly wrapped: bigint; readonly price: bigint;
    /**
     * RC6 inbox: each sellable coin of the box's frozen list (its creation-time list version) with a positive lot, read at
     * the snapshot: raw lot, balance (WETH counts unwrapped ETH, which refreshOrder wraps first), the VaultRelayer
     * allowance, recorded approval, clock and whether its ComposableCoW order is registered. Absent or empty: no jobs.
     */
    readonly coins?: readonly InboxCoin[];
  };
  /**
   * Second release review (RC6RR2-MONEY-1, RC6RR2-HP-1): a live sourced box's allocation lag at the snapshot. `buyerLag`
   * counts closed buyer sources past the receiver's buyer cursor (all ids below the open one are closed); `sellerRun`
   * counts closed seller sources in a row past its seller cursor, up to 3. The rc7 receiver view replaces storage reads.
   * The unchanged thresholds count every closed source; rc7 can reach further with up to five sub-unit passes plus two
   * quota places per side. Absent: unsourced, failed, unreadable or an rc6 receiver without the view.
   */
  readonly sources?: { readonly buyerLag: bigint; readonly sellerRun: bigint };
  /** The hook's immutable `STEP_MIN_Q` from its clone arguments (RC6RR2-HP-3); absent when its code is not a clone. */
  readonly stepMinQ?: bigint;
}

/** One frozen-list coin of an income inbox, in raw units of that coin. */
export interface InboxCoin {
  readonly coin: Address;
  readonly lot: bigint;
  readonly balance: bigint;
  readonly allowance: bigint;
  readonly approved: bigint;
  readonly oldestUnsoldAt: bigint;
  readonly registered: boolean;
}

export interface BoxState {
  readonly id: bigint;
  readonly version: 1 | 2;
  readonly coordinator: Address;
  readonly hook: Address;
  readonly receiver: Address;
  /** Box 0's executor only. */
  readonly priceSource: Address | null;
  /** Box-0 execution reads, only after checking the coordinator's executor and its launchPhase back-reference. */
  readonly executor?: { readonly budget: bigint; readonly batchThreshold: bigint; readonly twapReady: boolean };
  readonly graduated: boolean;
  readonly failed: boolean;
  readonly curveClosed: boolean;
  readonly gateOpen: boolean;
  readonly openAt: bigint;
  readonly deadline: bigint;
  readonly spotTick: number | null;
  readonly sampleTick: number | null;
  readonly checkpointTime: bigint;
  readonly fitOwed: bigint;
  readonly platformOwed: bigint;
  /** Native P = 1e18. ERC-20 P stays unknown; no on-chain price oracle or guessed valuation. */
  readonly qPerEthX18: bigint | null;
  /** Required to schedule v2. An incomplete read never becomes a default financial state. */
  readonly v2?: V2State;
  /** Set-only lifecycle reader: no fee, draw, ticket, item or holder maintenance state is inferred. */
  readonly setLifecycle?: { readonly closedAt: bigint };
}

export interface World {
  readonly drand?: readonly Candidate[];
  readonly m2Scan?: M2Scan;
  readonly block: { readonly number: bigint; readonly timestamp: bigint; readonly baseFeePerGas: bigint };
  readonly fitGraduated: boolean;
  readonly boxes: readonly BoxState[];
  /** Completeness, snapshot header and drand observation for the monitor view; only when the view is configured. */
  readonly monitor?: MonitorReadings;
}
