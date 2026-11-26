#!/usr/bin/env node
/**
 * Web server of the chain E2E suite (playwright.chain.config.ts; SH-C). Starts a local Square Hole chain with
 * packages/chain/scripts/local-chain.mjs (anvil on SH_E2E_CHAIN_PORT, default 8561; the contracts' deploy, finalize and
 * verify scripts; the contracts' external-trading harness seeding trades, fees, burns and claims), builds the app
 * against that chain's manifest into dist-chain/ and serves it with `vite preview`. Playwright stops the whole process
 * group at the end, anvil included. Local chain only; nothing is sent to a public network.
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalChain } from '../../../../packages/chain/scripts/local-chain.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const chainPort = Number(process.env.SH_E2E_CHAIN_PORT ?? 8561);
const appPort = Number(process.env.E2E_CHAIN_APP_PORT ?? 5393);

const chain = await startLocalChain({ port: chainPort, outDir: join(APP_DIR, 'e2e/.chain') });
// No v2 market record unless asked: this suite is about the local deployment (and checks Sepolia is not offered).
const env = { ...process.env, SH_LOCAL_MANIFEST: chain.manifest, SH_LOCAL_RPC_URL: chain.rpcUrl, SH_FIT_MARKET: process.env.SH_FIT_MARKET ?? 'none' };

const build = spawnSync('pnpm', ['exec', 'vite', 'build', '--outDir', 'dist-chain', '--emptyOutDir'], { cwd: APP_DIR, env, stdio: 'inherit' });
if (build.status !== 0) {
  await chain.stop();
  process.exit(build.status ?? 1);
}
const preview = spawn('pnpm', ['exec', 'vite', 'preview', '--outDir', 'dist-chain', '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], {
  cwd: APP_DIR,
  env,
  stdio: 'inherit',
});

let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  if (preview.exitCode === null) preview.kill('SIGTERM');
  await chain.stop();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
preview.on('exit', (code) => void shutdown(code ?? 0));
