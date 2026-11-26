import { buyBudgetV21, buyableV21, burnBudgetV21 } from './pay-in-t-v21';
import type { Address } from 'viem';
import { coinMinimumsFor, MAX_EXECUTOR_CHUNKS, type CoinMinimumOverrides } from './config';
import { pokeDue, topUpDue } from './poke';
import type { Rng } from './rng';
import { NO_CADENCE, collectDue, deepenDue, noteCollect, noteDeepen, type Cadence } from './schedule';
import type { Candidate } from './types';
import type { BoxState, InboxCoin, World } from './world';

/** What the keeper remembers between blocks; every update returns a new object. */
export interface Memory {
  /** Per box, keyed by its hook. */
  readonly cadence: Readonly<Record<string, Cadence>>;
  /** Per price source: the block of the last poke sent. */
  readonly pokes: Readonly<Record<string, bigint>>;
  readonly attempts: Readonly<Record<string, { block: bigint; next: bigint; nextAt?: bigint }>>;
  readonly steps: Readonly<Record<string, { job: StepJob; block: bigint; sent: boolean }>>;
  readonly buyBackSince: Readonly<Record<string, bigint>>;
  /**
   * Per hook with a waiting mark: the raw buy budget (buy-back P plus reward P) the last plan saw. A lower budget means a
   * buy happened and restarts the mark's age (SH-KEEPER-V2-STEPS, STEPS-B). Absent in journals written before it.
   */
  readonly buyBackBudget?: Readonly<Record<string, bigint>>;
}

export const emptyMemory = (): Memory => ({ cadence: {}, pokes: {}, attempts: {}, steps: {}, buyBackSince: {}, buyBackBudget: {} });

export interface PlanOptions {
  readonly keeper: Address;
  readonly payoutMinWei: bigint;
  readonly coinMinimums?: CoinMinimumOverrides;
  readonly rng: Rng;
  readonly retryBlocks?: bigint;
  readonly buyBackAlertBlocks?: bigint;
  readonly executorMaxChunks?: bigint;
}

/** The jobs that share a v2 pool's one protocol step per block (the hook's on-chain mark). */
export type StepJob = 'deepen' | 'buyBack' | 'shopFees' | 'sellFees';
/**
 * F137: anyone may press the plain hook's `sellFees` step and earns its capped tip; our keeper presses it only as an
 * hourly fallback (300 blocks of 12 s) after an attempt that found nothing. LIM-1(b): every sent press that consumes
 * T is due again on the step's next rotation turn, including positive-P conversions.
 */
export const SELL_FEES_FALLBACK_BLOCKS = 300n;
/**
 * RC6 inbox: at most one refresh and one observe per coin per clock hour, the period of the inbox's own 20-lot approval
 * cap (RC6RR2-COW-1 (b): the next one is due at the next hour's start, not 300 blocks after the last attempt).
 */
export const INBOX_REFRESH_BLOCKS = 300n;
/** `BoxRoyaltyRouterV2.MAX_LOTS_PER_HOUR`: a refresh never approves more than this many lots of one coin per hour. */
export const INBOX_MAX_LOTS_PER_HOUR = 20n;

/** Shared by planning and the read cache: a due positive hint must be refreshed before planning a send. */
export function inboxJob(c: InboxCoin, due: (job: 'royaltyRefresh' | 'royaltyObserve') => boolean) {
  const lots = c.lot > 0n ? c.balance / c.lot : 0n;
  const want = (lots < INBOX_MAX_LOTS_PER_HOUR ? lots : INBOX_MAX_LOTS_PER_HOUR) * c.lot;
  if (want > 0n && (!c.registered || c.allowance < want) && due('royaltyRefresh')) return 'royaltyRefresh';
  if (c.lot > 0n && (c.allowance < c.approved || (c.balance > 0n && c.balance < c.lot && c.oldestUnsoldAt === 0n))
    && due('royaltyObserve')) return 'royaltyObserve';
  return undefined;
}

