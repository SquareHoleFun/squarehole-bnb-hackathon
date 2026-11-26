import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLocalRpc, CHAIN_ID } from './core-v2-local-runtime.mjs';

test('alpha explicitly selects 31337 without changing the twin or accepting arbitrary chains', async () => {
  const alpha = async (_url, method) => method === 'eth_chainId' ? '0x7a69' : 'anvil/v1.8.3';
  const twin = async (_url, method) => method === 'eth_chainId' ? '0xaa36a7' : 'anvil/v1.8.3';
  const url = 'http://127.0.0.1:8573';
  assert.equal(CHAIN_ID, 11155111);
  await assertLocalRpc(url, alpha, { alpha: true });
  await assert.rejects(assertLocalRpc(url, alpha), /chain/);
  await assertLocalRpc(url, twin);
  await assert.rejects(assertLocalRpc(url, twin, { alpha: true }), /chain/);
  await assert.rejects(assertLocalRpc('https://example.invalid', alpha, { alpha: true }), /loopback/);
  await assert.rejects(assertLocalRpc(url, async () => '0x1', { alpha: true }), /chain/);
});

test('alpha manifest requires its deployed helper and binds hashes and wiring to one block', async () => {
  const { readAlphaLocalManifest } = await import('./core-v2-local-manifest.mjs');
  const { keccak256 } = await import('viem');
  const address = n => `0x${n.toString(16).padStart(40, '0')}`;
  const chain = { rpcUrl: 'http://127.0.0.1:8573', factory: address(1), poolSwapTest: address(2), manager: address(3),
    assets: { teth: address(5), pairs: address(6), usdc: address(7), nvda: address(8), gold: address(9), pepe: address(10) } };
  const calls = [];
  const block = { number: 91n, hash: `0x${'ab'.repeat(32)}` };
  const request = async (_url, method) => method === 'eth_chainId' ? '0x7a69' : 'anvil/v1.8.3';
  const client = {
    getBlock: async () => block,
    getCode: async args => { calls.push(args); return '0x60016000'; },
    readContract: async args => { calls.push(args); return args.functionName === 'registry' ? address(4) : chain.manager; },
  };
  const result = await readAlphaLocalManifest(chain, { request, client });
  assert.deepEqual(result.localDeployment, { poolSwapTest: chain.poolSwapTest, poolManager: chain.manager,
    poolSwapTestCodeHash: keccak256('0x60016000') });
  assert.equal(result.evidence.number, '91');
  assert.equal(result.coinDeployment.status, 'deployed');
  assert.equal(result.coinDeployment.chainId, 31337);
  assert.deepEqual(result.coinDeployment.teth, { address: chain.assets.teth, codeHash: keccak256('0x60016000') });
  assert.deepEqual(result.coinDeployment.pairHelper, { address: chain.assets.pairs, codeHash: keccak256('0x60016000') });
  assert.deepEqual(result.coinDeployment.pairs.map(p => p.coin), [chain.assets.usdc, chain.assets.nvda, chain.assets.gold, chain.assets.pepe]);
  assert.ok(result.coinDeployment.pairs.every(p => p.fee === '3000' && p.tickSpacing === 60 && p.tickLower === -887220 && p.tickUpper === 887220 && BigInt(p.hooks) === 0n));
  await assert.rejects(readAlphaLocalManifest({ ...chain, assets: undefined }, { request, client }), /deployment/);

  assert.ok(calls.every(c => c.blockNumber === 91n));
  await assert.rejects(readAlphaLocalManifest({ ...chain, poolSwapTest: undefined }, { request, client }), /deployment/);
  await assert.rejects(readAlphaLocalManifest(chain, { request, client: { ...client, getCode: async () => '0x' } }), /code/);
  await assert.rejects(readAlphaLocalManifest(chain, { request, client: { ...client, readContract: async () => address(8) } }), /manager/);
});

test('incomplete contract controls cannot be reported as a complete alpha rehearsal', async () => {
  const { verifyAlphaControls } = await import('../alpha-rehearsal.mjs');
  assert.throws(() => verifyAlphaControls(''), /controls did not pass/);
  assert.throws(() => verifyAlphaControls('6 tests passed, 0 failed'), /missing revert/);
});
