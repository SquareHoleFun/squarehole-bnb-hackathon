#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makePlan, runExplorer } from './lib/verify-sources.mjs';
import { readJson, requireValue, VerificationError } from './lib/verify-sources-common.mjs';
import { realpathSync } from 'node:fs';

const usage = 'verify-sources: --plan|--submit|--status --manifest FILE [--deployment FILE] [--build-dir DIR] [--source-root DIR] [--key-env NAME] [--allow-mainnet]\n';

export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text) => process.stderr.write(text));
  try {
    if (argv.length === 1 && argv[0] === '--help') { stdout(usage); return 0; }
    const args = {}; let mode;
    const values = new Set(['--manifest', '--deployment', '--build-dir', '--source-root', '--key-env']);
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (['--plan', '--submit', '--status'].includes(flag)) {
        requireValue(!mode, 'choose exactly one verification mode'); mode = flag.slice(2);
      } else if (flag === '--allow-mainnet') {
        requireValue(!args[flag], 'duplicate operator flag'); args[flag] = true;
      } else {
        requireValue(values.has(flag) && !args[flag] && argv[i + 1] && !argv[i + 1].startsWith('--'), 'unknown, duplicate or incomplete argument');
        args[flag] = argv[++i];
      }
    }
    requireValue(mode && args['--manifest'], usage.trim());
    const manifest = await readJson(args['--manifest']);
    const supplement = args['--deployment'] ? await readJson(args['--deployment']) : undefined;
    const plan = await makePlan(manifest, { supplement, baseDir: dirname(resolve(args['--deployment'] ?? args['--manifest'])),
      buildDir: args['--build-dir'], sourceRoot: args['--source-root'], allowMainnet: args['--allow-mainnet'] });
    if (mode === 'plan') { stdout(`${JSON.stringify(plan, null, 2)}\n`); return 0; }
    const keyEnv = args['--key-env'] ?? 'ETHERSCAN_API_KEY';
    requireValue(/^[A-Z_][A-Z0-9_]*$/.test(keyEnv), 'invalid explorer key environment variable name');
    const key = (io.env ?? process.env)[keyEnv];
    const result = await runExplorer(plan, { mode, key, allowMainnet: args['--allow-mainnet'], fetch: io.fetch, sleep: io.sleep });
    stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    stderr(`verify-sources: ${error instanceof VerificationError ? error.message : 'invalid public verification input'}\n`);
    return 1;
  }
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) process.exitCode = await runCli(process.argv.slice(2));
