#!/usr/bin/env node
/**
 * F156 (SH-ALPHA-TRADE-BOX): the Sepolia alpha's buy/sell box on a fresh local 31337 chain, LOCAL ONLY. It starts the
 * alpha setup of SH-ALPHA-REHEARSAL (packages/chain/scripts/alpha-rehearsal.mjs: the real v2 release, tETH with its
 * allowlist faucet, the tETH listing, the test-coin pools, a separate PoolSwapTest), two boxes (one priced in ETH, one in
 * tETH), the real core indexer over it, and the site with the trade switch on (`SH_SEPOLIA_TRADE=1`) pointed at it:
 *
 *   pnpm dev:alpha-local          the dev server (http://127.0.0.1:5534, Settings → Local chain)
 *   ... --e2e                     a development build served by `vite preview`, for apps/web/playwright.alpha-trade.config.ts
 *
 * (scripts/dev-alpha-local.mjs starts this file; it lives here, where viem and the alpha's libraries resolve.)
 *
 * Ports: anvil 8592 (SH_ALPHA_CHAIN_PORT), the indexer 5535 (SH_ALPHA_GATEWAY_PORT), the site 5534 (DEV_PORT). No URL,
 * key or fork is taken: every transaction goes to the anvil this script starts, from its unlocked test accounts. Each
 * run writes into its own new folder under .cache/alpha-local/ and nothing is deleted; .cache/alpha-local/current.json
 * names the newest run (written to a new file and renamed over the old one).
 */
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeAbiParameters, parseAbiParameters } from 'viem';
import { AlphaRun, buildAlphaArtifacts } from './alpha-rehearsal.mjs';
import { readAlphaLocalManifest } from './lib/core-v2-local-manifest.mjs';
import { readAlphaSiteManifest } from './lib/alpha-local-site.mjs';
import { writeLocalCreateOptions } from './lib/local-create-options.mjs';
import { ALPHA_FORGE_OUT, ALPHA_STACK_POINTER, createAlphaBox, mineAlpha, printed, waitForAlphaFeed } from './lib/alpha-local-actions.mjs';
import { ALPHA_CHAIN_ID, ROOT, child, delay, freePort, json, mineTo, stopChildren } from './lib/core-v2-local-runtime.mjs';

const e2e = process.argv.includes('--e2e');
const ports = { chain: Number(process.env.SH_ALPHA_CHAIN_PORT ?? 8592), gateway: Number(process.env.SH_ALPHA_GATEWAY_PORT ?? 5535), app: Number(process.env.DEV_PORT ?? 5534) };
const ETHER = 10n ** 18n;
const runDir = join(ROOT, '.cache/alpha-local', `${Date.now()}-${process.pid}`);
mkdirSync(runDir, { recursive: true });
const dependencies = parseAbiParameters('(address manager,address weth,address drand,address fit,address platform,address swapper,address poolSwapTest)');
const assets = parseAbiParameters('(address teth,address gold,address usdc,address nvda,address pepe,address pairs,address nativePools)');

let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(watchdog);
  await stopChildren({ failure: code !== 0 });
  process.exit(code);
}
// The browser suite's own deadline also covers a runner that died without stopping this stack.
const watchdog = e2e ? setTimeout(() => { console.error('alpha local stack: deadline exceeded'); void shutdown(1); }, 3_000_000) : undefined;
process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

/** A long-running service of this stack, its output in the run's folder; the stack stops when it stops. */
function service(name, command, args, env) {
  const log = openSync(join(runDir, `${name}.log`), 'a');
  let proc;
  try { proc = child(command, args, { env, stdio: ['ignore', log, log] }); } finally { closeSync(log); }
  proc.once('error', (error) => { console.error(error); void shutdown(1); });
  proc.once('exit', (code) => { if (!stopping) { console.error(`alpha local stack: ${name} exited (${code})`); void shutdown(code || 1); } });
  return proc;
}

