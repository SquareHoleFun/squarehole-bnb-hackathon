import { decodeFunctionData, encodeFunctionResult, parseAbiItem, type Address, type Hex } from 'viem';
import { expect, it } from 'vitest';
import { poolManagerAbi } from '@squarehole/chain/abi';
import { CoreChainIndexer } from '../chain-indexer';
import { MemoryHistory } from '../../history/memory-history';
import { HistoryWriter } from '../../history/writer';
import { World } from '../../../test/core/core-synth';
import { boxLogsV2, serviceChainV2, V2 } from '../../../test/core/scripted-core-chain';
import { A, logM2, m2Fixture } from './m2-fixture.test-support';

const funded = parseAbiItem('event HolderBatchFunded(uint256 indexed batchId,uint256 netP)');
const settled = parseAbiItem('event BatchSettled(uint256 indexed batchId,uint256 fundingP,uint256 holderP,uint256 residueP)');
const paid = parseAbiItem('event HolderPaid(uint256 indexed batchId,address indexed holder,address indexed to,uint256 grossP,uint256 tipP)');

it.each([false, true])('publishes M2 money and decimal history, then removes orphaned payments (deep=%s)', async deep => {
  const f = m2Fixture(false); const token = f.at(1).toLowerCase();
  const old = new World('m2-old'); old.block(10n);
  old.block(100n, [boxLogsV2(f), logM2(funded, f.at(5), { batchId: 1n, netP: 100n }, 0),
    logM2(settled, f.at(17), { batchId: 1n, fundingP: 100n, holderP: 80n, residueP: 20n }, 0)]);
  old.block(101n, [logM2(paid, f.at(17), { batchId: 1n, holder: A, to: A, grossP: 60n, tipP: 0n }, 0)]);
  old.to(deep ? 260n : 105n);
  const makeChain = (world: World) => {
    const chain = serviceChainV2(world, [f], (_box, key) => key === 'receiver.buyersChoice' ? 4 : undefined);
    const original = chain.callAt;
    chain.callAt = async (to: Address, data: Hex, hash: Hex) => {
      if (to.toLowerCase() === V2.poolManager.toLowerCase()) {
        const call = decodeFunctionData({ abi: poolManagerAbi, data });
        if (call.functionName === 'balanceOf' && call.args?.[0].toLowerCase() === f.at(17).toLowerCase()) {
          let balance = 100n; let header = chain.byHash.get(hash.toLowerCase());
          while (header) {
            if ((chain.logsOf.get(header.hash.toLowerCase()) ?? []).some(l => l.address.toLowerCase() === f.at(17).toLowerCase() && l.topics.length === 4)) balance -= 60n;
            header = chain.byHash.get(header.parentHash.toLowerCase());
          }
          return encodeFunctionResult({ abi: poolManagerAbi, functionName: 'balanceOf', result: balance });
        }
      }
      return original(to, data, hash);
    };
    return chain;
  };
  const follow = async (chain: ReturnType<typeof makeChain>) => {
    const history = new MemoryHistory(); const writer = new HistoryWriter(history);
    const indexer = new CoreChainIndexer({ reader: chain, manifest: f.manifest, auditEvery: 10_000, onHistory: writer.accept });
    await indexer.start(); await indexer.idle(); await writer.flush();
    return { indexer, history, writer };
  };
  const chain = makeChain(old); const got = await follow(chain);
  expect(got.indexer.metrics.errors).toBe(0);
  expect(got.indexer.v2BoxView(token)).toMatchObject({ m2: { batches: { '1': { paidP: '60', tipsP: '0' } } }, money: { m2: { holderBalanceP: '40' } } });
  const canonical = old.fork(100n, 'm2-canonical'); canonical.to(deep ? 350n : 110n);
  chain.setBranch(canonical.headers.filter(h => h.number > 100n), canonical.logs.filter(l => l.blockNumber > 100n));
  await got.indexer.enqueue(chain.header(chain.tip)); await got.indexer.idle(); await got.writer.flush();
  expect(got.indexer.metrics.errors).toBe(0);
  expect(got.indexer.v2BoxView(token)).toMatchObject({ m2: { batches: { '1': { paidP: '0', payments: {} } } }, money: { m2: { holderBalanceP: '100' } } });
  const truth = await follow(makeChain(canonical));
  expect(got.indexer.v2BoxView(token)).toEqual(truth.indexer.v2BoxView(token));
  const want = await truth.history.dump(V2.chainId);
  expect({ ...await got.history.dump(V2.chainId), chainBlocks: want.chainBlocks }).toEqual(want);
  expect(want.activity.map(row => JSON.parse(JSON.parse(row).data))).toContainEqual(expect.objectContaining({ event: 'HolderBatchFunded', netP: '100' }));
});
