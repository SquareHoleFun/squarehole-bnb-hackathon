import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../../packages/keeper/src/config.ts';
import { accepted, charge, decide, openBudget, reserve, settle } from '../../../../packages/keeper/src/decide.ts';
import { feesFor } from '../../../../packages/keeper/src/gas.ts';
import { buildMonitorView, encodeMonitorView, writeMonitorView } from '../../../../packages/keeper/src/monitor.ts';
import { StateStore, encodeState } from '../../../../packages/keeper/src/state.ts';
import { collect, keeperLock, readJson } from '../collect.mjs';
import { DEFAULTS, configure } from '../config.mjs';
import { summarize } from '../keeper-view.mjs';
import { evaluate } from '../policy.mjs';
import { fixture } from './drand-fixture.mjs';
import { IDENTITY, NOW, healthy, options } from './support.mjs';

// SH-RC8-KEEPER-DRAND request 6 and SH-RC8-MONITOR-DRAND request 8 (integrator, rc8 part 1): the monitor reads the
// keeper's R62 rescue counter and its lock refusal record, and its fee row tells a rescue from a pause.
const DAY = 86400n, HOUR = 3600n, GWEI = 1_000_000_000n, CAP = 50_000_000_000_000_000n;
const cfg = (over = {}) => configure({ ...options, ...over }, {});
const row = (o, id, c = cfg()) => evaluate(o, c, NOW).find(r => r.id === id);
const short = r => r.status === 'ok' ? 'ok' : r.reason;

/** Box 0 (v1) with draw key 3 requested so that its 7-day deadline is `left` seconds after NOW. */
function draw(left, k = {}) {
  const t = fixture().consumers[0];
  t.keys = [{ ...t.keys[0], requestedAt: String(NOW + left - 604800n), ...k }];
  return t;
}
/** Registry box 0 (v2) whose graduation word, key 0, was requested so that its deadline is `left` seconds away. */
function graduation(left, k = {}) {
  const t = fixture().consumers[1], at = String(NOW + left - 604800n);
  t.status.wordRequestedAt = at;
  t.keys = [{ ...t.keys[0], requestedAt: at, ...k }];
  return t;
}
/**
 * The same box with no request: its 30-day clock ends `left` seconds after NOW. With `failureWindowEnds` (v2's clock
 * when nonzero) the earlier gate opening alone would end within the hour, so a reader that used it would see a rescue.
 */
function unrequested(left, clock = 'gateOpenedAt') {
  const t = fixture().consumers[1];
  t.status.wordRequestedAt = '0'; t.keys = [];
  t[clock] = String(NOW + left - 2592000n);
  if (clock === 'failureWindowEnds') t.gateOpenedAt = String(NOW + HOUR - 2592000n);
  return t;
}
function inputs({ fee = 3_250_000_000n, consumers = [], spent, day = NOW / DAY } = {}) {
  const o = healthy({});
  o.view.maxFeePerGasWei = String(fee);
  o.drand = { consumers, timestamp: String(NOW - 900n), canary: { status: 'ok', reason: 'no-posted-word' } };
  o.keeper.state.budget.day = String(day);
  if (spent !== undefined) o.keeper.state.budget.drandRescueWei = typeof spent === 'bigint' ? String(spent) : spent;
  return o;
}

