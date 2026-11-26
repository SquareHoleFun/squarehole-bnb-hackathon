import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import * as manifest from './core-v2-local-manifest.mjs';
import { child, stopChild, run, delay, ROOT } from './core-v2-local-runtime.mjs';

test('CQ11-B plain fees come from block-pinned Collected events, including both sides above 2^53', async () => {
  const calls = [];
  const client = { getContractEvents: async args => {
    calls.push(args);
    return [{ args: { buyersP: 900719925474099312345n, sellersP: 7n, qToReserve: 3n, tip: 2n } },
      { args: { buyersP: 11n, sellersP: 13n, qToReserve: 0n, tip: 1n } }];
  } };
  const result = await manifest.readCollectedFees(client, 'receiver', 10n, 42n);
  assert.deepEqual(result, { buyersP: 900719925474099312356n, sellersP: 20n, qToReserve: 3n, tip: 3n });
  assert.equal(calls[0].address, 'receiver');
  assert.equal(calls[0].eventName, 'Collected');
  assert.equal(calls[0].fromBlock, 10n); assert.equal(calls[0].toBlock, 42n);
  assert.equal(calls[0].strict, true);
});

test('failure cleanup escalates a TERM-resistant detached service within a bounded grace period', async () => {
  const service = child(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await once(service, 'message');
  try {
    await Promise.race([stopChild(service, { graceMs: 40 }), delay(1000).then(() => { throw new Error('cleanup hung'); })]);
    assert.equal(service.signalCode, 'SIGKILL');
  } finally {
    try { process.kill(-service.pid, 'SIGKILL'); } catch { /* already reaped */ }
  }
});

test('forge commands yield to shutdown and have a wall-clock deadline', async () => {
  const pending = run(process.execPath, ['-e', 'setTimeout(() => {}, 250)'], { timeoutMs: 80 });
  assert.equal(typeof pending?.then, 'function', 'commands must not block signal handlers with spawnSync');
  await assert.rejects(pending, /timed out/);
});

test('Playwright bounds the suite and gracefully stops the service supervisor', () => {
  const config = readFileSync(`${ROOT}/apps/web/playwright.core-v2-chain.config.ts`, 'utf8');
  assert.match(config, /globalTimeout:\s*[\d_]+/);
  assert.match(config, /gracefulShutdown:\s*\{\s*signal:\s*'SIGTERM',\s*timeout:\s*[\d_]+\s*\}/);
});

test('cleanup reaches a detached group after its pnpm-like leader already exited', async () => {
  const source = `const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    descendant.once('message', () => { process.send(descendant.pid); setTimeout(() => process.exit(0), 20); });`;
  const leader = child(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const [descendant] = await once(leader, 'message');
  await once(leader, 'exit');
  try {
    assert.equal(leader.exitCode, 0);
    await stopChild(leader, { graceMs: 40 });
    // The descendant inherited both pipes: close proves it cannot keep Playwright's webServer teardown pending.
    await Promise.race([once(leader, 'close'), delay(1000).then(() => { throw new Error('descendant held server pipes open'); })]);
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
  } finally {
    try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* already stopped */ }
  }
});
