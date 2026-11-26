#!/usr/bin/env node
/**
 * `pnpm dev:core-local` (S10a § 7.2): the app against core v1 on a local chain.
 *
 *   1. packages/chain/scripts/local-core-chain.mjs: anvil on SH_CORE_CHAIN_PORT (default 8562; this repository's anvil
 *      range is 8550-8599, minus other workflows' ports), with Sepolia's chain id (a local twin: the drand pin), core v1
 *      and box 0 deployed by script/local/DeployCoreV1Local.s.sol with anvil's own unlocked account, the core manifest
 *      written from chain reads, then box 0's life up to SH_CORE_LIFE_UNTIL (default `stream`: every stage; `none` stops
 *      right after the creation, upcoming);
 *   2. the core service (packages/indexer start:core: the chain pipeline and gateway, hot state in memory) on
 *      SH_CORE_GATEWAY_PORT (default 5394);
 *   3. the Vite dev server (port 5391) with SH_CORE_LOCAL_MANIFEST, SH_CORE_LOCAL_RPC_URL and
 *      SH_CORE_LOCAL_INDEXER_ORIGIN pointing at them.
 *
 * Then open http://127.0.0.1:5391/settings and choose the local chain. Nothing here signs anything for the app or asks a
 * wallet; the twin is never added to a wallet (a signature made there would be valid on Sepolia). Ctrl+C stops all three.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT, startLocalCoreChain } from '../packages/chain/scripts/local-core-chain.mjs';

const port = Number(process.env.SH_CORE_CHAIN_PORT ?? 8562);
const gatewayPort = Number(process.env.SH_CORE_GATEWAY_PORT ?? 5394);
const until = process.env.SH_CORE_LIFE_UNTIL ?? 'stream';
const chain = await startLocalCoreChain({ port, outDir: join(REPO_ROOT, '.local/core-chain') });
if (until !== 'none') await chain.life({ until });

const children = [];
const start = (args, env) => {
  // Its own process group, so stopping it also stops what pnpm starts (pnpm does not forward signals).
  const child = spawn('pnpm', args, { cwd: REPO_ROOT, stdio: 'inherit', detached: true, env: { ...process.env, ...env } });
  children.push(child);
  return child;
};
start(['--filter', '@squarehole/indexer', 'start:core'], { SH_CORE_MANIFEST: chain.manifest, SH_CORE_HTTP_URLS: chain.rpcUrl, SH_CORE_GATEWAY_PORT: String(gatewayPort), SH_CORE_POLL_MS: '500' });
const web = start(['--filter', '@squarehole/web', 'dev', '--host', '127.0.0.1'], {
  SH_CORE_LOCAL_MANIFEST: chain.manifest,
  SH_CORE_LOCAL_RPC_URL: chain.rpcUrl,
  SH_CORE_LOCAL_INDEXER_ORIGIN: `http://127.0.0.1:${gatewayPort}`,
});

console.warn(`
Square Hole core v1 on a local chain
  chain     ${chain.rpcUrl} (chain id ${chain.chainId}, a local twin of Sepolia's id), manifest ${chain.manifest}
  box 0     token ${chain.token}, created in block ${chain.creationBlock}, life up to "${until}"
  service   http://127.0.0.1:${gatewayPort}/v1/feed?chain=${chain.chainId}
  app       http://127.0.0.1:${process.env.DEV_PORT ?? 5391}/settings → Data source → the local chain
  Ctrl+C stops the app, the service and anvil.
`);

let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
  await chain.stop();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
web.on('exit', (code) => void shutdown(code ?? 0));
