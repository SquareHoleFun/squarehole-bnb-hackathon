import { decodeFunctionData, encodeFunctionResult, encodeAbiParameters, parseAbiParameters, parseAbi, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import * as money from './money-v2';
import { m3Fixture, H, A, B, SEED, required } from './m3-fixture.test-support';
import { applyV2Block } from './views-v2';
const abi = parseAbi([
  'function fundingCursor() view returns (uint256)', 'function lifecycleCursor() view returns (uint256)',
  'function itemFundingCount() view returns (uint256)', 'function itemLifecycleCount() view returns (uint256)',
  'function itemCredit(uint256) view returns (uint256,uint256)', 'function ticketCredit(bytes32) view returns (uint256,uint256,bool)',
  'function ownerOf(uint256) view returns (address)', 'function balanceOf(address,uint256) view returns (uint256)',
  'function failed() view returns (bool)', 'function graduated() view returns (bool)',
  'function claim(uint256[],address) returns (uint256)',
  'function totalSupply() view returns (uint256)', 'function asset() view returns (address)',
  'function seeder() view returns (address)', 'function seedAmount() view returns (uint256)',
  'function leaveBehindBps() view returns (uint256)',
  'function quoteRedeem(uint256) view returns (uint256)',
]);
function reader(f: ReturnType<typeof m3Fixture>, overrides: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = { fundingCursor: 2n, lifecycleCursor: 4n, itemFundingCount: 2n, itemLifecycleCount: 4n,
    itemCredit: [2n ** 100n, 33n], ticketCredit: [7n, 9n, true], ownerOf: A, balanceOf: 2n ** 120n, failed: false, graduated: true,
    totalSupply: 100n, asset: f.record.q, seeder: f.record.creator, seedAmount: SEED, quoteRedeem: SEED + 20n, ...overrides };
  const calls: string[] = [];
  return { calls, callAt: vi.fn(async (_to: Address, data: Hex, hash: Hex) => {
    expect(hash).toBe(H(101));
    const { functionName } = decodeFunctionData({ abi, data }); calls.push(functionName);
    if (answers[functionName] instanceof Error) throw answers[functionName];
    return encodeFunctionResult({ abi, functionName, result: answers[functionName] as never });
  }) };
}
const request = { id: 1n };

describe('M352 current item credit is backed and reconciled at one canonical hash', () => {
  it.each([6, 8, 18])('keeps outside credit and stash exact at %s decimals, owner claim only', async decimals => {
    const f = m3Fixture(); const r = reader(f);
    const got = await money.readItemClaimV2(r, { ...f.row, pDecimals: decimals }, request, H(101));
    expect(got).toMatchObject({ hash: H(101), owner: A, status: 'synced', outsideP: 2n ** 100n, stashP: 33n, claimableP: 2n ** 100n + 33n, payout: 'unverified' });
    expect(r.calls).not.toContain('claimFor');
    expect(r.calls.length).toBeLessThanOrEqual(10);
  });
  it('hides stale credit until both histories catch up, retaining processed cursors for retry', async () => {
    const f = m3Fixture();
    for (const overrides of [{ fundingCursor: 1n }, { lifecycleCursor: 3n }]) {
      expect(await money.readItemClaimV2(reader(f, overrides), f.row, request, H(101))).toMatchObject({ status: 'sync_pending', claimableP: null, outsideP: null, stashP: null, payout: 'not_ready' });
    }
    expect(await money.readItemClaimV2(reader(f, { ownerOf: f.at(3) }), f.row, request, H(101))).toMatchObject({ claimableP: 0n, stashP: 33n, payout: 'not_owner_claimable' });
  });
  it('follows the current owner after transfer and simulates only that owner without a wallet', async () => {
    const f = m3Fixture(); const r = reader(f, { ownerOf: B });
    const callFromAt = vi.fn(async (from: Address, _to: Address, data: Hex, hash: Hex) => {
      expect(from).toBe(B); expect(hash).toBe(H(101));
      expect(decodeFunctionData({ abi, data })).toMatchObject({ functionName: 'claim', args: [[1n], B] });
      return encodeFunctionResult({ abi, functionName: 'claim', result: 2n ** 100n + 33n });
    });
    expect(await money.readItemClaimV2({ ...r, callFromAt }, f.row, request, H(101))).toMatchObject({ owner: B, payout: 'available' });
    const refusal = Object.assign(new Error('paused or ClaimsNotImplemented'), { code: 3 });
    callFromAt.mockRejectedValueOnce(refusal);
    expect(await money.readItemClaimV2({ ...r, callFromAt }, f.row, request, H(101))).toMatchObject({ claimableP: 2n ** 100n + 33n, payout: 'unavailable' });
    callFromAt.mockRejectedValueOnce(new Error('RPC unavailable'));
    expect(await money.readItemClaimV2({ ...r, callFromAt }, f.row, request, H(101))).toMatchObject({ payout: 'unverified' });
  });
  it('does not turn failed reads, invalid ids, impossible cursors or insufficient backing into claims', async () => {
    const f = m3Fixture();
    for (const overrides of [{ balanceOf: 1n }, { fundingCursor: 3n }, { ownerOf: new Error('RPC failed') }]) {
      await expect(money.readItemClaimV2(reader(f, overrides), f.row, request, H(101))).rejects.toThrow();
    }
    const r = reader(f);
    await expect(money.readItemClaimV2(r, f.row, { id: 0n }, H(101))).rejects.toThrow(/item/i);
    expect(r.calls).toHaveLength(0);
  });
  it('reads keyed ticket starts and credits only after both cursors agree', async () => {
    const f = m3Fixture();
    expect(await money.readItemTicketV2(reader(f), f.row, H(11), H(101))).toMatchObject({ key: H(11), start: 7n, outsideP: 9n, open: true, status: 'synced' });
    expect(await money.readItemTicketV2(reader(f, { lifecycleCursor: 3n }), f.row, H(11), H(101))).toMatchObject({ outsideP: null, start: null, open: null, status: 'sync_pending' });
  });
  it('checks remaining funded obligations after owner payments and residue against actual P custody', async () => {
    const f = m3Fixture();
    const state = applyV2Block(undefined, { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1000n }, [], f.row).state;
    const view = required(state.view.m3);
    const paidView = { ...view, items: { ...required(view.items), fundedP: 100n, paidP: 60n, flushedP: 3n, paidByItem: { '1': 60n } } };
    await expect(money.readM3MoneyV2(reader(f, { balanceOf: 36n }), f.row, paidView, H(101))).rejects.toThrow(/backed/i);
    expect(await money.readM3MoneyV2(reader(f, { balanceOf: 37n }), f.row, paidView, H(101))).toMatchObject({ itemBalanceP: 37n });
    // Extra claims are gifts, not more funding, payments or per-item entitlement.
    expect(await money.readM3MoneyV2(reader(f, { balanceOf: 1000n }), f.row, paidView, H(101))).toMatchObject({ itemBalanceP: 1000n });
    expect(paidView.items.fundedP).toBe(100n);
    expect(paidView.items.paidByItem).toEqual({ '1': 60n });
  });
});

describe('M352 pile live reads', () => {
  it('reads full live balance including gifts, never interpreting the commitment as received seed', async () => {
    const f = m3Fixture(true); const r = reader(f);
    const state = applyV2Block(undefined, { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1000n }, [], f.row).state;
    const got = await money.readM3MoneyV2(r, f.row, required(state.view.m3), H(101));
    expect(got.pile).toMatchObject({ balance: SEED + 20n, supply: 100n, seedAmount: SEED, seedReceived: false, seedReturnDue: 0n, redemptionOpen: false });
    expect(r.calls).not.toContain('progress');
  });
  it('quotes exact caller T using the fixed asset and keeps failure distinct from price and payment availability', async () => {
    const f = m3Fixture(true); const r = reader(f, { quoteRedeem: 7n });
    expect(await money.readPileQuoteV2(r, f.row, 3n, H(101))).toMatchObject({ tIn: 3n, assetOut: 7n, graduated: true, failed: false });
    expect(await money.readPileQuoteV2(reader(f, { failed: true, graduated: false }), f.row, 3n, H(101))).toMatchObject({ assetOut: null, failed: true });
    await expect(money.readPileQuoteV2(r, f.row, 101n, H(101))).rejects.toThrow();
  });
});

it('PF25 reads and verifies the creation preset at the same hash; old piles need no new selector', async () => {
  const f = m3Fixture(true);
  const row = { ...f.row, spec: { ...f.spec, contentsParams: encodeAbiParameters(parseAbiParameters('address,uint256,uint16'), [f.record.q, SEED, 500]) } };
  const state = applyV2Block(undefined, { number: 101n, hash: H(101), parentHash: H(100), timestamp: 1000n }, [], row).state;
  const view = required(state.view.m3);
  expect((await money.readM3MoneyV2(reader(f, { leaveBehindBps: 500n }), row, view, H(101))).pile).toHaveProperty('leaveBehindBps', 500n);
  await expect(money.readM3MoneyV2(reader(f, { leaveBehindBps: 0n }), row, view, H(101))).rejects.toThrow(/preset/);
  const legacy = reader(f);
  await money.readM3MoneyV2(legacy, f.row, view, H(101));
  expect(legacy.calls).not.toContain('leaveBehindBps');
});
