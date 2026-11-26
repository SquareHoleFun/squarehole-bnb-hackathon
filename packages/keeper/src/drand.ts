import { zeroAddress, zeroHash, type Abi, type Address, type Hex, type PublicClient } from 'viem';
import { RANDOMNESS_SOURCE, DRAND_SOURCE, DRAND_SILENCE_SECONDS, BACKUP_AFTER_SECONDS, BACKUP_LATEST_START_SECONDS, BACKUP_RECENT_BLOCKS } from '../../box-spec/src/generated/box-spec.v1';
import { ROLE_V2 } from '../../chain/src/core/roles';
import { backedSourceAbi, boxRegistryAbi, coordinatorV1Abi, drandSourceAbi, drandTicketsAbi, drandVaultAbi } from './abi';
import type { KeeperConfig } from './config';
import type { Logger } from './log';
import type { DrandObservation } from './monitor';
import { readFailed } from './read-failure';
import type { Candidate } from './types';
import { readWindows } from './tick-reads';

export const START_INCLUSION_SECONDS = 96n;
/** EIP-2935, pinned against BoxBackedSource.sol by backup-jobs.test.ts. */
export const HISTORY_WINDOW = 8191n;

export const DRAND_KEYS_PER_TICK = 64n;
export const DRAND_UNREQUESTED_SECONDS = 2_592_000n;

const PAGE = 2000n;
const PAGES_PER_TICK = 8n;
const WARN_BEFORE = 86_400n;
const SETTLE_COUNT = 8n;
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
const pruned = (error: unknown): boolean => {
  for (let e = error as { code?: number; message?: string; cause?: unknown } | undefined, n = 0; e && n < 12; e = e.cause as typeof e, n++) {
    if (e.code === 4444 || /pruned history unavailable/i.test(e.message ?? '')) return true;
  }
  return false;
};
/**
 * F143: box 0 (core v1) requests and reads its words through its BoxBackedSource (RANDOMNESS_SOURCE), whose requests,
 * words and silence follow drand first and the RANDAO backup; core v2 boxes stay drand-only on the DrandSource
 * (DRAND_SOURCE). Every round is posted, and every bounty withdrawn, on the DrandSource, which serves both.
 */
const sourceOf = (version: 1 | 2): Address => (version === 1 ? RANDOMNESS_SOURCE : DRAND_SOURCE);
interface Consumer { readonly address: Address; readonly version: 1 | 2; readonly tickets: boolean; readonly coordinator: Address; }
interface Request { readonly consumer: Address; readonly key: bigint; readonly version: 1 | 2; }
interface RequestState {
  readonly round: bigint; readonly readyAt: bigint; readonly usable: boolean; readonly silent: boolean;
  readonly requestedAt: bigint; readonly deadline: bigint;
}
// viem decodes Solidity uint32/40 to safe JS integers. Convert to bigint at the boundary.
interface Status { slots: number; wordRequestedAt: number; wordAcceptedAt: number; terminalAt: number; drawsRequested: number; drawsSettled: number; }
interface Ticket { readonly consumer: Consumer; readonly status: Status; readonly phase: number; }

/** No cursor is trusted after restart/reorg. Request events are hints; current contract reads authorize each call. */
export class DrandReader {
  private checkpoint: { block: bigint; hash: Hex; consumers: string } | null = null;
  private pending = new Map<string, Request>();
  private readonly warned = new Map<string, bigint>();
  /** This read's monitor observation: failed guarded reads and every request state read. */
  private failures = 0;
  private readErrors = 0;
  private logFloor = 0n;
  private observed = new Map<string, RequestState>();
  private last: DrandObservation = { complete: false, requests: [] };

  constructor(private readonly cfg: KeeperConfig, private readonly pub: PublicClient, private readonly keeper: Address, private readonly log: Logger) {}

  private call<T>(block: bigint, address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.pub.readContract({ address, abi, functionName, args, blockNumber: block } as never) as Promise<T>;
  }

