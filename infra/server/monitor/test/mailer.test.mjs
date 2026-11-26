import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import * as notify from '../notify.mjs';
import { configure, DEFAULTS } from '../config.mjs';
import { render } from '../delivery.mjs';
import { runOnce } from '../runtime.mjs';
import { NOW, options, healthy } from './support.mjs';
import { LANDING_HEADERS } from '../policy.mjs';
const env = { SH_MONITOR_MAILER_URL: 'https://mailer.invalid/FAKE_MAILER_PATH', SH_MONITOR_MAILER_TOKEN: 'FAKE_MAILER_CREDENTIAL' };
const text = 'Square Hole monitor: EMERGENCY\nA word needs attention.';
it('the default and install example choose mailer, with SMTP optional and Telegram refused', () => {
  expect(DEFAULTS.channels).toBe('mailer');
  expect(configure(options, {}).channels).toBe('mailer');
  expect(JSON.parse(readFileSync('infra/server/monitor/config.example.json', 'utf8')).channels).toBe('mailer');
  expect(Object.keys(notify.notifiers(env))).toEqual(['mailer']);
  expect(Object.keys(notify.notifiers({ ...env, SH_MONITOR_CHANNELS: 'mailer,smtp' }))).toEqual(['mailer', 'smtp']);
  for (const channels of ['telegram', 'mailer,mailer', '', 'other']) {
    expect(() => configure({ ...options, channels }, {})).toThrow();
    expect(() => notify.notifiers({ ...env, SH_MONITOR_CHANNELS: channels })).toThrow();
  }
  expect(notify.telegram).toBeUndefined();
});
it('202 acknowledges one HTTPS POST to /alert with exactly the agreed fields and a private Bearer header', async () => {
  const request = vi.fn().mockResolvedValue({ status: 202, body: '{"id":"fake-mail-id"}' }), log = vi.fn();
  await notify.mailer(env, request, log)(text);
  expect(request).toHaveBeenCalledTimes(1); expect(log).not.toHaveBeenCalled();
  const [url, init] = request.mock.calls[0];
  expect(url).toBe(env.SH_MONITOR_MAILER_URL + '/alert');
  expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.SH_MONITOR_MAILER_TOKEN } });
  expect(JSON.parse(init.body)).toEqual({ source: 'monitor', level: 'EMERGENCY', subject: 'Square Hole monitor: EMERGENCY', text });
  expect(Buffer.byteLength(init.body)).toBeLessThanOrEqual(8192);
});
for (const outcome of [200, 400, 401, 413, 429, 502, 'timeout']) it(`${outcome} fails delivery once, logs only status and preserves exit 2 without a heartbeat`, async () => {
  const request = vi.fn(), log = vi.fn(), state = { version: 1, channels: {} }, save = vi.fn(), heartbeat = vi.fn();
  if (outcome === 'timeout') request.mockRejectedValue(new Error(env.SH_MONITOR_MAILER_URL + env.SH_MONITOR_MAILER_TOKEN));
  else request.mockResolvedValue({ status: outcome, body: env.SH_MONITOR_MAILER_URL + env.SH_MONITOR_MAILER_TOKEN });
  const out = await runOnce(configure(options, {}), env, { now: NOW, collect: async () => healthy(LANDING_HEADERS),
    store: { load: async () => state, save }, senders: { mailer: notify.mailer(env, request, log) }, request: heartbeat });
  expect(out).toMatchObject({ code: 2, failedChannels: ['mailer'], heartbeat: 'skipped' });
  expect(request).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled(); expect(heartbeat).not.toHaveBeenCalled();
  expect(state.channels).toEqual({});
  expect(log.mock.calls.flat().join(' ')).toContain(outcome === 'timeout' ? 'request failed' : `HTTP ${outcome}`);
  for (const secret of Object.values(env)) expect(JSON.stringify({ out, logs: log.mock.calls })).not.toContain(secret);
});
for (const event of ['INFO', 'WARN', 'ALERT', 'CRITICAL', 'EMERGENCY', 'RECOVERY', 'ALL CLEAR', 'DELIVERY TEST', 'INTERNAL FAILURE']) {
  it(`maps ${event} to a contract level without changing the notification text`, async () => {
    const request = vi.fn().mockResolvedValue({ status: 202, body: '{"id":"ok"}' });
    const message = `Square Hole monitor: ${event}\nCheck status.`;
    await notify.mailer(env, request)(message);
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ text: message,
      level: ['RECOVERY', 'ALL CLEAR', 'DELIVERY TEST'].includes(event) ? 'INFO' : event === 'INTERNAL FAILURE' ? 'ALERT' : event });
  });
}
it('bounds characters and UTF-8 JSON bytes before sending, including a full rendered report', async () => {
  const request = vi.fn().mockResolvedValue({ status: 202, body: '{"id":"ok"}' }), send = notify.mailer(env, request, vi.fn());
  for (const message of ['', 's'.repeat(121), 's\n' + 'a'.repeat(6000), 's\n' + '€'.repeat(3000)]) {
    await expect(send(message)).rejects.toThrow();
  }
  expect(request).not.toHaveBeenCalled();
  const report = Array.from({ length: 300 }, () => ({ id: 'drand-words', status: 'alert', level: 'emergency', reason: '6d', detail: 'box detail '.repeat(30) }));
  await send(render(report, 'ALERT', NOW));
  const body = request.mock.calls[0][1].body;
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(8192); expect(JSON.parse(body).text.length).toBeLessThanOrEqual(6000);
});
it('configuration errors never include the URL or credential', () => {
  for (const change of [{ SH_MONITOR_MAILER_URL: 'http://mailer.invalid/private' }, { SH_MONITOR_MAILER_URL: 'https://mailer.invalid/?private=1' },
    { SH_MONITOR_MAILER_TOKEN: 'fake\r\ninjected' }]) {
    expect(() => notify.mailer({ ...env, ...change })).toThrow(/^invalid monitor input$/);
  }
});
