import { drandFeeApplies, maxFeeFor } from './drand-fee';
import { GasAdmissionError, transactionGas, tipPays, type Fees, type GasConstraints } from './gas';
import { jobSpec } from './jobs';
import type { Candidate, JobName, Sim } from './types';

/**
 * Whether to send a simulated call (the ticket's review lens): never a transaction that cannot pay for itself unless
 * it is ours to run (a tipless job, or a tipped one whose tip no longer covers its gas, which the ours list names);
 * ours jobs only within a daily budget, the pokes within their own; every send, tipped ones included, within one
 * daily ceiling for the hot wallet; the last `reserveWeiPerDay` of the ours budget and of the ceiling only for the
 * recovery jobs marked reserved in the version's job policy, never for a reserved job's routine call (`ordinary`); at
 * most a few transactions a block; the private jobs only through a private endpoint. Every amount reserved is the
 * entire signed gas limit at maxFeePerGas, before broadcast; failed and ambiguous sends remain charged. Once a send's
 * receipt is final and canonical, its reservation is settled to what it paid, gasUsed times the effective gas price
 * (second release review, RC6RR2-HP-2): a send without such a receipt stays charged at its signed maximum for the day.
 * Tips never replenish a daily ceiling.
 */
export interface Limits {
  readonly oursWeiPerDay: bigint;
  readonly pokesWeiPerDay: bigint;
  readonly reserveWeiPerDay: bigint;
  readonly totalWeiPerDay: bigint;
  readonly maxTxPerBlock: number;
  readonly maxFeePerGas?: bigint;
  readonly drandRescueMaxFeeWei?: bigint;
  readonly drandRescueWindowSeconds?: bigint;
  readonly drandRescueWeiPerDay?: bigint;
  /** LIM-4: per-box signed gas for refreshes and zero-P conversions, outside F111 but inside fixed daily ceilings. */
  readonly unblockingGasPerBoxPerDay?: bigint;
  /**
   * Second release review (RC6RR2-MONEY-2, RC6RR2-KEEPER-1, RR2-LIM-1): the wei all boxes' unblocking work may take of
   * the day, never exceeded (default half the ordinary ours room, (ours - reserve) / 2), and each box's share (default a
   * quarter of that): a box's unblocking work waits once the box has spent its share, so its last send can cross the
   * share by at most its own reservation, never the all-box ceiling.
   */
  readonly unblockingWeiPerDay?: bigint;
  readonly unblockingWeiPerBoxPerDay?: bigint;
}

export interface Budget {
  /** UTC day number (time / 86,400). */
  readonly day: bigint;
  readonly oursWei: bigint;
  readonly pokesWei: bigint;
  /** Every send's maximum cost reserved today, tipped or ours. */
  readonly totalWei: bigint;
  /** R62-FEE only: outside the ordinary wallet counters. */
  readonly drandRescueWei?: bigint;
  readonly block: bigint;
  readonly txInBlock: number;
  /** UTC daily unblocking reservations, keyed by the immutable box receiver; all sends, including ambiguous ones. */
  readonly unblockingGas?: Readonly<Record<string, bigint>>;
  /** The same sends' reserved wei today: all boxes together, then by box receiver. */
  readonly unblockingWei?: bigint;
  readonly unblockingWeiByBox?: Readonly<Record<string, bigint>>;
  /** Today's sends whose receipts are not final yet, each with what it reserved and where (RC6RR2-HP-2). */
  readonly pending?: readonly Reservation[];
}

/** One send's reservation, kept in the day's budget until its receipt is final and canonical. */
export interface Reservation {
  /** Signed gas maximum plus value, charged to total or the explicit rescue counter. */
  readonly costWei: bigint;
  readonly counter?: 'drandRescue';
  readonly valueWei?: bigint;
  /** Ordinary reservations also charge ours or pokes when the tip did not pay. */
  readonly ours?: 'ours' | 'pokes';
  /** Also charged to this box's (its receiver, lower case) and to all boxes' unblocking wei. */
  readonly box?: string;
  /** The node accepted the send under this hash (lower case); a reservation without one never settles. */
  readonly hash?: string;
}

export type Decision =
  | { readonly send: true; readonly asOurs: boolean; readonly privately: boolean; readonly costWei: bigint; readonly gas: bigint; readonly counter?: 'drandRescue'; readonly valueWei?: bigint }
  | { readonly send: false; readonly why: string };

export interface DecideContext {
  readonly candidate?: Candidate;
  readonly now?: bigint;
  readonly version?: 1 | 2;
  /** The candidate's `ordinary` mark: a routine call of a reserved job stays outside the protected reserve. */
  readonly ordinary?: boolean;
  readonly gasConstraints?: GasConstraints;
  readonly fees: Fees;
  readonly budget: Budget;
  readonly limits: Limits;
  readonly privateEndpoint: boolean;
}

/** The reason a simulation gives when the call would revert, wait or skip. */
export const NOTHING_TO_DO = 'nothing to do';

