import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as spawnProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dispatch, render } from '../delivery.mjs';
import { smtp } from '../notify.mjs';
import { boundedRequest, collect, readJournal, latestBackup } from '../collect.mjs';
import { configure } from '../config.mjs';
import { NOW, options } from './support.mjs';
const good = [{ id: 'disk', status: 'ok', reason: 'healthy' }];
const bad = [{ id: 'disk', status: 'alert', reason: 'capacity-low' }];
const cfg = configure(options, {});
describe('durable per-channel delivery', () => {
  it('deduplicates, reminds, recovers, sends one daily all-clear and retries only failed channels', async () => {
    const state = { version: 1, channels: {} }, a = vi.fn(), b = vi.fn().mockRejectedValueOnce(new Error('FAKE_TEST_SECRET'));
    const senders = { mailer: a, smtp: b }, save = vi.fn();
    expect(await dispatch(bad, state, senders, NOW, cfg, save)).toEqual(['smtp']);
    expect(save).toHaveBeenCalledTimes(1);
    expect(await dispatch(bad, state, senders, NOW + 60n, cfg, save)).toEqual([]);
    expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(2);
    await dispatch(bad, state, senders, NOW + 21601n, cfg, save); expect(a).toHaveBeenCalledTimes(2);
    await dispatch(good, state, senders, NOW + 21602n, cfg, save); expect(a.mock.calls.at(-1)[0]).toContain('RECOVERY');
    await dispatch(good, state, senders, NOW + 21603n, cfg, save); expect(a).toHaveBeenCalledTimes(3);
    await dispatch(good, state, senders, NOW + 86400n, cfg, save); expect(a).toHaveBeenCalledTimes(4);
    expect(a.mock.calls.at(-1)[0]).toContain('ALL CLEAR');
  });
  it('unknowns are incidents and save failures propagate without claiming delivery state', async () => {
    const state = { version: 1, channels: {} };
    expect(render([{ id: 'drand', status: 'unknown', reason: 'missing-stale-or-invalid-data' }], 'ALERT', NOW)).toContain('unknown');
    await expect(dispatch(bad, state, { mailer: vi.fn() }, NOW, cfg, () => { throw new Error('disk full'); })).rejects.toThrow();
  });
});
describe('notifier transports use private input, bounded output, and fixed errors', () => {
  it('uploads a private regular message file through a real child on Linux and macOS, then clears it', async () => {
    const stateDir = await mkdtemp(resolve('.cache/tmp/monitor-smtp-'));
    const env = { SH_MONITOR_SMTP_URL: 'smtps://smtp.example.invalid:465', SH_MONITOR_SMTP_USER: 'FAKE_TEST_USER', SH_MONITOR_SMTP_PASSWORD: 'FAKE_TEST_PASSWORD', SH_MONITOR_MAIL_FROM: 'monitor@example.invalid', SH_MONITOR_MAIL_TO: 'founder@example.invalid' };
    let exitCode;
    const spawn = (exe, args, opts) => {
      expect(exe).toBe('/usr/bin/curl'); expect(args).toEqual(['-q', '--config', '-']);
      expect(opts.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C' });
      const child = spawnProcess(process.execPath, ['infra/server/monitor/test/smtp-probe.mjs', stateDir], opts);
      child.on('close', code => { exitCode = code; });
      return child;
    };
    const send = smtp(env, spawn, stateDir);
    const result = await Promise.allSettled([send('ALERT\ndisk: alert')]);
    expect(exitCode, 'real child must be able to open a regular upload file').toBe(0);
    expect(result[0].status).toBe('fulfilled');
    await send('ALERT\ndisk: alert');
    expect(await readdir(stateDir)).toEqual(['smtp-message.eml']);
    expect((await stat(join(stateDir, 'smtp-message.eml'))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(stateDir, 'smtp-message.eml'), 'utf8')).toBe('');
  });
  it('feeds SMTP credentials via stdin and a private file body, uses TLS and no inherited secrets', async () => {
    const stateDir = await mkdtemp(resolve('.cache/tmp/monitor-smtp-'));
    let invocation;
    const spawn = (exe, args, opts) => {
      const p = new EventEmitter(); p.stdin = new PassThrough();
      let config = ''; p.stdin.on('data', d => config += d);
      p.stdin.on('finish', async () => {
        const message = await readFile(join(stateDir, 'smtp-message.eml'), 'utf8');
        invocation = { exe, args, opts, config, message }; p.emit('close', 0);
      });
      return p;
    };
    const env = { SH_MONITOR_SMTP_URL: 'smtps://smtp.example.invalid:465', SH_MONITOR_SMTP_USER: 'FAKE_TEST_USER', SH_MONITOR_SMTP_PASSWORD: 'FAKE_TEST_PASSWORD', SH_MONITOR_MAIL_FROM: 'monitor@example.invalid', SH_MONITOR_MAIL_TO: 'founder@example.invalid' };
    await smtp(env, spawn, stateDir)('ALERT\ndisk: alert');
    expect(invocation.args.join(' ')).not.toContain('FAKE_TEST');
    expect(invocation.config).toContain('FAKE_TEST_PASSWORD');
    expect(invocation.config).toContain('ssl-reqd');
    expect(invocation.opts.env).not.toHaveProperty('SH_MONITOR_SMTP_PASSWORD');
    expect(invocation.opts.stdio).toEqual(['pipe', 'ignore', 'ignore']);
    expect(invocation.message).toContain('Subject: Square Hole monitor');
    expect(() => smtp({ ...env, SH_MONITOR_SMTP_URL: 'smtp://smtp.example.invalid' }, spawn)).toThrow();
    expect(() => smtp({ ...env, SH_MONITOR_MAIL_TO: 'x\r\nBcc: victim' }, spawn)).toThrow();
  });
  it('clears the same bounded file on SMTP rejection, spawn failure and timeout', async () => {
    const stateDir = await mkdtemp(resolve('.cache/tmp/monitor-smtp-'));
    const env = { SH_MONITOR_SMTP_URL: 'smtps://smtp.example.invalid:465', SH_MONITOR_SMTP_USER: 'FAKE_TEST_USER', SH_MONITOR_SMTP_PASSWORD: 'FAKE_TEST_PASSWORD', SH_MONITOR_MAIL_FROM: 'monitor@example.invalid', SH_MONITOR_MAIL_TO: 'founder@example.invalid' };
    for (const outcome of ['reject', 'spawn-failure', 'timeout']) {
      const spawn = (_exe, _args, opts) => {
        const args = outcome === 'reject' ? ['infra/server/monitor/test/smtp-probe.mjs', stateDir, 'reject'] : ['-e', 'setInterval(() => {}, 1000)'];
        return spawnProcess(outcome === 'spawn-failure' ? join(stateDir, 'absent-executable') : process.execPath, args,
          { ...opts, timeout: outcome === 'timeout' ? 100 : opts.timeout });
      };
      await expect(smtp(env, spawn, stateDir)('ALERT\ndisk: alert')).rejects.toThrow(/^notification failed$/);
      expect(await readFile(join(stateDir, 'smtp-message.eml'), 'utf8')).toBe('');
    }
    expect(await readdir(stateDir)).toEqual(['smtp-message.eml']);
  });
  it('refuses an upload symlink without changing its target or starting curl', async () => {
    const stateDir = await mkdtemp(resolve('.cache/tmp/monitor-smtp-'));
    const target = join(stateDir, 'preserved'); await writeFile(target, 'keep this');
    await symlink(target, join(stateDir, 'smtp-message.eml'));
    const env = { SH_MONITOR_SMTP_URL: 'smtps://smtp.example.invalid:465', SH_MONITOR_SMTP_USER: 'FAKE_TEST_USER', SH_MONITOR_SMTP_PASSWORD: 'FAKE_TEST_PASSWORD', SH_MONITOR_MAIL_FROM: 'monitor@example.invalid', SH_MONITOR_MAIL_TO: 'founder@example.invalid' };
    const spawn = vi.fn();
    await expect(smtp(env, spawn, stateDir)('ALERT\ndisk: alert')).rejects.toThrow(/^notification failed$/);
    expect(spawn).not.toHaveBeenCalled(); expect(await readFile(target, 'utf8')).toBe('keep this');
  });
});
describe('bounded collectors', () => {
  it('does not follow redirects and bounds streamed responses', async () => {
    const fake = vi.fn().mockResolvedValue(new Response('abc', { status: 200 }));
    expect((await boundedRequest('https://example.invalid', {}, fake)).body).toBe('abc');
    expect(fake.mock.calls[0][1].redirect).toBe('error');
    fake.mockResolvedValue(new Response('x'.repeat(1048577)));
    await expect(boundedRequest('https://example.invalid', {}, fake)).rejects.toThrow('read failed');
    fake.mockRejectedValue(new Error('https://example.invalid/FAKE_TEST_SECRET'));
    await expect(boundedRequest('https://example.invalid', {}, fake)).rejects.toThrow(/^read failed$/);
  });
  it('collects read-only RPC and public edge probes; isolates failures without copying exceptions', async () => {
    const req = vi.fn(async (url, init) => {
      if (url === 'https://rpc.example.invalid/FAKE_TEST_KEY') {
        const call = JSON.parse(init.body);
        const result = { eth_chainId: '0xaa36a7', eth_getBlockByNumber: { number: '0x79e', timestamp: '0x1' }, eth_getBalance: '0x100' }[call.method];
        return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: call.id, result }) };
      }
      return { status: 200, headers: {}, body: url.includes('healthz') ? '{"ok":true}' : url.includes('/v1/feed') ? '{"chainId":11155111}' : '<title>Square Hole</title>' };
    });
    const fs = { json: async () => { throw new Error('FAKE_TEST_SECRET'); }, journal: async () => { throw new Error('FAKE_TEST_SECRET'); }, disk: async () => ({ total: '1000', available: '500' }), memory: async () => ({ total: '1000', available: '500' }), backup: async () => ({ modifiedAt: String(NOW) }) };
    const o = await collect(cfg, { SH_MONITOR_RPC_URL: 'https://rpc.example.invalid/FAKE_TEST_KEY' }, NOW, { request: req, files: fs });
    expect(o.rpc).toMatchObject({ chainId: '11155111', block: '1950', balanceWei: '256' });
    expect(o.keeper).toBeUndefined(); expect(JSON.stringify(o)).not.toContain('FAKE_TEST');
    expect(req.mock.calls.filter(x => x[1]?.method === 'POST').map(x => JSON.parse(x[1].body).method).sort()).toEqual(['eth_chainId', 'eth_getBalance', 'eth_getBlockByNumber']);
    expect(req.mock.calls.find(x => x[0].includes('healthz'))[1].headers.Origin).toBe(cfg.origin);
  });
  it('wrong-chain RPC refuses subsequent block/balance reads', async () => {
    const req = vi.fn(async (url, init) => {
      if (init.method === 'POST') return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }) };
      throw new Error('offline');
    });
    const files = Object.fromEntries(['json', 'journal', 'disk', 'memory', 'backup'].map(k => [k, async () => { throw new Error('offline'); }]));
    const o = await collect(cfg, { SH_MONITOR_RPC_URL: 'https://rpc.example.invalid' }, NOW, { request: req, files });
    expect(o.rpc).toBeUndefined(); expect(req.mock.calls.filter(x => x[1].method === 'POST')).toHaveLength(1);
  });
  it('refuses direct mainnet collection before any I/O without opt-in', async () => {
    const request = vi.fn();
    await expect(collect({ ...cfg, chainId: '1' }, {}, NOW, { request })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('exports file readers for integration checks', () => { expect(readJournal).toBeTypeOf('function'); expect(latestBackup).toBeTypeOf('function'); });
});
