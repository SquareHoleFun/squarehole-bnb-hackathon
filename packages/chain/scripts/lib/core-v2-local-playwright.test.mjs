import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, run } from './core-v2-local-runtime.mjs';

// Exercise the installed Playwright runner and real detached process groups without any listener or browser.
const require = createRequire(join(ROOT, 'apps/web/package.json'));
const cli = require.resolve('@playwright/test/cli');
const testModule = pathToFileURL(require.resolve('@playwright/test')).href;
const runtime = new URL('./core-v2-local-runtime.mjs', import.meta.url).href;

for (const outcome of ['assertion', 'test-timeout', 'global-timeout']) {
  test(`Playwright ${outcome} exits and reaps the detached stack`, { timeout: 15_000 }, async () => {
    const base = join(ROOT, '.cache/core-v2-local/runner-proofs');
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, `${outcome}-`));
    const actual = readFileSync(join(ROOT, 'apps/web/playwright.core-v2-chain.config.ts'), 'utf8');
    const grace = actual.match(/gracefulShutdown:\s*(\{[^}]+\})/)[1];
    writeFileSync(join(dir, 'playwright.config.mjs'), `export default {
      testDir: '.', testMatch: '*.spec.mjs', workers: 1, retries: 0, reporter: 'line',
      timeout: ${outcome === 'global-timeout' ? 10000 : 100}, globalTimeout: ${outcome === 'global-timeout' ? 2000 : 5000},
      webServer: { command: 'node service.mjs', wait: { stdout: /ready/ }, timeout: 3000,
        gracefulShutdown: ${grace} }
    };`);
    writeFileSync(join(dir, 'failure.spec.mjs'), `import playwright from '${testModule}'; const { test, expect } = playwright;
      test('controlled ${outcome}', async () => {
        ${outcome === 'assertion' ? 'expect(0n).toBeGreaterThan(0n);' : 'await new Promise(() => {});'}
      });`);
    writeFileSync(join(dir, 'service.mjs'), `import { child, stopChildren } from '${runtime}';
      import { writeFileSync } from 'node:fs';
      const services = [0, 1, 2].map(() => child(process.execPath, ['-e', 'setInterval(() => {}, 1000)']));
      writeFileSync('pids.json', JSON.stringify([process.pid, ...services.map(p => p.pid)]));
      const stop = async () => { await stopChildren(); process.exit(0); };
      process.once('SIGTERM', stop); process.once('SIGINT', stop);
      setTimeout(stop, 7000); // fixture failsafe, beyond the assertion below
      console.log('ready');`);
    const start = Date.now();
    await assert.rejects(run(process.execPath, [cli, 'test', '--config', join(dir, 'playwright.config.mjs')],
      { cwd: dir, timeoutMs: 10000 }), error => {
      writeFileSync(join(dir, 'result.log'), error.message);
      assert.match(error.message, /failed \(1\)/);
      assert.match(error.message, outcome === 'assertion' ? /toBeGreaterThan/ : /[Tt]imed?\s*out|[Tt]imeout/);
      return true;
    });
    assert(Date.now() - start < 6500, 'cleanup must finish before the fixture failsafe');
    for (const pid of JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8'))) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `process ${pid} survived failure`);
    }
  });
}
