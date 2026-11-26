import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeErrorResult, parseAbi } from 'viem';
import * as runtime from './core-v2-local-runtime.mjs';
import { localForge, callLocal } from '../local-core-v2-chain.mjs';

const hash = `0x${'92'.repeat(32)}`;
const errors = parseAbi(['error ItemLedgerGasTooLow(uint256 left, uint256 required)']);
const revert = encodeErrorResult({ abi: errors, errorName: 'ItemLedgerGasTooLow', args: [548743n, 2225873n] });

function diagnostics() {
  const calls = []; const reports = [];
  const request = async (_url, method, params) => {
    calls.push([method, params]);
    if (method === 'eth_getTransactionReceipt') return { status: '0x0', transactionHash: hash };
    if (method === 'debug_traceTransaction') return { error: 'execution reverted', output: revert };
    throw new Error(`unexpected ${method}`);
  };
  return { calls, reports, request, report: text => reports.push(text), errors: () => errors };
}

test('broadcast failure is replayed and decoded with its life step before propagation', async () => {
  const d = diagnostics();
  const original = new Error(`forge failed (1): Error: Transaction Failure: ${hash}`);
  await assert.rejects(runtime.runLocalStep({ rpcUrl: 'local' }, 'everyItem.withdraw', async () => { throw original; }, d),
    error => error.cause === original && /everyItem.withdraw/.test(error.message));
  assert.deepEqual(d.calls.map(c => c[0]), ['eth_getTransactionReceipt', 'debug_traceTransaction']);
  assert.equal(d.calls[1][1][0], hash);
  assert.match(d.reports.join('\n'), /everyItem.withdraw.*ItemLedgerGasTooLow\(548743, 2225873\)/s);
});

test('direct send keeps the mined hash so the step runner traces the actual failed transaction', async () => {
  const d = diagnostics();
  const request = async (...args) => args[1] === 'eth_sendTransaction' ? hash : d.request(...args);
  await assert.rejects(runtime.runLocalStep({ rpcUrl: 'local' }, 'failure.claim',
    () => runtime.send('local', { from: 'actor', value: 900719925474099312345n }, request), d), /failure.claim/);
  assert(d.calls.some(c => c[0] === 'debug_traceTransaction'));
});

test('successful steps return their result without tracing', async () => {
  const d = diagnostics();
  assert.equal(await runtime.runLocalStep({}, 'plain.collect', async () => 42n, d), 42n);
  assert.deepEqual(d.calls, []);
});

test('trace failure preserves the original failure and reports why replay is unavailable', async () => {
  const d = diagnostics(); const read = d.request;
  d.request = async (...args) => {
    if (args[1] === 'debug_traceTransaction') throw new Error('trace unavailable');
    return read(...args);
  };
  const original = new Error(`Error: Transaction Failure: ${hash}`);
  await assert.rejects(runtime.runLocalStep({ rpcUrl: 'local' }, 'shop.give', async () => { throw original; }, d),
    error => error.cause === original);
  assert.match(d.reports.join('\n'), /trace unavailable/);
});

test('unmined RPC rejection decodes its data and explicitly reports there is no transaction to replay', async () => {
  const d = diagnostics();
  await assert.rejects(runtime.runLocalStep({ rpcUrl: 'local' }, 'item.claim', async () => {
    throw Object.assign(new Error('eth_sendTransaction: rejected'), { data: revert });
  }, d), /item.claim/);
  assert.match(d.reports.join('\n'), /not mined.*ItemLedgerGasTooLow/s);
  assert.deepEqual(d.calls, []);
});

test('v4 wrapped errors expose the inner custom revert without a selector lookup', async () => {
  const d = diagnostics();
  const wrapped = parseAbi(['error WrappedError(address target, bytes4 selector, bytes reason, bytes details)']);
  const data = encodeErrorResult({ abi: wrapped, errorName: 'WrappedError', args: [
    '0x0000000000000000000000000000000000000001', '0x12345678', revert, '0x',
  ] });
  d.errors = () => [...wrapped, ...errors];
  const read = d.request;
  d.request = async (...args) => args[1] === 'debug_traceTransaction'
    ? { error: 'execution reverted', output: data } : read(...args);
  await assert.rejects(runtime.runLocalStep({ rpcUrl: 'local' }, 'holders.trade', async () => {
    throw new Error(`Transaction Failure: ${hash}`);
  }, d));
  assert.match(d.reports.join('\n'), /WrappedError.* -> ItemLedgerGasTooLow\(548743, 2225873\)/s);
});

test('default anvil tracer decodes returnValue when callTracer is unavailable', async () => {
  const d = diagnostics(); const read = d.request;
  d.request = async (...args) => {
    if (args[1] !== 'debug_traceTransaction') return read(...args);
    if (args[2][1].tracer) throw new Error('unsupported tracer');
    return { failed: true, returnValue: revert.slice(2) };
  };
  await assert.rejects(runtime.runLocalStep({ rpcUrl: 'local' }, 'everyItem.withdraw', async () => {
    throw new Error(`Transaction Failure: ${hash}`);
  }, d));
  assert.match(d.reports.join('\n'), /ItemLedgerGasTooLow\(548743, 2225873\)/);
});

test('forge and direct-send entry points both enter the diagnostic step runner', async () => {
  const chain = { rpcUrl: 'local', boxes: { everyItem: 'box' }, accounts: { actor: 'actor' } };
  const seen = [];
  const actions = { assertLocalRpc: async () => {}, run: async () => { throw new Error(`Transaction Failure: ${hash}`); },
    runLocalStep: async (_chain, name, operation) => { seen.push(name); return operation(); },
    artifact: () => ({ abi: parseAbi(['function collect(address)']) }),
    send: async () => { throw new Error('send failed'); } };
  await assert.rejects(localForge(chain, 'life', 'run()', [], 'actor', 'everyItem.withdraw', actions));
  await assert.rejects(callLocal(chain, 'BoxReceiverV2', 'receiver', 'collect', ['0x0000000000000000000000000000000000000001'], 'actor', 0n, actions));
  assert.deepEqual(seen, ['everyItem.withdraw', 'BoxReceiverV2.collect@receiver']);
});