  private warn(key: string, now: bigint, msg: string, fields: Record<string, unknown>) {
    const last = this.warned.get(key);
    if (last === undefined || now < last || now - last >= 3600n) {
      this.warned.set(key, now); this.log.warn(msg, fields);
    }
  }

  private async guard<T>(key: string, now: bigint, fn: () => Promise<T>): Promise<T | null> {
    try { return await fn(); }
    catch (error) {
      this.readErrors++;
      if (readFailed(error)) this.failures++;
      // Provider payloads are not public operational evidence and may contain credentials.
      this.warn(`read:${key}`, now, 'drand read failed', { source: key });
      return null;
    }
  }

  private async discover(block: bigint, now: bigint): Promise<Consumer[]> {
    const out: Consumer[] = [];
    const call = <T>(address: Address, abi: Abi, fn: string, args: readonly unknown[] = []) => this.call<T>(block, address, abi, fn, args);
    const box0 = this.cfg.box0;
    if (box0) await this.guard('box 0 drand wiring', now, async () => {
      const coordinator = box0.coordinator;
      const source = await call<Address>(coordinator, coordinatorV1Abi, 'randomness');
      if (!same(source, RANDOMNESS_SOURCE)) throw new Error('source mismatch');
      // The current coordinator pokes tickets instead of requesting directly; include its own events too.
      out.push({ address: coordinator, coordinator, tickets: false, version: 1 });
      const address = await call<Address>(coordinator, coordinatorV1Abi, 'tickets');
      if (!same(address, zeroAddress)) out.push({ address, coordinator, tickets: true, version: 1 });
    });
    const registry = this.cfg.boxRegistry;
    if (registry) await this.guard('registry drand wiring', now, async () => {
      const count = await call<bigint>(registry, boxRegistryAbi, 'boxCount');
      function* ids() { for (let id = 0n; id < count; id++) yield id; }
      const discovered = await readWindows(ids(), id => this.guard(`v2 tickets ${id}`, now, async (): Promise<Consumer | null> => {
        const address = await call<Address>(registry, boxRegistryAbi, 'roleOf', [id, BigInt(ROLE_V2.tickets)]);
        if (same(address, zeroAddress)) return null;
        const coordinator = await call<Address>(registry, boxRegistryAbi, 'roleOf', [id, BigInt(ROLE_V2.coordinator)]);
        return { address, coordinator, tickets: true, version: 2 };
      }));
      for (const consumer of discovered) if (consumer) out.push(consumer);
    });
    return out;
  }

