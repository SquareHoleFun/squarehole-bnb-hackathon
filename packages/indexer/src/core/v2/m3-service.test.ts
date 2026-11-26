import { decodeFunctionData, encodeFunctionResult, parseAbiItem, zeroAddress, type Address, type Hex } from 'viem';
import { expect, it } from 'vitest';
import { poolManagerAbi } from '@squarehole/chain/abi';
import { CoreChainIndexer } from '../chain-indexer';
import { MemoryHistory } from '../../history/memory-history';
import { HistoryWriter } from '../../history/writer';
import { World } from '../../../test/core/core-synth';
import { boxLogsV2, serviceChainV2, V2 } from '../../../test/core/scripted-core-chain';
import { pileVaultV2Abi } from './chain-v2';
import { A, B, logM3, m3Fixture, SEED } from './m3-fixture.test-support';

const transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)');
const paid = parseAbiItem('event ItemPaid(uint256 indexed id,address indexed owner,address indexed to,uint256 grossP,uint256 tipP)');

it.each([[false, false], [false, true], [true, false], [true, true]])('reorgs M3 public money and durable decimal history (pile=%s, deep=%s)', async (pile, deep) => {
  const f = m3Fixture(pile); const token = f.at(1).toLowerCase();
  const old = new World('m3-old'); old.block(10n);
  const start = pile ? [
    logM3(parseAbiItem('event SeedLoaded(address indexed seeder,address indexed asset,uint256 amount)'), f.at(3), { seeder: f.record.creator, asset: f.record.q, amount: SEED }, 0),
    logM3(parseAbiItem('event FailureEntered()'), f.at(3), {}, 0),
  ] : [logM3(parseAbiItem('event ItemFunded(uint256 indexed receiptId,uint256 indexed batchId,uint8 side,uint8 source,uint256 choiceP,uint256 ledgerP)'), f.at(5), { receiptId: 1n, batchId: 0n, side: 1, source: 3, choiceP: SEED, ledgerP: SEED }, 0),
    logM3(transfer, f.at(4), { from: zeroAddress, to: A, tokenId: 1n }, 0)];
  old.block(100n, [boxLogsV2(f), ...start]);
  old.block(101n, [pile ? logM3(parseAbiItem('event SeedReturned(address indexed seeder,uint256 amount)'), f.at(3), { seeder: f.record.creator, amount: SEED }, 0)
    : logM3(parseAbiItem('event ResidueFlushed(uint256 p)'), f.at(16), { p: 3n }, 0)]);
  if (!pile) old.block(102n, [logM3(transfer, f.at(4), { from: A, to: B, tokenId: 1n }, 0),
    logM3(paid, f.at(16), { id: 1n, owner: B, to: A, grossP: 7n, tipP: 0n }, 0)]);
  old.to(deep ? 260n : 105n);
  const makeChain = (world: World) => {
    const chain = serviceChainV2(world, [f], (_box, key) => !pile && ['receiver.buyersChoice', 'receiver.sellersChoice'].includes(key) ? 5 : undefined);
    const original = chain.callAt;
    chain.callAt = async (to: Address, data: Hex, hash: Hex) => {
      if (to.toLowerCase() === f.at(3).toLowerCase() && pile) {
        const call = decodeFunctionData({ abi: pileVaultV2Abi, data });
        const answers = { asset: f.record.q, seeder: f.record.creator, seedAmount: SEED };
        return encodeFunctionResult({ abi: pileVaultV2Abi, functionName: call.functionName, result: answers[call.functionName as keyof typeof answers] } as never);
      }
      if (to.toLowerCase() === V2.poolManager.toLowerCase()) {
        const call = decodeFunctionData({ abi: poolManagerAbi, data });
        if (call.functionName === 'balanceOf' && call.args?.[0].toLowerCase() === f.at(16).toLowerCase()) {
          let balance = SEED; let header = chain.byHash.get(hash.toLowerCase());
          while (header) {
            for (const log of chain.logsOf.get(header.hash.toLowerCase()) ?? []) {
              if (log.address.toLowerCase() === f.at(16).toLowerCase()) balance -= BigInt(log.data.slice(0, 66));
            }
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
    const indexer = new CoreChainIndexer({ reader: chain, manifest: f.manifest, auditEvery: 10000, onHistory: writer.accept });
    await indexer.start(); await indexer.idle(); await writer.flush();
    return { indexer, history, writer };
  };
  const chain = makeChain(old); const got = await follow(chain);
  expect(got.indexer.metrics.errors).toBe(0);
  expect(got.indexer.v2BoxView(token)).toMatchObject(pile ? { m3: { pile: { seedReturned: true, returnedAmount: String(SEED) } } }
    : { m3: { items: { fundedP: String(SEED), flushedP: '3', owners: { '1': B.toLowerCase() }, paidP: '7', paidByItem: { '1': '7' } } }, money: { m3: { itemBalanceP: String(SEED - 10n) } } });
  const canonical = old.fork(100n, 'm3-canonical');
  if (!pile) canonical.block(101n, [logM3(paid, f.at(16), { id: 1n, owner: A, to: B, grossP: 1n, tipP: 0n }, 0)]);
  canonical.to(deep ? 350n : 110n);
  chain.setBranch(canonical.headers.filter(h => h.number > 100n), canonical.logs.filter(l => l.blockNumber > 100n));
  await got.indexer.enqueue(chain.header(chain.tip)); await got.indexer.idle(); await got.writer.flush();
  expect(got.indexer.metrics.errors).toBe(0);
  expect(got.indexer.v2BoxView(token)).toMatchObject(pile ? { m3: { pile: { seedReturned: false, returnedAmount: '0' } } }
    : { m3: { items: { flushedP: '0', owners: { '1': A.toLowerCase() }, paidP: '1', paidByItem: { '1': '1' } } }, money: { m3: { itemBalanceP: String(SEED - 1n) } } });
  const truth = await follow(makeChain(canonical));
  expect(got.indexer.v2BoxView(token)).toEqual(truth.indexer.v2BoxView(token));
  const want = await truth.history.dump(V2.chainId);
  expect({ ...await got.history.dump(V2.chainId), chainBlocks: want.chainBlocks }).toEqual(want);
  expect(want.activity.map(row => JSON.parse(JSON.parse(row).data))).toContainEqual(expect.objectContaining(pile ? { event: 'SeedLoaded', amount: String(SEED) } : { event: 'ItemFunded', ledgerP: String(SEED) }));
  if (!pile) {
    const payments = want.activity.map(row => JSON.parse(JSON.parse(row).data)).filter(row => row.event === 'ItemPaid');
    expect(payments).toEqual([expect.objectContaining({ id: '1', owner: A, to: B, grossP: '1', tipP: '0' })]);
  }
});
