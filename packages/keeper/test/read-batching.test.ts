import { expect, it, vi } from 'vitest';
import { createPublicClient, custom, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, multicall3Abi, toFunctionSelector, type PublicClient } from 'viem';
import { sepolia } from 'viem/chains';
import { TickReads, keeperMulticall, readWindows } from '../src/tick-reads';
import { boxRegistryAbi, receiverV2Abi } from '../src/abi';
import { addr, keeper, options, quiet, time } from './support/v2';
import { ViemChain } from '../src/chain';
import { gasLimitFrom } from '../src/gas';
import type { Candidate } from '../src/types';
import { readsFixture } from './support/reads-fixture';
import { REVERT } from './support/fake-rpc';

it('BATCH-2 uses the measured 16 KiB chunk only on the known chain', () => {
  expect(keeperMulticall(11155111)).toEqual({ multicall: { batchSize: 16 * 1024, wait: 8 } });
  expect(keeperMulticall(1)).toBeUndefined();
});

it('BATCH-1 bounds active boxes and preserves registry order across windows', async () => {
  let active = 0, peak = 0;
  const ids = Array.from({ length: 70 }, (_, i) => i);
  const results = await readWindows(ids, async id => {
    peak = Math.max(peak, ++active);
    for (let i = 0; i < 70 - id; i++) await Promise.resolve();
    active--;
    return id;
  });
  expect(peak).toBe(32);
  expect(results).toEqual(ids);
});

it('BATCH-4 shares independent optional registry roles and receiver views at the round block', async () => {
  const fixture = readsFixture(3, true);
  await fixture.port.read();
  const holderRole = encodeFunctionData({ abi: boxRegistryAbi, functionName: 'roleOf', args: [0n, 17n] });
  const rewardView = toFunctionSelector('rewardsPendingP()');
  expect(fixture.requests.some(r => {
    if (r.method !== 'eth_call') return false;
    const [tx, block] = r.params as [{ to: string; data: `0x${string}` }, string];
    if (tx.to !== sepolia.contracts.multicall3.address || block !== '0xb72e87') return false;
    const decoded = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
    return decoded.functionName === 'aggregate3'
      && decoded.args[0].some(c => c.target.toLowerCase() === addr(500) && c.callData === holderRole)
      && decoded.args[0].some(c => c.target.toLowerCase() === addr(102) && c.callData === rewardView);
  })).toBe(true);
});

it('BATCH-4 batches ticket roles and finalized receiver wiring, keeping their blocks separate', async () => {
  const fixture = readsFixture(3, true);
  await fixture.tick();
  const batches = fixture.requests.flatMap(r => {
    if (r.method !== 'eth_call') return [];
    const [tx, block] = r.params as [{ to: string; data: `0x${string}` }, string];
    if (tx.to !== sepolia.contracts.multicall3.address || block === 'pending') return [];
    const decoded = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
    return decoded.functionName === 'aggregate3' ? [{ block: BigInt(block), calls: decoded.args[0] }] : [];
  });
  expect(batches.some(b => b.block === 12004999n && [0n, 1n, 2n].every(id => b.calls.some(c =>
    c.target.toLowerCase() === addr(500) && c.callData === encodeFunctionData({ abi: boxRegistryAbi,
      functionName: 'roleOf', args: [id, 7n] }))))).toBe(true);
  expect(batches.some(b => b.block === 12004900n && [102, 122, 142].every(id => b.calls.some(c =>
    c.target.toLowerCase() === addr(id) && c.callData === toFunctionSelector('PLATFORM_SAFE()'))))).toBe(true);
});

