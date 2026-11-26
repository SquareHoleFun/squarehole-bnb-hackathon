import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactErrors, diagnoseLocalFailure } from './core-v2-local-diagnostics.mjs';
import { markLocalFailure } from './core-v2-local-failure.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const CONTRACTS = join(ROOT, 'packages/contracts');
export const CHAIN_ID = 11155111;
export const ALPHA_CHAIN_ID = 31337;
export const TX_GAS = 15_000_000n; // Includes the named fail-safe stipends; below EIP-7825.
export const hex = n => `0x${BigInt(n).toString(16)}`;
export const json = value => `${JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2)}\n`;
export const delay = ms => new Promise(done => setTimeout(done, ms));
/**
 * SH-RC7 open item 30: the site's dev server in a browser suite's stack (the core v2 chain suite and the examples) watches
 * no file (apps/web/dev-server-watch.ts), so a late file event, such as one for the stack's own manifest, can never
 * update its modules while a test loads a page. The founder's `pnpm dev:core-v2-local` keeps its live reload.
 */
export const E2E_DEV_SERVER_ENV = Object.freeze({ SH_DEV_SERVER_WATCH: 'off' });

function assertLocalPort(port) {
  const reserved = new Set([8547, 8548, 8549, 8552, 8562, 8564, 5391, 5392, 4173, 4174, 4175, 5173]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || reserved.has(port)) throw new Error(`local v2 port refused: ${port}`);
}

export function localOptions(env = process.env) {
  const chainPort = Number(env.SH_CORE_V2_CHAIN_PORT ?? 8566);
  const appPort = Number(env.DEV_PORT ?? 5396);
  const gatewayPort = Number(env.SH_CORE_V2_GATEWAY_PORT ?? 5395);
  const artPort = Number(env.SH_CORE_V2_ART_PORT ?? 5387);
  for (const port of [chainPort, appPort, gatewayPort, artPort]) assertLocalPort(port);
  if (new Set([chainPort, appPort, gatewayPort, artPort]).size !== 4) throw new Error('local v2 ports must differ');
  return { chainPort, appPort, gatewayPort, artPort };
}

export async function rpc(url, method, params = []) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { data: body.error.data });
  return body.result;
}

export async function assertLocalRpc(url, request = rpc, { alpha = false } = {}) {
  const u = new URL(url);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.search || u.hash || u.pathname !== '/') {
    throw new Error('only a credential-free loopback anvil URL is allowed');
  }
  assertLocalPort(Number(u.port));
  if (BigInt(await request(url, 'eth_chainId')) !== BigInt(alpha ? ALPHA_CHAIN_ID : CHAIN_ID)) throw new Error('wrong local chain id');
  if (!(await request(url, 'web3_clientVersion')).startsWith('anvil/')) throw new Error('local node must be anvil');
}

export async function freePort(port) {
  await new Promise((done, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(done));
  });
}

export async function send(url, transaction, request = rpc) {
  const tx = { ...transaction, gas: hex(TX_GAS) };
  if (typeof tx.value === 'bigint') tx.value = hex(tx.value);
  const hash = await request(url, 'eth_sendTransaction', [tx]);
  return waitLocalReceipt(url, hash, request);
}

/** Also used by the browser test wallet, which preserves the UI's original gas limit and calldata. */
export async function waitLocalReceipt(url, hash, request = rpc) {
  for (let i = 0; i < 400; i += 1) {
    const receipt = await request(url, 'eth_getTransactionReceipt', [hash]);
    if (receipt) {
      if (receipt.status !== '0x1') throw Object.assign(new Error(`transaction ${hash} reverted`), { transactionHash: hash });
      return receipt;
    }
    await delay(25);
  }
  throw Object.assign(new Error(`transaction ${hash} was not mined`), { transactionHash: hash });
}

/** The operation must target the already checked local anvil. Diagnostics finish before callers clean up. */
export async function runLocalStep(chain, name, operation,
  { request = rpc, report = console.error, errors = () => artifactErrors(CONTRACTS) } = {}) {
  try { return await operation(); }
  catch (error) {
    try { markLocalFailure(name); }
    catch (markerError) { report(`[core-v2] failure marker unavailable: ${markerError.message}`); }
    try { await diagnoseLocalFailure(chain, name, error, { request, report, errors }); }
    catch (diagnosticError) { report(`[core-v2] FAILED ${name}: diagnostic unavailable: ${diagnosticError.message}`); }
    throw new Error(`Local life step ${name} failed: ${error.message}`, { cause: error });
  }
}

/**
 * SH-229: waits until the local indexer follows the chain at the block that is the head now. A test that sends
 * hundreds of transactions (a kit's 420 reveals) leaves the indexer behind, for minutes on a slow machine; while it
 * is behind its gateway answers 503 and lists no new box, and the next test's own waits (30 to 120 s for a new box)
 * were never meant to cover another test's backlog. Reads the gateway's /healthz: it follows, and its feed is at the
 * head or past it. Returns the milliseconds waited. A backlog is worked off block by block, so the wait lasts only
 * while the gateway's block moves: after `stall` without a new block (or without any answer) it throws, as it does
 * after `timeout` in all, each time with the block waited for and the gateway's last answer.
 */
