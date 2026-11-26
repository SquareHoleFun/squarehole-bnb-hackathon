import { DRAND_RESCUE_JOBS, drandFeeApplies, maxFeeFor } from './drand-fee';
import { DEFAULT_UNBLOCKING_GAS_PER_BOX_PER_DAY, UNKNOWN_INCOME_BOX, activeIncomeSpend, incomeCapped, incomeRefusal, incomeReservationTime, reconcileStarts, startRefusal, startUnpaid, unblockingWork, type IncomeSnapshot, type IncomeSpend } from './income';
import type { Address } from 'viem';
import type { CoinMinimumOverrides } from './config';
import { accepted, charge, chargeUnblocking, decide, openBudget, reserve, settle, unblockingRefusal, type Budget, type Limits } from './decide';
import { feesFor, zeroBasePrice, type GasConstraints, type Fees } from './gas';
import { jobSpec } from './jobs';
import type { Logger } from './log';
import type { M2Scan } from './m2';
import { trackQueue, type MonitorQueue, type TickObservation, type WorkStatus } from './monitor';
import { afterRun, emptyMemory, plan, type Memory, type StepJob } from './plan';
import type { Rng } from './rng';
import type { SentRecord, SentReservation, SignedSend } from './sent';
import { applyOutcomes, replaceHanging, type ReplacementPlan } from './hanging';
import { SendWait } from './sent';
import type { Takeover } from './chain';
import { deferralCode, logSkips, type DeferralCode, type SkipLog } from './skips';
import type { Candidate, JobName, Sim } from './types';
import type { World } from './world';

/**
 * What the runner needs of a chain: the world as read, a simulation against the pending block (`ok` false for a call
 * that would revert, wait or skip; it throws when the node could not answer), and a send.
 */
export interface ChainPort {
  /** Fetch off-chain inputs only after the fee/rate guard; never signs or reserves a second budget. */
  prepare?(c: Candidate, fees: Fees): Promise<Candidate>;
  readIncome?(spend: readonly IncomeSpend[]): Promise<IncomeSnapshot>;
  read(m2Scan?: M2Scan, mem?: Memory): Promise<World>;
  gasConstraints?(c: Candidate, estimate: bigint): Promise<GasConstraints>;
  simulate(c: Candidate, fees: Fees, start?: boolean): Promise<Sim>;
  send(c: Candidate, gas: bigint, fees: Fees, privately: boolean): Promise<string>;
  /** SH-249: sign in memory (nonce from the saved record), save durably, then broadcast only the saved bytes. */
  sign?(c: Candidate, gas: bigint, fees: Fees, privately: boolean, take?: Takeover): Promise<SignedSend>;
  /** SH-250 A: a hanging nonce this job may take (with the fees to decide and reserve with), and guarantee 3's guard. */
  takeover?(c: Candidate, privately: boolean, fees: Fees): Promise<Takeover | null>;
  inFlight?(key: string): boolean;
  keep?(s: SignedSend, reservation: SentReservation): Promise<void>;
  broadcast?(s: SignedSend): Promise<void>;
  /** SH-250: the record's settled outcomes, this round's hanging sends, and a replacement's signature and broadcast. */
  outcomes?(): Pick<SentRecord, 'renamed' | 'released'>;
  hangingSends?(): readonly ReplacementPlan[];
  replace?(p: ReplacementPlan): Promise<string>;
  /**
   * RC6RR2-HP-2: what each sent hash paid (gasUsed times its effective gas price), keyed by lower-case hash, for the
   * hashes whose receipt is in a final, canonical block and from this keeper; any other hash is left out.
   */
  settled?(hashes: readonly string[]): Promise<Readonly<Record<string, bigint>>>;
  /** SH-259 rule A: this tick's eth_gasPrice on a chain whose base fee is 0, read before any broadcast; null: failed. */
  tickGasPrice?(): bigint | null;
  /** True only for our bounty transfer with a finalized, canonical reverted receipt: no value executed. */
  bountyReverted?(source: Address, hash: string): Promise<boolean>;
}

