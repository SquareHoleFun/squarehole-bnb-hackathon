import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { collect } from '../collect.mjs';
import { configure } from '../config.mjs';
import { readDrand } from '../drand.mjs';
import { AT, configInput, env, rpcFixture } from './drand-fixture.mjs';
const files = Object.fromEntries(['json', 'journal', 'disk', 'memory', 'backup'].map(k => [k, async () => { throw new Error('offline'); }]));
it('30 seconds in readRpc leaves only 10 seconds to start drand POSTs', async () => {
  const h = rpcFixture(), request = h.request, started = 5000;
  h.elapsed = started;
  const out = await collect(configure({ ...configInput(h.f), rpcBatchSize: '1' }, {}), env, AT, {
    files, clock: () => h.elapsed, request: (url, init) => {
      if (init.method !== 'POST') return { status: 200, body: '{}' };
      const call = JSON.parse(init.body);
      h.step = ['eth_chainId', 'eth_getBlockByNumber', 'eth_getBalance'].includes(call.method) ? 10000 : 1000;
      return request(url, init);
    },
  });
  expect(h.posts.slice(0, 3).map(p => p.at)).toEqual([started, started + 10000, started + 20000]);
  expect(h.posts.slice(3).every(p => p.at < started + 40000)).toBe(true);
  expect(out.drand.consumers.some(t => t.error === 'read-time-limit')).toBe(true);
});
it('an explicit zero start is preserved and an exhausted budget sends no POST', async () => {
  const h = rpcFixture(); h.elapsed = 40000;
  const out = await readDrand(configure(configInput(h.f), {}), env, h.f.rpc, { request: h.request, clock: () => h.elapsed, started: 0 });
  expect(h.posts).toEqual([]); expect(out.error).toBe('read-time-limit');
});
it('the serial network bounds including the mailer fit inside the unchanged service timeout', () => {
  const read = path => readFileSync(path, 'utf8');
  const collector = read('infra/server/monitor/collect.mjs'), drand = read('infra/server/monitor/drand.mjs');
  const notify = read('infra/server/monitor/notify.mjs'), runtime = read('infra/server/monitor/runtime.mjs');
  const http = BigInt(/AbortSignal.timeout\((\d+)\)/.exec(collector)[1]);
  const rpcCalls = BigInt((collector.slice(collector.indexOf('export async function readRpc'), collector.indexOf('export async function collect')).match(/await rpc\(/g) ?? []).length);
  expect(rpcCalls).toBe(3n);
  expect(collector).toContain('started'); expect(collector).toMatch(/readDrand\([\s\S]*started/);
  const budget = BigInt(/clock\(\) - started >= (\d+)/.exec(drand)[1]);
  const smtp = BigInt(/timeout: (\d+)/.exec(notify)[1]);
  expect(notify).toMatch(/function mailer\(env, request = boundedRequest/);
  expect(notify).toContain('function pingHeartbeat(env, request = boundedRequest)');
  expect(runtime).toContain('await pingHeartbeat(env, ports.request)');
  const pre = rpcCalls * http, total = (pre > budget ? pre : budget) + http + http + smtp + http;
  const unit = BigInt(/^TimeoutStartSec=(\d+)$/m.exec(read('infra/server/systemd/squarehole-monitor.service'))[1]) * 1000n;
  expect(total).toBe(95000n); expect(total).toBeLessThan(unit);
});
