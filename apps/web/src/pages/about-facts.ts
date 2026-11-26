/**
 * The figures About & risks shows (SH-V2-FE7), each taken from the release's own constants: core v1's BoxSpec (box 0
 * and the values every box shares) and the launch-tax table. The few that live only in the core v2 contracts or in the
 * v2 creation flow are written here and pinned to their source by about-facts.test.ts (the Solidity constant, the
 * flow's own option list), so a change fails a test instead of leaving a stale figure, and this page, which the main
 * bundle loads, never pulls the creation flow or the box pages into it. Amounts stay bigint; every figure is a string.
 */
import {
  BOX0_FEE_SHARE_FIT,
  BOX0_FEE_SHARE_PLATFORM,
  BOX0_FEE_SHARE_T_BURN,
  BUILD_PROFILE_MAINNET,
  DRAW_FEE_BPS,
  FEE_SHARE_DENOMINATOR,
  FEE_SHARE_DEPTH,
  FEE_SHARE_Q_STREAM,
  ISSUANCE,
  LP_FEE,
  MAX_N,
  MIN_N,
  PICK_FEE_BPS,
  RETURN_FEE_BPS,
  TAX_STEP_SECONDS,
  WINDOW_SECONDS,
  WINDOW_STEPS,
} from '@squarehole/box-spec';
import { formatTokenAmount } from '@squarehole/domain';
import { LAUNCH_TAX_TABLE_PIPS } from '@squarehole/indexer/client';

const DAY = 86_400n;

/** Core v2 values that only the contracts hold (pinned by about-facts.test.ts to the named constant). */
export const V2_CONTRACT_FACTS = Object.freeze({
  /** ReleaseConstantsV2.FEE_SHARE_FIT_V2: FIT's fifteenths of every v2 fee. */
  fitShare: 2n,
  /** ReleaseConstantsV2.FEE_SHARE_PLATFORM_V2: the platform's fifteenths. */
  platformShare: 1n,
  /** ReleaseConstantsV2.STEP_TICKS: how far one buy-back or pool add may move the price. */
  stepTicks: 49n,
  /** ReleaseConstantsV2.GRADUATION_ESCAPE_DELAY: a filled curve that has not graduated can be closed after this. */
  graduationHatchSeconds: 7n * DAY,
  /** v2-frozen.ts GATE_CAP_SECONDS: a box not open this long after its planned opening can be closed. */
  notOpenSeconds: 14n * DAY,
  /** create/v2/model.ts DEADLINE_DAYS_V2: the deadlines a creator picks from. */
  deadlineDays: Object.freeze([30, 60, 90, 180]) as readonly number[],
  /** create/v2/model.ts PICK_FEE_PRESETS: the named-pick premiums of other boxes, in basis points. */
  pickFeeBps: Object.freeze([100n, 500n, 2_500n]) as readonly bigint[],
});

/** One share of a 1% fee, in fifteenths, with its label (for the split bars). */
export interface FeePart {
  readonly key: string;
  readonly label: string;
  readonly fifteenths: bigint;
}

/** Every other box: 10/15 by the creator's choice, 2/15 FIT, 1/15 Square Hole, 2/15 the box's own pool. */
export const V2_SPLIT: readonly FeePart[] = Object.freeze([
  { key: 'creator', label: 'Creator’s choice', fifteenths: FEE_SHARE_Q_STREAM },
  // SH-258 round 3: a BNB build never shows this part (about-content.ts folds it into Square Hole's); its label folds away.
  { key: 'fit', label: import.meta.env?.SH_BNB === true ? '' : 'FIT burn', fifteenths: V2_CONTRACT_FACTS.fitShare },
  { key: 'platform', label: 'Square Hole', fifteenths: V2_CONTRACT_FACTS.platformShare },
  { key: 'pool', label: 'Box pool', fifteenths: FEE_SHARE_DEPTH },
]);

/** Box 0's buyers' fees (ETH): 11/15 buy FIT and burn it, 2/15 its pool, 2/15 Square Hole. */
export const BOX0_BUY_SPLIT: readonly FeePart[] = import.meta.env?.SH_BNB === true ? Object.freeze([]) : Object.freeze([
  { key: 'fit', label: 'FIT burn', fifteenths: BOX0_FEE_SHARE_FIT },
  { key: 'platform', label: 'Square Hole', fifteenths: BOX0_FEE_SHARE_PLATFORM },
  { key: 'pool', label: 'Box pool', fifteenths: FEE_SHARE_DEPTH },
]);