export async function waitIndexerFollows(chain, { timeout = 900_000, stall = 60_000, interval = 500, request = rpc, read = fetch, now = Date.now, sleep = delay } = {}) {
  const origin = `http://127.0.0.1:${chain.ports.gatewayPort}`;
  const started = now();
  const head = BigInt(await request(chain.rpcUrl, 'eth_blockNumber'));
  let last;
  let seen = null;
  let moved = started;
  for (;;) {
    try {
      const response = await read(`${origin}/healthz`, { signal: AbortSignal.timeout(5_000) });
      const health = await response.json();
      const block = health?.asOf?.block;
      last = `status ${response.status}, following ${health?.following}, block ${block ?? 'none'}${health?.reason ? `, ${health.reason}` : ''}`;
      if (/^[0-9]+$/.test(String(block))) {
        if (response.status === 200 && health?.following === true && BigInt(block) >= head) return now() - started;
        if (String(block) !== seen) { seen = String(block); moved = now(); }
      }
    } catch (error) { last = `no answer: ${error?.message ?? error}`; }
    if (now() - moved >= stall) throw new Error(`the local indexer made no progress for ${stall} ms before block ${head} (${last})`);
    if (now() - started >= timeout) throw new Error(`the local indexer does not follow the chain at block ${head} after ${timeout} ms (${last})`);
    await sleep(interval);
  }
}

export async function mineTo(url, timestamp, request = rpc) {
  const block = await request(url, 'eth_getBlockByNumber', ['latest', false]);
  if (BigInt(block.timestamp) >= timestamp) return;
  await request(url, 'evm_setNextBlockTimestamp', [hex(timestamp)]);
  await request(url, 'evm_mine');
}

export function toolEnv(extra = {}) {
  const env = { ...process.env, PATH: `${join(homedir(), '.foundry/bin')}:${process.env.PATH ?? ''}`, ...extra };
  delete env.DEPLOYER_PRIVATE_KEY; delete env.ETH_PRIVATE_KEY;
  return env;
}

const children = new Set();
const chains = new WeakSet();
let stopping = false;

function forgeTimeoutMs(env) {
  const value = env.SH_FORGE_TIMEOUT_MS ?? process.env.SH_FORGE_TIMEOUT_MS ?? '300000';
  const ms = Number(value);
  // Node clamps overflowing timer delays to 1 ms, so reject them before spawning.
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647) {
    throw new Error('SH_FORGE_TIMEOUT_MS must be a positive integer no greater than 2147483647');
  }
  return ms;
}

/** Async so SIGTERM/global timeout can interrupt a stalled forge broadcast or compilation. */
export async function run(command, args, { cwd = CONTRACTS, env = {}, timeoutHint = '',
  timeoutMs = basename(command) === 'forge' ? forgeTimeoutMs(env) : 300_000 } = {}) {
  const proc = child(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let bytes = 0; let timer;
  try {
    await new Promise((done, reject) => {
      const collect = chunk => {
        bytes += chunk.length;
        if (bytes > 128 * 1024 * 1024) { reject(new Error(`${command}: output limit exceeded`)); return; }
        output += chunk;
      };
      proc.stdout.on('data', collect); proc.stderr.on('data', collect);
      proc.once('error', reject);
      proc.once('close', (code, signal) => code === 0 ? done() : reject(new Error(`${command} failed (${signal ?? code}):\n${output}`)));
      timer = setTimeout(() => reject(new Error(`${command} timed out after ${timeoutMs} ms:\n${output}${timeoutHint ? `\n${timeoutHint}` : ''}`)), timeoutMs);
    });
    return output;
  } finally {
    clearTimeout(timer);
    await stopChild(proc);
  }
}

export function child(command, args, options = {}) {
  if (stopping) throw new Error('local stack is stopping');
  const { keepOnFailure = false, ...spawnOptions } = options;
  const proc = spawn(command, args, { cwd: ROOT, stdio: 'inherit', detached: true, ...spawnOptions, env: toolEnv(options.env) });
  children.add(proc);
  if (keepOnFailure) chains.add(proc);
  // Keep exited group leaders until cleanup: their descendants may still be alive.
  proc.once('error', () => {}); // callers receive the error; prevent unhandled spawn errors during shutdown
  return proc;
}

/** Signal the owned group even if its leader exited (pnpm/shell descendants can still hold ports and pipes). */
export async function stopChild(proc, { graceMs = 2000 } = {}) {
  if (!proc?.pid) return;
  const signal = name => {
    try { process.kill(-proc.pid, name); return true; }
    // macOS answers EPERM for a group whose members are all zombies; that group is gone too, and throwing here
    // would hide the startup error that brought us to cleanup.
    catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; return false; }
  };
  if (signal('SIGTERM')) {
    const deadline = Date.now() + graceMs;
    while (signal(0) && Date.now() < deadline) await delay(20);
    signal('SIGKILL');
    // Reaping and pipe closure follow asynchronously; never wait indefinitely for a close event.
    const reapDeadline = Date.now() + 1000;
    while (proc.exitCode === null && proc.signalCode === null && Date.now() < reapDeadline) await delay(20);
  }
  children.delete(proc);
}

/** Includes anvil/forge still in startup, before a chain handle has been returned to the supervisor. */
export async function stopChildren({ failure = false } = {}) {
  stopping = true;
  await Promise.all([...children].map(proc => {
    if (failure && process.env.SH_CORE_V2_KEEP_CHAIN === '1' && chains.has(proc)
        && proc.pid && proc.exitCode === null && proc.signalCode === null) {
      children.delete(proc);
      proc.unref();
      console.error(`SH_CORE_V2_KEEP_CHAIN=1: retained anvil pid ${proc.pid}; stop after inspection with: kill -- -${proc.pid}`);
      return;
    }
    return stopChild(proc);
  }));
}