export interface RunConfig {
  readonly signal?: AbortSignal;
  readonly keeper: Address;
  readonly dryRun: boolean;
  readonly privateEndpoint: boolean;
  readonly priorityFeeWei: bigint;
  readonly limits: Limits;
  readonly payoutMinWei: bigint;
  readonly coinMinimums?: CoinMinimumOverrides;
  readonly rng: Rng;
  readonly retryBlocks?: bigint;
  readonly buyBackAlertBlocks?: bigint;
  readonly executorMaxChunks?: bigint;
  /** Durable reservation must finish before the signer may broadcast. */
  readonly checkpoint?: (state: KeeperState, now: bigint) => Promise<void>;
}

export interface KeeperState {
  /** Source (lower case):round reservations outlive daily budgets, including sends with an unknown hash. */
  readonly drandBounties?: Readonly<Record<string, BountyReservation>>;
  readonly drandLog?: Readonly<Record<string, bigint>>;
  readonly incomeSpend?: readonly IncomeSpend[];
  readonly m2Scan?: M2Scan;
  readonly mem?: Memory;
  readonly budget?: Budget;
  readonly skipLog?: SkipLog;
  /** Monitor view: outstanding work keys and the snapshot block each was first seen waiting (monitor.ts). */
  readonly monitorQueue?: MonitorQueue;
}

interface BountyReservation { readonly hash?: string; }

export interface Skipped {
  readonly boxId?: bigint;
  readonly code: DeferralCode;
  readonly job: JobName;
  readonly key: string;
  readonly why: string;
  readonly error?: unknown;
}

export interface TickReport {
  readonly block: bigint;
  readonly sent: { job: JobName; key: string; asOurs: boolean; gas: bigint }[];
  readonly skipped: Skipped[];
}

/** Both protocol steps share the hook's block slot. */
const SLOT_JOBS: ReadonlySet<JobName> = new Set(['deepen', 'buyBack', 'shopFees', 'sellFees']);

/**
 * SH-KEEPER-V2-STEPS (STEPS-A): a v2 pool step refused by a check of its own (budget, income cap, gas admission,
 * unblocking allowance) did no work. It keeps its retry eligibility (no attempt is recorded), but its turn in the pool's
 * rotation passes, so the next tick proposes the step after it and one blocked step cannot starve the others. `sent`
 * stays false: the block's protocol step is still free. Every cap that refused it is unchanged. The fee ceiling and the
 * send limit hold every step of a block alike and keep the turn instead (af1), or a periodic pause would leave the same
 * step up on every paused block. The slot check runs before every call; a pool whose step a send already took this
 * block would keep that mark all the same.
 */
function passTurn(mem: Memory, c: Candidate, w: World, slots: ReadonlySet<string>): Memory {
  if (c.version !== 2 || !c.pool || !SLOT_JOBS.has(c.job)) return mem;
  const key = c.pool.toLowerCase(), previous = mem.steps[key];
  if (slots.has(c.pool) || (previous?.sent && previous.block >= w.block.number)) return mem;
  return { ...mem, steps: { ...mem.steps, [key]: { job: c.job as StepJob, block: w.block.number, sent: false } } };
}

interface Tick {
  /** SH-259 rule A: why nothing is signed this tick (a zero-base-fee chain without a usable quote). */
  readonly feeWait?: string;
  /** Also protect pairs still on disk until this tick publishes their removal. */
  readonly previousSpend: readonly IncomeSpend[];
  readonly drandBounties: Record<string, BountyReservation>;
  readonly drandLog: Record<string, bigint>;
  /** Starts admitted for sending this tick, including a send whose result is unknown. */
  readonly startingRounds: Set<bigint>;
  readonly income: IncomeSnapshot | null;
  readonly incomeSpend: readonly IncomeSpend[];
  readonly m2Scan?: M2Scan;
  readonly w: World;
  readonly fees: Fees;
  readonly budget: Budget;
  readonly mem: Memory;
  readonly slots: ReadonlySet<string>;
  readonly cfg: RunConfig;
  readonly log: Logger;
  /** Carried unchanged into reservation checkpoints; the tick end writes the updated queue. */
  readonly monitorQueue?: MonitorQueue;
}

type Outcome = { readonly incomeSpend: readonly IncomeSpend[]; readonly work: WorkStatus } & (
  | { readonly mem: Memory; readonly budget: Budget; readonly skipped: Skipped }
  | { readonly mem: Memory; readonly budget: Budget; readonly sent: TickReport['sent'][number]; readonly slot: string | null });

