import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startLocalCoreV2Chain } from '../../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { E2E_DEV_SERVER_ENV, child, delay, freePort, stopChildren } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { localArtEnvironment, resetExampleArt, startLocalArtGateway } from '../../../../../packages/chain/scripts/lib/core-v2-local-art.mjs';
import { EXAMPLE_ART, portsFromEnv, RUN, stringify } from './support.mjs';
import { writeLocalCreateOptions } from '../../../../../packages/chain/scripts/lib/local-create-options.mjs';

// Reuse the production local deployment and indexer. Only lifecycle/time/funding helpers live in this ticket.
const ports = portsFromEnv();
let art;
let stopping = false;
// Outlast Playwright's 95-minute startup + suite budget by one cleanup minute.
const watchdog = setTimeout(() => void stop(1), 5_760_000);
async function stop(code) {
  if (stopping) return;
  stopping = true; clearTimeout(watchdog);
  if (art) { art.closeAllConnections(); await new Promise(resolve => art.close(resolve)); }
  await stopChildren(); process.exit(code);
}
process.once('SIGINT', () => void stop(0)); process.once('SIGTERM', () => void stop(0));
function start(command, args, env) {
  const process = child(command, args, { env });
  process.once('error', error => { console.error(error); void stop(1); });
  process.once('exit', code => { if (!stopping) void stop(code || 1); });
}
try {
  for (const port of Object.values(ports)) await freePort(port);
  mkdirSync(RUN, { recursive: true });
  // The catalogue plus, for this stack only, the pictures each example commits (written before its createBox).
  resetExampleArt(fileURLToPath(EXAMPLE_ART));
  art = await startLocalArtGateway(ports, { exampleArt: fileURLToPath(EXAMPLE_ART) });
  const artEnv = localArtEnvironment(ports);
  const running = await startLocalCoreV2Chain({ ports, outDir: fileURLToPath(RUN) });
  running.process.once('exit', () => { if (!stopping) void stop(1); });
  const { chain } = running;
  writeFileSync(new URL('local-core-v2-chain.json', RUN), stringify(chain));
  const origin = `http://127.0.0.1:${ports.gatewayPort}`;
  const createOptionsDirectory = writeLocalCreateOptions(chain.manifest);
  start('pnpm', ['--filter', '@squarehole/indexer', 'start:core'], {
    SH_CORE_CREATE_OPTIONS_DIR: createOptionsDirectory,
    SH_CORE_MANIFEST: chain.manifest, SH_CORE_HTTP_URLS: chain.rpcUrl, SH_CORE_WS_URLS: '',
    SH_CORE_GATEWAY_HOST: '127.0.0.1', SH_CORE_GATEWAY_PORT: String(ports.gatewayPort), SH_CORE_POLL_MS: '150',
    SH_STORE: 'memory', SH_HISTORY: 'memory', ...artEnv,
  });
  let ready = false;
  for (let i = 0; i < 1200; i++) {
    try {
      const response = await fetch(`${origin}/v2/feed?chain=${chain.chainId}`, { signal: AbortSignal.timeout(1000) });
      const feed = await response.json();
      if (feed.cards?.length === Object.keys(chain.boxes).length && feed.cards.every(c => c.verified && !c.stale)) { ready = true; break; }
    } catch { /* startup */ }
    await delay(100);
  }
  if (!ready) throw new Error('example stack: local indexer did not become ready');
  // The dev server, not a build: create.mjs reads the page's draft through its /src/ modules. SH-RC7 item 30: it
  // watches no file, so no late file event (the stack's own manifest included) can update its modules mid-test.
  start('pnpm', ['--filter', '@squarehole/web', 'dev', '--host', '127.0.0.1', '--port', String(ports.appPort), '--strictPort'], {
    DEV_PORT: String(ports.appPort), SH_CORE_LOCAL_MANIFEST: chain.manifest, SH_CORE_LOCAL_RPC_URL: chain.rpcUrl,
    SH_CORE_LOCAL_INDEXER_ORIGIN: origin, SH_FIT_MARKET: 'none', SH_LOCAL_MANIFEST: '', ...artEnv, ...E2E_DEV_SERVER_ENV,
  });
} catch (error) { console.error(error); await stop(1); }
