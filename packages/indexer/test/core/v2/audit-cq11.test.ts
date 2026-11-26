import { encodeFunctionResult, decodeFunctionData, toHex } from 'viem';
import { poolManagerAbi } from '@squarehole/chain/abi';
import { poolStateSlot } from '@squarehole/chain';
import { expect, it } from 'vitest';
import { CoreChainIndexer } from '../../../src/core/chain-indexer';
import { World } from '../core-synth';
import { serviceBoxV2, serviceChainV2, boxLogsV2, listingAddedLog, serviceListingV2, eventV2, requiredV2, synthManifestV2, V2 } from '../scripted-core-chain';

it('CQ11-E audits the full-range position against PoolManager, even with no later swap', async () => {
  const box = serviceBoxV2(); const token = requiredV2(box.record.contracts[1]); const world = new World('pool-audit');
  world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]); world.block(100n, [boxLogsV2(box)]);
  world.block(101n, [eventV2('hook', 'MigratedV2', requiredV2(box.record.contracts[2]), { poolId: box.record.poolId, liquidity: 400n, qLeft: 2n, tBurned: 0n })]); world.to(102n);
  const chain = serviceChainV2(world, [box], (_b, key, hash) => key === 'coordinator.graduated' ? (chain.byHash.get(hash)?.number ?? 0n) >= 101n : undefined);
  const call = chain.callAt.bind(chain); let liquidity = 412n;
  chain.callAt = async (to, data, hash) => {
    if (to.toLowerCase() !== V2.poolManager.toLowerCase()) return call(to, data, hash);
    const decoded = decodeFunctionData({ abi: poolManagerAbi, data });
    if (decoded.functionName !== 'extsload') return call(to, data, hash);
    const slot = decoded.args[0];
    const word = slot === toHex(BigInt(poolStateSlot(box.record.poolId)) + 3n, { size: 32 }) ? liquidity : 2n ** 96n;
    return encodeFunctionResult({ abi: poolManagerAbi, functionName: 'extsload', result: toHex(word, { size: 32 }) });
  };
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 }); await indexer.start();
  const mismatch = await indexer.audit();
  expect(mismatch[0]?.result.mismatches).toContain('pool.liquidity: 400 ≠ 412');
  expect(indexer.v2BoxView(token)?.verified).toBe(false);
  liquidity = 400n;
  await indexer.repairBox(requiredV2(indexer.boxesV2.get(token.toLowerCase())));
  expect((await indexer.audit()).every((r) => r.result.ok)).toBe(true);
});

it('CQ11-E stopping during the final repair anchor read cannot publish staged states', async () => {
  const box = serviceBoxV2(); const token = requiredV2(box.record.contracts[1]).toLowerCase();
  const world = new World('repair-stop'); world.block(10n); world.block(99n, [listingAddedLog(serviceListingV2())]);
  world.block(100n, [boxLogsV2(box)]); world.to(103n);
  const chain = serviceChainV2(world, [box]);
  const indexer = new CoreChainIndexer({ reader: chain, manifest: synthManifestV2(), auditEvery: 10_000 }); await indexer.start();
  const entry = requiredV2(indexer.boxesV2.get(token)); const states = entry.states;
  const header = chain.headerByNumber.bind(chain); let headReads = 0;
  chain.headerByNumber = async (number) => {
    const result = await header(number);
    if (number === 103n && ++headReads === 2) indexer.stop();
    return result;
  };
  await expect(indexer.repairBox(entry)).rejects.toThrow(/abort/i);
  expect(entry.states).toBe(states); expect(entry.repairing).toBe(false);
});