/** A top-up waits this long after any poke, so one not yet mined is not sent again [P]; big-move pokes go every block. */
export const TOP_UP_GUARD_BLOCKS = 25n;
function boxJobs(b: BoxState, w: World, mem: Memory, o: PlanOptions, held: string[]): Candidate[] {
  if (b.version === 2 && b.setLifecycle) {
    const job = lifecycleJob(b,w.block.timestamp,b.setLifecycle.closedAt);
    if (!job) return [];
    const key = `${job}:2:${b.hook.toLowerCase()}`;
    const attempt = mem.attempts[key];
    if (w.block.number < (attempt?.next ?? 0n) || w.block.timestamp < (attempt?.nextAt ?? 0n)) return [];
    return [{job,key,to:b.coordinator,fn:job,args:[],version:2,boxId:b.id,pool:b.hook,retryAfterBlocks:o.retryBlocks ?? 25n}];
  }
  if (b.version === 2) return v2Jobs(b, w, mem, o, held);
  const now = w.block.timestamp;
  const block = w.block.number;
  const out: Candidate[] = [];
  const at = (job: Candidate['job'], to: Address, fn: string, args: readonly unknown[] = []) =>
    out.push({ job, key: `${job}:${b.version}:${b.id}`, to, fn, args, boxId: b.id, version: b.version });
  const payouts = () => {
    if (b.fitOwed > 0n && b.fitOwed >= o.payoutMinWei) at('receiverPayFit', b.receiver, 'payFit');
    if (b.platformOwed > 0n && b.platformOwed >= o.payoutMinWei) at('receiverPayPlatform', b.receiver, 'payPlatform');
  };
  if (b.failed) {
    payouts();
    return out;
  }
  if (!b.graduated) {
    if (b.curveClosed) at('graduate', b.coordinator, 'graduate');
    return out;
  }
  const cadence = mem.cadence[b.hook] ?? NO_CADENCE;
  if (deepenDue(cadence, now, block)) at('deepen', b.hook, 'deepen', [o.keeper]);
  else if (collectDue(cadence, now, block)) at('collect', b.receiver, 'collect', [o.keeper]);
  if (b.priceSource && b.spotTick !== null && b.sampleTick !== null) {
    const last = mem.pokes[b.priceSource];
    if (pokeDue(b.spotTick, b.sampleTick, last, block)) at('poke', b.priceSource, 'poke');
    else if (topUpDue(b.checkpointTime, now) && (last === undefined || block >= last + TOP_UP_GUARD_BLOCKS)) at('executorTopUp', b.priceSource, 'poke');
  }
  const execution = b.executor;
  const maxChunks = o.executorMaxChunks ?? 1n;
  const executionKey = `executorExecute:1:${b.id}`;
  if (b.id === 0n && b.priceSource && w.fitGraduated && execution?.twapReady
    && execution.batchThreshold > 0n && execution.budget >= execution.batchThreshold
    && maxChunks > 0n && maxChunks <= MAX_EXECUTOR_CHUNKS && block >= (mem.attempts[executionKey]?.next ?? 0n)) {
    out.push({ job: 'executorExecute', key: executionKey, to: b.priceSource, fn: 'execute', args: [maxChunks],
      boxId: b.id, version: 1, retryAfterBlocks: o.retryBlocks ?? 25n });
  }
  payouts();
  return out;
}

/** Same reserved lifecycle policy for the separate set instance and v2.1. */
function lifecycleJob(b: BoxState, now: bigint, closedAt: bigint): 'graduate'|'fail'|'failClosed'|null {
  if (b.failed || b.graduated) return null;
  if (!b.gateOpen) return now >= b.openAt + 1_209_600n ? 'failClosed' : null;
  if (b.curveClosed) return closedAt > 0n && now >= closedAt + 604_800n ? 'fail' : 'graduate';
  return b.deadline > 0n && now >= b.deadline ? 'fail' : null;
}

/**
 * Read-only alerts never bypass a contract's step limit. Age is from the first canonical balance one buyBack call could
 * buy from (a bucket at or above the hook's STEP_MIN_Q) in a graduated box, restarted when the budget falls (a buy
 * happened); below the minimum, or before graduation, there is no backlog (SH-KEEPER-V2-STEPS, STEPS-B).
 */
