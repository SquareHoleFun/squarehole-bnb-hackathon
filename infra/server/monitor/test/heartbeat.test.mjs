import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configure } from '../config.mjs';
import { boundedRequest, collect } from '../collect.mjs';
import { pingHeartbeat } from '../notify.mjs';
import { evaluate, LANDING_HEADERS } from '../policy.mjs';
import { runOnce } from '../runtime.mjs';
import { main } from '../main.mjs';
import { healthy, options, NOW } from './support.mjs';
import { fixture, rpcFixture, configInput, env, AT } from './drand-fixture.mjs';
const cfg = configure(options, {}), args = mode => [mode, '--config', 'infra/server/monitor/config.example.json'];
const secrets = { ...env, SH_MONITOR_CHANNELS: 'mailer', SH_MONITOR_MAILER_TOKEN: 'FAKE_TEST_TOKEN', SH_MONITOR_MAILER_URL: 'https://mailer.invalid/FAKE_TEST_PATH' };
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline test: unexpected fetch')); });
afterEach(() => vi.restoreAllMocks());
function runtime(fail = false) {
  const events = [], o = { ...healthy(LANDING_HEADERS), heartbeat: { configured: true, valid: true } };
  return { events, o, ports: { now: NOW, collect: async () => o,
    store: { load: async () => ({ version: 1, channels: {} }), save: async () => { events.push('save'); } },
    senders: { mailer: async () => { events.push('send'); if (fail) throw new Error(Object.values(secrets).join(' ')); } },
    request: async (_url, init) => { events.push(init.method); return { status: 204, body: '' }; } } };
}
describe('dead-man success heartbeat', () => {
  it('accepts a bodyless 204 through the real bounded request reader', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    expect(await pingHeartbeat(secrets, (url, init) => boundedRequest(url, init, fetcher))).toBe('accepted');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  });
  for (const incident of [false, true]) it(`one GET after delivery and saves on code ${incident ? 1 : 0}`, async () => {
    const h = runtime(); if (incident) h.o.disk.available = '1';
    const out = await runOnce(cfg, secrets, h.ports);
    expect(out.code).toBe(incident ? 1 : 0); expect(out.heartbeat).toBe('accepted');
    expect(h.events).toEqual(['send', 'save', 'GET']); expect(JSON.stringify(out)).not.toContain('FAKE_');
  });
  it('does not ping on code 2 or a state save failure', async () => {
    const h = runtime(true); expect((await runOnce(cfg, secrets, h.ports)).code).toBe(2); expect(h.events).toEqual(['send']);
    const next = runtime(); next.ports.store.save = async () => { throw new Error('save failed'); };
    await expect(runOnce(cfg, secrets, next.ports)).rejects.toThrow(); expect(next.events).toEqual(['send']);
  });
  for (const failure of [500, 302, 'transport']) it(`heartbeat ${failure} fails quietly with exit 2`, async () => {
    const h = runtime(); h.ports.request = async () => { if (failure === 'transport') throw new Error(env.SH_MONITOR_HEARTBEAT_URL); return { status: failure }; };
    const out = await runOnce(cfg, secrets, h.ports); expect(out).toMatchObject({ code: 2, heartbeat: 'failed' }); expect(JSON.stringify(out)).not.toContain('FAKE_');
  });
  for (const value of [undefined, '', 'http://heartbeat.invalid/FAKE_SECRET', 'https://user:pass@heartbeat.invalid', 'https://heartbeat.invalid/?secret', 'https://heartbeat.invalid/#secret']) {
    it(`heartbeat configuration flag ${String(value).split(':')[0]}`, async () => {
      const files = Object.fromEntries(['json', 'journal', 'disk', 'memory', 'backup'].map(k => [k, async () => { throw new Error('offline'); }]));
      const request = vi.fn().mockRejectedValue(new Error('offline'));
      const out = await collect(cfg, { SH_MONITOR_HEARTBEAT_URL: value }, NOW, { request, files });
      const configured = Boolean(value); expect(out.heartbeat).toEqual({ configured, valid: false });
      expect(evaluate(out, cfg, NOW).find(r => r.id === 'heartbeat')).toMatchObject({ status: 'alert', reason: configured ? 'heartbeat-invalid' : 'heartbeat-not-configured' });
      expect(request.mock.calls.every(([url]) => url !== value)).toBe(true);
      expect(JSON.stringify(out)).not.toContain('FAKE_');
    });
  }
});
describe('offline CLI ports', () => {
  it('dry-run says 18 checks and only configured/not configured; no I/O', async () => {
    for (const e of [{}, secrets]) {
      let output = ''; const request = vi.fn();
      expect(await main(args('--dry-run'), e, { write: s => output += s, request })).toBe(0);
      expect(output).toContain('18 checks'); expect(output).toContain(e === secrets ? 'heartbeat configured' : 'heartbeat not configured');
      expect(output).not.toContain('FAKE_'); expect(request).not.toHaveBeenCalled();
    }
  });
  for (const state of ['accepted', 'failed', 'not configured']) it(`notify-test: heartbeat ${state}`, async () => {
    let output = ''; const request = vi.fn().mockResolvedValue({ status: state === 'failed' ? 500 : 204 });
    const e = { ...secrets }; if (state === 'not configured') delete e.SH_MONITOR_HEARTBEAT_URL;
    expect(await main(args('--notify-test'), e, { write: s => output += s, senders: { mailer: vi.fn() }, request })).toBe(state === 'failed' ? 2 : 0);
    expect(output).toContain(`heartbeat ${state}`); expect(output).not.toContain('FAKE_');
    expect(request).toHaveBeenCalledTimes(state === 'not configured' ? 0 : 1);
  });
  it('internal-failure path never pings and suppresses secrets in output and notifications', async () => {
    let output = ''; const request = vi.fn(), send = vi.fn();
    const code = await main(args('--run'), secrets, { write: s => output += s, error: s => output += s, request, senders: { mailer: send },
      store: { load: async () => { throw new Error(Object.values(secrets).join(' ')); } } });
    expect(code).toBe(2); expect(request).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.stringContaining('INTERNAL FAILURE')); expect(output + JSON.stringify(send.mock.calls)).not.toContain('FAKE_');
  });
  it('--drand reads only RPC and drand, emits each row plus canary with no state or delivery', async () => {
    const h = rpcFixture(), c = configInput(fixture());
    let output = ''; const send = vi.fn(), load = vi.fn();
    const ports = { readConfig: async () => c, write: s => output += s, error: s => output += s, request: h.request, now: AT + 21600n, senders: { mailer: send }, store: { load } };
    expect(await main(['--drand'], env, ports)).toBe(1);
    expect(output).toContain('drand-words: alert (6h)'); expect(output).toContain('drand-canary: ok (no-posted-word)');
    expect(output.trim().split('\n')).toHaveLength(3); expect(send).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
    expect(h.calls.some(c => c.method === 'eth_getBalance')).toBe(false);
    ports.now = AT; output = ''; expect(await main(['--drand'], env, ports)).toBe(0);
    h.fault = () => { throw new Error('FAKE_RPC_SECRET'); }; output = '';
    expect(await main(['--drand'], env, ports)).toBe(2); expect(output).not.toContain('FAKE_');
  });
});
