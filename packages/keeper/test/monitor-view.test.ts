import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MONITOR_VIEW_MAX_BYTES, buildMonitorView, encodeMonitorView, publishMonitorView, trackQueue,
  type MonitorReadings, type QueueTick, type WorkStatus,
} from '../src/monitor';
import { UNKNOWN_INCOME_BOX } from '../src/income';
import { runTick, type ChainPort, type KeeperState } from '../src/run';
import { decodeState, encodeState } from '../src/state';
import type { Candidate, Sim } from '../src/types';
import type { World } from '../src/world';
import { addr, box, options, quiet, time, world } from './support/v2';

// Offline: no RPC, only fake ports and scratch files under .cache.
const scratch = resolve(import.meta.dirname, '../../../.cache/keeper-monitor-view');
const readings = (over: Partial<MonitorReadings> = {}): MonitorReadings => ({
  complete: true, failedReads: 0, snapshot: { number: 99n, timestamp: time - 12n }, drand: { complete: true, requests: [] }, ...over,
});
const tick = (outcomes: Record<string, WorkStatus>, over: Partial<QueueTick> = {}): QueueTick => ({
  at: 99n, pending: 100n, now: time, complete: true, outcomes: new Map(Object.entries(outcomes)), attempts: {}, ...over,
});

describe('the outstanding work queue (keeper-view.md queue.count / oldestBlock)', () => {
  it('adds waiting work at the snapshot block and keeps its first block while it waits', () => {
    const first = trackQueue(undefined, tick({ a: 'waiting', b: 'none', c: 'unknown' }));
    expect(first).toEqual({ a: 99n });
    expect(trackQueue(first, tick({ a: 'waiting' }, { at: 140n, pending: 141n }))).toEqual({ a: 99n });
  });

  it('removes work only when a simulation finds none, or when a complete read no longer proposes it out of backoff', () => {
    const q = { a: 10n, b: 11n, c: 12n, d: 13n };
    const next = trackQueue(q, tick({ a: 'none' }, { attempts: { b: { next: 101n }, c: { next: 100n, nextAt: time + 1n }, d: { next: 100n } } }));
    // b waits out its retry blocks, c its clock-hour turn; d is due and was not proposed: done.
    expect(next).toEqual({ b: 11n, c: 12n });
    expect(trackQueue(q, tick({}, { complete: false }))).toEqual(q);
  });

  it('keeps the earlier state of work skipped before simulating (fee pause, rate limit, taken slot)', () => {
    expect(trackQueue({ a: 5n }, tick({ a: 'unknown', b: 'unknown' }))).toEqual({ a: 5n });
  });

  it('drops sent work, even inside its retry backoff, and rewinds entries above the snapshot after a reorg', () => {
    // Served work is not backlog: a send's backoff (an hour for inbox orders) must not age into a queue alert.
    expect(trackQueue({ a: 5n }, tick({ a: 'sent', b: 'sent' }))).toEqual({});
    expect(trackQueue({}, tick({}, { at: 400n, pending: 401n, attempts: { a: { next: 402n, nextAt: time + 3_599n } } }))).toEqual({});
    // Work still there after the send is waiting again from the block a simulation finds it deferred.
    expect(trackQueue({}, tick({ a: 'waiting' }, { at: 120n, pending: 121n }))).toEqual({ a: 120n });
    expect(trackQueue({ a: 120n, b: 130n }, tick({ a: 'waiting' }, { complete: false }))).toEqual({ a: 99n, b: 99n });
  });
});

