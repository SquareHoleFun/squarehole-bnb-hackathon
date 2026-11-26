/**
 * SH-261: a LOCAL chain with id 97 for the demo boxes: started from a rehearsal's state dump (lane c's
 * `anvil-state.json.gz`) or as a fork of an endpoint (the dry run of a real run), its unlocked accounts, and the local
 * funding of a wallet with a test coin from the deployer (impersonated on the local node only). Never a key.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { erc20Abi, toHex } from 'viem';
import { CHAIN_ID, makeChain, nodeSender, registerLocalNode, rpc, stateStore } from './chain.mjs';

export { CHAIN_ID, rpc };
/** The deployer of the real run (lane c, SH-260): it holds the test coins' supply on the rehearsal chain. */
export const DEPLOYER = '0x2EF9A78074bbf674bEA16f21154a30c821A3C576';
const delay = ms => new Promise(done => setTimeout(done, ms));

/** Whether something already listens on 127.0.0.1:`port`. */
export function portTaken(port) {
  return new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('error', () => done(false));
  });
}

/** A free port on 127.0.0.1, chosen by the system now (for a dry run's fork, unless one is given). */
export function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); });
  });
}

/**
 * anvil on 127.0.0.1:`port`, ours: a port that already answers is refused BEFORE starting (a run must never attach to
 * another run's node: on 25 November a dry run attached to this lane's chain and sent on it), the child's own
 * "Listening on 127.0.0.1:<port>" line is awaited, and the child exiting before or after that fails the start.
 */
export async function anvil(args, port) {
  if (await portTaken(port)) throw new Error(`127.0.0.1:${port} already answers: refusing to start (or attach to) a node there`);
  const child = spawn('anvil', [...args, '--port', String(port), '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', d => { stdout += d; if (stdout.length > 65_536) stdout = stdout.slice(-16_384); });
  child.stderr.on('data', d => { stderr += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 480; i += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`anvil exited before listening: ${stderr.slice(-2000)}`);
    if (stdout.includes(`Listening on 127.0.0.1:${port}`)) {
      // Every later request to this node checks that this child still runs (chain.mjs resilientFetch).
      registerLocalNode(url, child);
      assert.equal(Number(await rpc(url, 'eth_chainId')), CHAIN_ID, 'our node answers chain id 97');
      return { url, child, port, stop: () => stopChain(child) };
    }
    await delay(250);
  }
  stopChain(child);
  throw new Error(`anvil did not report listening on 127.0.0.1:${port}`);
}

/** anvil on `port` from the dump (the plain rehearsal: the release deployed). */
export async function startChain({ dumpGz, workDir, port }) {
  mkdirSync(workDir, { recursive: true });
  const state = join(workDir, 'anvil-state.json');
  writeFileSync(state, gunzipSync(readFileSync(dumpGz)));
  return anvil(['--load-state', state, '--chain-id', String(CHAIN_ID), '--hardfork', 'osaka', '--base-fee', '0', '--gas-limit', '100000000'], port);
}

/**
 * anvil on `port` as a fork of `forkUrl` at its latest block, or at `forkBlock` (a pinned rehearsal): the dry run of a
 * real run (nothing reaches that chain).
 */
export async function startFork({ forkUrl, port, forkBlock = null }) {
  return anvil(['--fork-url', forkUrl, ...(forkBlock === null ? [] : ['--fork-block-number', String(forkBlock)]), '--chain-id', String(CHAIN_ID), '--hardfork', 'osaka', '--no-rate-limit'], port);
}

/** Multicall3's canonical address (reveal-batch-calls-v2.ts) and its runtime code hash (items.mjs). */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_CODE_HASH = '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891';

/**
 * A local chain from the plain rehearsal has no Multicall3 (the real chain 97 has the canonical deployment). Its
 * runtime code is read from a public chain-97 endpoint, checked against the canonical hash and set at the same
 * address on the LOCAL node only.
 */
export async function plantMulticall3(url, codeSource) {
  if ((await rpc(url, 'eth_getCode', [MULTICALL3, 'latest'])) !== '0x') return 'present';
  const code = await rpc(codeSource, 'eth_getCode', [MULTICALL3, 'latest']);
  const { keccak256 } = await import('viem');
  assert.equal(keccak256(code), MULTICALL3_CODE_HASH, 'the code read is the canonical Multicall3');
  await rpc(url, 'anvil_setCode', [MULTICALL3, code]);
  return 'planted';
}

export function stopChain(child) {
  if (child.exitCode === null) child.kill('SIGTERM');
}

/** A local node's chain: its unlocked accounts send (or `impersonate`d addresses), its clock is moved. */
export function localChain(url, { store = stateStore(), log = () => undefined } = {}) {
  assert.match(new URL(url).hostname, /^127\.0\.0\.1$/, 'a local chain only');
  const chain = makeChain({ url, sender: nodeSender(url), store, clock: 'warp', log });
  chain.accounts = async () => rpc(url, 'eth_accounts');
  chain.impersonate = async address => rpc(url, 'anvil_impersonateAccount', [address]);
  /** Local funding only: the deployer, impersonated on this node, sends `amount` of a test coin. */
  chain.fund = async (coin, to, amount) => {
    await rpc(url, 'anvil_impersonateAccount', [DEPLOYER]);
    // Gas money for the impersonated deployer on this local node only.
    if (await chain.client.getBalance({ address: DEPLOYER }) < 10n ** 17n) await rpc(url, 'anvil_setBalance', [DEPLOYER, toHex(10n ** 18n)]);
    try {
      return await chain.act(`fund ${coin} ${to}`, () => chain.send(DEPLOYER, coin, erc20Abi, 'transfer', [to, amount]).then(r => r.transactionHash));
    } finally { await rpc(url, 'anvil_stopImpersonatingAccount', [DEPLOYER]); }
  };
  return chain;
}
