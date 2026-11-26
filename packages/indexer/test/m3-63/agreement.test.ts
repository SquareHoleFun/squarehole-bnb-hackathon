import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAbiItem, toHex, zeroAddress, type Abi, type AbiEvent } from 'viem';
import { decodeV2Logs, routeV2 } from '../../src/core/v2/events-v2';
import { applyV2Block, liveViewV2 } from '../../src/core/v2/views-v2';
import { readItemClaimV2, readItemTicketV2, readM3MoneyV2, readPileQuoteV2 } from '../../src/core/v2/m3-reads-v2';
import { jsonV2 } from '../../src/core/core-row';
import { A, B, H, logM3, m3Fixture, required } from '../../src/core/v2/m3-fixture.test-support';
import { reader } from './reader-double';

const header = { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1000n };
const funded = parseAbiItem('event ItemFunded(uint256 indexed receiptId,uint256 indexed batchId,uint8 side,uint8 source,uint256 choiceP,uint256 ledgerP)');
const lifecycle = parseAbiItem('event ItemLifecycleRecorded(uint256 indexed sequence,bytes32 indexed ticketKey,uint256 indexed itemId,uint256 fundingCursor,uint64 at,uint8 kind)');
const paid = parseAbiItem('event ItemPaid(uint256 indexed id,address indexed owner,address indexed to,uint256 grossP,uint256 tipP)');
const transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)');
const residue = parseAbiItem('event ResidueFlushed(uint256 p)');

describe('M363-EVENTS: every compiled M3 event is decoded at its authenticated role without numeric money loss', () => {
  const parts = [
    ['ItemLedgerV2', 'ItemLedgerV2', 16, false], ['PileVaultV2', 'PileVaultV2', 3, true],
    ['IBoxReceiverV2', 'IBoxReceiverItemsV2', 5, false], ['IBoxVaultV2', 'IBoxVaultItemsV2', 3, false],
  ] as const;
  it.each(parts)('%s / %s uses its actual artifact signatures and indexed fields', (file, name, role, pile) => {
    const abi = (JSON.parse(readFileSync(new URL(`../../../contracts/out/${file}.sol/${name}.json`, import.meta.url), 'utf8')) as { abi: Abi }).abi;
    const events = abi.filter((e): e is AbiEvent => e.type === 'event');
    expect(events.length).toBeGreaterThan(0);
    const f = m3Fixture(pile), route = routeV2(f.release, f.manifest, [], [f.record]);
    for (const event of events) {
      const args = Object.fromEntries(event.inputs.map(input => [input.name,
        input.type === 'address' ? A : input.type === 'bytes32' ? H(77) : input.type === 'bytes4' ? '0x12345678'
          : input.type === 'uint8' ? 2 : input.type === 'uint64' ? 2n ** 63n + 1n : 2n ** 200n + 7n]));
      const log = logM3(event, f.at(role), args, 0);
      expect(decodeV2Logs([log], route)).toMatchObject([{ name: event.name, boxId: f.record.boxId, args }]);
      expect(decodeV2Logs([{ ...log, address: B }, { ...log, removed: true }], route)).toEqual([]);
    }
  });
});

