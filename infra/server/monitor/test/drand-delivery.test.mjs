import { createHash } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { configure } from '../config.mjs';
import { dispatch, render } from '../delivery.mjs';
import { StateStore } from '../runtime.mjs';
import { options, NOW } from './support.mjs';
const cfg = configure(options, {});
const bad = (level = 'alert', reason = '6h', subject = '0x' + 'ab'.repeat(20) + ':3') => ({ id: 'drand-words', status: 'alert', level, reason, subject, detail: 'box 0 key 3; 6 d 18 h 0 min left' });
it('preserves byte-identical old signatures and dedups an old saved state', async () => {
  const report = [{ id: 'disk', status: 'alert', reason: 'capacity-low' }, { id: 'drand', status: 'unknown', reason: 'missing-stale-or-invalid-data' }];
  const signature = 'disk:alert:capacity-low|drand:unknown:missing-stale-or-invalid-data';
  const state = { version: 1, channels: { mailer: { signature, notifiedAt: String(NOW), lastClearDay: '0' } } }, send = vi.fn();
  await dispatch(report, state, { mailer: send }, NOW + 1n, cfg, vi.fn()); expect(send).not.toHaveBeenCalled();
  await dispatch(report, state, { mailer: send }, NOW + 21600n, cfg, vi.fn()); expect(state.channels.mailer.signature).toBe(signature);
});
it('hashes a 200-row report, durably saves it, and suppresses an identical next run', async () => {
  await mkdir('.cache/tmp', { recursive: true }); const store = new StateStore(await mkdtemp('.cache/tmp/drand-delivery-'));
  const report = Array.from({ length: 200 }, (_, i) => bad('critical', '3d', '0x' + 'ab'.repeat(20) + ':' + i));
  const joined = report.map(r => `${r.id}:${r.status}:${r.reason}:${r.subject}`).sort().join('|');
  const state = await store.load(), send = vi.fn();
  await dispatch(report, state, { mailer: send }, NOW, cfg, s => store.save(s));
  expect((await store.load()).channels.mailer.signature).toBe('sha256:' + createHash('sha256').update(joined).digest('hex'));
  await dispatch(report, await store.load(), { mailer: send }, NOW + 1n, cfg, s => store.save(s)); expect(send).toHaveBeenCalledTimes(1);
});
it('ignores changing time left, but immediately resends a rung or subject change', async () => {
  const state = { version: 1, channels: {} }, send = vi.fn(), report = [bad()];
  await dispatch(report, state, { mailer: send }, NOW, cfg, vi.fn());
  report[0].detail = '6 d 17 h 59 min left'; await dispatch(report, state, { mailer: send }, NOW + 60n, cfg, vi.fn()); expect(send).toHaveBeenCalledTimes(1);
  report[0].reason = '24h'; await dispatch(report, state, { mailer: send }, NOW + 61n, cfg, vi.fn()); expect(send).toHaveBeenCalledTimes(2);
  report[0].subject += '4'; await dispatch(report, state, { mailer: send }, NOW + 62n, cfg, vi.fn()); expect(send).toHaveBeenCalledTimes(3);
});
for (const [level, interval] of [['warn', 21600n], ['alert', 21600n], ['critical', 3600n], ['emergency', 900n]]) {
  it(`${level} repeats at ${interval} seconds, not one second before`, async () => {
    const state = { version: 1, channels: {} }, send = vi.fn(), report = [bad('alert'), bad(level, 'other')];
    await dispatch(report, state, { mailer: send }, NOW, cfg, vi.fn());
    await dispatch(report, state, { mailer: send }, NOW + interval - 1n, cfg, vi.fn()); expect(send).toHaveBeenCalledTimes(1);
    await dispatch(report, state, { mailer: send }, NOW + interval, cfg, vi.fn()); expect(send).toHaveBeenCalledTimes(2);
  });
}
for (const [rows, event] of [[[bad('warn')], 'WARN'], [[bad('warn'), bad()], 'ALERT'], [[bad('critical'), bad()], 'CRITICAL'], [[bad('emergency'), bad('critical')], 'EMERGENCY'], [[{ id: 'rpc', status: 'unknown', reason: 'failed' }, bad('warn')], 'ALERT']]) {
  it(`renders highest level ${event}`, () => expect(render(rows, 'ALERT', NOW).split('\n')[0]).toBe(`Square Hole monitor: ${event}`));
}
it('sorts severity then remaining time and puts each detail below its row', () => {
  const a = { ...bad('critical', 'A'), detail: '1 d 0 h 0 min left' }, b = { ...bad('critical', 'B'), detail: '0 d 1 h 0 min left' }, e = bad('emergency', 'E');
  const text = render([a, bad('warn', 'W'), b, e], 'ALERT', NOW);
  expect(text.indexOf('(E)')).toBeLessThan(text.indexOf('(B)')); expect(text.indexOf('(B)')).toBeLessThan(text.indexOf('(A)'));
  expect(text).toContain('drand-words: alert (B)\n0 d 1 h 0 min left');
});
it('caps the whole notification message at 3800 characters with exact omitted-row count', () => {
  const report = Array.from({ length: 200 }, (_, i) => ({ ...bad(), detail: `key ${i} ${'detail '.repeat(40)}` }));
  const text = render(report, 'ALERT', NOW);
  expect(text.length).toBeLessThanOrEqual(3800);
  const count = (text.match(/drand-words: alert/g) ?? []).length;
  expect(count).toBeGreaterThan(0); expect(text).toMatch(new RegExp(`\\.\\.\\. and ${200 - count} more rows$`));
});