/** Successful public posts only, local to this running adapter; never written to the journal. */
const pendingRoundPosts = new WeakMap<ChainPort, Map<bigint, bigint>>();

/** One candidate: simulate, reserve durably, then send. Storage errors stop the tick before signing. */
async function runOne(port: ChainPort, first: Candidate, t: Tick): Promise<Outcome> {
  let c = first;
  const skip = (why: string, mem = t.mem, error?: unknown, work: WorkStatus = 'waiting'): Outcome =>
    ({ incomeSpend: t.incomeSpend, work, mem, budget: t.budget, skipped: { boxId: c.boxId, job: c.job, key: c.key, why, code: deferralCode(why), error } });
  // A refusal of this step's own: no attempt, no charge; a pool step's turn passes (STEPS-A).
  const defer = (why: string, work: WorkStatus = 'waiting'): Outcome => skip(why, passTurn(t.mem, c, t.w, t.slots), undefined, work);
  // Skipped before simulating: whether work waits is unknown this tick. Both hold the whole block, so the turn stays (af1).
  if (t.feeWait) return skip(t.feeWait, t.mem, undefined, 'unknown');
  if (t.fees.maxFeePerGas > maxFeeFor(c, t.w.block.timestamp, t.cfg.limits)) return skip('fee ceiling reached', t.mem, undefined, 'unknown');
  if (t.budget.txInBlock >= t.cfg.limits.maxTxPerBlock) return skip('rate limit', t.mem, undefined, 'unknown');
  const bountyKey = c.job === 'drandGraduationBounty' ? `${c.to.toLowerCase()}:${c.args[0]}` : undefined;
  const bounty = bountyKey === undefined ? undefined : t.drandBounties[bountyKey];
  if (bounty) {
    let reverted = false;
    try { reverted = bounty.hash !== undefined && await port.bountyReverted?.(c.to, bounty.hash) === true; }
    catch { /* Missing or unreadable proof never permits another value transfer. */ }
    if (!reverted) return skip('drand bounty already reserved');
  }
  if (SLOT_JOBS.has(c.job)) {
    const previous = t.mem.steps[(c.pool ?? c.to).toLowerCase()];
    // Reservation precedes broadcast. Even an ambiguous send may already have taken the protocol slot.
    if (t.slots.has(c.pool ?? c.to) || (previous?.sent && previous.block >= t.w.block.number)) return skip('slot taken', t.mem, undefined, 'unknown');
  }
  // SH-250 guarantee 3: a job whose call is at a contested nonce is not planned again until that nonce is resolved.
  if (!t.cfg.dryRun && port.inFlight?.(c.key)) return skip('in flight', t.mem, undefined, 'unknown');
  let sim: Sim;
  let gasConstraints: GasConstraints | undefined;
  try {
    c = await port.prepare?.(c, t.fees) ?? c;
    sim = await port.simulate(c, t.fees);
    if (sim.ok) gasConstraints = await port.gasConstraints?.(c, sim.estimate);
  } catch (error) {
    return skip('simulation error', afterRun(t.mem, c, false, t.w), error);
  }
  // SH-250 A: a job that takes a hanging nonce decides and reserves at the fees it will sign with.
  const take = t.cfg.dryRun || !sim.ok ? null : await port.takeover?.(c, jobSpec(c.job, c.version).privately, t.fees).catch(() => null) ?? null;
  const fees = take?.fees ?? t.fees;
  let d = decide(c.job, sim, { fees, budget: t.budget, limits: t.cfg.limits, privateEndpoint: t.cfg.privateEndpoint, gasConstraints,
    candidate: c, now: t.w.block.timestamp, version: c.version, ordinary: c.ordinary === true });
  if (!d.send) {
    // Admission deferrals did no work: keep their eligibility and place ahead of already serviced jobs (a pool step's
    // turn passes all the same, STEPS-A; the block-wide fee and rate refusals were taken before simulating, above).
    // Only a failed/no-work simulation advances the attempt and starts retry backoff.
    const mem = sim.ok ? passTurn(t.mem, c, t.w, t.slots) : afterRun(t.mem, c, false, t.w);
    if (DRAND_RESCUE_JOBS.includes(c.job) && !drandFeeApplies(c, t.w.block.timestamp, t.cfg.limits)
      && ['daily ceiling reached', 'ours budget spent'].includes(d.why)) {
      const key = `daily:${c.key}`, now = t.w.block.timestamp;
      if (t.drandLog[key] === undefined || now - t.drandLog[key] >= 3600n) {
        t.drandLog[key] = now; t.log.warn('drand waits on the daily budget', { job: c.job, key: c.key });
      }
    }
    return skip(d.why, mem, undefined, sim.ok ? 'waiting' : 'none');
  }
  const box = t.w.boxes.find(b => b.version === c.version && b.id === c.boxId);
  const unblocking = unblockingWork(c, sim);
  const boxKey = box?.receiver.toLowerCase();
  if (unblocking) {
    if (!boxKey) return defer('unblocking box unavailable');
    if ((t.budget.unblockingGas?.[boxKey] ?? 0n) + d.gas
      > (t.cfg.limits.unblockingGasPerBoxPerDay ?? DEFAULT_UNBLOCKING_GAS_PER_BOX_PER_DAY)) return defer('box unblocking gas allowance spent');
    // RC6RR2-MONEY-2, RC6RR2-KEEPER-1, RR2-LIM-1: wei bounds, so unblocking work cannot take other boxes' room.
    const why = unblockingRefusal(t.budget, t.cfg.limits, boxKey, d.costWei);
    if (why) return defer(why);
  }
  let start = false;
  if (incomeCapped(c, sim)) {
    if (box && startUnpaid(box.receiver, t.incomeSpend)) return defer('start unpaid');
    const why = box ? incomeRefusal(box.receiver, d.costWei, t.incomeSpend, t.income) : 'income unavailable';
    if (why) {
      if (!box || box.failed || !box.v2 || !['box income cap', 'platform income cap'].includes(why)
        || !(c.job === 'collect' || (c.job === 'sellFees' && sim.zeroOutput !== true))) return defer(why);
      // Only an income-refused candidate pays for a fresh start simulation, valuation and head pair.
      try {
        sim = await port.simulate(c, t.fees, true);
        gasConstraints = sim.ok ? await port.gasConstraints?.(c, sim.estimate) : undefined;
      } catch (error) { return skip('simulation error', afterRun(t.mem, c, false, t.w), error); }
      // The start send uses this second result and estimate, with every original gas/budget guard reapplied.
      d = decide(c.job, { ...sim, tipWei: null }, { fees, budget: t.budget, limits: t.cfg.limits,
        privateEndpoint: t.cfg.privateEndpoint, gasConstraints, candidate: c, now: t.w.block.timestamp,
        version: c.version, ordinary: true });
      if (!d.send) return defer(d.why);
      if (unblockingWork(c, sim)) return defer(why);
      const refused = startRefusal(c, sim, box.receiver, d.costWei, t.incomeSpend, t.income);
      if (refused) return defer(refused);
      start = true;
    }
  }
  let incomeSpend = t.incomeSpend;
  if (incomeCapped(c, sim) && box) incomeSpend = [...incomeSpend, { box: box.receiver,
    at: incomeReservationTime(box.receiver, t.w.block.timestamp, [...t.previousSpend, ...incomeSpend], start && !t.cfg.dryRun), costWei: d.costWei,
    ...(start && !t.cfg.dryRun ? { start: { job: c.job as 'collect' | 'sellFees' } } : {}) }];
  if (d.counter === 'drandRescue') {
    const key = `fee:${c.key}`, now = t.w.block.timestamp;
    if (t.drandLog[key] === undefined || now - t.drandLog[key] >= 3600n) {
      t.drandLog[key] = now;
      t.log.warn('drand deadline fee in use', { job: c.job, key: c.key, maxFeePerGas: t.fees.maxFeePerGas, secondsLeft: (c.drandDeadline ?? now) - now });
    }
  }
  const gas = d.gas;
  const mem = afterRun(t.mem, c, true, t.w);
  const charged = charge(t.budget, c.job, d);
  let budget = reserve(unblocking && boxKey ? chargeUnblocking(charged, boxKey, gas, d.costWei) : charged, c.job, d,
    unblocking ? boxKey : undefined);
  if (d.counter === 'drandRescue') {
    const cap = t.cfg.limits.drandRescueWeiPerDay ?? 0n;
    for (const [percent, message] of [[50n, 'drand rescue allowance half used'], [80n, 'drand rescue allowance mostly used']] as const) {
      const key = `rescue:${percent}`;
      if ((budget.drandRescueWei ?? 0n) * 100n >= cap * percent && t.drandLog[key] !== budget.day) {
        t.drandLog[key] = budget.day; t.log.warn(message, { drandRescueWei: budget.drandRescueWei, limit: cap });
      }
    }
  }
  // Persist before broadcast. A crash or a timeout after node acceptance cannot reset the day's liability.
  // Replace a proved-reverted attempt with a new reservation before the retry can broadcast.
  if (c.job === 'backupStart' && typeof c.args[0] === 'bigint') t.startingRounds.add(c.args[0]);
  const named = (hash: string) => {
    if (bountyKey !== undefined) t.drandBounties[bountyKey] = { hash: hash.toLowerCase() };
    if (incomeSpend !== t.incomeSpend) incomeSpend = incomeSpend.map((s, i) => i === incomeSpend.length - 1 ? { ...s, hash } : s);
    budget = accepted(budget, hash);
  };
  // SH-249: a port that saves what it signs signs in memory first; the record, then the journal (both naming the hash)
  // are durable before the first broadcast. A refusal before any signature keeps no reservation (A2).
  let signed: SignedSend | undefined;
  if (!t.cfg.dryRun && port.sign && port.keep && port.broadcast) {
    try { signed = await port.sign(c, gas, fees, d.privately, take ?? undefined); } catch (error) {
      // SH-250 B5: too many unconfirmed transactions is a wait with its own reason, not an attempt.
      if (error instanceof SendWait) return skip(error.message);
      t.log.error('send failed', { job: c.job, key: c.key, error });
      return { incomeSpend: t.incomeSpend, work: 'waiting', mem, budget: t.budget, skipped: { boxId: c.boxId, job: c.job, key: c.key, why: 'send error', code: 'SEND_ERROR', error } };
    }
    named(signed.hash);
    const income = incomeSpend !== t.incomeSpend ? incomeSpend[incomeSpend.length - 1] : undefined;
    await port.keep(signed, { at: t.w.block.timestamp, day: budget.day, costWei: d.costWei, ...(bountyKey === undefined ? {} : { bounty: bountyKey }),
      ...(d.counter ? { counter: d.counter } : d.asOurs ? { ours: jobSpec(c.job).budget } : {}), ...(unblocking && boxKey ? { unblocking: boxKey } : {}),
      ...(jobSpec(c.job, c.version).reserved && c.ordinary !== true ? { reserve: true } : {}), v: 2,
      ...(income ? { income: { box: income.box.toLowerCase(), at: income.at, ...(income.start ? { start: income.start.job } : {}) } } : {}) });
  } else if (bountyKey !== undefined) t.drandBounties[bountyKey] = {};
  const carried = { drandBounties: t.drandBounties, ...(t.monitorQueue ? { monitorQueue: t.monitorQueue } : {}) };
  await t.cfg.checkpoint?.({ mem, budget, incomeSpend, m2Scan: t.m2Scan, drandLog: t.drandLog, ...carried }, t.w.block.timestamp);
  const what = { job: c.job, key: c.key, to: c.to, gas, asOurs: d.asOurs };
  let sentHash: string | undefined;
  try {
    if (t.cfg.dryRun) t.log.info('dry run: would send', what);
    else {
      const hash = signed ? (await port.broadcast?.(signed), signed.hash) : await port.send(c, gas, t.fees, d.privately);
      const retryAt = mem.attempts[c.key]?.next;
      if (c.job === 'drandPostRound' && typeof c.args[0] === 'bigint' && retryAt !== undefined) {
        pendingRoundPosts.get(port)?.set(c.args[0], retryAt);
      }
      if (!signed) named(hash);
      sentHash = hash;
    }
  } catch (error) {
    // A send error may follow node acceptance. Retain the full reservation even if the RPC reports failure.
    t.log.error('send failed', { job: c.job, key: c.key, error });
    return { incomeSpend, work: 'waiting', mem, budget, skipped: { boxId: c.boxId, job: c.job, key: c.key, why: 'send error', code: 'SEND_ERROR', error } };
  }
  if (sentHash !== undefined) {
    if (!signed) await t.cfg.checkpoint?.({ mem, budget, incomeSpend, m2Scan: t.m2Scan, drandLog: t.drandLog, ...carried }, t.w.block.timestamp);
    t.log.info('sent', { ...what, hash: /^0x[0-9a-fA-F]{64}$/.test(sentHash) ? sentHash : undefined });
  }
  return {
    incomeSpend, work: 'sent', mem, budget,
    sent: { job: c.job, key: c.key, asOurs: d.asOurs, gas },
    slot: SLOT_JOBS.has(first.job) ? c.pool ?? c.to : null,
  };
}

