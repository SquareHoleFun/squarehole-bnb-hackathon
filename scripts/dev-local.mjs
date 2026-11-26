#!/usr/bin/env node
/**
 * `pnpm dev:local` (SH-C): the app against a local Square Hole chain.
 *
 *   1. packages/chain/scripts/local-chain.mjs: anvil on port 8560 (SH_DEV_CHAIN_PORT, within 8550-8599), the contracts'
 *      deploy script, finalizer and verifier, the contracts' external-trading harness seeding trades, fees, burns and
 *      claims, and the manifest copied to .local/dev-chain/manifest-31337.json;
 *   2. the Vite dev server (port 5391) with SH_LOCAL_MANIFEST and SH_LOCAL_RPC_URL pointing at that chain.
 *
 * Then open http://127.0.0.1:5391/settings and choose "Local chain (anvil 31337)". To sign, add the network to a
 * browser wallet (RPC http://127.0.0.1:8560, chain id 31337) and import one of anvil's PUBLIC default test accounts
 * (for example alice, account 1, which holds FIT (The Misfits) and ORCH (ORCHARD) and has rewards to claim on both:
 * R = Q in WETH on The Misfits, R = T in ORCH on ORCHARD). Never use those keys, or
 * this wallet profile, on a public network. Ctrl+C stops the app and anvil. Nothing here touches Sepolia or mainnet.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT, startLocalChain } from '../packages/chain/scripts/local-chain.mjs';

const port = Number(process.env.SH_DEV_CHAIN_PORT ?? 8560);
const outDir = join(REPO_ROOT, '.local/dev-chain');

const chain = await startLocalChain({ port, outDir });
// Its own process group, so stopping it also stops the Vite process pnpm starts (pnpm does not forward signals).
const web = spawn('pnpm', ['--filter', '@squarehole/web', 'dev', '--host', '127.0.0.1'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  detached: true,
  env: { ...process.env, SH_LOCAL_MANIFEST: chain.manifest, SH_LOCAL_RPC_URL: chain.rpcUrl },
});

console.warn(`
Square Hole on a local chain
  chain     ${chain.rpcUrl} (chain id 31337), manifest ${chain.manifest}
  app       http://127.0.0.1:${process.env.DEV_PORT ?? 5391}/settings → Data source → "Local chain (anvil 31337)"
  wallet    add network 31337 at ${chain.rpcUrl}; import an anvil default account (public test keys, local only):
            alice ${chain.accounts.alice} holds FIT and ORCH with rewards to claim (WETH on The Misfits, ORCH on ORCHARD)
  pairs     The Misfits (FIT/WETH, R = Q) ${chain.pairs.THE_MISFITS.appPairId} · ORCHARD (ORCH/FIT, R = T) ${chain.pairs.ORCHARD.appPairId}
  Ctrl+C stops the app and anvil.
`);

let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  if (web.exitCode === null && web.pid !== undefined) {
    try {
      process.kill(-web.pid, 'SIGTERM');
    } catch {
      web.kill('SIGTERM');
    }
  }
  await chain.stop();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
web.on('exit', (code) => void shutdown(code ?? 0));
