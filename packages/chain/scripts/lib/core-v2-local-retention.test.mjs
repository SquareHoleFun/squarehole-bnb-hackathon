import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, run, stopChild } from './core-v2-local-runtime.mjs';

const runtime = new URL('./core-v2-local-runtime.mjs', import.meta.url).href;
for (const [keep, failure, retained] of [['1', true, true], ['0', true, false], ['1', false, false]]) {
  test(`KEEP_CHAIN=${keep}, failure=${failure}: retains only the chain when requested`, async () => {
    const source = `import { child, stopChildren, runLocalStep } from ${JSON.stringify(runtime)};
      const chain = child(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', keepOnFailure: true });
      const other = child(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(JSON.stringify({ chain: chain.pid, other: other.pid }));
      await stopChildren({ failure: ${failure} });`;
    const output = await run(process.execPath, ['--input-type=module', '-e', source], {
      env: { SH_CORE_V2_KEEP_CHAIN: keep }, timeoutMs: 5000,
    });
    const pids = JSON.parse(output.split('\n').find(line => line.startsWith('{')));
    try {
      assert.throws(() => process.kill(pids.other, 0), { code: 'ESRCH' });
      if (retained) {
        assert.doesNotThrow(() => process.kill(pids.chain, 0));
        assert.match(output, /SH_CORE_V2_KEEP_CHAIN=1.*retained.*pid/s);
      } else assert.throws(() => process.kill(pids.chain, 0), { code: 'ESRCH' });
    } finally { await stopChild({ pid: pids.chain, exitCode: 0 }); }
  });
}

const require = createRequire(join(ROOT, 'apps/web/package.json'));
const cli = require.resolve('@playwright/test/cli');
const testModule = pathToFileURL(require.resolve('@playwright/test')).href;
const config = pathToFileURL(join(ROOT, 'apps/web/playwright.core-v2-chain.config.ts')).href;
const supervisorUrl = pathToFileURL(join(ROOT, 'scripts/dev-core-v2-local.mjs'));
// Execute the actual supervisor shutdown, watchdog and signal handlers. Replace only startup with owned
// sleeper processes and stdout readiness, so installed Playwright can tear it down without opening sockets.
const supervisor = readFileSync(supervisorUrl, 'utf8').split('\ntry {')[0]
  .replace(/from '(\.\.?\/[^']+)'/g, (_match, path) => `from '${new URL(path, supervisorUrl).href}'`);

for (const [keep, outcome] of [['1', 'transaction'], ['1', 'assertion'], ['1', 'test-timeout'],
  ['1', 'global-timeout'], ['0', 'assertion'], ['1', 'success']]) {
  test(`Playwright ${outcome}, KEEP_CHAIN=${keep}: supervisor retains only a failed chain`, { timeout: 20_000 }, async () => {
    const base = join(ROOT, '.cache/core-v2-local/retention-proofs');
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, `${outcome}-${keep}-`));
    writeFileSync(join(dir, 'playwright.config.mjs'), `import actual from '${config}';
      export default { ...actual, testDir: '.', testMatch: '*.spec.mjs', outputDir: './results',
        projects: [{ name: 'socket-free' }],
        timeout: ${outcome === 'global-timeout' ? 10000 : 500},
        globalTimeout: ${outcome === 'global-timeout' ? 3000 : 10000},
        webServer: { ...actual.webServer, command: 'node service.mjs', url: undefined,
          wait: { stdout: /ready/ }, timeout: 5000 }
      };`);
    writeFileSync(join(dir, 'failure.spec.mjs'), `import playwright from '${testModule}';
      import { runLocalStep } from '${runtime}';
      const { test, expect } = playwright;
      test('controlled ${outcome}', async () => {
        ${outcome === 'transaction' ? `await runLocalStep({ rpcUrl: 'unused' }, 'failure.sweep',
          async () => { throw new Error('controlled send failure'); }, { errors: () => [] });`
    : outcome === 'assertion' ? 'expect(0n).toBeGreaterThan(0n);'
      : outcome === 'success' ? 'expect(1n).toBe(1n);' : 'await new Promise(() => {});'}
      });`);
    writeFileSync(join(dir, 'service.mjs'), `${supervisor}
      const chain = child(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', keepOnFailure: true });
      const other = child(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync('pids.json', JSON.stringify({ supervisor: process.pid, chain: chain.pid, other: other.pid }));
      clearTimeout(watchdog);
      watchdog = setTimeout(() => void shutdown(1), 15000);
      console.log('ready');`);
    let output;
    try {
      try {
        output = await run(process.execPath, [cli, 'test', '--config', join(dir, 'playwright.config.mjs')],
          { cwd: dir, timeoutMs: 17000, env: { SH_CORE_V2_KEEP_CHAIN: keep } });
        assert.equal(outcome, 'success', 'the controlled failure must fail Playwright');
      } catch (error) {
        output = error.message;
        assert.notEqual(outcome, 'success');
        assert.match(output, /failed \(1\)/);
        assert.match(output, outcome === 'transaction' ? /Local life step failure.sweep failed/
          : outcome === 'assertion' ? /toBeGreaterThan/ : /[Tt]imed?\s*out|[Tt]imeout/);
      }
      writeFileSync(join(dir, 'result.log'), output);
      const pids = JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8'));
      for (const pid of [pids.supervisor, pids.other]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      if (keep === '1' && outcome !== 'success') {
        assert.doesNotThrow(() => process.kill(pids.chain, 0), 'failed test must retain the chain before SIGTERM cleanup');
        assert.match(output, /retained anvil pid/);
      } else assert.throws(() => process.kill(pids.chain, 0), { code: 'ESRCH' });
    } finally {
      let pids = {};
      try { pids = JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8')); } catch { /* Startup may fail before spawning. */ }
      for (const pid of Object.values(pids)) await stopChild({ pid, exitCode: 0 });
    }
  });
}