it('M363-HISTORY: same-second draws retain distinct starts, reverse delivery, cancel, transfer, partial payments and residue', async () => {
  const f = m3Fixture(), route = routeV2(f.release, f.manifest, [], [f.record]);
  const logs: ReturnType<typeof logM3>[] = [];
  const fund = (id: bigint, source: number, choiceP: bigint, side = 1, ledgerP = choiceP) => logs.push(logM3(funded, f.at(5), {
    receiptId: id, batchId: source === 1 ? 1n : 0n, side, source, choiceP, ledgerP,
  }, logs.length));
  const life = (sequence: bigint, kind: number, key: bigint, itemId: bigint, fundingCursor: bigint) => logs.push(logM3(lifecycle, f.at(3), {
    sequence, kind, ticketKey: toHex(key, { size: 32 }), itemId, fundingCursor, at: 1000n,
  }, logs.length));
  fund(1n, 3, 43n); fund(2n, 3, 20n, 2, 0n);
  life(1n, 1, 1n, 0n, 2n); fund(3n, 1, 40n); life(2n, 1, 2n, 0n, 3n);
  life(3n, 2, 2n, 3n, 3n); life(4n, 2, 1n, 1n, 3n);
  life(5n, 5, 0n, 1n, 3n); life(6n, 4, 0n, 1n, 3n);
  life(7n, 1, 3n, 0n, 3n); fund(4n, 2, 40n); life(8n, 3, 3n, 0n, 4n);
  logs.push(logM3(transfer, f.at(4), { from: zeroAddress, to: A, tokenId: 1n }, logs.length));
  // A recipient callback transfers the NFT before ItemPaid; payment history cannot overwrite its new owner.
  logs.push(logM3(transfer, f.at(4), { from: A, to: B, tokenId: 1n }, logs.length));
  logs.push(logM3(paid, f.at(16), { id: 1n, owner: A, to: A, grossP: 7n, tipP: 0n }, logs.length));
  logs.push(logM3(paid, f.at(16), { id: 1n, owner: B, to: B, grossP: 5n, tipP: 0n }, logs.length));
  logs.push(logM3(residue, f.at(16), { p: 13n }, logs.length));
  const apply = (input: typeof logs) => applyV2Block(undefined, header, decodeV2Logs(input, route), f.row);
  const result = apply(logs.concat(logs).reverse());
  expect(result).toEqual(apply(logs));
  expect(result.state.view.m3?.items).toMatchObject({ fundedP: 123n, retainedBurnP: 20n, paidP: 12n, flushedP: 13n,
    outsideIndex: 20n, owners: { '1': B.toLowerCase() }, paidByItem: { '1': 12n },
    tickets: { [H(1)]: { start: 0n, state: 'delivered', itemId: 1n }, [H(2)]: { start: 10n, state: 'delivered', itemId: 3n },
      [H(3)]: { start: 10n, state: 'cancelled', itemId: null } },
  });
  const wire = JSON.parse(JSON.stringify(jsonV2(liveViewV2(result.state, header.timestamp))));
  expect(wire.m3.items).toMatchObject({ fundedP: '123', paidP: '12', flushedP: '13', paidByItem: { '1': '12' } });
  expect(wire.m3.items).not.toHaveProperty('claimableP');
  const r = reader({ balanceOf: 98n });
  expect(await readM3MoneyV2(r, f.row, required(result.state.view.m3), H(101))).toMatchObject({ itemBalanceP: 98n });
});

