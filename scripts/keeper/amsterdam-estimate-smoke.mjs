#!/usr/bin/env node
// Manual integrator probe only. No signer, key, broadcasts or gate invocation.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { realpathSync } from 'node:fs';

const METHODS = new Set(['eth_chainId', 'eth_config', 'eth_getBlockByNumber', 'eth_getCode',
  'eth_getBalance', 'eth_getTransactionCount', 'eth_estimateGas']);
const hex = n => `0x${n.toString(16)}`;
const quantity = value => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new Error('invalid RPC quantity');
  return BigInt(value);
};
const check = (condition, reason) => { if (!condition) throw new Error(reason); };

/** Calls are serialized and separated by 2.1 seconds after completion, including failed requests. */
export function createReadOnlyRpc(url, { fetch = globalThis.fetch, sleep: wait = sleep } = {}) {
  let previous = Promise.resolve(), id = 0;
  return (method, params = []) => {
    if (!METHODS.has(method)) return Promise.reject(new Error('read-only RPC method required'));
    const result = previous.then(async () => {
      if (id > 0) await wait(2100);
      const requestId = ++id;
      const response = await fetch(url, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
      check(response.ok, 'RPC HTTP failure');
      const body = await response.json();
      check(body.id === requestId && body.jsonrpc === '2.0', 'invalid RPC envelope');
      if (body.error) throw Object.assign(new Error('RPC request rejected'), { code: body.error.code });
      return body.result;
    });
    previous = result.catch(() => {});
    return result;
  };
}

/** Injection exists solely for offline verification; the executable below uses only the read-only transport. */
export async function smoke({ rpc, sender, recipient, fundedSender = false }) {
  const { destinationGasAdapters } = await import('../../packages/keeper/src/config.ts');
  const { gasLimitFrom, GasAdmissionError, EIP7825_GAS_CAP: cap } = await import('../../packages/keeper/src/gas.ts');
  check([sender, recipient].every(a => /^0x[0-9a-fA-F]{40}$/.test(a)) && sender !== recipient, 'invalid probe addresses');
  check(quantity(await rpc('eth_chainId')) === 11155111n, 'expected Sepolia chain id 11155111');
  const config = await rpc('eth_config');
  check(BigInt(config?.current?.activationTime ?? -1) === 1791294816n, 'expected Amsterdam activationTime 1791294816');
  const header = await rpc('eth_getBlockByNumber', ['latest', false]);
  quantity(header?.slotNumber);
  check(/^0x[0-9a-fA-F]{64}$/.test(header?.blockAccessListHash), 'missing blockAccessListHash');
  const blockGasLimit = quantity(header.gasLimit);
  const maxFeePerGas = 2n * quantity(header.baseFeePerGas) + 1n;
  check(await rpc('eth_getCode', [recipient, 'pending']) === '0x', 'recipient has code');
  check(quantity(await rpc('eth_getTransactionCount', [recipient, 'pending'])) === 0n, 'recipient has a nonce');
  check(quantity(await rpc('eth_getBalance', [recipient, 'pending'])) === 0n, 'recipient has a balance');
  let funding = 'state override';
  const client = { estimateGas: async request => {
    const tx = { from: request.account, to: request.to, data: request.data, value: hex(request.value),
      maxFeePerGas: hex(request.maxFeePerGas), maxPriorityFeePerGas: hex(request.maxPriorityFeePerGas) };
    try {
      return quantity(await rpc('eth_estimateGas', [tx, request.blockTag, { [sender]: { balance: hex(10n ** 20n) } }]));
    } catch (error) {
      if (error.code !== -32602) throw error;
      check(fundedSender, 'override unsupported: set SH_KEEPER_SMOKE_SENDER to a funded public sender');
      funding = 'existing balance';
      return quantity(await rpc('eth_estimateGas', [tx, request.blockTag]));
    }
  } };
  const policy = { fork: 'amsterdam', transactionCap: cap };
  const g = destinationGasAdapters(policy, client);
  const request = { account: sender, to: recipient, data: '0x', value: 1n,
    maxFeePerGas, maxPriorityFeePerGas: 1n, blockTag: 'pending' };
  const pair = await g.estimator(request);
  check(pair.gas >= 204600n && pair.gas <= 207669n, 'transfer estimate outside [204600, 207669]');
  const admit = async (adapters, estimate) => gasLimitFrom(estimate.gas, 0n,
    { ...await adapters.reader({}, estimate.gas, { gasLimit: blockGasLimit }, estimate), blockGasLimit });
  check(await admit(g, pair) <= cap, 'signed limit exceeds cap');
  // Synthetic oversized reply tests the production adapter/admission boundary without expensive live work.
  const oversized = destinationGasAdapters(policy, { estimateGas: async () => cap + 1n });
  let refused = false;
  try { await admit(oversized, await oversized.estimator(request)); }
  catch (error) { refused = error instanceof GasAdmissionError && error.message === 'gas admission: estimate exceeds destination limit'; }
  check(refused, 'adapter admission accepted an estimate above 2^24');
  return { estimate: pair.gas.toString(), funding, aboveCap: 'refused' };
}

// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  // Node's existing package hook resolves extensionless TS imports; no build or additional dependency.
  await import('../../packages/keeper/scripts/register-ts.mjs');
  try {
    check(process.argv.length === 2, 'no arguments accepted; use SH_KEEPER_RPC_URL and optional SH_KEEPER_SMOKE_SENDER');
    const url = process.env.SH_KEEPER_RPC_URL;
    check(typeof url === 'string' && /^https?:\/\//.test(url), 'SH_KEEPER_RPC_URL required');
    const result = await smoke({ rpc: createReadOnlyRpc(url),
      sender: process.env.SH_KEEPER_SMOKE_SENDER ?? `0x${randomBytes(20).toString('hex')}`,
      recipient: `0x${randomBytes(20).toString('hex')}`, fundedSender: Boolean(process.env.SH_KEEPER_SMOKE_SENDER) });
    process.stdout.write(`Amsterdam Sepolia smoke passed: ${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('Amsterdam smoke refused; check chain/fork/header, estimate range and override support (or supply a funded public SH_KEEPER_SMOKE_SENDER). Endpoint details suppressed.\n');
    process.exitCode = 1;
  }
}