export interface KeeperAlert { readonly kind: 'buyBackWaiting'; readonly boxId: bigint; readonly sinceBlock: bigint; }

/**
 * `held`: the pool steps this plan did not propose because another step had the pool's turn, or its block's protocol
 * step was already taken. Nothing was simulated, so the monitor's queue keeps their earlier state (STEPS-A).
 */
export function plan(w: World, mem: Memory, o: PlanOptions): { candidates: Candidate[]; mem: Memory; alerts: KeeperAlert[]; held: string[] } {
  const since = new Map(Object.entries(mem.buyBackSince));
  const seen = new Map(Object.entries(mem.buyBackBudget ?? {}));
  const alerts: KeeperAlert[] = [];
  for (const b of w.boxes) {
    if (b.version !== 2 || !b.v2) continue;
    const key = b.hook.toLowerCase();
    // buyBack needs graduation: the plan proposes it only after (v2Jobs), and the receiver reverts NotGraduated before (af1).
    if (b.failed || !b.graduated || !buyableV21(b.v2)) { since.delete(key); seen.delete(key); continue; }
    const budget = buyBudgetV21(b.v2), last = seen.get(key), previous = since.get(key);
    seen.set(key, budget);
    const bought = last !== undefined && budget < last;
    const start = bought || previous === undefined || previous > w.block.number ? w.block.number : previous;
    since.set(key, start);
    if (w.block.number - start > (o.buyBackAlertBlocks ?? 300n)) alerts.push({ kind: 'buyBackWaiting', boxId: b.id, sinceBlock: start });
  }
  const next = { ...mem, buyBackSince: Object.fromEntries(since), buyBackBudget: Object.fromEntries(seen) };
  const drand = (w.drand ?? []).filter(c => w.block.number >= (mem.attempts[c.key]?.next ?? 0n));
  const held: string[] = [];
  return { candidates: [...drand, ...w.boxes.flatMap((b) => boxJobs(b, w, next, o, held))], mem: next, alerts, held };
}

