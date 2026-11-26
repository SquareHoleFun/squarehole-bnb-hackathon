import { parseAbiItem, zeroAddress, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { applyV2Block } from './views-v2';
import { hasCollectionVaultV2 } from './vault-inventory-v2';
import { decodeV2Logs, routeV2 } from './events-v2';
import { m3ViewV2 } from './m3-views-v2';
import { jsonV2 } from '../core-row';
import { logM3, m3Fixture } from './m3-fixture.test-support';
import { A, B, H, required, inventoryEvents, inventoryMint, inventoryMove, inventoryTransfer,
  publishedVaultInventory, replayVaultInventory, vaultInventoryFixture, vaultInventoryWorld } from './vault-inventory-fixture.test-support';

const header = { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1000n };
type Fixture = ReturnType<typeof vaultInventoryFixture>;
function fold(f: Fixture, logs: ReturnType<typeof logM3>[], previous?: ReturnType<typeof applyV2Block>['state'], block = header) {
  return applyV2Block(previous, block, decodeV2Logs(logs, routeV2(f.release, f.manifest, [], [f.record])), f.row);
}
const order = (log: number, tx = 0, block = 101n) => (block << 64n) | (BigInt(tx) << 32n) | BigInt(log);

describe('SH-235 independent vault inventory', () => {
  it('replays a burn/burn box from creation with single and batch take-outs, a put-back and a second wallet', async () => {
    const { view } = await publishedVaultInventory();
    expect(view.choices).toEqual({ buyers: 'burn', sellers: 'burn' });
    expect(view.gate.open).toBe(true);
    expect(view).not.toHaveProperty('m3');
    expect(view.row.record.contracts[16]).toBe(zeroAddress);
    expect(view.vaultItems).toEqual({ firstId: '1', n: '500', known: [
      { id: '2', inside: true, sequence: String(order(1, 0, 103n)) },
      { id: '3', inside: false, sequence: String(order(2, 0, 102n)) },
      { id: '1', inside: false, sequence: String(order(1)) },
    ], owners: { '1': B.toLowerCase(), '3': A.toLowerCase() } });
    const again = await publishedVaultInventory();
    expect(again.view).toEqual(view);
    expect(view.asOf.block).toBe('140');
  });

  it('uses transfer owners even when a receiving contract passes the item on before Withdrawn', () => {
    const f = vaultInventoryFixture(); const receiver = f.record.creator;
    const result = fold(f, [inventoryMint(f), inventoryTransfer(f, 1n, f.at(3), receiver, 1),
      inventoryTransfer(f, 1n, receiver, B, 2), inventoryMove(f, 'withdrawn', [1n], receiver, 3)]);
    expect(result.state.view.vaultItems?.owners).toEqual({ '1': B.toLowerCase() });
    expect(result.state.view.vaultItems?.known).toEqual([{ id: 1n, inside: false, sequence: order(3) }]);
    expect(result.activity.map(e => e.data.event)).toEqual(['ConsecutiveTransfer', 'Transfer', 'Transfer', 'Withdrawn']);
    expect(result.state.view).not.toHaveProperty('m3');
  });

  it('folds put-backs, re-picks and burns without inventing ledger events or moving on a wallet transfer', () => {
    const f = vaultInventoryFixture();
    const logs = [inventoryMint(f), inventoryTransfer(f, 1n, f.at(3), A, 1), inventoryMove(f, 'withdrawn', [1n], A, 2),
      inventoryTransfer(f, 1n, A, f.at(3), 3), inventoryMove(f, 'returned', [1n], A, 4)];
    const returned = fold(f, logs);
    expect(returned.state.view.vaultItems).toEqual({ firstId: 1n, n: 500n,
      known: [{ id: 1n, inside: true, sequence: order(4) }], owners: {} });
    const picked = fold(f, [...logs, inventoryTransfer(f, 1n, f.at(3), A, 5), inventoryMove(f, 'withdrawn', [1n], A, 6),
      inventoryTransfer(f, 1n, A, zeroAddress, 7)]);
    expect(picked.state.view.vaultItems).toEqual({ firstId: 1n, n: 500n,
      known: [{ id: 1n, inside: false, sequence: order(6) }], owners: { '1': null } });
    expect(picked.activity).toHaveLength(8);
    expect(picked.activity.some(e => e.data.source === 'itemLedger' || e.data.event === 'ItemLifecycleRecorded')).toBe(false);
  });

  it('folds draw delivery and release-to-creator arrays from ordinary vault events', () => {
    const f = vaultInventoryFixture(1n, 500, true);
    const result = fold(f, [inventoryMint(f), inventoryTransfer(f, 7n, f.at(3), A, 1),
      logM3(inventoryEvents.delivered, f.at(3), { id: 7n, to: A, requestedAt: 900n, ticketsAfter: 0n }, 2),
      inventoryTransfer(f, 8n, f.at(3), f.record.creator, 3), inventoryTransfer(f, 9n, f.at(3), f.record.creator, 4),
      logM3(inventoryEvents.released, f.at(3), { creator: f.record.creator, ids: [8n, 9n] }, 5)]);
    expect(result.state.view.vaultItems).toEqual({ firstId: 1n, n: 500n, known: [
      { id: 8n, inside: false, sequence: order(5) }, { id: 9n, inside: false, sequence: order(5) },
      { id: 7n, inside: false, sequence: order(2) },
    ], owners: { '7': A.toLowerCase(), '8': f.record.creator.toLowerCase(), '9': f.record.creator.toLowerCase() } });
  });

  it('deduplicates logs and repeated blocks; order keys use block, transaction and log, not ledger sequence', () => {
    const f = vaultInventoryFixture();
    const logs = [inventoryMint(f), inventoryTransfer(f, 2n, f.at(3), A, 1), inventoryMove(f, 'withdrawn', [2n], A, 2),
      inventoryTransfer(f, 1n, f.at(3), B, 3), inventoryMove(f, 'withdrawn', [1n], B, 4)]
      .map((log, i) => ({ ...log, transactionIndex: i >= 3 ? 1 : 0 }));
    const plain = fold(f, logs);
    const repeated = fold(f, [...logs].reverse().concat(logs));
    expect(repeated).toEqual(plain);
    expect(repeated.activity).toHaveLength(5);
    expect(repeated.state.view.vaultItems?.known).toEqual([
      { id: 1n, inside: false, sequence: order(4, 1) }, { id: 2n, inside: false, sequence: order(2) },
    ]);
    expect(fold(f, logs, repeated.state).state).toBe(repeated.state);
    expect(() => fold(f, logs.map(l => ({ ...l, blockHash: H(999) })))).toThrow(/block\/hash/);
  });

  it('keeps full-width non-1 IDs exact and does not enumerate untouched range-minted items', () => {
    const first = 2n ** 200n + 91n; const f = vaultInventoryFixture(first, 10000);
    expect(fold(f, [inventoryMint(f)]).state.view.vaultItems).toEqual({ firstId: first, n: 10000n, known: [], owners: {} });
    const result = fold(f, [inventoryMint(f), inventoryTransfer(f, first + 13n, f.at(3), B, 1),
      inventoryMove(f, 'withdrawn', [first + 13n], A, 2)]);
    expect(jsonV2(result.state.view.vaultItems)).toEqual({ firstId: String(first), n: '10000',
      known: [{ id: String(first + 13n), inside: false, sequence: String(order(2)) }], owners: { [String(first + 13n)]: B.toLowerCase() } });
    expect(() => fold(f, [inventoryMove(f, 'withdrawn', [first - 1n])])).toThrow(/outside collection/);
    expect(() => fold(f, [inventoryTransfer(f, first + 10000n, A, B)])).toThrow(/outside collection/);
    expect(() => fold(f, [logM3(inventoryEvents.mint, f.at(4), { fromTokenId: first + 1n, toTokenId: first, fromAddress: zeroAddress, toAddress: A }, 0)])).toThrow(/reversed collection/);
  });

  it('uses ConsecutiveTransfer owners for known IDs, and ignores foreign, removed and ticket logs', () => {
    const f = vaultInventoryFixture(1n, 500, true);
    const logs = [inventoryMint(f), logM3(inventoryEvents.mint, f.at(4), {
      fromTokenId: 1n, toTokenId: 3n, fromAddress: zeroAddress, toAddress: B,
    }, 1), inventoryMove(f, 'withdrawn', [1n, 2n], A, 2),
    { ...inventoryTransfer(f, 1n, B, A, 3), address: A },
    { ...inventoryTransfer(f, 1n, B, A, 4), removed: true },
    { ...inventoryTransfer(f, 1n, B, A, 5), address: f.at(7) }];
    expect(fold(f, logs).state.view.vaultItems?.owners).toEqual({ '1': B.toLowerCase(), '2': B.toLowerCase() });
  });

  it.each([[500, 13, 1576], [10000, 1000, 119848]])('adds only moved-ID bytes (collection %s, outside %s)', (n, count, bytes) => {
    const f = vaultInventoryFixture(1n, n);
    const ids = Array.from({ length: count }, (_, i) => BigInt(i) + 1n);
    const block = { ...header, number: 12150000n, hash: H(12150000) };
    const logs = [inventoryMint(f), ...ids.map((id, i) => inventoryTransfer(f, id, f.at(3), A, i + 1)),
      inventoryMove(f, 'withdrawn', ids, A, count + 1)].map(l => ({ ...l, blockNumber: block.number, blockHash: block.hash }));
    const view = jsonV2(fold(f, logs, undefined, block).state.view);
    const before = { ...view }; delete before.vaultItems;
    expect(Buffer.byteLength(JSON.stringify(view)) - Buffer.byteLength(JSON.stringify(before))).toBe(bytes);
    expect(view.vaultItems?.known).toHaveLength(count);
    expect(Object.keys(required(view.vaultItems).owners)).toHaveLength(count);
  });

  it.each([false, true])('rolls placement and owners back on a reorg, including a deep rebuild (%s)', async deep => {
    const f = vaultInventoryFixture(); const old = vaultInventoryWorld(f).fork(deep ? 140n : 105n, 'sh-235-parent'); old.to(deep ? 300n : 105n);
    const { indexer, chain } = await replayVaultInventory(old, f);
    const oldView = required(indexer.v2BoxView(f.at(1)));
    const canonical = old.fork(102n, 'sh-235-reorg');
    canonical.block(103n, [inventoryTransfer(f, 1n, A, zeroAddress)]); canonical.to(deep ? 350n : 110n);
    chain.setBranch(canonical.headers.filter(h => h.number > 102n), canonical.logs.filter(l => l.blockNumber > 102n));
    await indexer.enqueue(chain.header(chain.tip)); await indexer.idle();
    expect(indexer.metrics.errors).toBe(0);
    const truth = await replayVaultInventory(canonical, f);
    expect(indexer.v2BoxView(f.at(1))).toEqual(truth.indexer.v2BoxView(f.at(1)));
    expect(indexer.v2BoxView(f.at(1))?.vaultItems?.owners).toEqual({ '1': null, '2': A.toLowerCase(), '3': A.toLowerCase() });
    expect(oldView.vaultItems?.owners).toEqual({ '1': B.toLowerCase(), '3': A.toLowerCase() });
    if (deep) expect(indexer.metrics.rebuilds).toBeGreaterThan(0);
    else expect(indexer.metrics.reorgs).toBeGreaterThan(0);
    indexer.stop(); truth.indexer.stop();
  });

  it('uses spec and roles only: all fee choices qualify; shops, piles and absent roles do not', () => {
    const f = vaultInventoryFixture();
    for (const a of [{ leg: 2, dest: 1, destParams: '0x' }, { leg: 1, dest: 2, destParams: '0x' },
      { leg: 1, dest: 6, destParams: H(1) }, { leg: 1, dest: 8, destParams: H(1) }]) {
      const spec = { ...f.spec, buyers: { ...f.spec.buyers, a: { ...a, legParams: '0x' as Hex, destParams: a.destParams as Hex } } };
      expect(fold({ ...f, spec, row: { ...f.row, spec } }, []).state.view.vaultItems).toEqual({ firstId: 1n, n: 500n, known: [], owners: {} });
    }
    for (const boxType of [4, 5]) expect(hasCollectionVaultV2({ ...f.spec, boxType }, f.at(3), f.at(4))).toBe(false);
    for (const n of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(hasCollectionVaultV2({ ...f.spec, n }, f.at(3), f.at(4))).toBe(false);
    for (const missing of [undefined, zeroAddress]) {
      expect(hasCollectionVaultV2(f.spec, missing, f.at(4))).toBe(false);
      expect(hasCollectionVaultV2(f.spec, f.at(3), missing)).toBe(false);
    }
  });

  it('publishes both records for an items side; placement/order/outside owners agree and M3 bytes are unchanged', () => {
    const f = m3Fixture();
    const life = (id: bigint, sequence: bigint, kind: number, i: number) => logM3(parseAbiItem(
      'event ItemLifecycleRecorded(uint256 indexed sequence,bytes32 indexed ticketKey,uint256 indexed itemId,uint256 fundingCursor,uint64 at,uint8 kind)'),
    f.at(3), { sequence, ticketKey: H(0), itemId: id, fundingCursor: 0n, at: 1000n, kind }, i);
    const logs = [inventoryMint(f), inventoryTransfer(f, 1n, f.at(3), A, 1), life(1n, 1n, 4, 2),
      inventoryMove(f, 'withdrawn', [1n], A, 3), inventoryTransfer(f, 2n, f.at(3), A, 4), life(2n, 2n, 4, 5),
      inventoryMove(f, 'withdrawn', [2n], A, 6), inventoryTransfer(f, 1n, A, f.at(3), 7), life(1n, 3n, 5, 8),
      inventoryMove(f, 'returned', [1n], A, 9), inventoryTransfer(f, 2n, A, B, 10)];
    const events = decodeV2Logs(logs, routeV2(f.release, f.manifest, [], [f.record]));
    const view = applyV2Block(undefined, header, events, f.row).state.view;
    const inventory = required(view.vaultItems); const m3 = required(view.m3?.items);
    expect(JSON.stringify(jsonV2(view.m3))).toBe(JSON.stringify(jsonV2(m3ViewV2(events, f.record.boxId, f.spec, f.record.creator))));
    expect(inventory.known.map(({ id, inside }) => ({ id: String(id), inside }))).toEqual(Object.entries(m3.items)
      .sort((a, b) => a[1].sequence > b[1].sequence ? -1 : 1).map(([id, item]) => ({ id, inside: item.inside })));
    for (let id = f.spec.firstId; id < f.spec.firstId + BigInt(f.spec.n); id++) {
      const known = inventory.known.find(i => i.id === id);
      expect(known?.inside ?? true).toBe(m3.items[String(id)]?.inside ?? true);
      if (known && !known.inside) expect(inventory.owners[String(id)]).toBe(m3.owners[String(id)]);
      else expect(inventory.owners).not.toHaveProperty(String(id));
    }
    expect(m3.lifecycleCursor).toBe(3n);
  });
});