describe('M363-READS: canonical reads preserve liabilities, ownership and payout status', () => {
  it.each([6, 8, 18])('at %s decimals, raw credit above JS safe integer remains exact', async decimals => {
    const n = 2n ** 100n + 1n, r = reader({ itemCredit: [n, 7n], ownerOf: B });
    const got = await readItemClaimV2(r, { ...r.f.row, pDecimals: decimals }, { id: 1n }, H(101));
    expect(got).toMatchObject({ owner: B, outsideP: n, stashP: 7n, claimableP: n + 7n, payout: 'available' });
    expect(jsonV2(got)).toMatchObject({ outsideP: String(n), claimableP: String(n + 7n) });
  });
  it.each([{ fundingCursor: 1n }, { lifecycleCursor: 2n }])('neither incomplete journal authorizes a stale claim: %s', async overrides => {
    const r = reader(overrides);
    expect(await readItemClaimV2(r, r.f.row, { id: 1n }, H(101))).toMatchObject({ status: 'sync_pending', outsideP: null, stashP: null, claimableP: null, payout: 'not_ready' });
    expect(r.callFromAt).not.toHaveBeenCalled();
    expect(await readItemTicketV2(r, r.f.row, H(7), H(101))).toMatchObject({ start: null, open: null, outsideP: null });
  });
  it('refused payout and unavailable RPC leave credit intact with different states', async () => {
    const r = reader({ itemCredit: [10n, 2n] });
    r.callFromAt.mockRejectedValueOnce(Object.assign(new Error('paused'), { code: 3 }));
    expect(await readItemClaimV2(r, r.f.row, { id: 1n }, H(101))).toMatchObject({ claimableP: 12n, payout: 'unavailable' });
    r.callFromAt.mockRejectedValueOnce(new Error('RPC unavailable'));
    expect(await readItemClaimV2(r, r.f.row, { id: 1n }, H(101))).toMatchObject({ claimableP: 12n, payout: 'unverified' });
    expect(await readItemClaimV2(r, r.f.row, { id: 1n }, H(101))).toMatchObject({ claimableP: 12n, payout: 'available' });
  });
  it('vault custody, invalid ids, impossible cursors and insufficient backing never become owner payouts', async () => {
    const r = reader({ ownerOf: m3Fixture().at(3), itemCredit: [10n, 2n] });
    expect(await readItemClaimV2(r, r.f.row, { id: 1n }, H(101))).toMatchObject({ claimableP: 0n, stashP: 2n, payout: 'not_owner_claimable' });
    expect(r.callFromAt).not.toHaveBeenCalled();
    for (const overrides of [{ fundingCursor: 3n }, { lifecycleCursor: 4n }, { balanceOf: 1n }]) {
      const bad = reader(overrides); await expect(readItemClaimV2(bad, bad.f.row, { id: 1n }, H(101))).rejects.toThrow();
    }
    for (const id of [0n, 5n]) await expect(readItemClaimV2(r, r.f.row, { id }, H(101))).rejects.toThrow();
  });
  it('remaining payments plus residue are checked against custody; a gift is never credited as new funding', async () => {
    const r = reader(), f = r.f;
    const empty = required(applyV2Block(undefined, header, [], f.row).state.view.m3);
    const view = { ...empty, items: { ...required(empty.items), fundedP: 100n, paidP: 60n, flushedP: 3n } };
    r.answers.balanceOf = 36n;
    await expect(readM3MoneyV2(r, f.row, view, H(101))).rejects.toThrow(/backed/);
    r.answers.balanceOf = 37n;
    expect(await readM3MoneyV2(r, f.row, view, H(101))).toMatchObject({ itemBalanceP: 37n });
    r.answers.balanceOf = 1000n;
    expect(await readM3MoneyV2(r, f.row, view, H(101))).toMatchObject({ itemBalanceP: 1000n });
    expect(view.items.fundedP).toBe(100n);
  });
  it('pile seed receipt, live gift, failure return and zero supply are distinct from quotes and commitments', async () => {
    const f = m3Fixture(true, 1000n), r = reader({}, f);
    const view = required(applyV2Block(undefined, header, [], f.row).state.view.m3);
    expect(await readM3MoneyV2(r, f.row, view, H(101))).toMatchObject({ pile: { balance: 1031n, seedReceived: false, seedReturnDue: 0n, redemptionOpen: false } });
    const failed = { ...view, pile: { ...required(view.pile), seedLoaded: true, loadedAmount: 1000n, failed: true } };
    r.answers.failed = true; r.answers.graduated = false;
    expect(await readM3MoneyV2(r, f.row, failed, H(101))).toMatchObject({ pile: { seedReturnDue: 1000n, seedReturnBacked: true } });
    expect(await readPileQuoteV2(r, f.row, 1n, H(101))).toMatchObject({ assetOut: null });
    r.answers.totalSupply = 0n;
    expect(await readM3MoneyV2(r, f.row, failed, H(101))).toMatchObject({ pile: { balance: null, balanceStatus: 'unavailable_zero_supply', seedReturnBacked: null } });
  });
});
