import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toEventSelector, type Abi, type AbiEvent } from 'viem';
import { CORE_TOPIC0_V2 } from '../../../chain/src/core/v2/events-v2';
import { vaultV2ExtraEventsAbi } from '../../../chain/src/core/v2/abi-v2';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { MemoryHistory } from '../../src/history/memory-history';
import { HistoryWriter } from '../../src/history/writer';
import { World } from '../core/core-synth';
import { boxLogsV2, serviceChainV2, V2 } from '../core/scripted-core-chain';
import { m3Fixture, logM3, A, H } from '../../src/core/v2/m3-fixture.test-support';
import { decodeV2Log, decodeV2Logs, routeV2 } from '../../src/core/v2/events-v2';
import { applyV2Block } from '../../src/core/v2/views-v2';

const abi: Abi = JSON.parse(readFileSync(new URL('../../../contracts/out/BoxVaultV2.sol/BoxVaultV2.json', import.meta.url), 'utf8')).abi;
const event = abi.find((e): e is AbiEvent => e.type === 'event' && e.name === 'FailureItemPaid');
if (!event) throw new Error('missing production FailureItemPaid event');
const principal = 2n ** 200n + 7n;

describe('FINAL-OC02: failed hidden-art T principal retains its causal event', () => {
  it('decodes compiled vault bytes at the authenticated role with exact identity', () => {
    const f = m3Fixture(); const route = routeV2(f.release, f.manifest, [], [f.record]);
    const raw = logM3(event, f.at(3), { creator: A, id: 1n, principal }, 3, 101n, H(101));
    expect(vaultV2ExtraEventsAbi).toEqual([event]);
    expect(CORE_TOPIC0_V2.vault).toContain(toEventSelector(event));
    expect(decodeV2Log(raw, route)).toEqual({ source: 'vault', name: 'FailureItemPaid', args: { creator: A, id: 1n, principal },
      address: f.at(3), boxId: f.record.boxId, listingId: null,
      ref: { blockNumber: 101n, blockHash: H(101), txHash: raw.transactionHash, txIndex: raw.transactionIndex, logIndex: 3 } });
    expect(decodeV2Log({ ...raw, address: A }, route)).toBeNull();
    expect(decodeV2Log({ ...raw, address: f.at(5) }, route)).toBeNull();
    expect(decodeV2Log({ ...raw, removed: true }, route)).toBeNull();
    expect(decodeV2Log({ ...raw, data: '0x' }, route)).toBeNull();
  });

  it('replays once into decimal activity without inventing a creator P claim', () => {
    const f = m3Fixture(); const route = routeV2(f.release, f.manifest, [], [f.record]);
    const header = { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1001n };
    const parent = applyV2Block(undefined, { ...header, number: 100n, hash: H(100), parentHash: H(99) }, [], f.row).state;
    const raw = logM3(event, f.at(3), { creator: A, id: 1n, principal }, 3, header.number, header.hash);
    const decoded = decodeV2Logs([raw, raw], route);
    const child = applyV2Block(parent, header, [...decoded, ...decoded], f.row);
    expect(child.activity).toEqual([{ id: '101-3', block: 101n, blockHash: H(101), txHash: raw.transactionHash,
      logIndex: 3, timestamp: 1001n, kind: 'v2_event', data: { source: 'vault', event: 'FailureItemPaid', emitter: f.at(3).toLowerCase(), creator: A, id: '1', principal: principal.toString() } }]);
    expect(child.state.claimPayments).toEqual([]);
    expect(child.state.view.creatorClaims).toEqual([]);
    expect(child.state.view.fees).toEqual(parent.view.fees);
    expect(applyV2Block(child.state, header, decoded, f.row).activity).toEqual([]);
    const canonical = applyV2Block(parent, { ...header, hash: H(201) }, [], f.row);
    expect(canonical.activity).toEqual([]);
    expect(canonical.state.claimPayments).toEqual([]);
    expect(canonical.state.view.creatorClaims).toEqual([]);
    expect(parent.block).toBe(100n);
  });

  it.each([false, true])('retains canonical durable history through reorg/rebuild (deep=%s)', async deep => {
    const f = m3Fixture(); const token = f.at(1).toLowerCase();
    const old = new World('final-oc-old'); old.block(10n); old.block(100n, [boxLogsV2(f)]);
    old.block(101n, [logM3(event, f.at(3), { creator: A, id: 1n, principal }, 0)]);
    old.to(deep ? 260n : 105n);
    const makeChain = (world: World) => serviceChainV2(world, [f], (_box, key) => ['receiver.buyersChoice', 'receiver.sellersChoice'].includes(key) ? 5 : undefined);
    const follow = async (reader: ReturnType<typeof makeChain>) => {
      const history = new MemoryHistory(); const writer = new HistoryWriter(history);
      const indexer = new CoreChainIndexer({ reader, manifest: f.manifest, auditEvery: 10000, onHistory: writer.accept });
      await indexer.start(); await indexer.idle(); await writer.flush();
      expect(indexer.metrics.errors).toBe(0);
      return { history, writer, indexer };
    };
    const chain = makeChain(old); const got = await follow(chain);
    const activity = async (history: MemoryHistory) => (await history.dump(V2.chainId)).activity.map(row => JSON.parse(JSON.parse(row).data));
    expect(await activity(got.history)).toContainEqual(expect.objectContaining({ event: 'FailureItemPaid', principal: principal.toString(), id: '1', creator: A }));
    const canonical = old.fork(100n, 'final-oc-canonical');
    canonical.block(101n, [logM3(event, f.at(3), { creator: A, id: 2n, principal: 19n }, 0)]);
    canonical.to(deep ? 350n : 110n);
    chain.setBranch(canonical.headers.filter(h => h.number > 100n), canonical.logs.filter(l => l.blockNumber > 100n));
    await got.indexer.enqueue(chain.header(chain.tip)); await got.indexer.idle(); await got.writer.flush();
    expect(got.indexer.metrics.errors).toBe(0);
    expect((await activity(got.history)).filter(row => row.event === 'FailureItemPaid')).toEqual([
      expect.objectContaining({ event: 'FailureItemPaid', principal: '19', id: '2', creator: A }),
    ]);
    const truth = await follow(makeChain(canonical));
    expect(got.indexer.v2BoxView(token)).toEqual(truth.indexer.v2BoxView(token));
    const expected = await truth.history.dump(V2.chainId);
    expect({ ...await got.history.dump(V2.chainId), chainBlocks: expected.chainBlocks }).toEqual(expected);
  });
});