describe('keeper-fee under R62: a rescue is not a pause', () => {
  it('keeps the F111 pause above 3 gwei when no drand work is inside its last 72 hours', () => {
    expect(short(row(inputs({ fee: 3n * GWEI }), 'keeper-fee'))).toBe('ok');
    expect(row(inputs({ fee: 3n * GWEI + 1n }), 'keeper-fee')).toEqual({ id: 'keeper-fee', status: 'alert', reason: 'fee-pause' });
    expect(short(row(inputs({ consumers: [draw(4n * DAY)] }), 'keeper-fee'))).toBe('fee-pause');
  });

  it('reports the rescue, not a pause, while a post inside its last 72 hours may pay up to 50 gwei', () => {
    const r = row(inputs({ consumers: [draw(3n * DAY - 1n)], spent: 1_950_000_000_000_000n }), 'keeper-fee');
    expect(r).toMatchObject({ status: 'alert', reason: 'drand-rescue-fee', level: 'warn' });
    expect(r.detail).toBe('max fee 3.25 gwei above the 3 gwei pause: ordinary jobs wait; R62 lets the keeper post for box 0 '
      + 'tickets 0x0000000000000000000000000000000000000011 key 3 at up to 50 gwei, 2 d 23 h 59 min left (deadline '
      + `${new Date(Number(NOW + 3n * DAY - 1n) * 1000).toISOString().replace('.000Z', 'Z')}); rescue spend 0.00195 ETH of 0.05 ETH today`);
    expect(short(row(inputs({ fee: 50n * GWEI, consumers: [draw(HOUR)] }), 'keeper-fee'))).toBe('drand-rescue-fee');
    expect(short(row(inputs({ fee: 50n * GWEI + 1n, consumers: [draw(HOUR)] }), 'keeper-fee'))).toBe('fee-pause');
  });

  it('is strict at 72 hours, still pays at the deadline itself, and has nothing to post after it', () => {
    expect(short(row(inputs({ consumers: [draw(3n * DAY)] }), 'keeper-fee'))).toBe('fee-pause');
    expect(short(row(inputs({ consumers: [draw(0n)] }), 'keeper-fee'))).toBe('drand-rescue-fee');
    expect(short(row(inputs({ consumers: [draw(-1n)] }), 'keeper-fee'))).toBe('fee-pause');
  });

  it('finds no rescue in a finalizing or usable post, terminal mode, another source, a failed read or behind a silent head', () => {
    const word = { word: '1', readyAt: String(NOW - DAY) };
    const cases = [
      draw(HOUR, { latestWord: '1', latestReadyAt: String(NOW - 60n) }), draw(HOUR, word),
      Object.assign(draw(HOUR), { status: { ...draw(HOUR).status, terminalAt: String(NOW - DAY) } }),
      Object.assign(draw(HOUR), { source: '0x0000000000000000000000000000000000000099' }),
      Object.assign(draw(HOUR), { error: 'read-failed' }),
    ];
    for (const t of cases) expect(short(row(inputs({ consumers: [t] }), 'keeper-fee'))).toBe('fee-pause');
    const blocked = draw(-1n);
    blocked.status.drawsRequested = '4';
    blocked.keys.push({ ...blocked.keys[0], key: '4', requestedAt: String(NOW + HOUR - 604800n) });
    expect(short(row(inputs({ consumers: [blocked] }), 'keeper-fee'))).toBe('fee-pause');
    const o = inputs(); delete o.drand;
    expect(short(row(o, 'keeper-fee'))).toBe('fee-pause');
  });

  it('a timely graduation accept waits at ordinary fees; missing requests still count, including late ones', () => {
    const usable = left => graduation(left, { word: '1', readyAt: String(NOW + left - 604800n + 10n) });
    expect(short(row(inputs({ consumers: [usable(3n * DAY - 1n)] }), 'keeper-fee'))).toBe('fee-pause');
    expect(short(row(inputs({ consumers: [usable(-1n)] }), 'keeper-fee'))).toBe('fee-pause');
    expect(short(row(inputs({ consumers: [graduation(HOUR)] }), 'keeper-fee'))).toBe('drand-rescue-fee');
    expect(short(row(inputs({ consumers: [unrequested(3n * DAY)] }), 'keeper-fee'))).toBe('fee-pause');
    const late = row(inputs({ consumers: [unrequested(-1n)] }), 'keeper-fee');
    expect(late.reason).toBe('drand-rescue-fee');
    expect(late.detail).toContain('R62 lets the keeper request the word for registry box 0 tickets 0x0000000000000000000000000000000000000021 key 0');
    expect(short(row(inputs({ consumers: [unrequested(3n * DAY - 1n, 'failureWindowEnds')] }), 'keeper-fee'))).toBe('drand-rescue-fee');
    expect(short(row(inputs({ consumers: [unrequested(4n * DAY, 'failureWindowEnds')] }), 'keeper-fee'))).toBe('fee-pause');
  });

  it('needs room in today\'s rescue allowance, a fresh journal and the rule switched on', () => {
    const t = () => [draw(HOUR)];
    expect(short(row(inputs({ consumers: t(), spent: CAP - 1n }), 'keeper-fee'))).toBe('drand-rescue-fee');
    expect(short(row(inputs({ consumers: t(), spent: CAP }), 'keeper-fee'))).toBe('fee-pause');
    expect(short(row(inputs({ consumers: t(), spent: CAP, day: NOW / DAY - 1n }), 'keeper-fee'))).toBe('drand-rescue-fee');
    for (const over of [{ drandRescueWindowSeconds: '0' }, { drandRescueWeiPerDay: '0' }]) {
      expect(short(row(inputs({ consumers: t() }), 'keeper-fee', cfg(over)))).toBe('fee-pause');
    }
    const stale = inputs({ consumers: t() }); stale.keeper.modifiedAt = String(NOW - 301n);
    expect(short(row(stale, 'keeper-fee'))).toBe('fee-pause');
    const other = inputs({ consumers: t() }); other.keeper.identity = 'wrong';
    expect(short(row(other, 'keeper-fee'))).toBe('fee-pause');
    const view = inputs({ consumers: t() }); view.view.observedAt = String(NOW - 301n);
    expect(row(view, 'keeper-fee').status).toBe('unknown');
  });
});