const DAY = 86_400n;

/** The budget for `block`: a new UTC day starts from zero, a new block from no transactions. */
export function openBudget(prev: Budget | undefined, block: bigint, time: bigint): Budget {
  const day = time / DAY;
  const base = prev && prev.day >= day ? prev : { day, oursWei: 0n, pokesWei: 0n, totalWei: 0n, drandRescueWei: 0n, block, txInBlock: 0 };
  return base.block === block ? base : { ...base, block, txInBlock: 0 };
}

export function decide(job: JobName, sim: Sim, ctx: DecideContext): Decision {
  if (!sim.ok) return { send: false, why: NOTHING_TO_DO };
  if (ctx.budget.txInBlock >= ctx.limits.maxTxPerBlock) return { send: false, why: 'rate limit' };
  const spec = jobSpec(job, ctx.version);
  if (spec.privately && !ctx.privateEndpoint) return { send: false, why: 'no private endpoint' };
  let gas: bigint;
  try { gas = transactionGas(job, sim.estimate, ctx.gasConstraints, ctx.version, sim.zeroOutput === true); }
  catch (error) {
    if (error instanceof GasAdmissionError) return { send: false, why: error.message };
    throw error;
  }
  const value = ctx.candidate?.value;
  const cost = gas * ctx.fees.maxFeePerGas + (value ?? 0n);
  const valueField = value === undefined ? {} : { valueWei: value };
  const c = { job, drandDeadline: ctx.candidate?.drandDeadline };
  const now = ctx.now ?? 0n;
  // First try the ordinary reserved path. Only these three refusals may use R62's cap.
  const fallback = (why: string): Decision => {
    if (!drandFeeApplies(c, now, ctx.limits)) return { send: false, why };
    if (ctx.fees.maxFeePerGas > maxFeeFor(c, now, ctx.limits)) return { send: false, why: 'fee ceiling reached' };
    if ((ctx.budget.drandRescueWei ?? 0n) + cost > (ctx.limits.drandRescueWeiPerDay ?? 0n)) return { send: false, why: 'drand rescue allowance spent' };
    return { send: true, asOurs: true, privately: spec.privately, costWei: cost, gas, ...valueField, counter: 'drandRescue' };
  };
  if (ctx.fees.maxFeePerGas > maxFeeFor({ job }, now, ctx.limits)) return fallback('fee ceiling reached');
  const kept = spec.reserved && ctx.ordinary !== true ? 0n : ctx.limits.reserveWeiPerDay;
  if (ctx.budget.totalWei + cost > ctx.limits.totalWeiPerDay - kept) return fallback('daily ceiling reached');
  // A tipless job's simulation reports no tip, so only a tip the call would really pay makes it pay for itself.
  if (tipPays(sim.tipWei, sim.estimate, ctx.fees)) return { send: true, asOurs: false, privately: spec.privately, costWei: cost, gas, ...valueField };
  const pokes = spec.budget === 'pokes';
  const spent = pokes ? ctx.budget.pokesWei : ctx.budget.oursWei;
  const limit = pokes ? ctx.limits.pokesWeiPerDay : ctx.limits.oursWeiPerDay - kept;
  if (spent + cost > limit) return spec.budget === 'ours' ? fallback('ours budget spent') : { send: false, why: 'pokes budget spent' };
  return { send: true, asOurs: true, privately: spec.privately, costWei: cost, gas, ...valueField };
}

/** The unblocking wei ceilings in force: configured, or derived from the ordinary ours room. */
export function unblockingWeiLimits(limits: Limits): { readonly all: bigint; readonly perBox: bigint } {
  const room = limits.oursWeiPerDay > limits.reserveWeiPerDay ? limits.oursWeiPerDay - limits.reserveWeiPerDay : 0n;
  const all = limits.unblockingWeiPerDay ?? room / 2n;
  return { all, perBox: limits.unblockingWeiPerBoxPerDay ?? all / 4n };
}

/** Why an unblocking send of `costWei` for box `key` (its immutable receiver, lower case) must wait, or null. */
export function unblockingRefusal(b: Budget, limits: Limits, key: string, costWei: bigint): string | null {
  const { all, perBox } = unblockingWeiLimits(limits);
  if ((b.unblockingWeiByBox?.[key] ?? 0n) >= perBox) return 'box unblocking wei spent';
  if ((b.unblockingWei ?? 0n) + costWei > all) return 'unblocking wei spent';
  return null;
}

/** Charges an unblocking send's signed gas and reserved wei to its box and to the all-box counter. */
export function chargeUnblocking(b: Budget, key: string, gas: bigint, costWei: bigint): Budget {
  return { ...b, unblockingGas: { ...b.unblockingGas, [key]: (b.unblockingGas?.[key] ?? 0n) + gas },
    unblockingWei: (b.unblockingWei ?? 0n) + costWei,
    unblockingWeiByBox: { ...b.unblockingWeiByBox, [key]: (b.unblockingWeiByBox?.[key] ?? 0n) + costWei } };
}

