#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { ArchiveError, fail, fileStateStore, readJson } from './common.mjs';
import { runArchive } from './arweave-lib.mjs';
import { deployment } from './revealed-source.mjs';
import { realpathSync } from 'node:fs';

const HELP = `Usage: node scripts/arweave/upload.mjs --dry-run | --upload | --check [--allow-mainnet]

Inputs: SH_REVEAL_PUBLIC, SH_REVEAL_FEED, SH_REVEAL_STATE (pin job files)
Deployment: SH_ARWEAVE_CHAIN_ID, SH_ARWEAVE_COLLECTION, SH_ARWEAVE_RPC_URL
Archive: SH_ARWEAVE_STATE (private durable receipt file; parent must exist)
Sources: SH_ARWEAVE_IPFS_GATEWAY (HTTPS origin)
Provider: SH_ARWEAVE_UPLOAD_ORIGIN, SH_ARWEAVE_PAYMENT_ORIGIN (Turbo HTTPS origins)
Checks: SH_ARWEAVE_GATEWAY_1, SH_ARWEAVE_GATEWAY_2 (independent HTTPS origins),
        SH_ARWEAVE_MIN_CONFIRMATIONS (positive decimal)
Budget: SH_ARWEAVE_MAX_WINC (cumulative estimate ceiling, decimal; dry-run/upload)
Signer: SH_ARWEAVE_KEY_FILE (path to RSA JWK; read only for new uploads)

No endpoint, chain, budget or key defaults. No wallet funding or EVM sends.
Exit 0: complete; 1: refused/error; 2: unreadable plan or verification pending.
See docs/runbooks/arweave.md for provenance, provider assumptions and recovery.
`;

export async function runCli(argv, { env = process.env, fetch = globalThis.fetch, loadKey,
  stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {}) {
  try {
    if (argv.length === 1 && argv[0] === '--help') { stdout(HELP); return 0; }
    const modes = argv.filter((s) => ['--dry-run', '--upload', '--check'].includes(s));
    if (modes.length !== 1 || argv.some((s) => !['--dry-run', '--upload', '--check', '--allow-mainnet'].includes(s)) || new Set(argv).size !== argv.length) fail('choose exactly one mode and optional --allow-mainnet; use --help');
    const mode = modes[0].slice(2);
    const allowMainnet = argv.includes('--allow-mainnet');
    deployment(env, allowMainnet);
    const publicFile = await readJson(env.SH_REVEAL_PUBLIC);
    const feed = await readJson(env.SH_REVEAL_FEED);
    const pinState = await readJson(env.SH_REVEAL_STATE);
    const run = (store) => runArchive({ mode, allowMainnet, env, publicFile, feed, pinState, store, fetch, loadKey,
      onResult: (value) => stdout(`${JSON.stringify(value)}\n`) });
    // A read-only plan needs existing receipts to avoid pricing accepted files.
    // Missing state is the only permissible fallback; malformed state fails closed.
    const result = mode === 'dry-run'
      ? await run({ load: async () => {
        if (!env.SH_ARWEAVE_STATE) fail('state file environment variable required');
        const { lstat } = await import('node:fs/promises');
        try { await lstat(env.SH_ARWEAVE_STATE); }
        catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
        return readJson(env.SH_ARWEAVE_STATE, 67_108_864);
      }, save: async () => fail('dry-run cannot write state') })
      : await fileStateStore(env.SH_ARWEAVE_STATE, run);
    return result ? 0 : 2;
  } catch (error) {
    stderr(`arweave: ${error instanceof ArchiveError ? error.message : 'operation failed; details suppressed'}\n`);
    return 1;
  }
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) process.exitCode = await runCli(process.argv.slice(2));