function v2Jobs(b: BoxState, w: World, mem: Memory, o: PlanOptions, held: string[]): Candidate[] {
  const v = b.v2;
  if (!v) return [];
  const out: Candidate[] = [];
  const block = w.block.number;
  const now = w.block.timestamp;
  const minimums = coinMinimumsFor(v.q, v.qDecimals, o.coinMinimums);
  // RC6RR2-MONEY-1, RC6RR2-HP-1: unchanged all-source thresholds; rc7 sub-unit passes can reach further.
  const lagging = v.sources !== undefined && (v.sources.buyerLag >= 2n || v.sources.sellerRun >= 3n);
  const at = (job: Candidate['job'], to: Address, fn: string, args: readonly unknown[] = [], suffix = '', retry?: bigint) => {
    const key = `${job}:2:${b.hook.toLowerCase()}${suffix}`;
    const attempt = mem.attempts[key];
    // A lag, outside presses included, is collected without waiting out an earlier attempt's retry, once a block.
    const lagCollect = job === 'collect' && lagging && (attempt === undefined || attempt.block < block);
    if (!lagCollect && block < (attempt?.next ?? 0n)) return;
    if (now < (attempt?.nextAt ?? 0n)) return;
    out.push({ job, key, to, fn, args, version: 2, boxId: b.id, pool: b.hook,
      retryAfterBlocks: retry ?? o.retryBlocks ?? 25n,
      minAmountRaw: job === 'collect' ? minimums?.collectRaw : undefined,
      settlesGraduation: job === 'collect' && b.graduated && !v.graduationSettled,
      ...(job === 'collect' && lagging ? { cursorLag: true as const } : {}),
      ...(job === 'sellFees' && v.sources ? { sourced: true as const } : {}),
      ...(job === 'sellFees' && v.stepMinQ !== undefined ? { lowValueBelow: v.stepMinQ / 100n } : {}) });
  };
  // F130: anyone can trigger fixed-Safe receipts, even before graduation or after failure.
  // Raw P needs neither a price/decimals read nor a minimum; user claims remain owner-only.
  if (b.fitOwed > 0n) at('receiverPayFit', b.receiver, 'payFit');
  if (b.platformOwed > 0n) at('receiverPayPlatform', b.receiver, 'payPlatform');
  for (const c of [...(v.m2 ?? []), ...(v.m3 ?? [])]) {
    if (block >= (mem.attempts[c.key]?.next ?? 0n)) out.push({ ...c, version: 2, boxId: b.id,
      retryAfterBlocks: o.retryBlocks ?? 25n });
  }
  // R53-E: royalty and income upkeep stay public, but our keeper stops it after failure; every claim sweeps the inbox.
  if (!b.failed && v.royalty) {
    const r = v.royalty;
    // flush delivers native P (ETH and WETH) or WETH P; in a box priced in another coin it only wraps ETH.
    if (r.eth > 0n || (BigInt(v.q) === 0n && r.wrapped > 0n)) at('royaltyFlush', r.address, 'flush');
    if (r.price > 0n) at('royaltySweep', r.address, 'sweep', [v.q]);
    // RC6: register or refresh a coin's CoW order when whole lots wait above its approval (at most 20 lots an hour).
    for (const c of r.coins ?? []) {
      const due = (job: 'royaltyRefresh' | 'royaltyObserve') => {
        const attempt = mem.attempts[`${job}:2:${b.hook.toLowerCase()}:${c.coin.toLowerCase()}`];
        return block >= (attempt?.next ?? 0n) && now >= (attempt?.nextAt ?? 0n);
      };
      const job = inboxJob(c, due);
      if (job) at(job, r.address, job === 'royaltyRefresh' ? 'refreshOrder' : 'observe', [c.coin], `:${c.coin.toLowerCase()}`, INBOX_REFRESH_BLOCKS);
    }
  }
  if (burnBudgetV21(v) > 0n) at('burnPending', b.receiver, 'burnPending');
  // Simulation finds unpoked LP fees/donations and applies the raw floor; graduation escrow never waits for fees.
  if (!b.failed && (minimums || (b.graduated && !v.graduationSettled))) at('collect', b.receiver, 'collect', [o.keeper]);
  if (b.failed) {
    at('routerSweep', v.router, 'sweep');
    return out;
  }
  if (!b.graduated) {
    const job = lifecycleJob(b,now,v.closedAt);
    if (job) at(job,b.coordinator,job);
    return out;
  }
  if (v.reward > 0n) at('claimReward', b.coordinator, 'claimReward', [o.keeper]);
  // Anyone may eat or move pending P without a tip/recipient or the pool's swap-step slot.
  for (const sellers of [false, true]) {
    const pending = v.modulePendingP?.[sellers ? 1 : 0];
    if (pending !== undefined && pending !== null && pending > 0n) at('executeModule', b.receiver, 'executeModule', [sellers], sellers ? ':sellers' : ':buyers');
  }
  if (v.pilePendingP !== undefined && v.pilePendingP !== null && v.pilePendingP > 0n) at('moveToPile', b.receiver, 'moveToPile');
  if (v.eatPendingP !== undefined && v.eatPendingP !== null && v.eatPendingP > 0n) at('eatPriceCoin', b.receiver, 'eatPriceCoin');
  // Also recover graduation tax if its fail-safe sweep was refused.
  at('routerSweep', v.router, 'sweep');
  const prev = mem.steps[b.hook.toLowerCase()];
  const rotation: readonly StepJob[] = ['buyBack', 'deepen', 'shopFees', 'sellFees'];
  // Waiting T includes unpoked position fees the counter cannot see, so sellFees may always have work.
  const waiting = (job: StepJob) => job === 'sellFees'
    || (job === 'buyBack' ? buyBudgetV21(v) : job === 'shopFees' ? v.shopPendingP ?? 0n : v.depthBudget) !== 0n;
  const hold = (jobs: readonly StepJob[]) => held.push(...jobs.filter(waiting).map(job => `${job}:2:${b.hook.toLowerCase()}`));
  if (v.lastProtocolBlock >= block || (prev?.sent && prev.block >= block)) {
    hold(rotation);
    return out;
  }
  const start = prev ? (rotation.indexOf(prev.job) + 1) % rotation.length : 0;
  const order = [...rotation.slice(start), ...rotation.slice(0, start)];
  for (const [i, job] of order.entries()) {
    if (job === 'sellFees') {
      // Simulation decides; idle probes are hourly. A press that finds nothing leaves the slot free, so the next step in
      // turn is proposed behind it.
      at('sellFees', b.hook, 'sellFees', [], '', SELL_FEES_FALLBACK_BLOCKS);
      continue;
    }
    if (!waiting(job)) continue;
    const count = out.length;
    at(job, job === 'deepen' ? b.hook : b.receiver, job === 'shopFees' ? 'executeModule' : job, job === 'shopFees' ? [true] : [o.keeper]);
    if (out.length > count) {
      // The steps after this one wait for their turn (a step refused by a check of its own passes it: run.ts passTurn).
      hold(order.slice(i + 1));
      break;
    }
  }
  return out;
}