  private async scan(consumers: readonly Consumer[], block: bigint, snapshotHash?: Hex, probe = true): Promise<void> {
    const identities = consumers.map(c => c.address.toLowerCase()).sort().join(',');
    let start = this.cfg.fromBlock > this.logFloor ? this.cfg.fromBlock : this.logFloor;
    const previous = this.checkpoint;
    if (previous && previous.block <= block && previous.consumers === identities
      && (await this.pub.getBlock({ blockNumber: previous.block })).hash === previous.hash) start = previous.block + 1n;
    else { this.pending = new Map(); this.checkpoint = null; }
    if (start < this.logFloor) start = this.logFloor;
    const allowed = new Set(consumers.map(c => c.address.toLowerCase()));
    if (allowed.size === 0) return;
    if (start > block) return;
    const limit = start + PAGE * PAGES_PER_TICK - 1n;
    const scanTo = limit < block ? limit : block;
    // Pin the end hash before scanning and prove it is still canonical afterwards.
    // The pending header already pinned its parent before discovery and scanning started.
    const pinned = scanTo === block ? snapshotHash : undefined;
    const before = pinned ?? (await this.pub.getBlock({ blockNumber: scanTo })).hash;
    const groups = ([1, 2] as const).map(version => ({ version, consumers: consumers.filter(c => c.version === version) }))
      .filter(g => g.consumers.length > 0);
    for (let from = start; from <= scanTo; from += PAGE) {
      const end = from + PAGE - 1n;
      for (const g of groups) {
        const allowedHere = new Set(g.consumers.map(c => c.address.toLowerCase()));
        const query = (fromBlock: bigint, toBlock: bigint) => this.pub.getContractEvents({ address: sourceOf(g.version), abi: drandSourceAbi,
          eventName: 'Requested', args: { consumer: g.consumers.map(c => c.address) }, fromBlock, toBlock, strict: true });
        const logs = await query(from, end < scanTo ? end : scanTo).catch(async error => {
          if (!probe || !pruned(error)) throw error;
          // Only a pruning reply permits skipping history. Rate limits/timeouts retain the old checkpoint.
          // Find the first served block, with at most 32 probes, then remember it across consumer/reorg resets.
          let low = from + 1n, high = block;
          let accepted: bigint | undefined;
          for (let n = 0; low <= high && n < 32; n++) {
            const mid = (low + high) / 2n;
            try { await query(mid, mid); accepted = mid; high = mid - 1n; }
            catch (e) { if (!pruned(e)) throw e; low = mid + 1n; }
          }
          if (accepted === undefined) throw error;
          this.logFloor = accepted;
          return null;
        });
        if (logs === null) return this.scan(consumers, block, snapshotHash, false);
        for (const e of logs) {
          if (e.removed || !allowed.has(e.args.consumer.toLowerCase()) || !allowedHere.has(e.args.consumer.toLowerCase())) continue;
          this.pending.set(`${e.args.consumer.toLowerCase()}:${e.args.key}`, { consumer: e.args.consumer, key: e.args.key, version: g.version });
        }
      }
    }
    if (!before) { this.checkpoint = null; return; }
    // A fresh numbered child proves its parent's canonical hash without historical state.
    // When caught up, recheck the pending parent's height directly. Standalone readers
    // without that initial anchor resolve the current tip, then its ancestry if it advanced.
    let after: Hex | null = null;
    if (pinned) {
      const end = await this.pub.getBlock({ blockNumber: scanTo });
      if (end.number === scanTo) after = end.hash;
    } else {
      const tip = scanTo === block ? await this.pub.getBlock({ blockTag: 'latest' }) : null;
      if (tip?.number === scanTo) after = tip.hash;
      else if (!tip || (tip.number !== null && tip.number > scanTo)) {
        const child = await this.pub.getBlock({ blockNumber: scanTo + 1n });
        if (child.number === scanTo + 1n) after = child.parentHash;
      }
    }
    this.checkpoint = before === after ? { block: scanTo, hash: before, consumers: identities } : null;
  }

  private readRequest(block: bigint, now: bigint, id: string, r: Request): Promise<RequestState | null> {
    return this.guard(id, now, async () => {
      const args = [r.consumer, r.key];
      const source = sourceOf(r.version);
      const [requestedAt, round] = await this.call<readonly [bigint, bigint]>(block, source, drandSourceAbi, 'requestOf', args);
      if (requestedAt === 0n || round === 0n) { this.pending.delete(id); return null; }
      const [word, readyAt] = await this.call<readonly [Hex, bigint]>(block, source, drandSourceAbi, 'wordOf', args);
      const deadline = requestedAt + DRAND_SILENCE_SECONDS;
      const usable = word !== zeroHash && readyAt >= requestedAt && readyAt <= now && readyAt <= deadline;
      const sourceSilent = await this.call<boolean>(block, source, drandSourceAbi, 'isSilent', args);
      // The canonical snapshot can precede the deadline while the block we would send into is already late.
      const silent = sourceSilent || (!usable && now > deadline);
      if (!usable && now >= deadline - WARN_BEFORE) {
        this.warn(`silence:${id}:${silent}`, now, silent ? 'drand request silent' : 'drand request nearing silence',
          { consumer: r.consumer, key: r.key, round, deadline, secondsLeft: now < deadline ? deadline - now : 0n });
      }
      if (readyAt !== 0n) this.pending.delete(id);
      const state = { round, readyAt, usable, silent, requestedAt, deadline };
      this.observed.set(id, state);
      return state;
    });
  }

