/** Offline workload shaped from SH-109: box 0 plus three v2 inboxes, six frozen coins each.
 * Values are synthetic; the old runner's outputs and request counts are recorded in reads-baseline.json.
 */
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, multicall3Abi, parseAbiItem, toHex, type Hex } from 'viem';
import { RANDOMNESS_SOURCE, DRAND_SOURCE } from '../../../box-spec/src/generated/box-spec.v1';
import { listingRegistryV2Abi, royaltyRouterV2Abi } from '../../src/abi';
import { keeperContracts, keeperMulticall } from '../../src/tick-reads';
import { fakeClient, fakeNode } from './fake-rpc';
import { addr, keeper, options, quiet, time } from './v2';
import { ViemChain } from '../../src/chain';
import { runTick, type KeeperState } from '../../src/run';

export function readsFixture(v2Count: number, batch: boolean, active = false, recent = false, batchBytes?: number) {
  const multicallAbi = [...multicall3Abi, parseAbiItem('function getCurrentBlockGasLimit() view returns (uint256)')] as const;
  const node = fakeNode({ block: { number: 12005000n, timestamp: time, baseFeePerGas: 1n } });
  const on = (id: number, fn: string, value: unknown) => { node.calls[`${addr(id)}:${fn}`] = () => value; };
  const registry = addr(500), listing = addr(501), pm = addr(600);
  // Keep the old four-box vectors byte-for-byte; larger fixtures must not overlap registry/coin/shared addresses.
  const coordinator = (i: number) => (i < 20 ? 100 : 10_000) + i * 20;
  const inboxes = new Set(Array.from({ length: v2Count }, (_, i) => addr(coordinator(i) + 4)));
  for (const [id, fn, value] of [
    [1, 'graduated', true], [1, 'randomness', RANDOMNESS_SOURCE], [1, 'tickets', addr(0)], [1, 'executor', addr(5)],
    [2, 'poolId', toHex(1n, { size: 32 })], [2, 'poolManager', pm], [2, 'closed', true],
    [3, 'fitOwed', 0n], [3, 'platformOwed', 0n], [5, 'fitGraduated', true], [5, 'launchPhase', addr(1)],
    [5, 'budget', 0n], [5, 'batchThreshold', 100n], [5, 'twap', [true, 0, 0]],
    [5, 'oracle', { tick: 0, time: Number(time), tickCumulative: 0n, head: 0, filled: 1 }],
    [5, 'checkpointAt', { time: Number(time - 3600n), tickCumulative: 0n }], [600, 'extsload', toHex(0n, { size: 32 })],
    [500, 'boxCount', BigInt(v2Count)], [501, 'sellableCount', 6n],
  ] as const) on(id, fn, value);
  node.calls[`${DRAND_SOURCE.toLowerCase()}:owedTo`] = () => 0n;
  node.calls[`${registry}:roleOf`] = ([id, role]) => ({ 0: addr(coordinator(Number(id))), 2: addr(coordinator(Number(id)) + 1),
    5: addr(coordinator(Number(id)) + 2), 6: addr(coordinator(Number(id)) + 3) })[String(role) as '0'] ?? addr(0);
  node.calls[`${listing}:sellableToken`] = ([i]) => addr(700 + Number(i));
  for (let i = 0; i < v2Count; i++) {
    const co = coordinator(i), hk = co + 1, rc = co + 2, inbox = co + 4;
    for (const id of [co, hk, rc, inbox]) node.versions[addr(id)] = 2;
    for (const [fn, value] of Object.entries({ graduated: true, failed: false, gateOpen: true, openAt: time - 100n,
      deadline: time + 900000n, rewardOf: 0n, roleAddress: addr(inbox) })) on(co, fn, value);
    for (const [fn, value] of Object.entries({ poolId: toHex(BigInt(i + 2), { size: 32 }), poolManager: pm, q: addr(0), closed: true,
      closedAt: time - 100n, lastProtocolBlock: 0n, depthBudget: 1000n })) on(hk, fn, value);
    for (const [fn, value] of Object.entries({ q: addr(0), PLATFORM_SAFE: addr(601), poolManager: pm, fitOwed: i === 0 ? 1n : 0n,
      platformOwed: 0n, buyBackP: 1000n, tBurnPending: 0n, graduationSettled: true, buyersChoice: 0, sellersChoice: 0,
      rewardsPendingP: 0n, rewardBurnPendingT: 0n, allocationCursors: [0n, 0n, 1n, 2n], payFit: 1n })) on(rc, fn, value);
    for (const [fn, value] of Object.entries({ weth: addr(700), listingRegistry: listing, listVersion: 1n,
      vaultRelayer: addr(602), lotSize: 100n, orderRegistered: true, oldestUnsoldAt: 0n })) on(inbox, fn, value);
  }
  // One trade each advancing block in the first v2 box: its fee views accrue one raw unit per trade.
  // The keeper reads these views, not PoolManager Swap logs. All other boxes remain idle.
  if (active && v2Count > 0) {
    const accrued = () => 1000n + node.block.number - 12005000n;
    node.calls[`${addr(coordinator(0) + 1)}:depthBudget`] = accrued;
    node.calls[`${addr(coordinator(0) + 2)}:buyBackP`] = accrued;
  }
  for (let i = 700; i < 706; i++) { on(i, 'balanceOf', 0n); on(i, 'allowance', 0n); }
  const base = fakeClient(node).transport.request;
  const requests: { method: string; params?: unknown }[] = [];
  const aggregates: { calls: number; inputBytes: number; outputBytes: number; childBytes: number }[] = [];
  const inner = async (args: { method: string; params?: unknown }): Promise<unknown> => {
    const p = args.params as [Record<string, Hex>, string] | undefined;
    if (args.method === 'eth_call' && p && p[0].to?.toLowerCase() === keeperContracts(11155111)?.multicall3.address.toLowerCase()) {
      const decoded = decodeFunctionData({ abi: multicallAbi, data: p[0].data ?? '0x' });
      if (decoded.functionName === 'getEthBalance') return encodeFunctionResult({ abi: multicall3Abi, functionName: 'getEthBalance', result: 0n });
      if (decoded.functionName === 'getCurrentBlockGasLimit') return encodeFunctionResult({ abi: multicallAbi, functionName: decoded.functionName, result: 30_000_000n });
      if (decoded.functionName === 'getCurrentBlockTimestamp') return encodeFunctionResult({ abi: multicall3Abi, functionName: decoded.functionName, result: node.block.timestamp });
      const calls = decoded.args[0] as readonly { target: Hex; callData: Hex }[];
      const results = await Promise.all(calls.map(async c => {
        try { return { success: true, returnData: await inner({ method: 'eth_call', params: [{ to: c.target, data: c.callData }, p[1]] }) as Hex }; }
        catch { return { success: false, returnData: '0x' as Hex }; }
      }));
      const result = encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results });
      if (p[1] !== 'pending') aggregates.push({ calls: calls.length, inputBytes: ((p[0].data?.length ?? 2) - 2) / 2,
        outputBytes: (result.length - 2) / 2, childBytes: calls.reduce((n, c) => n + (c.callData.length - 2) / 2, 0) });
      return result;
    }
    if (args.method === 'eth_call' && p) {
      const target = p[0].to?.toLowerCase();
      const abi = target === listing ? listingRegistryV2Abi : target && inboxes.has(target as Hex) ? royaltyRouterV2Abi : null;
      if (abi) {
        const decoded = decodeFunctionData({ abi, data: p[0].data ?? '0x' });
        const handler = node.calls[`${target}:${decoded.functionName}`];
        if (!handler) throw new Error('missing fixture inbox reply');
        return encodeFunctionResult({ abi, functionName: decoded.functionName, result: handler(decoded.args ?? []) } as never);
      }
    }
    if (args.method === 'eth_getBlockByNumber') {
      const tag = (args.params as string[])[0] ?? 'invalid';
      const n = tag === 'pending' ? node.block.number : tag === 'finalized' ? node.block.number - 100n : tag === 'latest' ? node.block.number - 1n : BigInt(tag);
      return { number: toHex(n), hash: toHex(n, { size: 32 }), parentHash: toHex(n - 1n, { size: 32 }), timestamp: toHex(time - (12005000n - n) * 12n),
        baseFeePerGas: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', transactions: [] };
    }
    if (args.method === 'eth_getBalance' || args.method === 'eth_getStorageAt') return toHex(0n, { size: 32 });
    if (args.method === 'eth_getCode') return '0x';
    return base(args as never);
  };
  const pub = createPublicClient({ chain: { id: 11155111, name: 'fixture', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://fixture.invalid'] } }, contracts: keeperContracts(11155111) },
    batch: batch ? (batchBytes ? { multicall: { batchSize: batchBytes, wait: 8 } } : keeperMulticall(11155111)) : undefined,
    transport: custom({ request: async args => { requests.push(args); return inner(args); } }, { retryCount: 0 }) });
  const cfg = { ...options(), priorityFeeWei: 1n, monitorFile: null, fromBlock: recent ? 12004890n : 11960000n,
    box0: { coordinator: addr(1), hook: addr(2), receiver: addr(3), executor: addr(5) }, boxRegistry: v2Count ? registry : null };
  const port = new ViemChain(cfg, pub, keeper, { public: null, private: null }, null, quiet);
  const simulations: unknown[] = [];
  const snapshots: unknown[] = [];
  const read = port.read.bind(port);
  port.read = async (...args) => { const world = await read(...args); snapshots.push(world); return world; };
  const simulate = port.simulate.bind(port);
  port.simulate = async (c, fees) => { const result = await simulate(c, fees); simulations.push({ job: c.job, key: c.key, result }); return result; };
  return { node, port, requests, aggregates, advance(blocks: bigint) { node.block.number += blocks; node.block.timestamp += blocks * 12n; }, async tick(state: KeeperState = {}) {
    requests.length = 0; simulations.length = 0; snapshots.length = 0;
    const out = await runTick(port, state, cfg, quiet);
    node.block.number += 2n;
    node.block.timestamp += 24n;
    return { decisions: JSON.parse(JSON.stringify({ report: out.report, state: out.state, income: out.observed.income, simulations, snapshots },
      (key, value: unknown) => key === 'error' ? undefined : typeof value === 'bigint' ? String(value) : value)), count: requests.length };
  } };
}
