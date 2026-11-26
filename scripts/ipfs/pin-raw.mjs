#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PinRawError, readBytes, runPinRaw } from './pin-raw-lib.mjs';
import { realpathSync } from 'node:fs';

const HELP = `Usage: node scripts/ipfs/pin-raw.mjs --manifest FILE MODE [OPTIONS]

Modes (exactly one required):
  --dry-run             Compute hashes and raw CIDs offline; never read credentials.
  --pin                 Import one raw-block CAR per file into Pinata.
  --check               Check gateway bytes without uploading or reading credentials.

Options:
  --key-env NAME        Environment variable containing the Pinata JWT (pin only).
  --key-file FILE       File containing the Pinata JWT (pin only).
  --gateway ORIGIN      HTTPS gateway origin; required for check, optional after pin.
  --timeout-ms INTEGER  Per-request deadline, 1..600000 ms; default 60000.
  --help                Show this help offline.

Never put a key value in arguments. Use exactly one key source for pin.
Paths in the manifest resolve relative to that manifest. Output is JSON lines.
Encoding defaults/overrides are declared in the manifest; no image is re-encoded.
See docs/runbooks/pin-raw-blocks.md for the manifest schema and reveal precautions.
`;

function parseArguments(argv) {
  const options = {};
  const names = { '--manifest': 'manifestPath', '--key-env': 'keyEnv', '--key-file': 'keyFile', '--gateway': 'gateway', '--timeout-ms': 'timeoutMs' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--dry-run', '--pin', '--check'].includes(arg)) {
      if (options.mode) throw new PinRawError('choose exactly one mode');
      options.mode = arg.slice(2);
      continue;
    }
    const name = names[arg];
    if (!Object.hasOwn(names, arg) || Object.hasOwn(options, name)
        || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new PinRawError('invalid, missing or repeated option; use --help');
    options[name] = argv[++i];
  }
  if (!options.mode || !options.manifestPath) throw new PinRawError('manifest and exactly one mode are required; use --help');
  if (options.timeoutMs !== undefined) {
    if (!/^[0-9]{1,6}$/.test(options.timeoutMs)) throw new PinRawError('invalid timeout-ms');
    options.timeoutMs = Number(options.timeoutMs);
  }
  return options;
}

export async function runCli(argv, dependencies = {}) {
  const { stdout = (text) => process.stdout.write(text), stderr = (text) => process.stderr.write(text), readBytes: read = readBytes } = dependencies;
  try {
    if (argv.length === 1 && argv[0] === '--help') {
      stdout(HELP);
      return 0;
    }
    const options = parseArguments(argv);
    let manifest;
    try {
      manifest = JSON.parse((await read(options.manifestPath, 4_194_304)).toString('utf8'));
    } catch {
      throw new PinRawError('cannot read manifest JSON (regular file, at most 4 MiB required)');
    }
    await runPinRaw({ ...options, manifest, baseDirectory: dirname(resolve(options.manifestPath)) }, {
      ...dependencies, onResult: (record) => stdout(`${JSON.stringify(record)}\n`),
    });
    return 0;
  } catch (error) {
    stderr(`pin-raw: ${error instanceof PinRawError ? error.message : 'operation failed; details suppressed'}\n`);
    return 1;
  }
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