describe('keeper-rescue-spend: R62\'s own daily counter', () => {
  it('is ok below half, ALERT at half, CRITICAL at 80%, and resets with the UTC day', () => {
    const at = (spent, day) => row(inputs({ spent, day }), 'keeper-rescue-spend');
    for (const spent of [undefined, 0n, CAP / 2n - 1n]) expect(short(at(spent))).toBe('ok');
    expect(at(CAP / 2n)).toEqual({ id: 'keeper-rescue-spend', status: 'alert', reason: 'drand-rescue-half-used', level: 'alert',
      detail: 'keeper drand rescue spend 0.025 ETH of 0.05 ETH today (R62, outside the ordinary daily ceilings)' });
    expect(short(at(CAP * 4n / 5n - 1n))).toBe('drand-rescue-half-used');
    expect(at(CAP * 4n / 5n)).toMatchObject({ reason: 'drand-rescue-mostly-used', level: 'critical' });
    expect(short(at(CAP))).toBe('drand-rescue-mostly-used');
    expect(short(at(CAP, NOW / DAY - 1n))).toBe('ok');
  });

  it('is unknown on a malformed field or journal, and stays outside ours, pokes and total', () => {
    expect(row(inputs({ spent: 1 }), 'keeper-rescue-spend').status).toBe('unknown');
    const stale = inputs({ spent: 0n }); stale.keeper.modifiedAt = String(NOW - 301n);
    expect(row(stale, 'keeper-rescue-spend').status).toBe('unknown');
    const o = inputs({ spent: CAP });
    expect(short(row(o, 'keeper-spend'))).toBe('ok');
    expect(short(row(o, 'keeper-reserve'))).toBe('ok');
  });

  it('with the rule off (cap 0) any recorded rescue spend means the keeper and monitor settings differ', () => {
    expect(short(row(inputs({ spent: 0n }), 'keeper-rescue-spend', cfg({ drandRescueWeiPerDay: '0' })))).toBe('ok');
    expect(short(row(inputs({ spent: 1n }), 'keeper-rescue-spend', cfg({ drandRescueWeiPerDay: '0' })))).toBe('drand-rescue-mostly-used');
  });

  it('mirrors the keeper\'s R62 defaults and refuses settings the keeper refuses', () => {
    const { limits } = loadConfig({ SH_KEEPER_RPC_URL: 'https://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' });
    expect([DEFAULTS.drandRescueMaxFeeWei, DEFAULTS.drandRescueWindowSeconds, DEFAULTS.drandRescueWeiPerDay])
      .toEqual([limits.drandRescueMaxFeeWei, limits.drandRescueWindowSeconds, limits.drandRescueWeiPerDay].map(String));
    expect([DEFAULTS.oursWeiPerDay, DEFAULTS.pokesWeiPerDay, DEFAULTS.totalWeiPerDay, DEFAULTS.reserveWeiPerDay, DEFAULTS.maxFeePerGasWei])
      .toEqual([limits.oursWeiPerDay, limits.pokesWeiPerDay, limits.totalWeiPerDay, limits.reserveWeiPerDay, limits.maxFeePerGas].map(String));
    for (const bad of [{ drandRescueMaxFeeWei: '0' }, { drandRescueMaxFeeWei: '2999999999' }, { drandRescueWindowSeconds: '-1' },
      { drandRescueWeiPerDay: '1e16' }, { drandRescueWeiPerDay: 1 }]) expect(() => cfg(bad)).toThrow();
    expect(cfg({ drandRescueWindowSeconds: '0', drandRescueWeiPerDay: '0' }).drandRescueWeiPerDay).toBe('0');
  });
});

