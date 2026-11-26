#!/usr/bin/env node
/**
 * SH-V21-FE13: the local v2 chain (genesis, the release and its nine recipe boxes), the production indexer and the site,
 * as `scripts/dev-core-v2-local.mjs --e2e` starts them, plus one thing that suite's stack has not: an art gateway that
 * also serves the pictures a browser test writes for the box it creates (core-v2-local-example-art.mjs), so the indexer
 * can list that box. The site is a build served by `vite preview`, not the dev server: a file event in the worktree
 * reloaded the dev server's modules mid-test (SH-V21-FE13 run 1, "hmr update" in its log), which remounted the page and
 * dropped what the test had typed. Loopback only; the ports are the suite's (DEV_PORT, SH_CORE_V2_GATEWAY_PORT,
 * SH_CORE_V2_ART_PORT, SH_CORE_V2_CHAIN_PORT). No life is run: the test lives its own box.
 */
import { mkdirSync } from 'node:fs';
import { startLocalCoreV2Chain } from '../../../../../packages/chain/scripts/local-core-v2-chain.mjs';
import { ROOT, child, delay, freePort, localOptions, run, stopChildren } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { localArtEnvironment, resetExampleArt, startLocalArtGateway } from '../../../../../packages/chain/scripts/lib/core-v2-local-art.mjs';
import { writeLocalCreateOptions } from '../../../../../packages/chain/scripts/lib/local-create-options.mjs';
import { ART, RUN } from './support.mjs';

const ports = localOptions();
let art;
let stopping = false;
// Outlast the config's 15-minute startup and 30-minute suite budget by one cleanup minute.
const watchdog = setTimeout(() => void stop(1), 2_760_000);
async function stop(code) {
  if (stopping) return;
  stopping = true; clearTimeout(watchdog);
  if (art) { art.closeAllConnections(); await new Promise((done) => art.close(done)); }
  await stopChildren({ failure: code !== 0 });
  process.exit(code);
}
process.once('SIGINT', () => void stop(0)); process.once('SIGTERM', () => void stop(0));
function start(command, args, env) {
  const proc = child(command, args, { env });
  proc.once('error', (error) => { console.error(error); void stop(1); });
  proc.once('exit', (code) => { if (!stopping) void stop(code || 1); });
}
try {
  for (const port of [ports.appPort, ports.gatewayPort, ports.artPort]) await freePort(port);
  mkdirSync(RUN, { recursive: true });
  resetExampleArt(ART);
  art = await startLocalArtGateway(ports, { exampleArt: ART });
  const artEnv = localArtEnvironment(ports);
  const running = await startLocalCoreV2Chain({ ports, outDir: RUN });
  running.process.once('exit', () => { if (!stopping) void stop(1); });
  const { chain } = running;
  const origin = `http://127.0.0.1:${ports.gatewayPort}`;
  // SH-218 rail 2: the page reads the Create list of this stack's own release before it shows Create as available.
  const createOptionsDirectory = writeLocalCreateOptions(chain.manifest);
  start('pnpm', ['--filter', '@squarehole/indexer', 'start:core'], {
    SH_CORE_CREATE_OPTIONS_DIR: createOptionsDirectory,
    SH_CORE_MANIFEST: chain.manifest, SH_CORE_HTTP_URLS: chain.rpcUrl, SH_CORE_WS_URLS: '',
    SH_CORE_GATEWAY_HOST: '127.0.0.1', SH_CORE_GATEWAY_PORT: String(ports.gatewayPort), SH_CORE_POLL_MS: '150',
    SH_STORE: 'memory', SH_HISTORY: 'memory', ...artEnv,
  });
  let ready = false;
  for (let i = 0; i < 1200; i += 1) {
    try {
      const response = await fetch(`${origin}/v2/feed?chain=${chain.chainId}`, { signal: AbortSignal.timeout(1000) });
      const feed = await response.json();
      if (feed.cards?.length === Object.keys(chain.boxes).length && feed.cards.every((card) => card.verified && !card.stale)) { ready = true; break; }
    } catch { /* the service may still be starting */ }
    await delay(100);
  }
  if (!ready) throw new Error('shop stack: the local indexer never served every recipe box verified');
  const siteEnv = { DEV_PORT: String(ports.appPort), SH_CORE_LOCAL_MANIFEST: chain.manifest, SH_CORE_LOCAL_RPC_URL: chain.rpcUrl,
    SH_CORE_LOCAL_INDEXER_ORIGIN: origin, SH_FIT_MARKET: 'none', SH_LOCAL_MANIFEST: '', ...artEnv };
  // The development build (the Demo's branches kept, as on the dev server), with this chain's manifest embedded.
  await run('pnpm', ['--filter', '@squarehole/web', 'exec', 'vite', 'build'], { cwd: ROOT, env: siteEnv, timeoutMs: 600_000 });
  start('pnpm', ['--filter', '@squarehole/web', 'exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(ports.appPort), '--strictPort'], siteEnv);
  console.warn(`Shop stack LOCAL ONLY: http://127.0.0.1:${ports.appPort} · RPC ${chain.rpcUrl} · indexer ${origin} · art ${artEnv.SH_CORE_ART_GATEWAYS}`);
} catch (error) {
  console.error(error);
  await stop(1);
}
