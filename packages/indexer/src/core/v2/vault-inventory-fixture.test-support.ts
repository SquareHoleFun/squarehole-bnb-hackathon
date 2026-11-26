/** SH-235 / part 2: a published burn/burn vault, 500 items from 1, no item ledger. Offline only. */
import { parseAbiItem, zeroAddress, type Address } from 'viem';
import { synthBoxV2, synthManifestV2 } from '../../../../chain/src/core/v2/test-support/synth-v2';
import { World } from '../../../test/core/core-synth';
import { boxLogsV2, serviceChainV2 } from '../../../test/core/scripted-core-chain';
import { CoreChainIndexer } from '../chain-indexer';
import type { BoxRowV2 } from '../core-row';
import { rolesOfV2 } from './chain-v2';
import { A, B, H, logM3, required } from './m3-fixture.test-support';

export { A, B, H, required };
export const inventoryEvents = {
  transfer: parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)'),
  mint: parseAbiItem('event ConsecutiveTransfer(uint256 indexed fromTokenId,uint256 toTokenId,address indexed fromAddress,address indexed toAddress)'),
  withdrawn: parseAbiItem('event Withdrawn(address indexed owner,uint256[] ids,uint256 principal,uint256 fee,uint256 supplyAfter,uint256 escrowAfter,uint256 insideAfter)'),
  returned: parseAbiItem('event Returned(address indexed owner,uint256[] ids,uint256 principal,uint256 fee,uint256 supplyAfter,uint256 escrowAfter,uint256 insideAfter)'),
  delivered: parseAbiItem('event TicketDelivered(uint256 indexed id,address indexed to,uint256 requestedAt,uint256 ticketsAfter)'),
  released: parseAbiItem('event ReleasedToCreator(address indexed creator,uint256[] ids)'),
};

export function vaultInventoryFixture(firstId = 1n, n = 500, draw = false, boxId = 235n) {
  const base = synthBoxV2({ boxId, specOf: s => ({ ...s, n, firstId, sellers: s.buyers }) });
  const contracts = [...base.record.contracts];
  const codeHashes = [...base.record.codeHashes];
  for (const index of draw ? [8] : [7, 8]) { contracts[index] = zeroAddress; codeHashes[index] = H(0); }
  const record = { ...base.record, contracts, codeHashes };
  const manifest = synthManifestV2(); const release = required(manifest.releases[0]);
  const row: BoxRowV2 = { ...record, ...rolesOfV2(record), protocol: 2, chainId: manifest.chainId,
    registry: release.registry.address, record, spec: base.spec, encodedSpec: base.encodedSpec, release,
    origin: { blockHash: H(100), txHash: H(1), logIndex: 0 }, marks: [], pDecimals: 18 };
  return { ...base, record, manifest, release, row, at: (i: number) => required(contracts[i]) };
}

type Fixture = Pick<ReturnType<typeof vaultInventoryFixture>, 'at' | 'spec'>;
export const inventoryTransfer = (f: Fixture, id: bigint, from: Address, to: Address, i = 0) =>
  logM3(inventoryEvents.transfer, f.at(4), { tokenId: id, from, to }, i);
export const inventoryMint = (f: Fixture, i = 0) => logM3(inventoryEvents.mint, f.at(4), {
  fromTokenId: f.spec.firstId, toTokenId: f.spec.firstId + BigInt(f.spec.n) - 1n, fromAddress: zeroAddress, toAddress: f.at(3),
}, i);
export const inventoryMove = (f: Fixture, name: 'withdrawn' | 'returned', ids: readonly bigint[], owner = A, i = 0) =>
  logM3(inventoryEvents[name], f.at(3), { owner, ids, principal: 1n, fee: 0n, supplyAfter: 0n, escrowAfter: 0n, insideAfter: 0n }, i);

export function vaultInventoryWorld(f = vaultInventoryFixture()) {
  const w = new World('sh-235'); w.block(10n);
  const effectiveOpenAt = w.startTime + 1200n;
  w.block(100n, [boxLogsV2(f), inventoryMint(f), logM3(parseAbiItem('event BoxOpenSet(uint256 effectiveOpenAt,uint256 deadline)'),
    f.at(0), { effectiveOpenAt, deadline: effectiveOpenAt + 30n * 86400n }, 0)]);
  const id = f.spec.firstId;
  w.block(101n, [[inventoryTransfer(f, id, f.at(3), A), inventoryMove(f, 'withdrawn', [id])]]);
  w.block(102n, [[inventoryTransfer(f, id + 1n, f.at(3), A), inventoryTransfer(f, id + 2n, f.at(3), A),
    inventoryMove(f, 'withdrawn', [id + 1n, id + 2n])]]);
  w.block(103n, [[inventoryTransfer(f, id + 1n, A, f.at(3)), inventoryMove(f, 'returned', [id + 1n])]]);
  w.block(104n, [inventoryTransfer(f, id, A, B)]);
  w.to(140n); // Creation and movements are in the cold-start range, before the 32-block tail.
  return w;
}

export async function replayVaultInventory(world: World, f = vaultInventoryFixture()) {
  const chain = serviceChainV2(world, [f], (_box, key) => key === 'receiver.sellersChoice' ? 2 : undefined);
  const indexer = new CoreChainIndexer({ reader: chain, manifest: f.manifest, auditEvery: 10000 });
  await indexer.start(); await indexer.idle();
  if (indexer.metrics.errors) throw new Error(required(indexer.metrics.lastError));
  return { indexer, chain };
}

/** Actual indexer publication, including row/spec and the common asOf envelope. */
export async function publishedVaultInventory() {
  const fixture = vaultInventoryFixture();
  const { indexer } = await replayVaultInventory(vaultInventoryWorld(fixture), fixture);
  const view = required(indexer.v2BoxView(fixture.at(1)));
  indexer.stop();
  return { view, manifest: fixture.manifest };
}
