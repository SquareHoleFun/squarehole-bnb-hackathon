import { releaseReservations, unblockingRefusal, type Budget, type Limits, type Reservation } from './decide';
import { incomeRefusal, type IncomeSnapshot, type IncomeSpend } from './income';
import type { Logger } from './log';
import { journalHashes, renameState, type SentRecord } from './sent';
import type { KeeperState } from './run';

/**
 * SH-250 (stage B), the runner's half: the journal follows the record's settled outcomes, and a hanging send's
 * replacement is reserved in the journal before it is signed.
 */

/** A replacement as the chain proposes it (chain.ts `Replacement`), seen through what the runner needs. */
export interface ReplacementPlan {
  readonly entry: { readonly signer: string; readonly nonce: bigint; readonly txs: readonly { readonly hash: string }[];
    readonly reservation?: SentRecordReservation };
  readonly costWei: bigint;
}
type SentRecordReservation = NonNullable<SentRecord['entries'][number]['reservation']>;

/**
 * B1, B6, B7: a call the record names as won by another of its transactions is named by the winner's hash; a call that
 * provably never executed (its nonce went to another transaction, or its bytes never left) frees its daily reservation,
 * its F111 spend (a first collection included) and its drand bounty reservation. Idempotent.
 */
export function applyOutcomes(state: KeeperState, outcomes: Pick<SentRecord, 'renamed' | 'released'> | undefined): KeeperState {
  if (!outcomes) return state;
  const next = renameState(state, outcomes.renamed);
  const released = new Set(Object.keys(outcomes.released ?? {}));
  if (![...journalHashes(next)].some(h => released.has(h))) return next;
  const gone = (h: string | undefined) => h !== undefined && released.has(h.toLowerCase());
  return { ...next,
    ...(next.budget ? { budget: releaseReservations(next.budget, released) } : {}),
    ...(next.incomeSpend ? { incomeSpend: next.incomeSpend.filter(s => !gone(s.hash)) } : {}),
    ...(next.drandBounties ? { drandBounties: Object.fromEntries(Object.entries(next.drandBounties).filter(([, b]) => !gone(b.hash))) } : {}),
  };
}

export interface ReplaceContext {
  readonly budget: Budget;
  readonly incomeSpend: readonly IncomeSpend[];
  readonly income: IncomeSnapshot | null;
  readonly limits: Limits;
  readonly log: Logger;
  /** Writes the journal with these books (the reservation of the higher maximum) before the replacement is signed. */
  readonly save: (budget: Budget, incomeSpend: readonly IncomeSpend[]) => Promise<void>;
  readonly replace: (p: ReplacementPlan) => Promise<string>;
}

/**
 * B1 to B4: the nonce's liability is the highest maximum signed for it. Before a replacement is signed, the extra over
 * what the day already holds for that nonce is charged on the day it is signed, to the counters the original was charged
 * to, as a further daily entry under the journal's hash (settled with it as one liability), and the F111 spend entry is
 * raised to the new maximum. The extra must fit every ceiling the original passed (the protected reserve only for a job
 * that may use it, ours or pokes, the unblocking wei, the drand rescue allowance, the box and platform income caps) and
 * the per-block send limit; otherwise the replacement waits. Charging is idempotent: a crash after the reservation and
 * before the save finds the day already holding it. A reservation of an earlier day counts only its original cost.
 */
export async function replaceHanging(plans: readonly ReplacementPlan[], ctx: ReplaceContext): Promise<{ budget: Budget; incomeSpend: readonly IncomeSpend[] }> {
  let { budget, incomeSpend } = ctx;
  for (const p of plans) {
    const r = p.entry.reservation, name = p.entry.txs[0]?.hash;
    if (!r || !name) continue;
    if (budget.txInBlock >= ctx.limits.maxTxPerBlock) break;
    const group = (budget.pending ?? []).filter(x => x.hash === name);
    const held = group.reduce((n, x) => n + x.costWei, 0n);
    const required = r.day === budget.day ? p.costWei : p.costWei - r.costWei;
    const extra = required > held ? required - held : 0n;
    const spend = r.income ? incomeSpend.find(s => s.hash === name) : undefined;
    const extraIncome = spend && p.costWei > spend.costWei ? p.costWei - spend.costWei : 0n;
    const why = refusal(budget, ctx.limits, r, extra) ?? (spend && extraIncome > 0n ? incomeRefusal(spend.box, extraIncome, incomeSpend, ctx.income) : null);
    if (why) {
      ctx.log.warn('replacement waits', { nonce: p.entry.nonce, why });
      continue;
    }
    const entry: Reservation = { costWei: extra, hash: name, ...(r.counter ? { counter: r.counter } : r.ours ? { ours: r.ours } : {}),
      ...(r.unblocking ? { box: r.unblocking } : {}) };
    budget = { ...charged(budget, entry), txInBlock: budget.txInBlock + 1, ...(extra > 0n ? { pending: [...(budget.pending ?? []), entry] } : {}) };
    if (spend && extraIncome > 0n) incomeSpend = incomeSpend.map(s => s === spend ? { ...s, costWei: p.costWei } : s);
    await ctx.save(budget, incomeSpend);
    try { await ctx.replace(p); } catch (error) { ctx.log.error('replacement failed', { nonce: p.entry.nonce, error }); }
  }
  return { budget, incomeSpend };
}

function refusal(b: Budget, limits: Limits, r: SentRecordReservation, extra: bigint): string | null {
  if (extra === 0n) return null;
  if (r.counter === 'drandRescue') return (b.drandRescueWei ?? 0n) + extra > (limits.drandRescueWeiPerDay ?? 0n) ? 'drand rescue allowance spent' : null;
  const kept = r.reserve ? 0n : limits.reserveWeiPerDay;
  if (b.totalWei + extra > limits.totalWeiPerDay - kept) return 'daily ceiling reached';
  if (r.ours === 'ours' && b.oursWei + extra > limits.oursWeiPerDay - kept) return 'ours budget spent';
  if (r.ours === 'pokes' && b.pokesWei + extra > limits.pokesWeiPerDay) return 'pokes budget spent';
  if (r.unblocking) return unblockingRefusal(b, limits, r.unblocking, extra);
  return null;
}

function charged(b: Budget, r: Reservation): Budget {
  if (r.costWei === 0n) return b;
  if (r.counter === 'drandRescue') return { ...b, drandRescueWei: (b.drandRescueWei ?? 0n) + r.costWei };
  return { ...b, totalWei: b.totalWei + r.costWei,
    ...(r.ours === 'ours' ? { oursWei: b.oursWei + r.costWei } : r.ours === 'pokes' ? { pokesWei: b.pokesWei + r.costWei } : {}),
    ...(r.box === undefined ? {} : { unblockingWei: (b.unblockingWei ?? 0n) + r.costWei,
      unblockingWeiByBox: { ...b.unblockingWeiByBox, [r.box]: (b.unblockingWeiByBox?.[r.box] ?? 0n) + r.costWei } }) };
}