/** Box 0's sellers' fees (FIT): 13/15 the Misfits' stream (burned for Misfits inside the vault), 2/15 its pool. */
export const BOX0_SELL_SPLIT: readonly FeePart[] = import.meta.env?.SH_BNB === true ? Object.freeze([]) : Object.freeze([
  { key: 'stream', label: 'Misfits stream', fifteenths: BOX0_FEE_SHARE_T_BURN },
  { key: 'pool', label: 'Box pool', fifteenths: FEE_SHARE_DEPTH },
]);

/** "1%", "2.5%", "25%" from basis points (exact: the release's rates have at most two decimals). */
export function percentOfBps(bps: bigint): string {
  const whole = bps / 100n;
  const rest = bps % 100n;
  if (rest === 0n) return `${whole}%`;
  return `${whole}.${rest.toString().padStart(2, '0').replace(/0$/, '')}%`;
}

/** A tax in pips (10^6 = 100%) to one decimal, rounded half up: 931,974 → "93.2%". */
export function percentOfPips(pips: number): string {
  const tenths = (BigInt(pips) * 1000n + 500_000n) / 1_000_000n;
  return `${tenths / 10n}.${tenths % 10n}%`;
}

/** Seconds as minutes to one decimal: 384 → "6.4 min". */
export function minutesOf(seconds: bigint): string {
  const tenths = (seconds * 10n) / 60n;
  return tenths % 10n === 0n ? `${tenths / 10n} min` : `${tenths / 10n}.${tenths % 10n} min`;
}

/** Whole days: 604,800 → "7 d". */
export const daysOf = (seconds: bigint): string => `${seconds / DAY} d`;

/** The fee in pips of the pool (LP_FEE, 10^6 = 100%) as basis points. */
const FEE_BPS = BigInt(LP_FEE) / 100n;

const firstTax = LAUNCH_TAX_TABLE_PIPS[0] ?? 0;
const lastTax = LAUNCH_TAX_TABLE_PIPS.at(-1) ?? 0;

/** Every figure the page shows, as text. */
export const ABOUT_FACTS = Object.freeze({
  fee: percentOfBps(FEE_BPS),
  fifteenths: FEE_SHARE_DENOMINATOR.toString(),
  raise: `${formatTokenAmount(BUILD_PROFILE_MAINNET.values.RAISE, 18, { maxFractionDigits: 18 })} ETH`,
  window: minutesOf(WINDOW_SECONDS),
  windowSteps: WINDOW_STEPS.toString(),
  stepSeconds: `${TAX_STEP_SECONDS} s`,
  taxFirst: percentOfPips(firstTax),
  taxLast: percentOfPips(lastTax),
  taxTable: LAUNCH_TAX_TABLE_PIPS,
  deadlines: V2_CONTRACT_FACTS.deadlineDays,
  deadlineRange: `${V2_CONTRACT_FACTS.deadlineDays[0] ?? 0}–${V2_CONTRACT_FACTS.deadlineDays.at(-1) ?? 0} d`,
  notOpen: daysOf(V2_CONTRACT_FACTS.notOpenSeconds),
  hatch: daysOf(V2_CONTRACT_FACTS.graduationHatchSeconds),
  /**
   * A failed box's claim has no end (RC5-A, F136): BoxCoordinatorV2 has no claim period and no sweep, so the page states
   * no number of days; about-facts.test.ts pins that to the Solidity source.
   */
  claims: 'No expiry',
  stepTicks: V2_CONTRACT_FACTS.stepTicks.toString(),
  fitSupply: formatTokenAmount(ISSUANCE, 18),
  draw: percentOfBps(DRAW_FEE_BPS),
  pick: percentOfBps(PICK_FEE_BPS),
  giveBack: percentOfBps(RETURN_FEE_BPS),
  picks: V2_CONTRACT_FACTS.pickFeeBps.map(percentOfBps),
  items: `${MIN_N.toLocaleString('en-US')}–${MAX_N.toLocaleString('en-US')}`,
});