try {
  for (const port of Object.values(ports)) await freePort(port);
  writeFileSync(join(runDir, 'build.log'), await buildAlphaArtifacts());
  const url = `http://127.0.0.1:${ports.chain}`;
  // Chain time follows the wall clock (no fixed start), so the indexer and the browser read today's times.
  service('anvil', 'anvil', ['--host', '127.0.0.1', '--port', String(ports.chain), '--chain-id', String(ALPHA_CHAIN_ID),
    '--enable-tx-gas-limit', '--steps-tracing', '--base-fee', '0', '--hardfork', 'osaka', '--silent'], {});
  const r = new AlphaRun(url, runDir);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i += 1) { try { await r.guard(); ready = true; } catch { await delay(100); } }
  if (!ready) throw new Error('anvil readiness');
  await r.request({ method: 'anvil_mine', params: ['0x10'] });
  const [owner, tester, tester2, outsider] = await r.request({ method: 'eth_accounts' });
  const d = decodeAbiParameters(dependencies, printed(await r.forge('dependencies', 'CoreV2LocalGenesis', 'runAlpha()', [], owner), 'dependencies'))[0];
  const startBlock = BigInt(await r.request({ method: 'eth_blockNumber' }));
  const factory = printed(await r.forge('release', 'DeployCoreV2Local', 'runAlpha(address,address,address,address,address)',
    [d.manager, d.weth, d.drand, d.fit, d.platform], owner), 'factory');
  const a = decodeAbiParameters(assets, printed(await r.forge('assets', 'AlphaRehearsalSetup', 'runAssets(address)', [d.manager], owner), 'assets'))[0];
  await r.call('admit two testers', owner, 'TestETH', a.teth, 'admit', [[tester, tester2]]);
  await r.call('tester drip', tester, 'TestETH', a.teth, 'drip');
  await r.call('second tester drip', tester2, 'TestETH', a.teth, 'drip');
  await r.forge('listing OTHER raise 1', 'AlphaRehearsalSetup', 'runListing(address,address)', [factory, a.teth], owner);
  await r.forge('seed pools', 'AlphaRehearsalSetup', 'runPools((address,address,address,address,address,address,address))', [`(${Object.values(a).join(',')})`], owner);
  // The browser suite's flows need more than one day's drip: W hands each tester tETH it already holds (no mint).
  await r.call('fund tester', owner, 'ERC20', a.teth, 'transfer', [tester, 50n * ETHER]);
  await r.call('fund second tester', owner, 'ERC20', a.teth, 'transfer', [tester2, 50n * ETHER]);
  const openAt = (await r.client.getBlock()).timestamp + 900n;
  const boxes = { eth: await createAlphaBox(url, { factory, listingId: 0, openAt, from: tester }), teth: await createAlphaBox(url, { factory, listingId: 1, openAt, from: tester }) };
  // The coin calls need the assets too (SH-ALPHA-COIN-CALLS): the manifest then holds `coinDeployment` for the test-coin page.
  const alpha = await readAlphaLocalManifest({ rpcUrl: url, factory, ...d, assets: a });
  const site = await readAlphaSiteManifest({ rpcUrl: url, factory, manager: d.manager, weth: d.weth, drand: d.drand, platform: d.platform, testers: [tester, tester2], startBlock }, { outDir: ALPHA_FORGE_OUT });
  const files = { alpha: join(runDir, 'alpha-manifest.json'), site: join(runDir, 'site-manifest.json'), stack: join(runDir, 'stack.json') };
  writeFileSync(files.alpha, json(alpha));
  writeFileSync(files.site, json(site));
  const origin = `http://127.0.0.1:${ports.gateway}`;
  const createOptionsDirectory = writeLocalCreateOptions(files.site);
  service('indexer', 'pnpm', ['--filter', '@squarehole/indexer', 'start:core'], {
    SH_CORE_CREATE_OPTIONS_DIR: createOptionsDirectory,
    SH_CORE_MANIFEST: files.site, SH_CORE_HTTP_URLS: url, SH_CORE_WS_URLS: '', SH_CORE_GATEWAY_HOST: '127.0.0.1',
    SH_CORE_GATEWAY_PORT: String(ports.gateway), SH_CORE_POLL_MS: '150', SH_STORE: 'memory', SH_HISTORY: 'memory',
  });
  // A new box is checked by the indexer's audit, every 32 blocks: two periods of blocks, one second each.
  await mineAlpha(url, 64);
  await waitForAlphaFeed(origin, Object.values(boxes), { timeoutMs: 180_000 });
  // --e2e: the browser suite's build also takes the Privy stand-in (privy-standin.ts; a production build refuses it), for
  // the alpha's "Set me up" (F166), whose made wallet the suite's own tests drive on this chain.
  const env = { SH_SEPOLIA_TRADE: '1', SH_CORE_LOCAL_MANIFEST: files.site, SH_CORE_LOCAL_RPC_URL: url, SH_CORE_LOCAL_INDEXER_ORIGIN: origin,
    SH_ALPHA_LOCAL_MANIFEST: files.alpha, SH_FIT_MARKET: 'none', SH_LOCAL_MANIFEST: '', SH_DEV_SERVER_WATCH: e2e ? 'off' : '', ...(e2e ? { SH_ALPHA_STANDIN: '1' } : {}) };
  const stack = { schema: 'square-hole-alpha-local-stack/1', chainId: ALPHA_CHAIN_ID, rpcUrl: url, origin, ports, run: runDir, files,
    accounts: { owner, tester, tester2, outsider }, factory, listingIds: { eth: 0, teth: 1 }, assets: a, dependencies: d, boxes, openAt: openAt.toString(),
    localDeployment: alpha.localDeployment, coinDeployment: alpha.coinDeployment, forgeOut: ALPHA_FORGE_OUT };
  writeFileSync(files.stack, json(stack));
  if (e2e) {
    const outDir = join(runDir, 'site');
    const build = child('pnpm', ['--filter', '@squarehole/web', 'exec', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    build.stdout.on('data', (chunk) => { log += chunk; }); build.stderr.on('data', (chunk) => { log += chunk; });
    const code = await new Promise((done) => build.once('close', done));
    writeFileSync(join(runDir, 'site-build.log'), log);
    if (code !== 0) throw new Error(`the site build failed (${code}); see ${join(runDir, 'site-build.log')}`);
    service('preview', 'pnpm', ['--filter', '@squarehole/web', 'exec', 'vite', 'preview', '--outDir', outDir, '--host', '127.0.0.1', '--port', String(ports.app), '--strictPort'], env);
  } else {
    service('site', 'pnpm', ['--filter', '@squarehole/web', 'dev', '--host', '127.0.0.1', '--port', String(ports.app), '--strictPort'], { ...env, DEV_PORT: String(ports.app) });
  }
  const pointer = join(ROOT, '.cache/alpha-local', `current-${process.pid}.json`);
  writeFileSync(pointer, json({ stack: files.stack }));
  renameSync(pointer, ALPHA_STACK_POINTER);
  // The boxes open in 15 minutes; until then they show as upcoming. mineTo moves the chain's clock for a quick look.
  if (!e2e && process.env.SH_ALPHA_OPEN_NOW === '1') await mineTo(url, openAt + 1n);
  console.warn(`Alpha LOCAL ONLY: http://127.0.0.1:${ports.app}/settings → Local chain, then /box/${ALPHA_CHAIN_ID}/<token>\n`
    + `RPC ${url}; indexer ${origin}; boxes ${boxes.eth} (ETH), ${boxes.teth} (tETH); run ${runDir}\nCtrl+C stops anvil, the indexer and the site.`);
} catch (error) {
  console.error(error);
  await shutdown(1);
}