  /**
   * The last read's view for the monitor: every request state it read (the heads of blocked consumers included), and
   * whether it is complete. A read that threw stays incomplete.
   */
  observation(): DrandObservation { return this.last; }

  /** One canonical snapshot; due work is re-simulated against pending state before every send. */
  async read(block: bigint, now: bigint, snapshotHash?: Hex): Promise<Candidate[]> {
    this.failures = 0;
    this.readErrors = 0;
    this.observed = new Map();
    this.last = { complete: false, requests: [] };
    if (!this.cfg.box0 && !this.cfg.boxRegistry) {
      this.last = { complete: true, requests: [] };
      return [];
    }
    const discovered = await this.discover(block, now);
    const consumers: Consumer[] = [];
    const tickets: Ticket[] = [];
    const states = await readWindows(discovered, c => c.tickets ? this.guard(c.address, now, async () => {
        const [source, coordinator, status, phase] = await Promise.all([
          this.call<Address>(block, c.address, drandTicketsAbi, 'source'),
          this.call<Address>(block, c.address, drandTicketsAbi, 'coordinator'),
          this.call<Status>(block, c.address, drandTicketsAbi, 'status'),
          this.call<number>(block, c.address, drandTicketsAbi, 'phase'),
        ]);
        if (!same(source, sourceOf(c.version)) || !same(coordinator, c.coordinator)) throw new Error('ticket wiring mismatch');
        return { consumer: c, status, phase };
      }) : Promise.resolve(null));
    for (const [i, c] of discovered.entries()) {
      if (!c.tickets) { consumers.push(c); continue; }
      const ticket = states[i];
      if (ticket) { consumers.push(c); tickets.push(ticket); }
    }
    const consumersComplete = this.readErrors === 0;
    if (consumersComplete) await this.guard('Requested scan', now, () => this.scan(consumers, block, snapshotHash));
    const out: Candidate[] = [];
    const at = (job: Candidate['job'], to: Address, fn: string, args: readonly unknown[], version: 1 | 2, suffix = '', drandDeadline?: bigint) => {
      out.push({ job, to, fn, args, version, drandDeadline, key: `${job}:${to.toLowerCase()}${suffix}`, retryAfterBlocks: 2n });
    };
    const live = new Map(consumers.map(c => [c.address.toLowerCase(), c]));
    for (const t of tickets) if (t.status.terminalAt !== 0) live.delete(t.consumer.address.toLowerCase());
    // Head reads also recover work when an RPC log scan is temporarily unavailable, and after a restart.
    const requests = new Map<string, Request>();
    const readCounts = new Map<string, bigint>();
    const heads = new Map<string, RequestState | null>();
    const blocked = new Set<string>();
    for (const t of tickets) {
      const c = t.consumer, s = t.status;
      if (s.terminalAt !== 0) continue;
      if (t.phase === 2 && s.wordRequestedAt === 0) {
        const deadline = await this.guard(`assignment:${c.address}`, now, async () => {
          const vault = await this.call<Address>(block, c.address, drandTicketsAbi, 'vault');
          const end = c.version === 2 ? await this.call<bigint>(block, vault, drandVaultAbi, 'failureWindowEnds') : 0n;
          const at = end || await this.call<bigint>(block, vault, drandVaultAbi, 'gateOpenedAt');
          return at === 0n ? undefined : at + DRAND_UNREQUESTED_SECONDS;
        });
        at('drandRequestWord', c.address, 'requestGraduationWord', [], c.version, '', deadline ?? undefined);
      }
      const key = s.wordRequestedAt !== 0 && s.wordAcceptedAt === 0 ? 0n
        : s.drawsRequested > s.drawsSettled ? BigInt(s.drawsSettled) + 1n : null;
      if (key !== null) {
        const id = `${c.address.toLowerCase()}:${key}`;
        const request = { consumer: c.address, key, version: c.version };
        requests.set(id, request);
        const head = await this.readRequest(block, now, id, request);
        heads.set(id, head);
        readCounts.set(c.address.toLowerCase(), 1n);
        for (let next = key + 1n; next <= BigInt(s.drawsRequested) && next < key + DRAND_KEYS_PER_TICK; next++) {
          requests.set(`${c.address.toLowerCase()}:${next}`, { consumer: c.address, key: next, version: c.version });
        }
        // Both ticket versions stop at an unusable head, even before terminalAt is set. Resolve it before
        // collecting any rounds; a failed read also defers this consumer until the next canonical snapshot.
        if (!head || head.silent) blocked.add(c.address.toLowerCase());
      }
    }
    // Sequential state reads take priority; logs may fill unused capacity, never bypass the bound.
    for (const [id, request] of this.pending) if (!requests.has(id)) requests.set(id, request);
    const bounties = new Set<bigint>();
    const dueRounds = new Map<bigint, bigint>();
    // One backup read per round and tick, including the optional graduation top-up.
    type Backup = readonly [bigint, bigint, bigint, Hex];
    const backups = new Map<bigint, Promise<Backup>>();
    const backupOf = (round: bigint): Promise<Backup> => {
      let backup = backups.get(round);
      if (!backup) {
        backup = this.call<Backup>(block, RANDOMNESS_SOURCE, backedSourceAbi, 'backupOf', [round]);
        backups.set(round, backup);
      }
      return backup;
    };
    const backupRounds = new Map<bigint, { request: Request; deadline: bigint; roundTime: bigint; backup: Backup }>();
    for (const [id, r] of requests) {
      const c = live.get(r.consumer.toLowerCase());
      if (!c) { if (consumersComplete) this.pending.delete(id); continue; }
      if (blocked.has(r.consumer.toLowerCase())) continue;
      if (!heads.has(id) && c.tickets) {
        const count = readCounts.get(c.address.toLowerCase()) ?? 0n;
        if (count >= DRAND_KEYS_PER_TICK) continue;
        readCounts.set(c.address.toLowerCase(), count + 1n);
      }
      const state = heads.has(id) ? heads.get(id) : await this.readRequest(block, now, id, r);
      if (!state || state.silent) continue;
      await this.guard(id, now, async () => {
        const { round, readyAt, usable } = state;
        const target = this.cfg.graduationBountyWei ?? 0n;
        const ticket = tickets.find(t => same(t.consumer.address, r.consumer));
        if (target > 0n && c.version === 1 && c.tickets && r.key === 0n && ticket?.status.wordRequestedAt
          && ticket.status.wordAcceptedAt === 0 && readyAt === 0n && !bounties.has(round)) {
          bounties.add(round);
          // The round's pot is on the DrandSource (F143: box 0's backed source only forwards to it), where the round is
          // posted and the bounty paid; the reservation key (DrandSource:round) is the one the keeper used before F143.
          // Once the round's backup started, box 0 ignores a drand post for it: a top-up would only pay a post that can no
          // longer serve box 0 (F143; the security review's F7), so there is none.
          await this.guard(`bounty:${round}`, now, async () => {
            const pot = await this.call<bigint>(block, DRAND_SOURCE, drandSourceAbi, 'bountyOf', [round]);
            if (pot < target && (await backupOf(round))[0] === 0n) out.push({ job: 'drandGraduationBounty',
              key: `drandGraduationBounty:${DRAND_SOURCE.toLowerCase()}:${round}`,
              to: DRAND_SOURCE, fn: 'addBounty', args: [round], version: 1, value: target - pot, retryAfterBlocks: 2n });
          });
        }
        if (usable) {
          const t = tickets.find(t => same(t.consumer.address, r.consumer));
          if (t && r.key === 0n && t.status.wordAcceptedAt === 0) at('drandAcceptWord', c.address, 'acceptGraduationWord', [], c.version, '', state.deadline);
          else if (t && t.phase === 3 && r.key === BigInt(t.status.drawsSettled) + 1n && t.status.drawsSettled < t.status.drawsRequested) {
            at('drandSettle', c.address, 'settle', [SETTLE_COUNT], c.version, `:${r.key}`);
          }
        } else if (readyAt === 0n) {
          const roundTime = await this.call<bigint>(block, DRAND_SOURCE, drandSourceAbi, 'roundTime', [round]);
          if (roundTime > now) return;
          // A started round never posts for box 0; a v2 consumer may still need the same round.
          if (r.version === 1) {
            const backup = await backupOf(round);
            const [startedAt] = backup;
            if (c.tickets) {
              const previous = backupRounds.get(round);
              if (!previous || state.deadline < previous.deadline) {
                backupRounds.set(round, { request: r, deadline: state.deadline, roundTime, backup });
              }
            }
            if (startedAt !== 0n) {
              this.warn(`backup:${round}`, now, 'box 0 round on its backup', { consumer: r.consumer, key: r.key, round, startedAt });
              return;
            }
          }
          // R62: a shared round's post carries the earliest deadline among the requests it still serves (a box 0
          // request on its backup no longer counts).
          const previous = dueRounds.get(round);
          if (previous === undefined || state.deadline < previous) dueRounds.set(round, state.deadline);
        }
      });
    }
    // Finality is needed only for an unfixed backup, and read once even when the RPC cannot answer.
    let finalized: Promise<bigint | null> | undefined;
    for (const [round, { request: r, deadline, roundTime, backup }] of backupRounds) {
      const [startedAt, targetBlock, fixedAt] = backup;
      const fields = { consumer: r.consumer, key: r.key, round };
      if (startedAt === 0n) {
        const until = roundTime + BACKUP_LATEST_START_SECONDS;
        if (now + START_INCLUSION_SECONDS > until) {
          this.warn(`backup-late:${round}`, now, 'box 0 backup past its latest start', fields);
        } else if (roundTime + BACKUP_AFTER_SECONDS < now) {
          at('backupStart', RANDOMNESS_SOURCE, 'startBackup', [round], 1, `:${round}`, until);
        }
      } else if (fixedAt === 0n) {
        finalized ??= this.guard('backup finalized block', now, async () => {
          // A failed block read is never a contract's no-work answer, regardless of provider error text.
          const final = await this.pub.getBlock({ blockTag: 'finalized' }).catch(() => null);
          if (!final || final.number === null || final.hash === null) throw new Error('finalized block unavailable');
          return final.number;
        });
        const final = await finalized;
        if (block - targetBlock > HISTORY_WINDOW - BACKUP_RECENT_BLOCKS || now + START_INCLUSION_SECONDS > deadline) {
          this.warn(`backup-fix-late:${round}`, now, 'box 0 backup fix window closed', { ...fields, targetBlock });
        } else if (final !== null && targetBlock <= final && targetBlock <= block) {
          // The target travels as preparation input, replaced by its proven header before simulation.
          at('backupFix', RANDOMNESS_SOURCE, 'fixBackup', [round, targetBlock], 1, `:${round}`, deadline);
        }
      }
    }
    // Ascending rounds serve the oldest deadlines first. Each shared round is posted just once, on the DrandSource.
    for (const round of [...dueRounds.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
      at('drandPostRound', DRAND_SOURCE, 'postRound', [round], 1, `:${round}`, dueRounds.get(round));
    }
    const owed = await this.guard('keeper bounty', now, () => this.call<bigint>(block, DRAND_SOURCE, drandSourceAbi, 'owedTo', [this.keeper]));
    if (owed !== null && owed > 0n) at('drandWithdrawBounty', DRAND_SOURCE, 'withdrawBounty', [this.keeper], 1);
    // Complete: no guarded read failed and the Requested scan reached this block on one fork (no unfinished backfill).
    const scanned = consumers.length === 0 || this.checkpoint?.block === block;
    this.last = { complete: consumersComplete && this.failures === 0 && scanned && this.logFloor <= this.cfg.fromBlock, requests: [...this.observed.values()].map(r => ({
      requestedAt: r.requestedAt, deadline: r.deadline, usable: r.usable, silent: r.silent })) };
    return out;
  }
}
