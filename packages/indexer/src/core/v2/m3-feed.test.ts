import { parseAbiItem, zeroAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { decodeV2Logs, routeV2 } from './events-v2';
import { applyV2Block, liveViewV2 } from './views-v2';
import { jsonV2 } from '../core-row';
import { A, B, H, logM3, m3Fixture, required } from './m3-fixture.test-support';

const transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)');
const consecutive = parseAbiItem('event ConsecutiveTransfer(uint256 indexed fromTokenId,uint256 toTokenId,address indexed fromAddress,address indexed toAddress)');
const paid = parseAbiItem('event ItemPaid(uint256 indexed id,address indexed owner,address indexed to,uint256 grossP,uint256 tipP)');
const funded = parseAbiItem('event ItemFunded(uint256 indexed receiptId,uint256 indexed batchId,uint8 side,uint8 source,uint256 choiceP,uint256 ledgerP)');
const residue = parseAbiItem('event ResidueFlushed(uint256 p)');
const lifecycle = parseAbiItem('event ItemLifecycleRecorded(uint256 indexed sequence,bytes32 indexed ticketKey,uint256 indexed itemId,uint256 fundingCursor,uint64 at,uint8 kind)');
type Fixture = ReturnType<typeof m3Fixture>;
const header = { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1000n };
function replay(f: Fixture, logs: ReturnType<typeof logM3>[]) {
  return applyV2Block(undefined, header, decodeV2Logs(logs, routeV2(f.release, f.manifest, [], [f.record])), f.row);
}
const move = (f: Fixture, id: bigint, from: Address, to: Address, i: number) => logM3(transfer, f.at(4), { tokenId: id, from, to }, i);
const mint = (f: Fixture, first = f.spec.firstId, last = first + BigInt(f.spec.n) - 1n) => logM3(consecutive, f.at(4), { fromTokenId: first, toTokenId: last, fromAddress: zeroAddress, toAddress: f.at(3) }, 0);
const fund = (f: Fixture, amount: bigint, i = 0) => logM3(funded, f.at(5), { receiptId: 1n, batchId: 0n, side: 1, source: 3, choiceP: amount, ledgerP: amount }, i);
const pay = (f: Fixture, amount: bigint, i: number, id = f.spec.firstId, owner = A, to = B, tipP = 0n) => logM3(paid, f.at(16), { id, owner, to, grossP: amount, tipP }, i);

describe('M352-FEED ownership without ownerOf scans', () => {
  it('indexes the initial range, wallet transfers, returns, re-picks and burns independently of lifecycle facts', () => {
    const f = m3Fixture(); const id = f.spec.firstId;
    const life = logM3(lifecycle, f.at(3), { sequence: 1n, ticketKey: H(0), itemId: id, fundingCursor: 0n, at: 1000n, kind: 4 }, 2);
    const logs = [mint(f), move(f, id, f.at(3), A, 1), life, move(f, id, A, B, 3),
      move(f, id, B, f.at(3), 4), move(f, id, f.at(3), A, 5), move(f, id + 1n, f.at(3), zeroAddress, 6)];
    const result = replay(f, logs.reverse().concat(logs));
    expect(result.state.view.m3?.items).toMatchObject({ owners: {
      [String(id)]: A.toLowerCase(), [String(id + 1n)]: null,
      [String(id + 2n)]: f.at(3).toLowerCase(), [String(id + 3n)]: f.at(3).toLowerCase(),
    } });
    // Existing custody fields keep their meaning; a transfer does not invent a journal entry.
    expect(result.state.view.m3?.items?.items).toEqual({ [String(id)]: { inside: false, sequence: 1n } });
    expect(result.state.view.m3?.items?.lifecycleCursor).toBe(1n);
    const next = { ...header, number: 102n, hash: H(102), parentHash: header.hash };
    const event = { ...move(f, id, A, B, 0), blockNumber: next.number, blockHash: next.hash };
    const child = applyV2Block(result.state, next, decodeV2Logs([event], routeV2(f.release, f.manifest, [], [f.record])), f.row);
    expect(child.state.view.m3?.items).toMatchObject({ owners: { [String(id)]: B.toLowerCase() } });
    expect(result.state.view.m3?.items).toMatchObject({ owners: { [String(id)]: A.toLowerCase() } });
  });

  it('keeps full-width item ids exact and rejects out-of-range or reversed ranges before expansion', () => {
    const base = m3Fixture(); const firstId = 2n ** 200n + 1n;
    const spec = { ...base.spec, firstId };
    const f = { ...base, spec, row: { ...base.row, spec } };
    expect(replay(f, [mint(f), move(f, firstId + 2n, f.at(3), A, 1)]).state.view.m3?.items).toMatchObject({ owners: { [String(firstId + 2n)]: A.toLowerCase() } });
    for (const log of [mint(f, firstId - 1n, firstId), mint(f, firstId, firstId + 4n), mint(f, firstId + 1n, firstId), move(f, firstId + 4n, A, B, 1)]) {
      expect(() => replay(f, [log])).toThrow(/collection/i);
    }
  });

  it('ignores foreign emitters, token transfers, ticket transfers and removed logs', () => {
    const base = m3Fixture(); const contracts = [...base.record.contracts];
    contracts[7] = base.record.creator;
    const f = { ...base, record: { ...base.record, contracts } }; const id = f.spec.firstId;
    const logs = [move(f, id, zeroAddress, A, 0), { ...move(f, id, A, B, 1), address: B },
      { ...move(f, id, A, B, 2), address: f.at(1) }, { ...move(f, id, A, B, 3), removed: true },
      { ...move(f, id, A, B, 4), address: base.record.creator }];
    expect(replay(f, logs).state.view.m3?.items).toMatchObject({ owners: { [String(id)]: A.toLowerCase() }, paidP: 0n, paidByItem: {} });
  });
});

