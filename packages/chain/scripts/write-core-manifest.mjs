#!/usr/bin/env node
/**
 * Writes a core v1 deployment manifest (`squarehole.core-deployment/v1`, S10a § 2.3) from chain reads, read-only:
 * views and `eth_getCode` at one block (finalized on Sepolia and mainnet, latest on a local chain) and box 0's registry logs
 * (src/core/core-manifest-writer.ts). No key, no signing, no broadcast log is read: the founder (or an agent) runs it
 * after the broadcast with a keyless RPC and commits the file.
 *
 * Usage (from packages/chain; `pnpm core-manifest:write -- …` adds the TypeScript flags):
 *   node --experimental-transform-types --no-warnings=ExperimentalWarning --import ./scripts/register-ts.mjs \
 *     scripts/write-core-manifest.mjs --rpc <keyless URL> --factory <address> [--network mainnet|sepolia|local]
 *     [--out <file>] [--git-commit <40 hex>] [--platform-eoa]
 * Default --out: packages/contracts/deployments/core-v1/<chainId>.json (mainnet, Sepolia) or stdout (local). On
 * mainnet it replaces the committed `awaiting-broadcast` file 1.json (SH-188); the platform must be the deployed Safe.
 * --platform-eoa: the factory's platform has no code (Sepolia's box 0 with the runbook's Z3: the testnet deployer, or
 * the mainnet Safe's address, which has no code there); taken only when box 0's spec names that address. Without it a
 * Sepolia platform must have code.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, isAddress } from 'viem';
import { readCoreManifest, viemCoreReads } from '../src/core/core-manifest-writer.ts';

const here = dirname(fileURLToPath(import.meta.url));
const deploymentsDir = resolve(here, '../../contracts/deployments/core-v1');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const rpc = arg('rpc');
const factory = arg('factory');
const network = arg('network') ?? 'sepolia';
const gitCommit = arg('git-commit') ?? null;
const platformEoa = process.argv.includes('--platform-eoa');
if (!rpc || !factory || !isAddress(factory) || !['mainnet', 'sepolia', 'local'].includes(network)) {
  console.error('usage: write-core-manifest.mjs --rpc <keyless URL> --factory <address> [--network mainnet|sepolia|local] [--out <file>] [--git-commit <hex>] [--platform-eoa]');
  process.exit(2);
}
const url = new URL(rpc);
if (url.username || url.password || url.search) {
  console.error('error: the RPC URL must be keyless (no credentials, no query string)');
  process.exit(2);
}
if (gitCommit !== null && !/^[0-9a-f]{40}$/.test(gitCommit)) {
  console.error('error: --git-commit must be 40 lowercase hex characters');
  process.exit(2);
}

const client = createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 2 }) });
const manifest = await readCoreManifest(viemCoreReads(client), factory, { network, gitCommit, platformEoa });
const text = `${JSON.stringify(manifest, null, 2)}\n`;
const out = arg('out') ?? (network === 'local' ? null : resolve(deploymentsDir, `${manifest.chainId}.json`));
if (out === null) {
  process.stdout.write(text);
} else {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), text);
  process.stderr.write(`wrote ${resolve(out)} (chain ${manifest.chainId}, evidence block ${manifest.evidence.block.number})\n`);
}
