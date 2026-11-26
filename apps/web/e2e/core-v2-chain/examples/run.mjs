import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORTS, ROOT, validatePorts } from './support.mjs';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: fileURLToPath(ROOT), stdio: 'inherit', ...options });
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT'); const terminate = () => forward('SIGTERM');
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
      if (code === 0) resolve(); else reject(new Error(`${command} exited ${signal ?? code}`));
    });
  });
}
async function available(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
let phase;
function beginPhase(name) {
  phase = name;
  console.warn(`[examples] Phase: ${phase}`);
}
try {
  beginPhase('preflight tests');
  // Type transforms: the example art test loads the production indexer and card art checkers.
  await run(process.execPath, ['--experimental-vm-modules', '--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--test',
    'packages/chain/scripts/create-example-v2.test.mjs', 'packages/chain/scripts/lib/core-v2-local-junkyard.test.mjs',
    'apps/web/e2e/core-v2-chain/examples/junkyard.test.mjs', 'apps/web/e2e/core-v2-chain/examples/junkyard-create.test.mjs',
    'apps/web/e2e/core-v2-chain/examples/one-collection-shop.test.mjs',
    'apps/web/e2e/core-v2-chain/examples/chain.test.mjs',
    'packages/box-spec/examples/v2/registry.test.mjs', 'apps/web/e2e/core-v2-chain/examples/support.test.mjs',
    'apps/web/e2e/core-v2-chain/examples/wallet.test.mjs', 'apps/web/e2e/core-v2-chain/examples/offline.test.mjs',
    'apps/web/e2e/core-v2-chain/examples/run.test.mjs', 'apps/web/e2e/core-v2-chain/examples/feed.test.mjs',
    'apps/web/e2e/core-v2-chain/examples/reporter.test.mjs',
    'packages/chain/scripts/lib/core-v2-local.test.mjs', 'packages/chain/scripts/lib/core-v2-local-example-art.test.mjs']);
  // The probe starts at the caller's assigned ports (SH_EXAMPLES_PORTS, as playwright.config.mjs and stack.mjs read them),
  // else at the defaults; a port in use still moves on by 4, never reusing a service.
  const ports = process.env.SH_EXAMPLES_PORTS ? validatePorts(JSON.parse(process.env.SH_EXAMPLES_PORTS)) : { ...DEFAULT_PORTS };
  if (!process.argv.includes('--list')) {
    beginPhase('offline contracts and replay');
    await run(process.execPath, ['apps/web/e2e/core-v2-chain/examples/offline.mjs', ...process.argv.slice(2).filter(arg => arg === '--keep-hidden-art')]);
    await run(process.execPath, ['apps/web/e2e/core-v2-chain/examples/offline.mjs', '--junkyard']);
    beginPhase('free-port preflight');
    for (const role of Object.keys(ports)) {
      for (;;) {
        validatePorts(ports);
        try { await available(ports[role]); break; }
        catch (error) {
          if (error.code !== 'EADDRINUSE') throw error; // EPERM is a sandbox restriction, never permission to reuse a service.
          ports[role] += 4;
          while (Object.entries(ports).some(([key, port]) => key !== role && port === ports[role])) ports[role] += 4;
        }
      }
    }
  }
  console.warn(`Example ports: ${JSON.stringify(ports)}`);
  beginPhase(process.argv.includes('--list') ? 'browser test discovery' : 'local stack and browser tests');
  await run('pnpm', ['--filter', '@squarehole/web', 'exec', 'playwright', 'test', '--config', 'e2e/core-v2-chain/examples/playwright.config.mjs', ...process.argv.slice(2).filter(arg => arg !== '--keep-hidden-art')],
    { env: { ...process.env, SH_EXAMPLES_PORTS: JSON.stringify(ports), SH_FORGE_TIMEOUT_MS: '1800000' } });
  beginPhase('complete');
} catch (error) {
  console.error(`Examples E2E failed during ${phase}: ${error.message}`);
  process.exitCode = 1;
}