/**
 * Records sent calls and attempted deepens so cadence and executor guards survive each tick.
 */
export function afterRun(mem: Memory, c: Candidate, sent: boolean, w: World): Memory {
  const now = w.block.timestamp;
  const block = w.block.number;
  if (c.job === 'executorExecute' || c.job.startsWith('drand') || c.job === 'backupStart' || c.job === 'backupFix') {
    return { ...mem, attempts: { ...mem.attempts, [c.key]: { block, next: block + (c.retryAfterBlocks ?? 25n) } } };
  }
  if (c.version === 2) {
    const step = c.job === 'deepen' || c.job === 'buyBack' || c.job === 'shopFees' || c.job === 'sellFees';
    // RC6RR2-COW-1 (b): the inbox's 20-lot cap resets on the clock hour, so a refresh or observe, sent or not, is next
    // due at the next hour's start.
    if (c.job === 'royaltyRefresh' || c.job === 'royaltyObserve') {
      return { ...mem, attempts: { ...mem.attempts, [c.key]: { block, next: block + 1n, nextAt: (now / 3600n + 1n) * 3600n } } };
    }
    // Sent sellFees always consumed T (interpret); no-work/error probes retain the hourly fallback.
    const hourly = c.job === 'sellFees' && !sent;
    // A lag collect, sent or attempted, is tried again on the next block while the lag lasts.
    const next = block + (hourly ? c.retryAfterBlocks ?? 300n : c.job === 'collect' && c.cursorLag === true ? 1n
      : (step || c.job === 'eatPriceCoin' || c.job === 'moveToPile' || c.job === 'executeModule') && sent ? 1n : c.retryAfterBlocks ?? 25n);
    const attempts = { ...mem.attempts, [c.key]: { block, next } };
    // RC6RR2-HP-1: a press closes a buyer/seller pair; the box's collect is due on the next block to allocate it.
    const collectKey = c.pool ? `collect:2:${c.pool.toLowerCase()}` : '';
    const collect = attempts[collectKey];
    if (c.job === 'sellFees' && sent && c.sourced === true && collect && collect.next > block + 1n) {
      attempts[collectKey] = { ...collect, next: block + 1n };
    }
    return { ...mem, attempts,
      steps: step && c.pool ? { ...mem.steps, [c.pool.toLowerCase()]: { job: c.job as StepJob, block, sent } } : mem.steps };
  }
  const box = w.boxes.find((b) => b.id === c.boxId && (b.hook === c.to || b.receiver === c.to));
  switch (c.job) {
    case 'deepen':
    case 'collect': {
      if (!box || (c.job === 'collect' && !sent)) return mem;
      const before = mem.cadence[box.hook] ?? NO_CADENCE;
      const after = c.job === 'deepen' ? noteDeepen(before, now, block, sent) : noteCollect(before, now);
      return { ...mem, cadence: { ...mem.cadence, [box.hook]: after } };
    }
    case 'poke':
    case 'executorTopUp':
      return sent ? { ...mem, pokes: { ...mem.pokes, [c.to]: block } } : mem;
    default:
      return mem;
  }
}
