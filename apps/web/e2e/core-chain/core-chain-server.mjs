#!/usr/bin/env node
/**
 * Web server of the live core v1 suite (`pnpm e2e:core-chain`, playwright.core-chain.config.ts; S10a § 7.3). Starts
 * core v1 and box 0 on a local twin chain with packages/chain/scripts/local-core-chain.mjs (anvil on
 * SH_E2E_CORE_CHAIN_PORT, default 8559; box 0 right after its creation, upcoming), builds the app against that chain's
 * core manifest into dist-core-chain/ with the indexer origin the spec's core service will answer on
 * (SH_E2E_CORE_GATEWAY_PORT, default 5398), and serves it with `vite preview` on E2E_PORT (default 5397). The spec
 * itself runs box 0's life stage by stage, the core service and the history writer (a throwaway Postgres on a socket).
 * Playwright stops the whole process group at the end, anvil included. Local chain only; nothing is sent to a public
 * network, no key is used (anvil's unlocked accounts sign the life's test transactions).
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalCoreChain } from '../../../../packages/chain/scripts/local-core-chain.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const chainPort = Number(process.env.SH_E2E_CORE_CHAIN_PORT ?? 8559);
const gatewayPort = Number(process.env.SH_E2E_CORE_GATEWAY_PORT ?? 5398);
const appPort = Number(process.env.E2E_PORT ?? 5397);

const chain = await startLocalCoreChain({ port: chainPort, outDir: join(APP_DIR, 'e2e/.core-chain') });
// Only the core manifest: no v1 local manifest, no v2 market record (this suite is about core v1 on the twin).
const env = {
  ...process.env,
  SH_CORE_LOCAL_MANIFEST: chain.manifest,
  SH_CORE_LOCAL_RPC_URL: chain.rpcUrl,
  SH_CORE_LOCAL_INDEXER_ORIGIN: `http://127.0.0.1:${gatewayPort}`,
  SH_FIT_MARKET: 'none',
};
delete env.SH_LOCAL_MANIFEST;

const build = spawnSync('pnpm', ['exec', 'vite', 'build', '--outDir', 'dist-core-chain', '--emptyOutDir'], { cwd: APP_DIR, env, stdio: 'inherit' });
if (build.status !== 0) {
  await chain.stop();
  process.exit(build.status ?? 1);
}
const preview = spawn('pnpm', ['exec', 'vite', 'preview', '--outDir', 'dist-core-chain', '--host', '127.0.0.1', '--port', String(appPort), '--strictPort'], {
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