const ordered = (cs: readonly Candidate[], mem: Memory) =>
  cs.map((c, i) => ({ c, i })).sort((a, b) => {
    const priority = jobSpec(a.c.job).priority - jobSpec(b.c.job).priority;
    const lastA = mem.attempts[a.c.key]?.block ?? 0n, lastB = mem.attempts[b.c.key]?.block ?? 0n;
    return priority || (lastA < lastB ? -1 : lastA > lastB ? 1 : a.i - b.i);
  }).map((x) => x.c);

/** One block: read, plan, then simulate, decide and send each candidate in priority order; log the skips. */
export async function runTick(port: ChainPort, given: KeeperState, cfg: RunConfig, log: Logger) {
  const w = await port.read(given.m2Scan, given.mem);
  // SH-250: the journal carries the record's settled outcomes (renamed winners, released calls) before anything reads it.
  const state = applyOutcomes(given, port.outcomes?.());
  const drandBounties = { ...state.drandBounties };
  const drandLog = { ...state.drandLog };
  const pendingPosts = pendingRoundPosts.get(port) ?? new Map<bigint, bigint>();
  pendingRoundPosts.set(port, pendingPosts);
  for (const [round, until] of pendingPosts) if (w.block.number >= until) pendingPosts.delete(round);
  const m2Scan = w.m2Scan ?? state.m2Scan;
  // SH-259 rule A: a chain whose base fee is 0 signs at this tick's eth_gasPrice plus a quarter, at most the ceiling;
  // without a quote, or above the ceiling, nothing is signed this tick. A chain with a base fee: as before.
  const price = w.block.baseFeePerGas === 0n
    ? zeroBasePrice(port.tickGasPrice?.() ?? null, cfg.priorityFeeWei, maxFeeFor({ job: 'collect' }, w.block.timestamp, cfg.limits)) : undefined;
  const feeWait = price === null ? 'gas price unread' : undefined;
  const fees = feesFor(w.block.baseFeePerGas, price ?? cfg.priorityFeeWei);
  let budget = openBudget(state.budget, w.block.number, w.block.timestamp);
  // RC6RR2-HP-2: settle today's sends whose receipts are final; an unreadable receipt keeps its whole reservation.
  const sentHashes = (budget.pending ?? []).flatMap(r => r.hash === undefined ? [] : [r.hash]);
  if (sentHashes.length > 0 && port.settled) {
    try { budget = settle(budget, await port.settled(sentHashes)); }
    catch (error) { log.warn('receipt read failed; reservations kept', { error }); }
  }
  // Old journals have no attribution or transaction hashes. Retain their recorded liability
  // against every box until an operator reconciles it; upgrading never grants fresh income room.
  const previousSpend = state.incomeSpend ?? (state.budget && state.budget.totalWei > 0n
    ? [{ box: UNKNOWN_INCOME_BOX, at: w.block.timestamp, costWei: state.budget.totalWei }] : []);
  let income: IncomeSnapshot | null;
  try {
    income = await port.readIncome?.(previousSpend) ?? null;
    if (income && income.at !== w.block.timestamp) throw new Error('stale income snapshot');
  } catch (error) { income = null; log.warn('income read failed; pokes deferred', { error }); }
  let incomeSpend: readonly IncomeSpend[] = reconcileStarts(activeIncomeSpend(previousSpend, income, cfg.dryRun, w.block.timestamp), income);
  // SH-250 B2: hanging sends are replaced first, each reserved in the journal before it is signed.
  const plans = cfg.dryRun || w.block.baseFeePerGas === 0n ? [] : port.hangingSends?.() ?? [];
  if (plans.length && port.replace) ({ budget, incomeSpend } = await replaceHanging(plans, { budget, incomeSpend, income, limits: cfg.limits, log,
    replace: p => port.replace?.(p) ?? Promise.reject(new Error('no replacement')),
    save: (b, spend) => cfg.checkpoint?.({ ...state, drandBounties, drandLog, m2Scan, budget: b, incomeSpend: spend }, w.block.timestamp) ?? Promise.resolve() }));
  const planned = plan(w, state.mem ?? emptyMemory(), cfg);
  let mem = planned.mem;
  for (const alert of planned.alerts) log.warn('buy-back backlog', { ...alert });
  const report: TickReport = { block: w.block.number, sent: [], skipped: [] };
  let slots: ReadonlySet<string> = new Set<string>();
  const outcomes = new Map<string, WorkStatus>();
  const postedRounds = new Set<bigint>();
  const startingRounds = new Set<bigint>();
  for (const c of ordered(planned.candidates, mem)) {
    if (cfg.signal?.aborted) break;
    const round = typeof c.args[0] === 'bigint' ? c.args[0] : undefined;
    if (c.job === 'backupStart' && round !== undefined && postedRounds.has(round)) {
      report.skipped.push({ boxId: c.boxId, job: c.job, key: c.key, why: 'round posted this tick', code: 'SLOT_TAKEN' });
      outcomes.set(c.key, 'none');
      continue;
    }
    if (c.job === 'backupStart' && round !== undefined && pendingPosts.has(round)) {
      report.skipped.push({ boxId: c.boxId, job: c.job, key: c.key, why: 'round post pending', code: 'SLOT_TAKEN' });
      outcomes.set(c.key, 'unknown');
      continue;
    }
    // Priority 2 starts reach their send boundary before priority 3 top-ups from the same snapshot.
    // Box 0 ignores that round's drand word after a start, even when its send reply is lost.
    if (c.job === 'drandGraduationBounty' && round !== undefined && startingRounds.has(round)) {
      report.skipped.push({ boxId: c.boxId, job: c.job, key: c.key, why: 'round backup starting this tick', code: 'SLOT_TAKEN' });
      outcomes.set(c.key, 'none');
      continue;
    }
    const out = await runOne(port, c, { feeWait, previousSpend, drandBounties, drandLog, startingRounds, w, fees, budget, mem, slots, m2Scan, cfg, log, income, incomeSpend, monitorQueue: state.monitorQueue });
    ({ mem, budget, incomeSpend } = out);
    outcomes.set(c.key, out.work);
    if ('skipped' in out) {
      report.skipped.push(out.skipped);
      continue;
    }
    report.sent.push(out.sent);
    if (c.job === 'drandPostRound' && round !== undefined) postedRounds.add(round);
    if (out.slot) slots = new Set([...slots, out.slot]);
  }
  const skipLog = logSkips(state.skipLog, report.skipped, w.block.timestamp, log);
  // A pool step waiting for its turn was not simulated: the queue keeps its earlier state (STEPS-A), so a step whose
  // turn passed on a deferral keeps its age rather than leaving the queue and coming back young.
  for (const key of planned.held) if (!outcomes.has(key)) outcomes.set(key, 'unknown');
  // Only a keeper with the monitor view configured tracks its queue (the adapter then supplies `w.monitor`).
  const monitorQueue = w.monitor ? trackQueue(state.monitorQueue, { at: w.block.number > 0n ? w.block.number - 1n : 0n,
    pending: w.block.number, now: w.block.timestamp, complete: w.monitor.complete, outcomes, attempts: mem.attempts }) : undefined;
  const next = { drandBounties, drandLog, mem, budget, skipLog, m2Scan, incomeSpend, ...(monitorQueue ? { monitorQueue } : {}) } satisfies KeeperState;
  await cfg.checkpoint?.(next, w.block.timestamp);
  const observed: TickObservation = { readings: w.monitor, maxFeePerGas: fees.maxFeePerGas, income, incomeSpend, deferrals: report.skipped };
  return { state: next, report, observed };
}
