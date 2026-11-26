#!/usr/bin/env node
/**
 * SH-SEP-MANIFEST: adds a core v2 release to the Sepolia manifest (`packages/contracts/deployments/core-v1/11155111.json`,
 * the file install.sh copies to /srv/squarehole/manifests/11155111.json for the indexer and the CoW poster). Inputs are
 * the founder's public deploy outputs only: the reviewed release plan, the public copy of the broadcast run file,
 * VerifyCoreV2's `forge script --json` output and the registry address he reports. No key, no forge cache file, no
 * signing, no sending. The result is cross-checked (src/core/v2/sepolia-release.ts), then checked against the chain at
 * the v1 manifest's evidence block with read-only JSON-RPC (src/core/v2/sepolia-release-chain.ts), then written.
 *
 * Usage (from packages/chain; `pnpm core-v2-release:write -- …` adds the TypeScript flags):
 *   node --experimental-transform-types --no-warnings=ExperimentalWarning --import ./scripts/register-ts.mjs \
 *     scripts/write-sepolia-v2-release.mjs --plan <reviewed plan.json> --run <run file copy.json> \
 *     --verify-json <VerifyCoreV2 --json output> --registry <address> --rpc <keyless Sepolia URL>
 *     [--v1 <v1 manifest>] [--out <file>|-] [--fit-control-proof <in>,<out>] [--platform-control-proof <in>,<out>]
 *     [--replace] [--min-interval-ms 2000]
 *   --offline instead of --rpc skips the chain check and prints to stdout only (a preview; never committed).
 * Default --v1 and --out: packages/contracts/deployments/core-v1/11155111.json (rewritten in place).
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, custom } from 'viem';
import { buildSepoliaRelease } from '../src/core/v2/sepolia-release.ts';
import { checkReleaseOnChain, viemReleaseReads } from '../src/core/v2/sepolia-release-chain.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = resolve(here, '../../contracts/deployments/core-v1/11155111.json');
const CONTRACTS_CACHE = resolve(here, '../../contracts/cache') + sep;

const usage = 'usage: write-sepolia-v2-release.mjs --plan <file> --run <file> --verify-json <file> --registry <address> (--rpc <keyless URL> | --offline) [--v1 <file>] [--out <file>|-] [--fit-control-proof <in>,<out>] [--platform-control-proof <in>,<out>] [--replace] [--min-interval-ms <n>]';
function die(message, code = 2) {
  console.error(`error: ${message}`);
  process.exit(code);
}
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || (value.startsWith('--') && value !== '-')) die(`--${name} needs a value\n${usage}`);
  return value;
}
const flag = (name) => process.argv.includes(`--${name}`);
function input(name, path) {
  if (!path) die(`--${name} is required\n${usage}`);
  const full = resolve(path);
  // forge's "sensitive values" file lives under cache/: never an input (only the public broadcast file is).
  if (full.startsWith(CONTRACTS_CACHE) || /(^|[\\/])cache[\\/].*run-latest\.json$/.test(full)) die(`--${name}: ${path} is under forge's cache/ (sensitive values); pass the public broadcast file's copy`);
  try {
    return readFileSync(full, 'utf8');
  } catch (error) {
    return die(`--${name}: cannot read ${path} (${error.code ?? error.message})`);
  }
}
function json(name, text) {
  try {
    return JSON.parse(text);
  } catch {
    return die(`--${name} is not JSON`);
  }
}
function proof(name) {
  const value = arg(name);
  if (value === undefined) return undefined;
  const [inTx, outTx, extra] = value.split(',');
  if (!inTx || !outTx || extra !== undefined) die(`--${name} takes <in tx hash>,<out tx hash>`);
  return { inTx, outTx };
}

/** One JSON-RPC request at a time; each sent at least `minIntervalMs` after the previous answer (public endpoints' manners). */
function throttledTransport(url, minIntervalMs) {
  let last = 0;
  let queue = Promise.resolve();
  let id = 0;
  const send = async ({ method, params }) => {
    const wait = last + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code, data: body.error.data });
      return body.result;
    } finally {
      // Counted from the answer, so two requests never reach the host closer than the interval, whatever the latency.
      last = Date.now();
    }
  };
  return custom({ request: (args) => (queue = queue.then(() => send(args), () => send(args))) }, { retryCount: 2 });
}

