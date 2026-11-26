import { REQUEST_SPACING_MS } from './api';
import { orderFields, orderUid } from './order';
import type { ChainReader, CowApi, Health, Log, ReservationStore, Target } from './types';

interface Options {
  chain: ChainReader;
  api: CowApi;
  store: ReservationStore;
  chainId: number;
  feeBps: bigint;
  mode: Health['mode'];
  now: () => number;
  log: Log;
  health: (health: Health) => Promise<void> | void;
  signal?: AbortSignal;
  /** The cycle period (SH_COW_CYCLE_MS): a no-quote wait and the status reads' time bound follow it. */
  cycleMs?: number;
}
/** The third cycle in a row whose RPC reads fail is fatal, as every failure was before, so a dead RPC still restarts. */
const FATAL_FAILED_CYCLES = 3;
const HOUR_MS = 3_600_000;
/** RC6RR2-COW-3: every order's UID changes at the hour's turn; a minute later our keeper's refresh has usually landed. */
export const HOUR_TURN_DELAY_MS = 60_000;

/** RC6RR2-COW-3: the next cycle starts after the cycle period, or at the next hour's turn plus a minute if that is sooner. */
export function nextCycleDelay(cycleMs: number, elapsedMs: number, nowMs: number): number {
  const regular = Math.max(0, cycleMs - elapsedMs);
  const thisTurn = Math.floor(nowMs / HOUR_MS) * HOUR_MS + HOUR_TURN_DELAY_MS;
  const turn = nowMs < thisTurn ? thisTurn : thisTurn + HOUR_MS;
  return Math.min(regular, turn - nowMs);
}

interface Wait { readonly epoch?: bigint; readonly block?: bigint; readonly retried?: true }
interface Outcome { readonly order?: true; readonly reserved?: string }
const keyOf = (t: Target) => `${t.inbox}:${t.coin}`.toLowerCase();
/** CoW may store EIP-1271 bytes as posted or after the owner's address; any other bytes are another poster's. */
const sameSignature = (stored: string, ours: string, owner: string) => {
  const s = stored.toLowerCase(), o = ours.toLowerCase();
  return s === o || s === `0x${owner.slice(2).toLowerCase()}${o.slice(2)}`;
};

export class Poster {
  private waits = new Map<string, Wait>();
  /** When this process last posted each target's order: least recently posted goes first (RC6RR2-COW-3). */
  private lastPosted = new Map<string, number>();
  private failedCycles = 0;
  constructor(private readonly options: Options) {}