describe('the published view', () => {
  const income = {
    at: time, platformWei: 4000n, mined: {},
    boxes: { [addr(3)]: { shareWei: 100n, tipsWei: 7n }, [addr(4)]: { shareWei: 50n, tipsWei: 0n } },
  };
  const spend = [{ box: addr(3), at: time, costWei: 20n }, { box: addr(5), at: time, costWei: 9n },
    { box: UNKNOWN_INCOME_BOX, at: time, costWei: 3n }, { box: addr(3), at: time, costWei: 1n }];

  it('reports every amount as a decimal string, the union of credited and spending boxes, and the queue', () => {
    const view = buildMonitorView({ chainId: 11155111, identity: 'id', readings: readings(), maxFeePerGas: 2_100_000_000n,
      queue: { a: 90n, b: 95n }, income, incomeSpend: spend });
    expect(view).toEqual({
      deferralsComplete: true, deferralsOmitted: '0', deferrals: [], valuationFailures: [],
      schema: 'squarehole.monitor-keeper.v1', chainId: '11155111', identity: 'id', observedAt: String(time - 12n), block: '99',
      complete: true, failedReads: '0', maxFeePerGasWei: '2100000000', queue: { count: '2', oldestBlock: '90' },
      income: { platformWei: '4000', unattributedWei: '3', boxes: [
        { box: addr(3), shareWei: '100', tipsWei: '7', spentWei: '21' },
        { box: addr(4), shareWei: '50', tipsWei: '0', spentWei: '0' },
        { box: addr(5), shareWei: '0', tipsWei: '0', spentWei: '9' },
      ] },
      drand: { complete: true, requests: [] },
    });
  });

  it('adds latest-tick reasons, clears recovery, and bounds the new fields without changing old fields', () => {
    const base = { chainId: 11155111, identity: 'id', readings: readings(), maxFeePerGas: 1n, queue: {}, income, incomeSpend: spend };
    const deferred = { boxId: 5n, job: 'collect', code: 'BOX_INCOME_CAP' as const };
    const view = buildMonitorView({ ...base, deferrals: [deferred], income: { ...income,
      valuationFailures: [{ boxId: 6n, code: 'PIN_INVALID' }] } });
    const stamp = { observedAt: String(time - 12n), block: '99' };
    expect(view?.deferrals).toEqual([{ boxId: '5', job: 'collect', code: 'BOX_INCOME_CAP', ...stamp }]);
    expect(view?.valuationFailures).toEqual([{ boxId: '6', code: 'PIN_INVALID', ...stamp }]);
    expect(buildMonitorView(base)).toMatchObject({ deferralsComplete: true, deferralsOmitted: '0', deferrals: [], valuationFailures: [] });
    const many = buildMonitorView({ ...base, deferrals: Array.from({ length: 60_000 }, () => deferred),
      income: { ...income, valuationFailures: Array.from({ length: 60_000 }, () => ({ boxId: 6n, code: 'PIN_INVALID' as const })) } });
    if (!many) throw new Error('view missing');
    expect(Buffer.byteLength(JSON.stringify(many))).toBeGreaterThan(MONITOR_VIEW_MAX_BYTES);
    const body = encodeMonitorView(many);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MONITOR_VIEW_MAX_BYTES);
    expect(JSON.parse(body)).toEqual({ ...buildMonitorView(base), deferralsComplete: false, deferralsOmitted: '120000' });
    expect(buildMonitorView({ ...base, deferrals: [{ job: 'collect', code: 'OTHER' }],
      income: { ...income, valuationFailures: [{ boxId: -1n, code: 'PIN_INVALID' }] } }))
      .toEqual({ ...buildMonitorView(base), deferralsComplete: false, deferralsOmitted: '2' });
  });

  it('M2 omits the diagnostic keys themselves when the old view alone fits', () => {
    const boxes = Object.fromEntries(Array.from({ length: 43_235 }, (_, i) => [addr(i + 1), { shareWei: 0n, tipsWei: 0n }]));
    const current = buildMonitorView({ chainId: 11155111, identity: 'id', readings: readings(), maxFeePerGas: 1n,
      queue: {}, income: { ...income, boxes }, incomeSpend: [] });
    if (!current) throw new Error('view missing');
    const old = Object.fromEntries(Object.entries(current).filter(([key]) =>
      !['deferrals', 'valuationFailures', 'deferralsComplete', 'deferralsOmitted'].includes(key)));
    // Pad only the identity to put this fixture exactly at the old publisher's byte bound.
    const room = MONITOR_VIEW_MAX_BYTES - Buffer.byteLength(JSON.stringify(old) + '\n');
    const padded = { ...current, identity: current.identity + 'x'.repeat(room) };
    expect(JSON.parse(encodeMonitorView(padded))).toEqual({ ...old, identity: padded.identity });
    expect(Buffer.byteLength(encodeMonitorView(padded))).toBe(MONITOR_VIEW_MAX_BYTES);
  });

  it('is incomplete without income, has a null oldest block when empty, and is withheld without a snapshot header', () => {
    const base = { chainId: 1, identity: 'id', maxFeePerGas: 1n, queue: {}, income: null, incomeSpend: [] };
    const view = buildMonitorView({ ...base, readings: readings() });
    expect(view).toMatchObject({ complete: false, queue: { count: '0', oldestBlock: null }, income: { platformWei: '0', boxes: [] } });
    expect(buildMonitorView({ ...base, readings: readings({ complete: false, failedReads: 2 }) })).toMatchObject({ complete: false, failedReads: '2' });
    expect(buildMonitorView({ ...base, readings: readings({ snapshot: null }) })).toBeNull();
  });

  it('writes one private file atomically and never exceeds the monitor\'s size limit', () => {
    mkdirSync(scratch, { recursive: true });
    const dir = mkdtempSync(`${scratch}/publish-`);
    const file = `${dir}/monitor.json`;
    const out = { state: { monitorQueue: { a: 98n } }, observed: { readings: readings(), maxFeePerGas: 5n, income, incomeSpend: spend } };
    expect(publishMonitorView(file, 11155111, 'id', out)).toBe(true);
    expect(readdirSync(dir)).toEqual(['monitor.json']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ block: '99', queue: { count: '1', oldestBlock: '98' } });
    expect(publishMonitorView(file, 11155111, 'id', { state: {} })).toBe(false);
    // A failed replace (here the target is a non-empty directory) throws and leaves no stray pending file.
    const blocked = mkdtempSync(`${scratch}/blocked-`);
    mkdirSync(`${blocked}/monitor.json/keep`, { recursive: true });
    expect(() => publishMonitorView(`${blocked}/monitor.json`, 11155111, 'id', out)).toThrow();
    expect(readdirSync(blocked)).toEqual(['monitor.json']);
    expect(publishMonitorView(file, 11155111, 'id', { state: {}, observed: { ...out.observed, readings: undefined } })).toBe(false);
    const many = Array.from({ length: 60_000 }, (_, i) => ({ requestedAt: BigInt(i + 1), deadline: BigInt(i + 604_801), usable: false, silent: false }));
    const big = buildMonitorView({ chainId: 1, identity: 'id', readings: readings({ drand: { complete: true, requests: many } }),
      maxFeePerGas: 1n, queue: {}, income, incomeSpend: spend });
    if (!big) throw new Error('view expected');
    const body = encodeMonitorView(big);
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(MONITOR_VIEW_MAX_BYTES);
    expect(Buffer.byteLength(body)).toBeLessThan(MONITOR_VIEW_MAX_BYTES);
    expect(JSON.parse(body)).toMatchObject({ complete: false, drand: { complete: false, requests: [] }, income: { boxes: [] } });
  });
});

