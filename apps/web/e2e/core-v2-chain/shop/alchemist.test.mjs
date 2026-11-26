import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeAbiParameters, decodeFunctionResult, encodeAbiParameters, getAddress, zeroAddress } from 'viem';
import { artifact } from '../../../../../packages/chain/scripts/lib/core-v2-local-manifest.mjs';
import { deployAlchemist } from './alchemist.mjs';

// eth_accounts answers lowercase (packages/chain/scripts/local-core-v2-chain.mjs keeps that spelling in the chain file);
// anvil's accounts 1 and 4 contain letters, so their checksummed and lowercase spellings differ.
const ANVIL_ACTOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const ANVIL_KEEPER = '0x15d34aaf54267db7d7c367839aaf71a00a2c6a65';

/** The deployment helper with its send replaced by a recording double; the constructor arguments it encoded. */
async function deployed(actor, keeper) {
  const chain = { accounts: { actor, keeper } };
  const pm = '0x0000000000000000000000000000000000000020';
  const receiver = '0x0000000000000000000000000000000000000021';
  const coordinator = '0x0000000000000000000000000000000000000022';
  const gold = '0x0000000000000000000000000000000000000023';
  const module = '0x0000000000000000000000000000000000000024';
  const release = { implementations: { receiver: { address: receiver }, coordinator: { address: coordinator } } };
  const route = [{ kind: 4, tokenIn: zeroAddress, tokenOut: gold, pool: pm, fee: 3000, tickSpacing: 60 }];
  const cap = 10n ** 18n;
  const dust = 10n ** 9n;
  const calls = [];
  const address = await deployAlchemist(chain, release, pm, route, cap, dust, async (...args) => {
    calls.push(args);
    return { contractAddress: module };
  });
  const action = artifact('AlchemistFeeModuleV21');
  const [, , , data] = calls[0] ?? [];
  const args = data ? decodeAbiParameters(action.abi.find((entry) => entry.type === 'constructor').inputs, `0x${data.slice(action.bytecode.object.length)}`) : null;
  return { chain, pm, receiver, coordinator, module, route, cap, dust, calls, address, action, args };
}

for (const [actor, keeper] of [
  ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000004'],
  ['0x0000000000000000000000000000000000000011', '0x0000000000000000000000000000000000000044'],
  [ANVIL_ACTOR, ANVIL_KEEPER],
]) {
  test(`AF1: FE14 deploys from ${actor} but grants immediate conversion to its keeper`, async () => {
    const { chain, pm, receiver, coordinator, module, route, cap, dust, calls, address, action, args } = await deployed(actor, keeper);
    assert.equal(address, getAddress(module));
    assert.equal(calls.length, 1);
    const [sentChain, from, to, data, value, gas] = calls[0];
    assert.equal(sentChain, chain);
    assert.equal(from, actor, 'the creator still deploys; the keeper does not deploy');
    assert.equal(to, null);
    assert.equal(value, 0n);
    assert.equal(gas, 15_000_000n);
    assert.ok(data.startsWith(action.bytecode.object));
    assert.deepEqual(args.slice(0, 6), [getAddress(pm), getAddress(receiver), getAddress(coordinator), route, cap, dust]);
    assert.equal(args[6], getAddress(keeper), 'conversionTrigger must be the executeModule caller before seven days');
    assert.notEqual(args[6], getAddress(from), 'deployment must not confer conversion authority');
  });
}

test('G1-INT: the trigger getter answers checksummed, so the life compares it with getAddress(keeper), not the lowercase account', async () => {
  assert.notEqual(getAddress(ANVIL_KEEPER), ANVIL_KEEPER, 'the fixture needs a keeper whose spellings differ');
  const { args, action } = await deployed(ANVIL_ACTOR, ANVIL_KEEPER);
  // What the deployed getter returns is the immutable the constructor received; decode it as readContract does.
  const answer = decodeFunctionResult({ abi: action.abi, functionName: 'conversionTrigger', data: encodeAbiParameters([{ type: 'address' }], [args[6]]) });
  assert.equal(answer, getAddress(ANVIL_KEEPER), 'fees-life.e2e.mjs: readContract(conversionTrigger) toBe getAddress(keeper)');
  assert.notEqual(answer, ANVIL_KEEPER, 'a strict compare with the eth_accounts spelling would refuse the right keeper');
  assert.notEqual(getAddress(ANVIL_ACTOR), getAddress(ANVIL_KEEPER), 'the deployer and the trigger are different accounts');
});

test('G1-INT: the constructor takes the dust size between the cap and the trigger, and the module answers it', async () => {
  const { args, action, cap, dust } = await deployed(ANVIL_ACTOR, ANVIL_KEEPER);
  const inputs = action.abi.find((entry) => entry.type === 'constructor').inputs;
  assert.deepEqual(inputs.slice(4).map((input) => input.type), ['uint256', 'uint256', 'address']);
  assert.equal(args[4], cap); assert.equal(args[5], dust);
  assert.ok(args[5] > 0n && args[5] <= args[4], 'the constructor refuses a dust size of zero or above the cap');
  const answer = decodeFunctionResult({ abi: action.abi, functionName: 'dustMax', data: encodeAbiParameters([{ type: 'uint256' }], [args[5]]) });
  assert.equal(answer, dust);
});