const offline = flag('offline');
const rpc = arg('rpc');
if (offline === Boolean(rpc)) die(`pass exactly one of --rpc and --offline\n${usage}`);
// A loopback http RPC is accepted for this script's own test (a fake JSON-RPC answering at 127.0.0.1); Sepolia is https.
const loopback = (url) => url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
let rpcUrl = null;
if (rpc) {
  try {
    rpcUrl = new URL(rpc);
  } catch {
    die('--rpc is not a URL');
  }
  if (rpcUrl.username || rpcUrl.password || rpcUrl.search || (rpcUrl.protocol !== 'https:' && !loopback(rpcUrl))) die('the RPC URL must be a keyless https URL (no credentials, no query string)');
}
const out = arg('out') ?? (offline ? '-' : MANIFEST);
if (offline && out !== '-') die('--offline prints a preview to stdout only (--out -): a committed manifest needs the chain check');
const minIntervalMs = Number.parseInt(arg('min-interval-ms') ?? '2000', 10);
if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0 || (minIntervalMs < 2000 && !(rpcUrl && loopback(rpcUrl)))) die('--min-interval-ms is at least 2000 (public endpoints)');
const v1Path = arg('v1') ?? MANIFEST;
const controlProofs = { fit: proof('fit-control-proof'), platform: proof('platform-control-proof') };

let result;
try {
  result = buildSepoliaRelease({
    v1Manifest: json('v1', input('v1', v1Path)),
    plan: json('plan', input('plan', arg('plan'))),
    run: json('run', input('run', arg('run'))),
    verifyOutput: input('verify-json', arg('verify-json')),
    registry: arg('registry') ?? die(`--registry is required\n${usage}`),
    controlProofs,
    replace: flag('replace'),
  });
} catch (error) {
  die(error instanceof Error ? error.message : String(error), 1);
}
const { json: manifestJson, manifest, report } = result;
const release = manifest.releases.at(-1); // buildSepoliaRelease appends this release last
// buildSepoliaRelease records the directory event's hash; the chain check below must authenticate it before writing.
process.stderr.write(`directory: ${release.feeModuleDirectory.address}, hash ${release.feeModuleDirectory.codeHash} (chain check required)\n`);
process.stderr.write(`release: factory ${release.factory.address}, registry ${release.registry.address}, start block ${report.startBlock} (receipts ${report.startBlock}-${report.lastBlock}, ${report.transactions} transactions from ${report.deployer})${report.extraCreated.length ? `; also created ${report.extraCreated.join(', ')}` : ''}${report.replaced ? '; replaced the earlier entry' : ''}\n`);

if (rpc) {
  const client = createPublicClient({ transport: throttledTransport(rpc, minIntervalMs) });
  let problems;
  try {
    problems = await checkReleaseOnChain(manifest, release, viemReleaseReads(client), controlProofs);
  } catch (error) {
    die(`chain check failed to read: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
  if (problems.length) die(`the chain at block ${manifest.evidence.block.number} disagrees:\n  ${problems.join('\n  ')}`, 1);
  process.stderr.write(`chain check: all reads at block ${manifest.evidence.block.number} (${manifest.evidence.block.hash}) agree\n`);
} else {
  process.stderr.write('chain check: SKIPPED (--offline preview; do not commit this output)\n');
}

const text = `${JSON.stringify(manifestJson, null, 2)}\n`;
if (out === '-') {
  process.stdout.write(text);
} else {
  const target = resolve(out);
  writeFileSync(`${target}.tmp`, text);
  renameSync(`${target}.tmp`, target);
  process.stderr.write(`wrote ${target} (${manifest.releases.length} release(s), evidence block ${manifest.evidence.block.number})\n`);
}
