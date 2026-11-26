import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MONITOR_VIEW_MAX_BYTES, buildMonitorView, encodeMonitorView, publishMonitorView, writeMonitorView } from '../../../../packages/keeper/src/monitor.ts';
import { runTick } from '../../../../packages/keeper/src/run.ts';
import { options as keeperOptions, quiet } from '../../../../packages/keeper/test/support/v2.ts';
import { readJson } from '../collect.mjs';
import { configure } from '../config.mjs';
import { decimal, main, summarize } from '../keeper-view.mjs';
import { evaluate } from '../policy.mjs';
import { IDENTITY, NOW, healthy, options } from './support.mjs';

// The keeper's real publisher feeding the monitor's real reader and checks: no RPC, scratch files under .cache/tmp.
const cfg = () => configure(options, {});
const box = '0x0000000000000000000000000000000000000002';
const KEEPER = ['keeper-queue', 'keeper-fee', 'keeper-income', 'drand'];
function view(over = {}) {
  return buildMonitorView({
    chainId: 11155111, identity: IDENTITY, maxFeePerGas: 2_000_000_000n, queue: { 'collect:2:0xhook': 1990n },
    readings: { complete: true, failedReads: 0, snapshot: { number: 2000n, timestamp: NOW - 12n },
      drand: { complete: true, requests: [{ requestedAt: NOW - 100n, deadline: NOW - 100n + 604_800n, usable: false, silent: false }] } },
    income: { at: NOW, platformWei: 4000n, mined: {}, boxes: { [box]: { shareWei: 100n, tipsWei: 5n } } },
    incomeSpend: [{ box, at: NOW, costWei: 50n }],
    ...over,
  });
}
async function published(v) {
  await mkdir(resolve('.cache/tmp'), { recursive: true });
  const dir = await mkdtemp(resolve('.cache/tmp/monitor-keeper-view-'));
  writeMonitorView(`${dir}/monitor.json`, encodeMonitorView(v));
  return { dir, view: await readJson(`${dir}/monitor.json`) };
}
const checks = o => Object.fromEntries(evaluate(o, cfg(), NOW).filter(r => KEEPER.includes(r.id)).map(r => [r.id, r.status === 'ok' ? 'ok' : r.reason]));

