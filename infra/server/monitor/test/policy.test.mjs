import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluate, LANDING_HEADERS } from '../policy.mjs';
import { configure } from '../config.mjs';
import { healthy, NOW, options } from './support.mjs';
const cfg = () => configure(options, {});
const check = (o, id) => evaluate(o, cfg(), NOW).find(x => x.id === id);
describe('monitor checks', () => {
  it('pins landing security headers to the served policy', () => {
    const text = readFileSync('apps/landing/public/_headers', 'utf8').split('/art/*')[0];
    const served = Object.fromEntries([...text.matchAll(/^ {2}([^:]+): (.+)$/gm)].map(m => [m[1].toLowerCase(), m[2]]));
    expect(LANDING_HEADERS).toEqual(served);
  });
  it('accepts healthy data and treats every absent input as unknown', () => {
    expect(evaluate(healthy(LANDING_HEADERS), cfg(), NOW).every(x => x.status === 'ok')).toBe(true);
    expect(evaluate({}, cfg(), NOW).every(x => x.status === 'unknown')).toBe(true);
  });
  it('rejects redirects, missing Cloudflare/security headers, wrong cache and idle indexers', () => {
    for (const mutate of [o => o.landing.status = 301, o => delete o.landing.headers['cf-ray'], o => delete o.landing.headers['content-security-policy'], o => o.landing.headers['cache-control'] = 'public']) {
      const o = healthy(LANDING_HEADERS); mutate(o); expect(check(o, 'landing').status).toBe('alert');
    }
    const o = healthy(LANDING_HEADERS); o.api.body.following = false;
    expect(check(o, 'api').status).toBe('alert');
    o.api.headers['access-control-allow-origin'] = '*'; expect(check(o, 'api').status).toBe('alert');
  });
  it('compares with finalized head, checks chain and stale/future timestamps', () => {
    const o = healthy(LANDING_HEADERS); o.api.body.asOf.block = '1800';
    expect(check(o, 'indexer').status).toBe('alert');
    o.api.body.asOf.block = '2000'; o.rpc.timestamp = String(NOW - 2000n);
    expect(check(o, 'indexer').status).toBe('alert');
    o.rpc.timestamp = String(NOW); o.feed.body.chainId = 1;
    expect(check(o, 'indexer').status).toBe('alert');
    o.feed.body.chainId = 11155111; o.api.body.asOf.block = '3000';
    expect(check(o, 'indexer').status).toBe('alert');
    o.api.body.asOf.block = '2000'; o.api.body.asOf.timestamp = String(NOW + 1n);
    expect(check(o, 'indexer').status).toBe('alert');
  });
  it('checks queue age, freshness, 3 gwei boundary and reserve headroom', () => {
    const o = healthy(LANDING_HEADERS); o.view.queue = { count: '1', oldestBlock: '1700' };
    expect(check(o, 'keeper-queue').status).toBe('alert');
    o.view.maxFeePerGasWei = '3000000000'; expect(check(o, 'keeper-fee').status).toBe('ok');
    o.view.maxFeePerGasWei = '3000000001'; expect(check(o, 'keeper-fee').status).toBe('alert');
    o.keeper.state.budget.oursWei = '51000000000000000'; o.keeper.state.budget.totalWei = '51000000000000000';
    expect(check(o, 'keeper-reserve').status).toBe('alert');
    o.view.observedAt = String(NOW - 301n); expect(check(o, 'keeper-queue').status).toBe('unknown');
  });
  it('keeps exact amounts, caps and day rollover; malformed or wrong identity is unknown', () => {
    const o = healthy(LANDING_HEADERS); o.keeper.state.budget.totalWei = '114000000000000001';
    expect(check(o, 'keeper-spend').status).toBe('alert');
    o.keeper.state.budget.totalWei = 114000000000000000; expect(check(o, 'keeper-spend').status).toBe('unknown');
    o.keeper.state.budget.totalWei = '114000000000000001'; o.keeper.state.budget.day = String(NOW / 86400n - 1n);
    expect(check(o, 'keeper-spend').status).toBe('ok');
    o.keeper.identity = 'wrong'; expect(check(o, 'keeper-spend').status).toBe('unknown');
  });
  it('honors per-box 1/15 share, quarter platform income, received tips and unattributed liabilities', () => {
    const o = healthy(LANDING_HEADERS); const b = o.view.income.boxes[0];
    b.spentWei = '11'; expect(check(o, 'keeper-income').status).toBe('alert');
    b.tipsWei = '1'; expect(check(o, 'keeper-income').status).toBe('ok');
    b.shareWei = '1000'; b.spentWei = '102'; expect(check(o, 'keeper-income').status).toBe('alert');
    b.spentWei = '0'; o.view.income.unattributedWei = '1002'; expect(check(o, 'keeper-income').status).toBe('alert');
  });
  it('uses poster usability: warns within 24h, silent only after deadline, timely words stay usable', () => {
    const o = healthy(LANDING_HEADERS);
    const r = { requestedAt: String(NOW - 6n * 86400n), deadline: String(NOW + 86400n), usable: false, silent: false };
    o.view.drand.requests = [r]; expect(check(o, 'drand').status).toBe('alert');
    r.requestedAt = String(NOW - 604800n); r.deadline = String(NOW);
    expect(check(o, 'drand').reason).toBe('nearing-silence');
    r.requestedAt = String(NOW - 604801n); r.deadline = String(NOW - 1n);
    expect(check(o, 'drand').reason).toBe('silent');
    r.usable = true; expect(check(o, 'drand').status).toBe('ok');
    o.view.drand.complete = false; expect(check(o, 'drand').status).toBe('unknown');
  });
  it('checks UTC journal record and mtime, disk, MemAvailable and completed backup age', () => {
    const o = healthy(LANDING_HEADERS); o.journal.record.recordedUtc = '2026-10-12T00:00:00.000Z';
    expect(check(o, 'burn-journal').status).toBe('alert');
    o.disk.available = '150'; expect(check(o, 'disk').status).toBe('alert');
    o.memory.available = '100'; expect(check(o, 'memory').status).toBe('alert');
    o.backup.modifiedAt = String(NOW - 108001n); expect(check(o, 'backup').status).toBe('alert');
    o.backup.modifiedAt = String(NOW + 1n); expect(check(o, 'backup').status).toBe('alert');
  });
});
