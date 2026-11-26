import { expect, it, vi } from 'vitest';
import { configure } from '../config.mjs';
import { collect } from '../collect.mjs';
import { evaluate } from '../policy.mjs';
import { dispatch } from '../delivery.mjs';
import { main } from '../main.mjs';
import { NOW, options } from './support.mjs';

const cfg = () => configure({ ...options, alphaSenderEnabled: true }, {});
const view = (patch = {}) => ({ v: 1, service: 'alpha-sender', mode: 'live', at: Number(NOW * 1000n),
  modifiedAt: String(NOW), floatWei: '249999999999999999', lowFloatThresholdWei: '250000000000000000',
  lowFloat: true, waitingClaims: 3, ...patch });
const checks = (v, now = NOW) => evaluate({ alphaSender: v }, cfg(), now).filter(r => r.id === 'alpha-sender-float');

it('includes the alpha check in the offline configuration smoke count', async () => {
  const write = vi.fn();
  expect(await main(['--dry-run'], {}, { readConfig: async () => ({ ...options, alphaSenderEnabled: true }), write })).toBe(0);
  expect(write.mock.calls[0][0]).toContain('19 checks');
});

it('collects the sender monitor only when enabled and isolates missing or unreadable files', async () => {
  const c = cfg(), json = vi.fn(async path => { if (path === c.alphaSenderFile) return view(); throw new Error('private'); });
  const fail = async () => { throw new Error('private'); };
  const ports = { request: fail, files: { json, journal: fail, disk: fail, memory: fail, backup: fail } };
  expect((await collect(c, {}, NOW, ports)).alphaSender).toEqual(view());
  json.mockClear(); expect((await collect(configure(options, {}), {}, NOW, ports)).alphaSender).toBeUndefined();
  expect(json.mock.calls.flat()).not.toContain(c.alphaSenderFile);
  json.mockImplementation(fail);
  expect((await collect(c, {}, NOW, ports)).alphaSender).toBeUndefined();
  expect(checks(undefined)[0].status).toBe('unknown');
});

it('alerts with the waiting count, compares wei exactly, and uses existing mail deduplication and recovery', async () => {
  const bad = checks(view());
  expect(bad[0]).toMatchObject({ status: 'alert', reason: 'low-float', detail: expect.stringContaining('3 waiting claims') });
  const good = checks(view({ floatWei: '250000000000000000', lowFloat: false, waitingClaims: 0 }));
  expect(good[0].status).toBe('ok');
  expect(checks(view({ floatWei: '900719925474099300000', lowFloatThresholdWei: '900719925474099300001', waitingClaims: 0 }))[0].status).toBe('alert');
  const state = { version: 1, channels: {} }, mailer = vi.fn();
  await dispatch(bad, state, { mailer }, NOW, cfg(), () => {});
  await dispatch(bad, state, { mailer }, NOW + 1n, cfg(), () => {});
  expect(mailer).toHaveBeenCalledTimes(1); expect(mailer.mock.calls[0][0]).toContain('3 waiting claims');
  await dispatch(good, state, { mailer }, NOW + 2n, cfg(), () => {});
  expect(mailer).toHaveBeenCalledTimes(2); expect(mailer.mock.calls[1][0]).toContain('RECOVERY');
});

it('missing, stale, future, malformed and inconsistent sender data is unknown, never an all-clear', () => {
  for (const patch of [{ at: Number((NOW - 301n) * 1000n) }, { at: Number((NOW + 1n) * 1000n) },
    { modifiedAt: String(NOW - 301n) }, { service: 'keeper' }, { floatWei: 1 }, { lowFloatThresholdWei: '0' },
    { waitingClaims: -1 }, { waitingClaims: '2' }, { mode: 'disabled' }, { lowFloat: false }]) {
    expect(checks(view(patch))[0].status).toBe('unknown');
  }
  expect(evaluate({}, configure(options, {}), NOW).some(r => r.id === 'alpha-sender-float')).toBe(false);
  expect(() => configure({ ...options, alphaSenderEnabled: '1' }, {})).toThrow();
  expect(() => configure({ ...options, alphaSenderFile: 'relative' }, {})).toThrow();
});