describe('the keeper publisher meets the monitor\'s view contract', () => {
  it('passes every keeper check through the monitor\'s own file reader', async () => {
    const o = { ...healthy({}), view: (await published(view())).view };
    expect(checks(o)).toEqual({ 'keeper-queue': 'ok', 'keeper-fee': 'ok', 'keeper-income': 'ok', drand: 'ok' });
  });

  it('old readers accept both absent and populated SH-236 diagnostic fields', async () => {
    const old = view();
    delete old.deferrals; delete old.valuationFailures; delete old.deferralsComplete; delete old.deferralsOmitted;
    const current = view({ deferrals: [{ boxId: 5n, job: 'collect', code: 'BOX_INCOME_CAP' }],
      income: { at: NOW, platformWei: 4000n, mined: {}, boxes: { [box]: { shareWei: 100n, tipsWei: 5n } },
        valuationFailures: [{ boxId: 6n, code: 'PIN_INVALID' }] } });
    for (const candidate of [old, current]) {
      expect(checks({ ...healthy({}), view: (await published(candidate)).view })).toEqual({
        'keeper-queue': 'ok', 'keeper-fee': 'ok', 'keeper-income': 'ok', drand: 'ok',
      });
    }
  });

  it('keeps all four old checks readable after a shared drand NO_WORK deferral', async () => {
    const port = {
      read: async () => ({ block: { number: 2001n, timestamp: NOW, baseFeePerGas: 1n }, boxes: [], fitGraduated: false,
        drand: [{ job: 'drandPostRound', key: 'drandPostRound:round', to: box, fn: 'postRound', args: [123n],
          version: 1, retryAfterBlocks: 2n }],
        monitor: { complete: true, failedReads: 0, snapshot: { number: 2000n, timestamp: NOW - 12n },
          drand: { complete: true, requests: [] } } }),
      readIncome: async () => ({ at: NOW, platformWei: 0n, mined: {}, boxes: {} }),
      simulate: async () => ({ ok: false, tipWei: null, estimate: 0n }),
      send: async () => { throw new Error('no-work tick must not send'); },
    };
    const out = await runTick(port, {}, keeperOptions(), quiet);
    expect(out.report.skipped).toEqual([expect.objectContaining({ job: 'drandPostRound', code: 'NO_WORK', boxId: undefined })]);
    const { dir } = await published(view());
    expect(publishMonitorView(`${dir}/monitor.json`, 11155111, IDENTITY, out)).toBe(true);
    const current = await readJson(`${dir}/monitor.json`);
    expect(checks({ ...healthy({}), view: current })).toEqual({
      'keeper-queue': 'ok', 'keeper-fee': 'ok', 'keeper-income': 'ok', drand: 'ok',
    });
    expect(current).toMatchObject({ complete: true, deferralsComplete: false, deferralsOmitted: '1', deferrals: [] });
  });

  it.each(['invalid id', 'size truncation'])('isolates %s in diagnostics from the old readings and alerts', async kind => {
    const base = view({ queue: { a: 1700n }, maxFeePerGas: 3_000_000_001n,
      incomeSpend: [{ box, at: NOW, costWei: 106n }] });
    const candidate = view({ queue: { a: 1700n }, maxFeePerGas: 3_000_000_001n,
      incomeSpend: [{ box, at: NOW, costWei: 106n }],
      deferrals: kind === 'invalid id' ? [{ boxId: -1n, job: 'collect', code: 'OTHER' }]
        : Array.from({ length: 60_000 }, () => ({ boxId: 5n, job: 'collect', code: 'BOX_INCOME_CAP' })) });
    if (kind === 'size truncation') expect(Buffer.byteLength(JSON.stringify(candidate))).toBeGreaterThan(MONITOR_VIEW_MAX_BYTES);
    const current = (await published(candidate)).view;
    expect(current.complete).toBe(true);
    expect(current).toMatchObject({ deferralsComplete: false, deferralsOmitted: kind === 'invalid id' ? '1' : '60000',
      deferrals: [], valuationFailures: [] });
    for (const field of ['schema', 'chainId', 'identity', 'observedAt', 'block', 'complete', 'failedReads',
      'maxFeePerGasWei', 'queue', 'income', 'drand']) expect(current[field]).toEqual(base[field]);
    expect(checks({ ...healthy({}), view: current })).toEqual({
      'keeper-queue': 'queue-backlog', 'keeper-fee': 'fee-pause',
      'keeper-income': 'income-cap-or-unattributed-liability', drand: 'ok',
    });
  });

  it('M2 preserves all old readings at the 43235-box size boundary by omitting diagnostic keys', async () => {
    const boxes = Object.fromEntries(Array.from({ length: 43235 }, (_, i) =>
      [`0x${BigInt(i + 1).toString(16).padStart(40, '0')}`, { shareWei: 0n, tipsWei: 0n }]));
    const candidate = view({ queue: {}, income: { at: NOW, platformWei: 0n, mined: {}, boxes }, incomeSpend: [] });
    const legacy = Object.fromEntries(Object.entries(candidate).filter(([key]) =>
      !['deferrals', 'valuationFailures', 'deferralsComplete', 'deferralsOmitted'].includes(key)));
    expect(Buffer.byteLength(JSON.stringify(candidate) + '\n')).toBeGreaterThan(MONITOR_VIEW_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(legacy) + '\n')).toBeLessThanOrEqual(MONITOR_VIEW_MAX_BYTES);
    const current = (await published(candidate)).view;
    const publishedFields = Object.fromEntries(Object.entries(current).filter(([key]) => key !== 'modifiedAt'));
    expect(publishedFields).toEqual(legacy);
    expect(checks({ ...healthy({}), view: current })).toEqual({
      'keeper-queue': 'ok', 'keeper-fee': 'ok', 'keeper-income': 'ok', drand: 'ok',
    });
  });

  it('raises each keeper alert from the published numbers', async () => {
    const alerts = await Promise.all([
      view({ queue: { a: 1700n } }), view({ maxFeePerGas: 3_000_000_001n }),
      view({ incomeSpend: [{ box, at: NOW, costWei: 106n }] }),
      view({ incomeSpend: [{ box: '0x0000000000000000000000000000000000000000', at: NOW, costWei: 1n }] }),
      view({ readings: { complete: true, failedReads: 0, snapshot: { number: 2000n, timestamp: NOW },
        drand: { complete: true, requests: [{ requestedAt: NOW - 604_800n + 3600n, deadline: NOW + 3600n, usable: false, silent: false }] } } }),
    ].map(async v => checks({ ...healthy({}), view: (await published(v)).view })));
    expect(alerts.map(a => Object.entries(a).filter(([, s]) => s !== 'ok'))).toEqual([
      [['keeper-queue', 'queue-backlog']], [['keeper-fee', 'fee-pause']],
      [['keeper-income', 'income-cap-or-unattributed-liability']], [['keeper-income', 'income-cap-or-unattributed-liability']],
      [['drand', 'nearing-silence']],
    ]);
  });

  it('turns an incomplete, stale or other-identity view into unknown, never healthy', async () => {
    const incomplete = view({ income: null });
    const stale = view({ readings: { complete: true, failedReads: 0, snapshot: { number: 2000n, timestamp: NOW - 301n }, drand: { complete: true, requests: [] } } });
    const other = view({ identity: '11155111:0x0000000000000000000000000000000000000009::' });
    for (const v of [incomplete, stale, other]) {
      const o = { ...healthy({}), view: (await published(v)).view };
      expect(evaluate(o, cfg(), NOW).filter(r => KEEPER.includes(r.id)).every(r => r.status === 'unknown')).toBe(true);
    }
  });
});