describe('M352-PAID claim-only ItemPaid history', () => {
  it('sums actual tranches by item once, preserving historical recipients and current ownership separately', () => {
    const f = m3Fixture(); const id = f.spec.firstId; const amount = 2n ** 127n - 1n;
    const logs = [fund(f, 3n * amount), move(f, id, zeroAddress, A, 1), pay(f, amount, 2),
      move(f, id, A, B, 3), pay(f, amount, 4, id, B, A), pay(f, 1n, 5, id + 1n),
      logM3(residue, f.at(16), { p: 3n }, 6)];
    const result = replay(f, [...logs].reverse().concat(logs));
    expect(result.state.view.m3?.items).toMatchObject({ owners: { [String(id)]: B.toLowerCase() },
      paidP: 2n * amount + 1n, paidByItem: { [String(id)]: 2n * amount, [String(id + 1n)]: 1n }, fundedP: 3n * amount, flushedP: 3n });
    const data = result.activity.filter(a => a.data.event === 'ItemPaid').map(a => a.data);
    expect(data).toHaveLength(3);
    expect(data[0]).toMatchObject({ grossP: String(amount), tipP: '0', owner: A, to: B });
    const wire = JSON.parse(JSON.stringify(jsonV2(liveViewV2(result.state, header.timestamp))));
    expect(wire.m3.items.paidByItem[String(id)]).toBe(String(2n * amount));
    expect(wire.m3.items.paidP).toBe(String(2n * amount + 1n));
    expect(wire.m3.items).not.toHaveProperty('claimableP');
    expect(applyV2Block(result.state, header, [], f.row).state).toBe(result.state);
  });

  it('does not treat a payment recipient or a pre-callback claim owner as the current NFT owner', () => {
    const f = m3Fixture(); const id = f.spec.firstId;
    // The recipient can transfer the NFT in its payout callback, before ItemPaid is emitted.
    const result = replay(f, [fund(f, 5n), move(f, id, zeroAddress, A, 1), move(f, id, A, B, 2), pay(f, 5n, 3, id, A, A)]);
    expect(result.state.view.m3?.items).toMatchObject({ owners: { [String(id)]: B.toLowerCase() }, paidByItem: { [String(id)]: 5n } });
  });

  it('refuses tips, invalid ids and payment/residue combinations exceeding transferred backing in either order', () => {
    const f = m3Fixture();
    for (const logs of [
      [fund(f, 10n), pay(f, 11n, 1)],
      [fund(f, 10n), pay(f, 1n, 1, f.spec.firstId, A, B, 1n)],
      [fund(f, 10n), pay(f, 1n, 1, f.spec.firstId + 4n)],
      [fund(f, 10n), pay(f, 9n, 1), logM3(residue, f.at(16), { p: 2n }, 2)],
      [fund(f, 10n), logM3(residue, f.at(16), { p: 2n }, 1), pay(f, 9n, 2)],
    ]) expect(() => replay(f, logs)).toThrow(/payment|claim|collection|funding|residue/i);
    const result = replay(f, [fund(f, 10n), { ...pay(f, 4n, 1), removed: true }, { ...pay(f, 4n, 2), address: A }]);
    expect(required(result.state.view.m3).items).toMatchObject({ paidP: 0n, paidByItem: {} });
  });
});
