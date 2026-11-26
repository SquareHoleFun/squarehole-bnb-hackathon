import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configure } from '../config.mjs';
import { collect } from '../collect.mjs';
import { evaluate } from '../policy.mjs';
import { main, summarizeSet } from '../keeper-view.mjs';
import { dispatch } from '../delivery.mjs';
import * as drand from '../drand.mjs';
import { main as monitorMain } from '../main.mjs';
import { healthy, NOW, options } from './support.mjs';

const address = `0x${'22'.repeat(20)}`, registry = `0x${'33'.repeat(20)}`;
const identity = `11155111:${address}:${registry}:`;
const input = { ...options, keeperSetEnabled: true, keeperSetAddress: address, keeperSetIdentity: identity };
const config = () => configure(input, {});
function observation() {
  const old = healthy({});
  return { ...old, keeperSet: { ...structuredClone(old.keeper), identity }, keeperSetRpc: { ...old.rpc },
    keeperSetLock: { absent: true }, keeperSetView: { ...structuredClone(old.view), identity,
      schema: 'squarehole.monitor-keeper-set.v1', sets: [] } };
}
const checks = (o, c = config(), now = NOW) => evaluate(o, c, now).filter(r => r.id.startsWith('keeper-set-'));
const row = (o, id) => checks(o).find(r => r.id === `keeper-set-${id}`);