describe('the operator\'s keeper view', () => {
  it('formats raw wei with bigint only', () => {
    expect(decimal(102_000_000_000_000_000n, 18, 6)).toBe('0.102');
    expect(decimal(2_150_000_000n, 9, 3)).toBe('2.15');
    expect(decimal(3n, 18, 6)).toBe('0');
  });

  it('prints one line per keeper check from the files alone and exits 0 only when all pass', async () => {
    const { dir } = await published(view());
    const keeper = { version: 1, identity: IDENTITY, state: { budget: { day: String(NOW / 86400n), oursWei: '10200000000000000', pokesWei: '0', totalWei: '10200000000000000' } } };
    await writeFile(`${dir}/keeper.json`, JSON.stringify(keeper));
    // The journal's freshness is its file time; pin it to the fixture clock.
    await utimes(`${dir}/keeper.json`, Number(NOW), Number(NOW));
    const config = `${dir}/monitor-config.json`;
    await writeFile(config, JSON.stringify({ ...options, keeperFile: `${dir}/keeper.json`, keeperViewFile: `${dir}/monitor.json` }));
    let out = '';
    expect(await main(['--config', config], {}, { now: NOW, write: s => { out += s; } })).toBe(0);
    expect(out).toBe([
      'keeper view block 2000, 12 s old, complete',
      'queue    ok      1 waiting, oldest 10 blocks',
      'fee      ok      2 gwei max fee (pause above 3 gwei; drand jobs inside their last 72 h up to 50 gwei)',
      'spend    ok      ours 0.0102 ETH of 0.102 ETH, pokes 0 ETH of 0.012 ETH, total 0.0102 ETH of 0.114 ETH today',
      'rescue   ok      drand rescue 0 ETH of 0.05 ETH today',
      'income   ok      1 boxes, platform 0 ETH, unattributed 0 ETH',
      'drand    ok      1 waiting for a word, next silent in 6 d 23 h',
      'lock     ok      no refused keeper start',
      'reserve  needs the RPC balance: see the monitor run', ''].join('\n'));
    out = '';
    expect(await main(['--config', config], {}, { now: NOW, write: s => { out += s; }, files: { json: async () => { throw new Error('missing'); } } })).toBe(1);
    expect(out.split('\n').slice(0, 2)).toEqual(['keeper view missing or unreadable', 'queue    unknown missing-stale-or-invalid-data; unreadable']);
    expect(await main(['--bad'], {}, { write: () => {} })).toBe(2);
  });

  it('summarizes alerts with their reason', () => {
    const o = { view: view({ maxFeePerGas: 4_000_000_000n }), keeper: healthy({}).keeper };
    expect(summarize({ ...o, view: { ...o.view, modifiedAt: String(NOW) } }, cfg(), NOW).split('\n')[2])
      .toBe('fee      alert   fee-pause; 4 gwei max fee (pause above 3 gwei; drand jobs inside their last 72 h up to 50 gwei)');
  });
});
