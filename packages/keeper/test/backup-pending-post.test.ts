import { describe, expect, it, vi } from 'vitest';
import { DRAND_SOURCE, RANDOMNESS_SOURCE } from '../../box-spec/src/generated/box-spec.v1';
import { runTick, type ChainPort, type KeeperState } from '../src/run';
import { decodeState, encodeState } from '../src/state';
import type { Candidate } from '../src/types';
import { options, quiet, time } from './support/v2';

const round = 123n;
const post: Candidate = { job: 'drandPostRound', key: `drandPostRound:${DRAND_SOURCE.toLowerCase()}:${round}`,
  to: DRAND_SOURCE, fn: 'postRound', args: [round], version: 1, retryAfterBlocks: 2n };
const start: Candidate = { job: 'backupStart', key: `backupStart:${RANDOMNESS_SOURCE.toLowerCase()}:${round}`,
  to: RANDOMNESS_SOURCE, fn: 'startBackup', args: [round], version: 1, retryAfterBlocks: 2n };

function fixture() {
  let number = 100n;
  const prepare = vi.fn(async (c: Candidate) => c);
  const simulate = vi.fn(async () => ({ ok: true, tipWei: null, estimate: 100000n }));
  const send = vi.fn(async () => 'hash');
  const port: ChainPort = { read: async () => ({ block: { number, timestamp: time + (number - 100n) * 12n, baseFeePerGas: 1n },
    boxes: [], fitGraduated: false, drand: number === 100n ? [post] : [start],
    monitor: { complete: true, failedReads: 0, snapshot: { number: number - 1n, timestamp: time }, drand: { complete: true, requests: [] } },
  }), prepare, simulate, send };
  const cfg = { ...options(), dryRun: false };
  const log = { ...quiet, info: vi.fn(), warn: vi.fn() };
  return { port, prepare, simulate, send, cfg, log, at: (n: bigint) => { number = n; } };
}

describe('a backup start waits for our sent post only through its retry backoff', () => {
  it('skips at N+1 before simulation or reservation, preserves the queue, and sends at N+2', async () => {
    const f = fixture();
    const first = await runTick(f.port, {}, f.cfg, f.log);
    expect(first.report.sent.map(c => c.job)).toEqual(['drandPostRound']);
    f.at(101n);
    const waiting = await runTick(f.port, { ...first.state, monitorQueue: { [start.key]: 90n } }, f.cfg, f.log);
    expect(waiting.report.skipped).toContainEqual({ boxId: undefined, job: 'backupStart', key: start.key, why: 'round post pending', code: 'SLOT_TAKEN' });
    expect(waiting.report.sent).toEqual([]);
    expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.simulate).toHaveBeenCalledTimes(1); expect(f.send).toHaveBeenCalledTimes(1);
    expect(waiting.state.budget?.totalWei).toBe(first.state.budget?.totalWei);
    expect(waiting.state.budget?.pending).toEqual(first.state.budget?.pending);
    expect(waiting.state.mem?.attempts[start.key]).toBeUndefined();
    expect(waiting.state.monitorQueue).toEqual({ [start.key]: 90n });
    expect(f.log.info).toHaveBeenCalledWith('skipped', expect.objectContaining({ code: 'SLOT_TAKEN' }));
    expect(f.log.warn).not.toHaveBeenCalledWith('skipped', expect.objectContaining({ code: 'SLOT_TAKEN' }));
    f.at(102n);
    const next = await runTick(f.port, waiting.state, f.cfg, f.log);
    expect(next.report.sent.map(c => c.job)).toEqual(['backupStart']);
    expect(next.state.monitorQueue).toEqual({});
  });

  it.each(['relay failure', 'send error', 'no work', 'simulation error', 'fee wait', 'budget wait', 'dry run', 'another account'] as const)('%s never delays the next start', async kind => {
    const f = fixture();
    if (kind === 'relay failure') f.prepare.mockRejectedValueOnce(new Error('offline relay failure'));
    if (kind === 'send error') f.send.mockRejectedValueOnce(new Error('offline send failure'));
    if (kind === 'no work') f.simulate.mockResolvedValueOnce({ ok: false, tipWei: null, estimate: 0n });
    if (kind === 'simulation error') f.simulate.mockRejectedValueOnce(new Error('offline simulation failure'));
    const read = f.port.read;
    if (kind === 'fee wait') f.port.read = async () => { const w = await read(); return { ...w, block: { ...w.block, baseFeePerGas: 1600000000n } }; };
    if (kind === 'another account') f.port.read = async () => ({ ...await read(), drand: [] });
    const cfg = { ...f.cfg, dryRun: kind === 'dry run', limits: kind === 'budget wait' ? { ...f.cfg.limits, oursWeiPerDay: 0n } : f.cfg.limits };
    const first = await runTick(f.port, {}, cfg, f.log);
    f.at(101n); f.port.read = read;
    const next = await runTick(f.port, first.state, f.cfg, f.log);
    expect(next.report.sent.map(c => c.job)).toEqual(['backupStart']);
  });

  it.each(['restart', 'another round'] as const)('%s does not inherit the wait', async kind => {
    const f = fixture();
    const first = await runTick(f.port, {}, f.cfg, f.log);
    f.at(101n);
    let port = f.port;
    let state: KeeperState = first.state;
    if (kind === 'restart') {
      port = { ...f.port };
      state = decodeState(encodeState(first.state, 'test'), 'test');
    } else {
      const read = f.port.read;
      f.port.read = async () => ({ ...await read(), drand: [{ ...start, key: start.key + '4', args: [round + 1n] }] });
    }
    const next = await runTick(port, state, f.cfg, f.log);
    expect(next.report.sent.map(c => c.job)).toEqual(['backupStart']);
  });
});
