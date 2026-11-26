import type { ValuationFailure } from './income-failure';
import type { Address } from 'viem';
import { V2_GAS_FLOORS } from './gas';
import { jobSpec } from './jobs';
import type { Candidate, Sim } from './types';

/** F111 rolling window: (pending timestamp - 86,400 seconds, pending timestamp]. */
export const INCOME_WINDOW_SECONDS = 86_400n;
export const START_MAX_SIGNED_COST_WEI = 50_000_000_000_000_000n;
export const UNKNOWN_INCOME_BOX: Address = '0x0000000000000000000000000000000000000000';
export const F111_MAX_FEE_WEI = 3_000_000_000n;
/**
 * 24 of each unblocking job a day at its published signed floor: refresh and observe 5M, a press 16M (the largest,
 * Amsterdam's) and a collect 8M (816,000,000 since the rc7 part 3 review; 792,000,000 at af2's 7M;
 * 744,000,000 after the second release review, 504,000,000 before observes and lag collects).
 * Signed gas, never a guessed ETH valuation; the wei ceilings in decide.ts bind first.
 */
export const DEFAULT_UNBLOCKING_GAS_PER_BOX_PER_DAY = 24n * (V2_GAS_FLOORS.royaltyRefresh + V2_GAS_FLOORS.royaltyObserve
  + V2_GAS_FLOORS.sellFees + V2_GAS_FLOORS.collect);

/**
 * Zero-P and below-floor status come only from the pending simulation, never from a candidate or a forecast: a zero-P
 * press, and (second release review) any call `interpret` marks `unblocking`.
 */
export const unblockingWork = (c: Candidate, sim?: Sim) => c.version === 2
  && (c.job === 'royaltyRefresh' || c.job === 'royaltyObserve'
    || (sim?.ok === true && ((c.job === 'sellFees' && sim.zeroOutput === true) || sim.unblocking === true)));

/** Reserved before signing; live unknown/ambiguous transactions never age out without a receipt. */
export interface IncomeSpend {
  readonly box: Address;
  readonly at: bigint;
  readonly costWei: bigint;
  readonly hash?: string;
  /** Unpaid starts persist; final settlement or repayment is never revisited. */
  readonly start?: {
    readonly job: 'collect' | 'sellFees';
    readonly settledAt?: bigint;
    readonly repaidAt?: bigint;
    /** Whole later transactions assigned once to this debt; never recycled into another repayment. */
    readonly paymentHashes?: readonly string[];
  };
}
export interface IncomeReceipt {
  readonly box: Address;
  readonly hash: string;
  readonly at: bigint;
  readonly shareWei: bigint;
  readonly tipsWei: bigint;
  /** Only the start's own job, target and sender, in this successful final transaction. */
  readonly startTipWei: bigint;
}

/** Only starts reserve unique seconds. Ordinary duplicates stay legal away from a start's second. */
export function incomeReservationTime(box: Address, now: bigint, spend: readonly IncomeSpend[], start: boolean): bigint {
  const sameBox = spend.filter(s => s.box.toLowerCase() === box.toLowerCase());
  if (start || sameBox.some(s => s.start && s.at === now)) {
    while (sameBox.some(s => s.at === now)) now += 1n;
  }
  return now;
}
export interface IncomeSnapshot {
  /** Latest read only; no credit or durable liability. */
  readonly valuationFailures?: readonly ValuationFailure[];
  readonly at: bigint;
  readonly platformWei: bigint;
  readonly boxes: Readonly<Record<string, { readonly shareWei: bigint; readonly tipsWei: bigint }>>;
  /** Canonical finalized receipt timestamps, including reverted transactions. */
  readonly mined: Readonly<Record<string, bigint>>;
  /** Authenticated transactions for start settlement and later repayment; not extra rolling income. */
  readonly startReceipts?: readonly IncomeReceipt[];
}

/**
 * Exits, fixed-Safe payments and recovery retries keep the existing protected policy. A reserved job's routine call
 * (`ordinary`: a purchased-T tranche or a T residue burn) is capped like any other per-box maintenance.
 */
export const incomeCapped = (c: Candidate, sim?: Sim) => c.version === 2 && c.job !== 'drandWithdrawBounty' && !unblockingWork(c, sim)
  && (c.ordinary === true || !jobSpec(c.job, 2).reserved);

/** Dry spend models inclusion at reservation time. Paid starts leave the books after their debit window. */
export function activeIncomeSpend(spend: readonly IncomeSpend[], income: IncomeSnapshot | null, dryRun = false, now = income?.at): IncomeSpend[] {
  return spend.filter(s => {
    if (s.start) {
      const paidAt = s.start.repaidAt ?? s.start.settledAt;
      return paidAt === undefined || now === undefined || paidAt > now - INCOME_WINDOW_SECONDS;
    }
    const mined = dryRun ? s.at : s.hash ? income?.mined[s.hash] : undefined;
    return mined === undefined || !income || mined > income.at - INCOME_WINDOW_SECONDS;
  });
}