it('BATCH-1 shares registry discovery across boxes and isolates a reverted box view', async () => {
  const fixture = readsFixture(3, true);
  fixture.node.calls[`${addr(120)}:gateOpen`] = () => { throw REVERT; };
  const world = await fixture.port.read();
  expect(world.boxes.map(b => [b.version, b.id])).toEqual([[1, 0n], [2, 0n], [2, 2n]]);
  const aggregates = fixture.requests.filter(r => r.method === 'eth_call').flatMap(r => {
    const [tx, block] = r.params as [{ to: string; data: `0x${string}` }, string];
    if (tx.to !== sepolia.contracts.multicall3.address) return [];
    expect(block).toBe('0xb72e87'); // pending number - 1; never pending/latest for shared views.
    const decoded = decodeFunctionData({ abi: multicall3Abi, data: tx.data });
    return decoded.functionName === 'aggregate3' ? [decoded.args[0]] : [];
  });
  // The failed box and a healthy neighbour must actually have shared an aggregate.
  expect(aggregates.some(calls => [addr(120), addr(140)].every(target => calls.some(c => c.target.toLowerCase() === target)))).toBe(true);
  expect(aggregates.some(calls => calls.filter(c => c.target.toLowerCase() === addr(500)).length >= 12)).toBe(true);
});
it('READS-5 deduplicates concurrent and sequential snapshot reads, never pending simulations', async () => {
  const readContract = vi.fn(async () => 1n);
  const simulateContract = vi.fn(async () => ({ result: 1n }));
  const reads = new TickReads({ readContract, simulateContract } as unknown as PublicClient);
  reads.begin();
  const call = { address: addr(1), abi: receiverV2Abi, functionName: 'fitOwed', blockNumber: 10n } as const;
  await Promise.all([reads.client.readContract(call), reads.client.readContract(call)]);
  await reads.client.readContract(call);
  expect(readContract).toHaveBeenCalledTimes(1);
  await reads.client.simulateContract({ ...call, functionName: 'payFit', account: addr(2) });
  await reads.client.simulateContract({ ...call, functionName: 'payFit', account: addr(2) });
  expect(simulateContract).toHaveBeenCalledTimes(2);
  reads.begin(); await reads.client.readContract(call);
  expect(readContract).toHaveBeenCalledTimes(2);
});

it('af1 F3 observes fresh pending gas and time for admission without repeating the world header', async () => {
  const getBlock = vi.fn(async () => ({ timestamp: time, gasLimit: 30_000_000n }));
  let pending = { timestamp: time + 12n, gasLimit: 100_000n };
  const readContract = vi.fn(async () => [pending.gasLimit, pending.timestamp].map(value => ({ success: true,
    returnData: encodeAbiParameters([{ type: 'uint256' }], [value]) })));
  const pub = { chain: sepolia, getBlock, readContract } as unknown as PublicClient;
  const destination = vi.fn(async (_c, _estimate, block) => {
    expect(block).toEqual(pending);
    return { fork: 'cancun' as const, transactionCap: null };
  });
  const chain = new ViemChain(options(), pub, keeper, { public: null, private: null }, null, quiet, destination);
  const c = { job: 'collect', key: 'admission', to: addr(2), fn: 'collect', args: [keeper] } as unknown as Candidate;
  const rules = await chain.gasConstraints(c, 200_000n);
  expect(rules.blockGasLimit).toBe(100_000n);
  expect(() => gasLimitFrom(200_000n, 0n, rules)).toThrow();
  pending = { timestamp: time + 24n, gasLimit: 31_000_000n };
  expect((await chain.gasConstraints(c, 200_000n)).blockGasLimit).toBe(31_000_000n);
  expect(readContract).toHaveBeenCalledTimes(2);
  expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: sepolia.contracts.multicall3.address,
    functionName: 'aggregate3', blockTag: 'pending' }));
  expect(getBlock).not.toHaveBeenCalled();
  readContract.mockRejectedValueOnce(new Error('pending observation unavailable'));
  await expect(chain.gasConstraints(c, 200_000n)).rejects.toThrow('pending observation unavailable');
});
it('READS-5 aggregates caller-independent reads through Sepolia Multicall3', async () => {
  const request = vi.fn(async (args: { method: string; params?: unknown }) => { expect(args.method).toBe('eth_call'); return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: [
    { success: true, returnData: encodeFunctionResult({ abi: receiverV2Abi, functionName: 'fitOwed', result: 1n }) },
    { success: true, returnData: encodeFunctionResult({ abi: receiverV2Abi, functionName: 'platformOwed', result: 2n }) },
  ] }); });
  const pub = createPublicClient({ chain: sepolia, batch: keeperMulticall(11155111), transport: custom({ request }, { retryCount: 0 }) });
  expect(await Promise.all((['fitOwed', 'platformOwed'] as const).map(functionName => pub.readContract({ address: addr(1), abi: receiverV2Abi, functionName, blockNumber: 12000000n })))).toEqual([1n, 2n]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[0]).toMatchObject({ method: 'eth_call', params: [{ to: sepolia.contracts.multicall3.address }, '0xb71b00'] });
});
