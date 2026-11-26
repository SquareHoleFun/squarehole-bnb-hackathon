import { expect, it, vi } from 'vitest';
import { configure } from '../config.mjs';
import { collect } from '../collect.mjs';
import { evaluate } from '../policy.mjs';
import { dispatch } from '../delivery.mjs';
import { NOW, options } from './support.mjs';

const config = () => configure({ ...options, alphaApiEnabled: true }, {});
const snapshot = (patch = {}) => ({ v: 1, service: 'alpha-api', at: Number(NOW * 1000n), modifiedAt: String(NOW),
  pending: 60, approved: 20, cap: 100, claimsWaiting: 2, oldestActiveWaitSeconds: 1801, recentFailures: 3, ...patch });
const observation = patch => ({ alphaApi: snapshot(patch), alphaBackup: { modifiedAt: String(NOW) },
  alphaApiHealth: { status: 200, body: { ok: true }, headers: { 'cache-control': 'no-store' } } });
const checks = (o, c = config()) => evaluate(o, c, NOW).filter(r => r.id.startsWith('alpha-'));

it('collects public health and private counts only when enabled; read failures stay unknown', async () => {
  const c = config(), fail = async () => { throw new Error('private'); };
  const request = vi.fn(async url => {
    if (new URL(url).pathname === '/alpha/health') return { status: 200, body: '{"ok":true}', headers: {} };
    throw new Error('other');
  });
  const json = vi.fn(async path => { if (path === c.alphaApiFile) return snapshot(); throw new Error('other'); });
  const ports = { request, files: { json, journal: fail, memory: fail, backup: fail, alphaBackup: fail, disk: fail } };
  expect((await collect(c, {}, NOW, ports)).alphaApi).toEqual(snapshot());
  expect((await collect(c, {}, NOW, ports)).alphaApiHealth.body).toEqual({ ok: true });
  request.mockClear(); json.mockClear();
  expect((await collect(configure(options, {}), {}, NOW, ports)).alphaApi).toBeUndefined();
  expect(json.mock.calls.flat()).not.toContain(c.alphaApiFile);
  expect(checks({}).every(c => c.status === 'unknown')).toBe(true);
});

it('warns at exactly 80%, alerts after 30 active minutes and three failures/hour, then deduplicates and recovers by mail', async () => {
  const bad = checks(observation());
  expect(bad.find(c => c.id === 'alpha-signups')).toMatchObject({ status: 'alert', level: 'warn' });
  expect(bad.find(c => c.id === 'alpha-queue').status).toBe('alert');
  expect(bad.find(c => c.id === 'alpha-claim-failures').status).toBe('alert');
  const good = checks(observation({ pending: 59, oldestActiveWaitSeconds: 1800, recentFailures: 2 }));
  expect(good.every(c => c.status === 'ok')).toBe(true);
  const mailer = vi.fn(), state = { version: 1, channels: {} };
  await dispatch(bad, state, { mailer }, NOW, config(), () => {});
  await dispatch(bad, state, { mailer }, NOW + 1n, config(), () => {});
  expect(mailer).toHaveBeenCalledTimes(1);
  await dispatch(good, state, { mailer }, NOW + 2n, config(), () => {});
  expect(mailer).toHaveBeenCalledTimes(2); expect(mailer.mock.calls[1][0]).toContain('RECOVERY');
});

it('stale, future, missing or malformed counts never give an all-clear; failed HTTP and stale alpha backups alert', () => {
  for (const patch of [{ at: Number((NOW - 301n) * 1000n) }, { modifiedAt: String(NOW + 1n) }, { cap: 0 }, { recentFailures: '3' }, { claimsWaiting: -1 }]) {
    expect(checks(observation(patch)).filter(c => c.id !== 'alpha-backup').every(c => c.status === 'unknown')).toBe(true);
  }
  const o = observation(); o.alphaApiHealth.status = 503; o.alphaBackup.modifiedAt = String(NOW - 108001n);
  expect(checks(o).find(c => c.id === 'alpha-api').status).toBe('alert');
  expect(checks(o).find(c => c.id === 'alpha-backup').status).toBe('alert');
  expect(() => configure({ ...options, alphaFailureCount: '0' }, {})).toThrow();
  expect(() => configure({ ...options, alphaQueueAgeSeconds: '-1' }, {})).toThrow();
});