describe('keeper-lock: the keeper\'s refusal record', () => {
  const record = (over = {}) => ({ record: { schema: 'squarehole.keeper-lock-refused.v1', at: String(NOW - 120n), lockStartedAt: String(NOW - DAY), modifiedAt: String(NOW - 120n), ...over } });
  const lock = keeperLock => { const o = inputs(); o.keeperLock = keeperLock; return row(o, 'keeper-lock'); };
  it('is healthy without a record and CRITICAL with one, naming both times or a pid-only lock', () => {
    expect(short(lock({ absent: true }))).toBe('ok');
    expect(lock(record())).toEqual({ id: 'keeper-lock', status: 'alert', reason: 'lock-refused', level: 'critical',
      detail: 'keeper start refused at 2026-10-13T11:58:00Z: a leftover state lock from 2026-10-12T12:00:00Z; '
        + 'see docs/ops/drand-poster.md, Leftover lock' });
    expect(lock(record({ lockStartedAt: null })).detail).toContain('a leftover pid-only state lock (start time unknown)');
  });
  it('is unknown when the record is unreadable or not exactly the v1 shape', () => {
    for (const bad of [undefined, {}, record({ schema: 'squarehole.keeper-lock-refused.v2' }), record({ at: 1 }),
      record({ lockStartedAt: 'yesterday' }), record({ host: 'droplet' })]) expect(lock(bad).status).toBe('unknown');
  });
  it('reads the record beside the configured journal: absent is healthy, other failures stay unknown', async () => {
    const c = cfg(), seen = [];
    const files = (fail) => ({ json: async path => {
      seen.push(path);
      if (path !== `${c.keeperFile}.lock-refused.json`) throw new Error('offline');
      throw Object.assign(new Error('FAKE_TEST_SECRET'), { code: fail });
    } });
    expect((await collect(c, {}, NOW, { request: async () => { throw new Error('offline'); }, files: files('ENOENT') })).keeperLock).toEqual({ absent: true });
    expect(seen).toContain('/var/lib/docker/volumes/squarehole_keeper_state/_data/keeper.json.lock-refused.json');
    expect((await collect(c, {}, NOW, { request: async () => { throw new Error('offline'); }, files: files('EACCES') })).keeperLock).toBeUndefined();
  });
  it('follows the merged keeper\'s real lock: a refused start alerts until a later start clears its record', async () => {
    await mkdir(resolve('.cache/tmp'), { recursive: true });
    const file = `${await mkdtemp(resolve('.cache/tmp/monitor-keeper-lock-'))}/keeper.json`;
    const first = new StateStore(file, IDENTITY);
    let refusal;
    try { new StateStore(file, IDENTITY); } catch (error) { refusal = error; }
    expect(refusal?.code).toBe('SH_KEEPER_LOCK_HELD');
    const refused = await keeperLock(`${file}.lock-refused.json`);
    const o = inputs(); o.keeperLock = refused;
    expect(evaluate(o, cfg({ keeperFile: file }), NOW).find(r => r.id === 'keeper-lock')).toMatchObject({ status: 'alert', reason: 'lock-refused' });
    first.close();
    new StateStore(file, IDENTITY).close();
    expect(await keeperLock(`${file}.lock-refused.json`)).toEqual({ absent: true });
  });
});