export function charge(b: Budget, job: JobName, d: Decision): Budget {
  if (!d.send) return b;
  if (d.counter === 'drandRescue') return { ...b, txInBlock: b.txInBlock + 1, drandRescueWei: (b.drandRescueWei ?? 0n) + d.costWei };
  const next = { ...b, txInBlock: b.txInBlock + 1, totalWei: b.totalWei + d.costWei };
  if (!d.asOurs) return next;
  return jobSpec(job).budget === 'pokes'
    ? { ...next, pokesWei: next.pokesWei + d.costWei }
    : { ...next, oursWei: next.oursWei + d.costWei };
}

/** The reservation `charge` (and `chargeUnblocking`, for `box`) just made, appended to the day's pending list. */
export function reserve(b: Budget, job: JobName, d: Decision, box?: string): Budget {
  if (!d.send) return b;
  const r: Reservation = { costWei: d.costWei, ...(d.valueWei === undefined ? {} : { valueWei: d.valueWei }), ...(d.counter ? { counter: d.counter } : d.asOurs ? { ours: jobSpec(job).budget } : {}), ...(box !== undefined ? { box } : {}) };
  return { ...b, pending: [...(b.pending ?? []), r] };
}

/** Names the hash the node accepted for the last reservation, so it can settle. */
export function accepted(b: Budget, hash: string): Budget {
  const pending = b.pending ?? [];
  const last = pending[pending.length - 1];
  if (!last || last.hash !== undefined) return b;
  return { ...b, pending: [...pending.slice(0, -1), { ...last, hash: hash.toLowerCase() }] };
}

/** Takes `amount` off the counters a reservation was charged to. */
function credit(b: Budget, r: Reservation, amount: bigint): Budget {
  if (amount <= 0n) return b;
  if (r.counter === 'drandRescue') return { ...b, drandRescueWei: (b.drandRescueWei ?? 0n) - amount };
  return { ...b, totalWei: b.totalWei - amount,
    ...(r.ours === 'ours' ? { oursWei: b.oursWei - amount } : r.ours === 'pokes' ? { pokesWei: b.pokesWei - amount } : {}),
    ...(r.box === undefined ? {} : { unblockingWei: (b.unblockingWei ?? 0n) - amount,
      unblockingWeiByBox: { ...b.unblockingWeiByBox, [r.box]: (b.unblockingWeiByBox?.[r.box] ?? 0n) - amount } }) };
}

/**
 * Settles each reservation whose hash has a final, canonical receipt (`paid`: its gasUsed times effective gas price,
 * keyed by lower-case hash) down to that amount on every counter it was charged to. A paid amount above the signed
 * maximum is not this send's receipt, and that reservation stays.
 *
 * SH-250 B1: a replacement's extra charge is a further entry under the same hash, so the day's entries sharing a hash are
 * one liability: settled together to what the winner paid, the release taken from the latest entry first. A single entry
 * settles exactly as before.
 */
export function settle(b: Budget, paid: Readonly<Record<string, bigint>>): Budget {
  if (!b.pending?.length) return b;
  let next: Budget = b;
  const left: Reservation[] = [];
  const groups = new Map<string, Reservation[]>();
  for (const r of b.pending) {
    if (r.hash === undefined || paid[r.hash] === undefined) { left.push(r); continue; }
    groups.set(r.hash, [...(groups.get(r.hash) ?? []), r]);
  }
  for (const [hash, group] of groups) {
    const gasPaid = paid[hash] ?? -1n;
    const reserved = group.reduce((n, r) => n + r.costWei, 0n);
    const cost = gasPaid + group.reduce((n, r) => n + (r.valueWei ?? 0n), 0n);
    if (gasPaid < 0n || cost > reserved) { left.push(...group); continue; }
    let release = reserved - cost;
    for (const r of [...group].reverse()) {
      const part = release < r.costWei - (r.valueWei ?? 0n) ? release : r.costWei - (r.valueWei ?? 0n);
      next = credit(next, r, part);
      release -= part;
    }
  }
  if (left.length === b.pending.length) return b;
  const order = new Map(b.pending.map((r, i) => [r, i]));
  return { ...next, pending: left.sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0)) };
}

/**
 * SH-250 B1, B6: a call that provably never executed (another transaction took its nonce, or its bytes never left)
 * frees its whole reservation for the day, value included; entries of earlier days are gone already.
 */
export function releaseReservations(b: Budget, hashes: ReadonlySet<string>): Budget {
  if (!b.pending?.some(r => r.hash !== undefined && hashes.has(r.hash))) return b;
  let next: Budget = b;
  for (const r of b.pending) if (r.hash !== undefined && hashes.has(r.hash)) next = credit(next, r, r.costWei);
  return { ...next, pending: b.pending.filter(r => r.hash === undefined || !hashes.has(r.hash)) };
}