/** A paid start keeps the normal signed debit; later repayment holds it for a fresh full window. */
export function incomeCost(s: IncomeSpend, income: IncomeSnapshot | null): bigint {
  const paidAt = s.start?.repaidAt ?? s.start?.settledAt;
  return paidAt !== undefined && income && paidAt <= income.at - INCOME_WINDOW_SECONDS ? 0n : s.costWei;
}

export const startUnpaid = (box: Address, spend: readonly IncomeSpend[]) => spend.some(s =>
  s.box.toLowerCase() === box.toLowerCase() && s.start && s.start.settledAt === undefined && s.start.repaidAt === undefined);

/** Ordinary admission uses received income. Only startRefusal supplies a candidate-only provisional tip. */
export function incomeRefusal(box: Address, cost: bigint, spend: readonly IncomeSpend[], income: IncomeSnapshot | null, candidateTip = 0n): string | null {
  if (!income) return 'income unavailable';
  const key = box.toLowerCase();
  const credit = income.boxes[key];
  let own = cost, total = cost, tips = 0n;
  for (const s of spend) { const debit = incomeCost(s, income); total += debit; if (s.box.toLowerCase() === key || s.box === UNKNOWN_INCOME_BOX) own += debit; }
  for (const c of Object.values(income.boxes)) tips += c.tipsWei;
  if (own > (credit?.shareWei ?? 0n) + (credit?.tipsWei ?? 0n) + candidateTip) return 'box income cap';
  if (total > income.platformWei / 4n + tips + candidateTip) return 'platform income cap';
  return null;
}

/** Called only after ordinary admission fails an income cap; never writes forecast income. */
export function startRefusal(c: Candidate, sim: Sim, box: Address, cost: bigint,
  spend: readonly IncomeSpend[], income: IncomeSnapshot | null): string | null {
  if (c.version !== 2 || !(c.job === 'collect' || (c.job === 'sellFees' && sim.zeroOutput !== true))) return 'box income cap';
  if (!income) return 'income unavailable';
  if (sim.startBlockPaired === false) return 'simulation error';
  if (startUnpaid(box, spend)) return 'start unpaid';
  if ((c.value ?? 0n) !== 0n || cost > START_MAX_SIGNED_COST_WEI) return 'start cost cap';
  if (sim.startTipWei === undefined || sim.startTipWei === null || sim.startTipWei < cost) return 'start tip too small';
  return incomeRefusal(box, cost, spend, income, sim.startTipWei);
}

/** Finality is final. Only unresolved starts need an own proof or later same-box repayment. */
export function reconcileStarts(spend: readonly IncomeSpend[], income: IncomeSnapshot | null): IncomeSpend[] {
  const receipts = income?.startReceipts ?? [];
  const used = new Set(spend.flatMap(s => (s.start?.paymentHashes ?? []).map(h => `${s.box.toLowerCase()}:${h}`)));
  const next = [...spend];
  for (const [i, s] of next.entries()) {
    if (!s.start || s.start.settledAt !== undefined || s.start.repaidAt !== undefined || !s.hash || !/^0x[0-9a-fA-F]{64}$/.test(s.hash) || !income) continue;
    const fresh = receipts.filter(r => r.box.toLowerCase() === s.box.toLowerCase()
      && r.at > income.at - INCOME_WINDOW_SECONDS && r.at <= income.at);
    const own = fresh.find(r => r.hash === s.hash);
    if (own && own.startTipWei >= s.costWei && !s.start.paymentHashes?.length) {
      next[i] = { ...s, start: { job: s.start.job, settledAt: own.at } };
      continue;
    }
    const available = fresh.filter(r => r.hash !== s.hash && r.at > s.at && !used.has(`${r.box.toLowerCase()}:${r.hash}`));
    const covered = available.reduce((n, r) => n + r.shareWei, 0n) / 4n + available.reduce((n, r) => n + r.tipsWei, 0n);
    if (covered < s.costWei || incomeRefusal(s.box, 0n, next, income)) continue;
    const paymentHashes = [...new Set([...(s.start.paymentHashes ?? []), ...available.map(r => r.hash)])];
    next[i] = { ...s, start: { job: s.start.job, repaidAt: income.at, paymentHashes } };
    for (const h of paymentHashes) used.add(`${s.box.toLowerCase()}:${h}`);
  }
  return next;
}