describe('keeper-fee and keeper-spend read the merged keeper\'s journal and view (SH-RC8-MONITOR-DRAND request 8)', () => {
  it('follows real admissions, reservations and settlement through the monitor\'s own file reader', async () => {
    const { limits } = loadConfig({ SH_KEEPER_RPC_URL: 'https://fake.invalid', SH_KEEPER_DESTINATION_FORK: 'osaka', SH_KEEPER_TRANSACTION_GAS_CAP: '16777216' });
    const sim = { ok: true, tipWei: null, estimate: 450_000n };
    const post = hours => ({ job: 'drandPostRound', key: `post:${hours}`, to: '0x0000000000000000000000000000000000000011', fn: 'postRound', args: [1n], version: 1, drandDeadline: NOW + hours * HOUR });
    let budget = openBudget(undefined, 2000n, NOW);
    const send = (fees, hours, hash) => {
      const d = decide('drandPostRound', sim, { candidate: post(hours), now: NOW, fees, budget, limits, privateEndpoint: false });
      expect(d.send).toBe(true);
      budget = accepted(reserve(charge(budget, 'drandPostRound', d), 'drandPostRound', d), hash);
      return d;
    };
    const ordinary = send(feesFor(475_000_000n, 50_000_000n), 100n, `0x${'a'.repeat(64)}`);
    const rescue = send(feesFor(1_600_000_000n, 50_000_000n), 71n, `0x${'b'.repeat(64)}`);
    expect([ordinary.counter, rescue.counter]).toEqual([undefined, 'drandRescue']);
    await mkdir(resolve('.cache/tmp'), { recursive: true });
    const dir = await mkdtemp(resolve('.cache/tmp/monitor-keeper-r62-'));
    const publish = async () => {
      await writeFile(`${dir}/keeper.json`, encodeState({ budget, drandLog: { 'rescue:50': budget.day } }, IDENTITY));
      await utimes(`${dir}/keeper.json`, Number(NOW), Number(NOW));
      writeMonitorView(`${dir}/monitor.json`, encodeMonitorView(buildMonitorView({
        chainId: 11155111, identity: IDENTITY, maxFeePerGas: feesFor(1_600_000_000n, 50_000_000n).maxFeePerGas, queue: {},
        readings: { complete: true, failedReads: 0, snapshot: { number: 2000n, timestamp: NOW - 12n }, drand: { complete: true, requests: [] } },
        income: { at: NOW, platformWei: 4000n, mined: {}, boxes: {} }, incomeSpend: [],
      })));
      const o = { ...inputs({ consumers: [draw(71n * HOUR)] }), keeper: await readJson(`${dir}/keeper.json`), view: await readJson(`${dir}/monitor.json`) };
      return { o, rows: Object.fromEntries(evaluate(o, cfg(), NOW).map(r => [r.id, short(r)])), text: summarize(o, cfg(), NOW).split('\n') };
    };
    let p = await publish();
    expect(p.o.keeper.state.budget).toMatchObject({ oursWei: String(ordinary.costWei), totalWei: String(ordinary.costWei), drandRescueWei: String(rescue.costWei) });
    expect([p.rows['keeper-fee'], p.rows['keeper-spend'], p.rows['keeper-reserve'], p.rows['keeper-rescue-spend']])
      .toEqual(['drand-rescue-fee', 'ok', 'ok', 'ok']);
    expect(p.text.filter(l => /^(fee|spend|rescue) /.test(l))).toEqual([
      'fee      alert   drand-rescue-fee; 3.25 gwei max fee (pause above 3 gwei; drand jobs inside their last 72 h up to 50 gwei)',
      'spend    ok      ours 0.0006 ETH of 0.102 ETH, pokes 0 ETH of 0.012 ETH, total 0.0006 ETH of 0.114 ETH today',
      'rescue   ok      drand rescue 0.00195 ETH of 0.05 ETH today']);
    // A final receipt settles the rescue reservation to what it paid, on its own counter only.
    budget = settle(budget, { [`0x${'b'.repeat(64)}`]: 400_000n * 3_250_000_000n });
    p = await publish();
    expect(p.o.keeper.state.budget).toMatchObject({ oursWei: String(ordinary.costWei), drandRescueWei: String(400_000n * 3_250_000_000n) });
    // One 50 gwei rescue post takes 60% of the day's 0.05 ETH: the monitor's ladder sees the keeper's counter.
    send(feesFor(24_975_000_000n, 50_000_000n), 2n, `0x${'c'.repeat(64)}`);
    p = await publish();
    expect(p.rows['keeper-rescue-spend']).toBe('drand-rescue-half-used');
    expect(p.text.find(l => l.startsWith('rescue '))).toBe('rescue   alert   drand-rescue-half-used; drand rescue 0.0313 ETH of 0.05 ETH today');
  });
});
