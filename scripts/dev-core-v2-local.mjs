#!/usr/bin/env node
/** Local-only v2 chain + the production v1/v2 indexer + site. No wallet provider is installed by this server. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startLocalCoreV2Chain, runLocalLife, runSetLocalLife, recipe, callLocal, readLocalManifest } from '../packages/chain/scripts/local-core-v2-chain.mjs';
import { E2E_DEV_SERVER_ENV, ROOT, child, delay, freePort, json, localOptions, stopChildren } from '../packages/chain/scripts/lib/core-v2-local-runtime.mjs';
import { localRunFailed } from '../packages/chain/scripts/lib/core-v2-local-failure.mjs';
import { localArtEnvironment, resetExampleArt, startLocalArtGateway } from '../packages/chain/scripts/lib/core-v2-local-art.mjs';
import { writeLocalCreateOptions } from '../packages/chain/scripts/lib/local-create-options.mjs';

const ports = localOptions();
/** TA-22: where the browser suite writes a page-created box's pictures (core-v2-chain/create-v2-send.spec.mjs). */
const E2E_ART = join(ROOT, '.cache/core-v2-local/run/created-art');
const browser = process.argv.includes('--e2e');
let running;
let artGateway;
let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(watchdog);
  if (artGateway) {
    artGateway.closeAllConnections();
    await new Promise(done => artGateway.close(done));
  }
  await stopChildren({ failure: code !== 0 || localRunFailed() });
  process.exit(code);
}
// Independent startup/suite watchdog also covers browser-runner death. Dev mode stays up after readiness.
// SH-229: in a browser suite it is the longest global limit of the suites that start this launcher with --e2e plus one
// minute: the chain suite's hour (playwright.core-v2-chain.config.ts). The Arweave suite
// (e2e/core-v2-chain/arweave/playwright.config.mjs, 20 minutes) starts it too; after a dead runner its stack now
// stays up to 41 minutes longer than its suite could have run. At the earlier 21 minutes this watchdog ended the
// stack under a chain suite that takes 22 on the laptop. core-v2-local-art-supervisor.test.mjs holds them together.
let watchdog = setTimeout(() => { console.error('local stack deadline exceeded'); void shutdown(1); }, browser ? 3_660_000 : 600_000);
process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

function start(command, args, env) {
  const proc = child(command, args, { env });
  proc.once('error', error => { console.error(error); void shutdown(1); });
  proc.once('exit', code => { if (!stopping) void shutdown(code || 1); });
  return proc;
}

try {
  await freePort(ports.appPort); await freePort(ports.gatewayPort);
  // TA-22: in the browser suite the gateway also serves the pictures a page-created box commits, written by its spec
  // into a catalogue this run starts empty (as the example stack does); the founder's dev stack serves the catalogue only.
  if (browser) resetExampleArt(E2E_ART);
  artGateway = browser ? await startLocalArtGateway(ports, { exampleArt: E2E_ART }) : await startLocalArtGateway(ports);
  artGateway.once('error', error => { console.error(error); void shutdown(1); });
  const artEnv = localArtEnvironment(ports);
  running = await startLocalCoreV2Chain({ ports });
  running.process.once('exit', () => { if (!stopping) void shutdown(1); });
  const { chain } = running;
  await runLocalLife(chain, { browser });
  writeFileSync(chain.manifest, json(await readLocalManifest(chain)));
  // The add-on's full set life (two boxes, every checkpoint) runs on the founder's stack; the chain suite (`--e2e`)
  // only needs the add-on release deployed (its pages create their own boxes) and would pass Playwright's start limit.
  if (!browser) await runSetLocalLife(chain, {recipe, callLocal});
  const origin = `http://127.0.0.1:${ports.gatewayPort}`;
  const createOptionsDirectory = writeLocalCreateOptions(chain.manifest);
  start('pnpm', ['--filter', '@squarehole/indexer', 'start:core'], {
    SH_CORE_CREATE_OPTIONS_DIR: createOptionsDirectory,
    SH_CORE_MANIFEST: chain.manifest, SH_SET_MANIFEST: chain.setManifest, SH_CORE_HTTP_URLS: chain.rpcUrl, SH_CORE_WS_URLS: '',
    SH_CORE_GATEWAY_HOST: '127.0.0.1', SH_CORE_GATEWAY_PORT: String(ports.gatewayPort), SH_CORE_POLL_MS: '150',
    SH_STORE: 'memory', SH_HISTORY: 'memory', ...artEnv,
  });
  // The site is not ready until the real indexer has every created v2 row.
  let indexed = false;
  for (let i = 0; i < 1200; i += 1) {
    try {
      const response = await fetch(`${origin}/v2/feed?chain=${chain.chainId}`, { signal: AbortSignal.timeout(1000) });
      const feed = await response.json();
      if (feed.cards?.length === Object.keys(chain.boxes).length && feed.cards.every(card => card.verified && !card.stale)) {
        const sets = await fetch(`${origin}/v2/sets/feed?chain=${chain.chainId}`, { signal: AbortSignal.timeout(1000) });
        if (sets.ok && (await sets.json()).boxes?.length === (browser ? 0 : 2)) { indexed = true; break; }
      }
    } catch { /* The service may still be starting/catching up. */ }
    await delay(100);
  }
  if (!indexed) throw new Error('v2 indexer never produced all local v2 and set boxes');
  start('pnpm', ['--filter', '@squarehole/web', 'dev', '--host', '127.0.0.1', '--port', String(ports.appPort), '--strictPort'], {
    DEV_PORT: String(ports.appPort), SH_CORE_LOCAL_MANIFEST: chain.manifest, SH_CORE_LOCAL_RPC_URL: chain.rpcUrl,
    SH_CORE_LOCAL_INDEXER_ORIGIN: origin, SH_SET_LOCAL_MANIFEST: chain.setManifest, SH_FIT_MARKET: 'none', SH_LOCAL_MANIFEST: '',
    // SH-RC7 item 30: in the chain suite the dev server watches no file; the founder's stack keeps its live reload.
    ...artEnv, ...(browser ? E2E_DEV_SERVER_ENV : {}),
  });
  if (!browser) clearTimeout(watchdog);
  console.warn(`Core v2 LOCAL ONLY: http://127.0.0.1:${ports.appPort}/settings → Local chain\n` +
    `RPC ${chain.rpcUrl}; indexer ${origin}; art ${artEnv.SH_CORE_ART_GATEWAYS}; local custody doubles (no Safe signing).\n` +
    `State: ${join(ROOT, '.cache/core-v2-local/run/local-core-v2-chain.json')}\nCtrl+C stops all four services.`);
} catch (error) {
  console.error(error);
  await shutdown(1);
}