  async cycle(): Promise<void> {
    const { chain, api, chainId, mode, now, health, log } = this.options;
    const startedAt = now();
    const state: Health = { phase: 'running', mode, chainId, startedAt, updatedAt: now(), targets: 0, posted: 0, skipped: 0, errors: 0 };
    const observed = await this.rpc('chain_id', state, () => chain.chainId());
    if (observed === undefined) return;
    if (observed !== chainId) throw new Error('RPC chain mismatch');
    await health({ ...state });
    const found = await this.rpc('discover', state, () => chain.discover());
    if (found === undefined) return;
    const { targets, errors } = found;
    state.targets = targets.length; state.errors = errors;
    const block = await this.rpc('block_number', state, () => chain.blockNumber());
    if (block === undefined) return;
    this.failedCycles = 0;
    // RC6RR2-COW-3: least recently posted first, so when a cycle cannot reach every target in its hour, the ones left
    // out go first the next time.
    const ordered = targets.map((target, i) => ({ target, i, at: this.lastPosted.get(keyOf(target)) ?? -Infinity }))
      .sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1) || a.i - b.i).map(x => x.target);
    const reserved: { target: Target; uid: string }[] = [];
    let orders = 0;
    for (const target of ordered) {
      this.options.signal?.throwIfAborted();
      const outcome = await this.process(target, block, state);
      if (outcome.order) orders++;
      if (outcome.reserved) reserved.push({ target, uid: outcome.reserved });
      state.updatedAt = now(); await health({ ...state });
    }
    // RC6RR2-COW-3: status reads of UIDs posted in earlier cycles come after every new post, end with the cycle period,
    // and never take the time the next hour's posts need (a quote and a POST for each target with an order).
    const nextHour = (Math.floor(now() / HOUR_MS) + 1) * HOUR_MS;
    const deadline = Math.min(this.options.cycleMs === undefined ? Infinity : startedAt + this.options.cycleMs,
      nextHour - orders * 2 * REQUEST_SPACING_MS);
    for (const [i, { target, uid }] of reserved.entries()) {
      if (now() >= deadline) { log('status_deferred', { count: reserved.length - i }); break; }
      this.options.signal?.throwIfAborted();
      const status = await api.status(uid);
      if (status === null) state.errors++;
      log('order_status', { inbox: target.inbox, coin: target.coin, uid, status: status ?? 'no_data' });
      state.updatedAt = now(); await health({ ...state });
    }
    // Only current canonical discovery retains a poll schedule or a posting time.
    const active = new Set(targets.map(keyOf));
    for (const key of this.waits.keys()) if (!active.has(key)) this.waits.delete(key);
    for (const key of this.lastPosted.keys()) if (!active.has(key)) this.lastPosted.delete(key);
    state.phase = 'idle'; state.completedAt = now(); state.updatedAt = now();
    await health({ ...state });
    log('cycle_complete', { targets: state.targets, posted: state.posted, skipped: state.skipped, errors: state.errors });
  }

  /** An RPC read that fails ends this cycle, not the process: the CoW client's back-off and this poster's poll and fee
   * waits survive a flapping RPC. A chain mismatch, a storage or health-file failure and the third such cycle in a row
   * stay fatal. Nothing of the error is logged. */
  private async rpc<T>(stage: string, state: Health, read: () => Promise<T>): Promise<T | undefined> {
    try { return await read(); }
    catch (error) {
      this.options.signal?.throwIfAborted();
      if (++this.failedCycles >= FATAL_FAILED_CYCLES) throw error;
      this.options.log('cycle_failed', { stage, failedCycles: this.failedCycles });
      state.phase = 'idle'; state.errors++; state.updatedAt = this.options.now();
      await this.options.health({ ...state });
      return undefined;
    }
  }

  /** One target: its chain read and, for a UID not attempted yet, the quote and the POST; a reserved UID's status
   * waits for the cycle's status reads. */
  private async process(target: Target, block: bigint, state: Health): Promise<Outcome> {
    const { chain, api, store, feeBps, now, log } = this.options;
    const key = keyOf(target);
    const fields = { inbox: target.inbox, coin: target.coin };
    const wait = this.waits.get(key);
    const epoch = () => BigInt(Math.floor(now() / 1000));
    if ((wait?.epoch !== undefined && epoch() < wait.epoch) || (wait?.block !== undefined && block < wait.block)) {
      state.skipped++; return {};
    }
    this.waits.delete(key);
    const result = await chain.tradeable(target);
    if (result.type !== 'order') {
      if (result.type === 'no_data') state.errors++; else state.skipped++;
      if (result.type === 'PollTryAtEpoch') {
        // RC6RR2-COW-1 (c): our keeper refreshes a coin at the hour's start and its transaction can land after this
        // check, so a check that finds no order is repeated once, on the next cycle, before it waits for the epoch.
        const recheck = wait?.retried !== true;
        this.waits.set(key, recheck ? { epoch: epoch() + 1n, retried: true } : { epoch: result.epoch });
        log(result.type, { ...fields, epoch: String(result.epoch), ...(recheck ? { recheck: 'next_cycle' } : {}) });
      } else if (result.type === 'PollTryNextBlock') {
        this.waits.set(key, { block: result.block });
        log(result.type, { ...fields, block: String(result.block) });
      } else log(result.type, fields);
      return {};
    }
    const { order, signature, domainSeparator } = result;
    if (order.sellToken.toLowerCase() !== target.coin.toLowerCase() || order.receiver.toLowerCase() !== target.inbox.toLowerCase()) {
      log('target_mismatch', fields); state.errors++; return {};
    }
    try { orderFields(order); }
    catch { log('unsupported_order', fields); state.errors++; return {}; }
    if (BigInt(order.validTo) <= epoch()) { log('expired', fields); state.skipped++; return { order: true }; }
    const uid = orderUid(order, target.inbox, domainSeparator);
    if (await store.has(uid)) { state.skipped++; log('already_attempted', { ...fields, uid }); return { order: true, reserved: uid }; }
    const quote = await api.quote(order, target.inbox);
    if (!quote) {
      log('no_quote', fields); state.errors++;
      // RC6RR2-COW-3: a coin CoW will not quote waits more than one cycle, not a quote every cycle.
      if (this.options.cycleMs !== undefined) this.waits.set(key, { epoch: epoch() + BigInt(Math.ceil((this.options.cycleMs * 3) / 2000)) });
      return { order: true };
    }
    if (quote.feeAmount < 0n || quote.feeAmount * 10_000n > order.sellAmount * feeBps) {
      this.waits.set(key, { epoch: BigInt(order.validTo) });
      log('high_fee', { ...fields, feeAmount: quote.feeAmount.toString(), sellAmount: order.sellAmount.toString() });
      state.skipped++; return { order: true };
    }
    if (BigInt(order.validTo) <= epoch()) { state.skipped++; return { order: true }; }
    if (this.options.mode !== 'live') {
      // Dry run: everything up to the POST, which needs live mode. The same order is not quoted again this hour.
      this.waits.set(key, { epoch: BigInt(order.validTo) });
      log('dry_run_order', { ...fields, uid, sellAmount: order.sellAmount.toString(), feeAmount: quote.feeAmount.toString() });
      state.skipped++; return { order: true };
    }
    // Reserve permanently even if the server times out, rejects, or replies with an unexpected UID.
    // A lost response must never trigger a second POST. Disk errors are fatal, not retriable submissions.
    if (!await store.reserve(uid)) { state.skipped++; log('already_attempted', { ...fields, uid }); return { order: true, reserved: uid }; }
    const posted = await api.post(order, target.inbox, signature);
    this.lastPosted.set(key, now());
    // RC6RR2-COW-3: no status read right after a POST; this UID's status waits for a later cycle's status reads.
    if (posted === uid) { state.posted++; log('posted', { ...fields, uid }); return { order: true }; }
    state.errors++; log('post_unknown', { ...fields, uid });
    // RC6RR2-COW-2: the UID may already be in CoW's book under another poster's signature bytes.
    // An order stored with other bytes can no longer settle. Compare the bytes CoW stores with ours.
    const stored = await api.stored(uid);
    if (stored?.signature && !sameSignature(stored.signature, signature, target.inbox)) {
      state.errors++; log('foreign_signature', { ...fields, uid });
    } else log('order_status', { ...fields, uid, status: stored?.status ?? 'no_data' });
    return { order: true };
  }
}