describe('runTick tracks the queue durably when the adapter supplies monitor readings', () => {
  // One graduated v2 box. Only buyBack finds work; the box has no income, so F111 defers it (keeper.md).
  const b = box();
  const buyBack = `buyBack:2:${b.hook.toLowerCase()}`;
  function fixture(w: (n: bigint) => World, funded: () => boolean) {
    const saved: KeeperState[] = [];
    const port: ChainPort = {
      read: async () => current,
      readIncome: async () => ({ at: current.block.timestamp, mined: {}, platformWei: funded() ? 10n ** 30n : 0n,
        boxes: funded() ? { [b.receiver.toLowerCase()]: { shareWei: 10n ** 30n, tipsWei: 0n } } : {} }),
      simulate: async (c: Candidate): Promise<Sim> => c.job === 'buyBack' ? { ok: true, tipWei: null, estimate: 300_000n } : { ok: false, tipWei: null, estimate: 0n },
      send: async () => `0x${'ab'.repeat(32)}`,
    };
    let current = w(100n);
    const cfg = { ...options(), checkpoint: async (s: KeeperState) => { saved.push(s); } };
    return { port, cfg, saved, at: (n: bigint) => { current = w(n); } };
  }
  const monitored = (n: bigint): World => ({ ...world(box(), n, time + (n - 100n) * 12n), monitor: readings({ snapshot: { number: n - 1n, timestamp: time } }) });

  it('records deferred work, keeps its age across a journal restart, and drops it when the work is sent', async () => {
    let funded = false;
    const f = fixture(monitored, () => funded);
    const first = await runTick(f.port, {}, f.cfg, quiet);
    expect(first.report.skipped.find(s => s.key === buyBack)).toMatchObject({ boxId: b.id, why: 'box income cap', code: 'BOX_INCOME_CAP' });
    expect(first.observed.deferrals).toEqual(first.report.skipped);
    expect(first.state.monitorQueue).toEqual({ [buyBack]: 99n });
    expect(first.observed).toMatchObject({ readings: { complete: true }, maxFeePerGas: 2n + options().priorityFeeWei });
    // The journal round trip a restart performs keeps the first-seen block.
    const restarted = decodeState(encodeState(first.state, 'id'), 'id');
    expect(restarted.monitorQueue).toEqual({ [buyBack]: 99n });
    f.at(101n);
    const second = await runTick(f.port, restarted, f.cfg, quiet);
    expect(second.state.monitorQueue).toEqual({ [buyBack]: 99n });
    funded = true;
    f.at(102n);
    f.saved.length = 0;
    const third = await runTick(f.port, second.state, f.cfg, quiet);
    expect(third.report.sent.map(s => s.key)).toContain(buyBack);
    expect(third.observed.deferrals?.some(s => s.job === 'buyBack')).toBe(false);
    expect(third.state.monitorQueue).toBeDefined();
    expect(third.state.monitorQueue).not.toHaveProperty(buyBack);
    // Reservation checkpoints before and after the send keep the previous queue; the tick end writes the new one.
    expect(f.saved.length).toBeGreaterThan(1);
    expect(f.saved.slice(0, -1).every(s => s.monitorQueue?.[buyBack] === 99n)).toBe(true);
    expect(f.saved.at(-1)?.monitorQueue).not.toHaveProperty(buyBack);
  });

  it('tracks nothing and adds nothing to the journal without monitor readings', async () => {
    const f = fixture(n => world(box(), n), () => false);
    const out = await runTick(f.port, {}, f.cfg, quiet);
    expect(out.state.monitorQueue).toBeUndefined();
    expect(out.observed.readings).toBeUndefined();
    expect(f.saved.every(s => !('monitorQueue' in s))).toBe(true);
  });
});