describe('independent set keeper monitoring', () => {
  it('the monitor configuration smoke reports the additional enabled checks', async () => {
    const write = vi.fn();
    expect(await monitorMain(['--dry-run'], {}, { readConfig: async () => input, write })).toBe(0);
    expect(write.mock.calls[0][0]).toContain('25 checks');
  });
  it('is off by default and leaves every existing check and alert unchanged', () => {
    const off = configure(options, {}), o = observation();
    expect(off.keeperSetEnabled).toBe(false);
    expect(checks(o, off)).toEqual([]);
    expect(evaluate(o, config(), NOW).filter(r => !r.id.startsWith('keeper-set-'))).toEqual(evaluate(o, off, NOW));
    expect(checks(o).map(r => [r.id, r.status])).toEqual(['health', 'spend', 'reserve', 'queue', 'fee', 'lock', 'filled']
      .map(k => [`keeper-set-${k}`, 'ok']));
    expect(summarizeSet({}, off, NOW)).toBe('keeper-set: disabled\n');
  });
  it('requires a separate signer, registry identity, files and independently valid allowance', () => {
    const c = config();
    expect(c.keeperSetFile).toContain('squarehole_keeper_set_state');
    for (const over of [{ keeperSetEnabled: '1' }, { keeperSetAddress: options.keeperAddress },
      { keeperSetIdentity: `11155111:${address}::` }, { keeperSetIdentity: `11155111:${address}:${registry}:${address}` },
      { keeperSetFile: c.keeperFile }, { keeperSetViewFile: c.keeperViewFile }, { keeperSetFile: c.keeperSetViewFile },
      { keeperSetReserveWeiPerDay: '115000000000000000' }, { keeperSetMaxFeePerGasWei: '3000000001' }]) {
      expect(() => configure({ ...input, ...over }, {})).toThrow('invalid monitor input');
    }
  });
  it('checks stale/missing/wrong-identity/incomplete views and journals without trusting the original instance', () => {
    for (const change of [o => { delete o.keeperSetView; }, o => { o.keeperSetView.identity = options.keeperIdentity; },
      o => { o.keeperSetView.complete = false; }, o => { o.keeperSetView.observedAt = String(NOW - 301n); },
      o => { o.keeperSet.modifiedAt = String(NOW - 301n); }, o => { o.keeperSet.identity = options.keeperIdentity; }]) {
      const o = observation(); change(o); expect(row(o, 'health').status).toBe('unknown');
    }
  });
  it('uses only the set budget, balance, queue, fee and lock; raw amounts stay exact', () => {
    const o = observation();
    Object.assign(o.keeperSet.state.budget, { oursWei: '900719925474099300000', totalWei: '900719925474099300000' });
    o.keeperSetRpc.balanceWei = '1';
    o.keeperSetView.queue = { count: '1', oldestBlock: '1600' };
    o.keeperSetView.maxFeePerGasWei = '3000000001';
    o.keeperSetLock = { record: { schema: 'squarehole.keeper-lock-refused.v1', at: String(NOW), lockStartedAt: null, modifiedAt: String(NOW) } };
    for (const id of ['spend', 'reserve', 'queue', 'fee', 'lock']) expect(row(o, id).status).toBe('alert');
    for (const id of ['spend', 'reserve', 'queue', 'fee', 'lock']) expect(evaluate(o, config(), NOW).find(r => r.id === `keeper-${id}`).status).toBe('ok');
    const c = configure({ ...input, keeperSetOursWeiPerDay: '200000000000000000', keeperSetTotalWeiPerDay: '212000000000000000' }, {});
    expect(c.oursWeiPerDay).toBe('102000000000000000');
    const reset = observation(); reset.keeperSet.state.budget.day = String(NOW / 86400n - 1n);
    reset.keeperSet.state.budget.totalWei = '900719925474099300000';
    expect(row(reset, 'spend').status).toBe('ok');
  });
  it('reports filled age, closedAt and escape remaining through the exact boundary, excluding finished sets', () => {
    const o = observation();
    const set = { id: '7', coordinator: address, closed: true, closedAt: String(NOW - 3599n), graduated: false, failed: false };
    o.keeperSetView.sets = [set];
    expect(row(o, 'filled')).toMatchObject({ status: 'alert', level: 'warn', reason: 'filled-ungraduated' });
    expect(row(o, 'filled').detail).toContain('closedAt');
    expect(summarizeSet(o, config(), NOW)).toContain('age 3599 s; remaining escape 601201 s');
    set.closedAt = String(NOW - 3600n);
    expect(row(o, 'filled')).toMatchObject({ status: 'alert', level: 'critical' });
    set.closedAt = String(NOW - 604800n);
    expect(row(o, 'filled')).toMatchObject({ status: 'alert', level: 'emergency', reason: 'escape-reached' });
    expect(row(o, 'filled').detail).toContain('remaining escape 0 s');
    for (const key of ['graduated', 'failed']) {
      set[key] = true; expect(row(o, 'filled').status).toBe('ok'); set[key] = false;
    }
    set.closedAt = String(NOW + 1n); expect(row(o, 'filled').status).toBe('unknown');
  });
  it('delivers one-hour escalation immediately, repeats hourly and identifies each waiting set', async () => {
    const o = observation(), c = config(), send = vi.fn(), state = { version: 1, channels: {} };
    o.keeperSetView.sets = [{ id: '7', coordinator: address, closed: true, closedAt: String(NOW - 3599n), graduated: false, failed: false }];
    await dispatch(checks(o), state, { mailer: send }, NOW, c, () => {});
    await dispatch(checks(o, c, NOW + 1n), state, { mailer: send }, NOW + 1n, c, () => {});
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][0]).toContain('CRITICAL');
    o.keeperSetView.observedAt = String(NOW + 3601n); o.keeperSet.modifiedAt = String(NOW + 3601n);
    o.keeperSetRpc.timestamp = String(NOW + 3601n);
    await dispatch(checks(o, c, NOW + 3601n), state, { mailer: send }, NOW + 3601n, c, () => {});
    expect(send).toHaveBeenCalledTimes(3);
    o.keeperSetView.observedAt = String(NOW);
    o.keeperSetView.sets.push({ ...o.keeperSetView.sets[0], id: '8', coordinator: registry });
    expect(checks(o).filter(r => r.id === 'keeper-set-filled').map(r => r.subject)).toEqual([address, registry]);
  });
  it('collects the set journal/view/lock and its own wallet; disabled mode reads none of them; errors stay redacted', async () => {
    const c = config(), reads = [];
    const files = Object.fromEntries(['json', 'journal', 'disk', 'memory', 'backup'].map(k => [k, vi.fn(async path => {
      reads.push(path); throw Object.assign(new Error('FAKE_SECRET'), { code: 'ENOENT' });
    })]));
    const request = vi.fn(async (_url, init) => {
      const call = JSON.parse(init.body);
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: call.id, result: {
        eth_chainId: '0xaa36a7', eth_getBlockByNumber: { number: '0x10', timestamp: '0x1' }, eth_getBalance: '0x123',
      }[call.method] }) };
    });
    const o = await collect(c, { SH_MONITOR_RPC_URL: 'https://offline.invalid' }, NOW, { files, request });
    expect(reads).toEqual(expect.arrayContaining([c.keeperSetFile, c.keeperSetViewFile, `${c.keeperSetFile}.lock-refused.json`]));
    expect(o.keeperSetRpc.balanceWei).toBe('291');
    expect(o.keeperSetLock).toEqual({ absent: true });
    expect(JSON.stringify(o)).not.toContain('FAKE_SECRET');
    expect(request.mock.calls.some(([, init]) => init.body?.includes(address))).toBe(true);
    reads.length = 0; request.mockClear();
    await collect(configure(options, {}), { SH_MONITOR_RPC_URL: 'https://offline.invalid' }, NOW, { files, request });
    expect(reads).not.toContain(c.keeperSetFile);
    expect(request.mock.calls.some(([, init]) => init.body?.includes(address))).toBe(false);
  });
  it('the --set operator command reads only the selected files, refuses stale data and reports disabled without I/O', async () => {
    await mkdir('.cache/tmp', { recursive: true });
    const dir = await mkdtemp(resolve('.cache/tmp/set-view-')), path = `${dir}/config.json`;
    await writeFile(path, JSON.stringify(input));
    const c = config(), o = observation(), read = vi.fn(async path => {
      if (path === c.keeperSetFile) return o.keeperSet;
      if (path === c.keeperSetViewFile) return o.keeperSetView;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    const write = vi.fn();
    expect(await main(['--set', '--config', path], {}, { now: NOW, files: { json: read }, write })).toBe(0);
    expect(read.mock.calls.map(([p]) => p)).toEqual([c.keeperSetViewFile, c.keeperSetFile, `${c.keeperSetFile}.lock-refused.json`]);
    o.keeperSetView.observedAt = String(NOW - 301n);
    expect(await main(['--set', '--config', path], {}, { now: NOW, files: { json: read }, write })).toBe(1);
    await writeFile(path, JSON.stringify(options)); read.mockClear(); write.mockClear();
    expect(await main(['--set', '--config', path], {}, { now: NOW, files: { json: read }, write })).toBe(0);
    expect(read).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledWith('keeper-set: disabled\n');
  });
  it('a slow set read cannot consume the existing drand collector time window', async () => {
    const c = config(); let release;
    const gate = new Promise(resolve => { release = resolve; });
    const files = Object.fromEntries(['json', 'journal', 'disk', 'memory', 'backup'].map(k => [k, async path => {
      if (path === c.keeperSetFile) await gate;
      throw new Error('offline');
    }]));
    const request = async (_url, init) => {
      const call = JSON.parse(init.body);
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: call.id, result: {
        eth_chainId: '0xaa36a7', eth_getBlockByNumber: { number: '0x10', timestamp: '0x1' }, eth_getBalance: '0x123',
      }[call.method] }) };
    };
    const oldDrand = vi.spyOn(drand, 'readDrand').mockResolvedValue({ consumers: [] });
    const collected = collect(c, { SH_MONITOR_RPC_URL: 'https://offline.invalid' }, NOW, { files, request });
    try { await vi.waitFor(() => expect(oldDrand).toHaveBeenCalled(), { timeout: 200 }); }
    finally { release(); await collected; oldDrand.mockRestore(); }
  });
});
