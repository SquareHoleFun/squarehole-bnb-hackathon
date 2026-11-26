import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { jsonV2 } from '../../src/core/core-row';
import { A, B, H, m3Fixture } from '../../src/core/v2/m3-fixture.test-support';
import { readItemClaimV2 } from '../../src/core/v2/m3-reads-v2';

const CAP = (1n << 127n) - 1n;
const abi = parseAbi([
  'function fundingCursor() view returns (uint256)', 'function lifecycleCursor() view returns (uint256)',
  'function itemFundingCount() view returns (uint256)', 'function itemLifecycleCount() view returns (uint256)',
  'function itemCredit(uint256) view returns (uint256,uint256)', 'function ownerOf(uint256) view returns (address)',
  'function balanceOf(address,uint256) view returns (uint256)', 'function failed() view returns (bool)',
  'function graduated() view returns (bool)', 'function claim(uint256[],address) returns (uint256)',
]);

/** RPC transport only: each snapshot and simulated payment is supplied independently by the test. */
function snapshot(outside: bigint, stash: bigint, payment: bigint, overrides: Record<string, unknown> = {}, hash = H(101)) {
  const f = m3Fixture();
  const answers: Record<string, unknown> = {
    fundingCursor: 2n, lifecycleCursor: 3n, itemFundingCount: 2n, itemLifecycleCount: 3n,
    itemCredit: [outside, stash], ownerOf: A, balanceOf: outside + stash, failed: false, graduated: true, ...overrides,
  };
  const roles: Record<string, Address> = {
    fundingCursor: f.at(16), lifecycleCursor: f.at(16), itemCredit: f.at(16),
    itemFundingCount: f.at(5), itemLifecycleCount: f.at(3), ownerOf: f.at(4),
    balanceOf: f.row.poolManager, failed: f.at(0), graduated: f.at(0),
  };
  const callAt = vi.fn(async (to: Address, data: Hex, at: Hex) => {
    expect(at).toBe(hash);
    const { functionName, args } = decodeFunctionData({ abi, data });
    expect(to).toBe(roles[functionName]);
    if (functionName === 'itemCredit' || functionName === 'ownerOf') expect(args).toEqual([1n]);
    if (functionName === 'balanceOf') expect(args).toEqual([f.at(16), BigInt(f.row.q)]);
    return encodeFunctionResult({ abi, functionName, result: answers[functionName] as never });
  });
  const callFromAt = vi.fn(async (from: Address, to: Address, data: Hex, at: Hex) => {
    expect(at).toBe(hash); expect(from).toBe(answers.ownerOf); expect(to).toBe(f.at(16));
    expect(decodeFunctionData({ abi, data })).toEqual({ functionName: 'claim', args: [[1n], from] });
    return encodeFunctionResult({ abi, functionName: 'claim', result: payment });
  });
  const reader = { callAt, callFromAt };
  return { f, hash, reader, read: () => readItemClaimV2(reader, f.row, { id: 1n }, hash) };
}

describe('M363-OC02: item liability and next payable part remain distinct', () => {
  it.each([6, 8, 18])('offers the backed partial payment at %s decimals without truncating credit', async pDecimals => {
    const s = snapshot(CAP + 1n, 7n, CAP);
    const got = await readItemClaimV2(s.reader, { ...s.f.row, pDecimals }, { id: 1n }, s.hash);
    expect(got).toMatchObject({ outsideP: CAP + 1n, stashP: 7n, claimableP: CAP, payout: 'available' });
    expect(s.reader.callFromAt).toHaveBeenCalledOnce();
    expect(s.reader.callAt).toHaveBeenCalledTimes(9);
    expect(jsonV2(got)).toMatchObject({ outsideP: (CAP + 1n).toString(), stashP: '7', claimableP: CAP.toString() });
  });

  it.each([
    [0n, 0n, 0n], [1n, 0n, 1n], [CAP - 1n, 0n, CAP - 1n], [CAP, 0n, CAP],
    [CAP + 1n, 0n, CAP], [0n, CAP + 1n, CAP], [CAP - 1n, 2n, CAP],
  ])('quotes outside %s plus stash %s as next payment %s', async (outside, stash, payment) => {
    const s = snapshot(outside, stash, payment);
    expect(await s.read()).toMatchObject({ outsideP: outside, stashP: stash, claimableP: payment,
      payout: payment === 0n ? 'empty' : 'available' });
    expect(s.reader.callFromAt).toHaveBeenCalledTimes(payment === 0n ? 0 : 1);
  });

  it.each([0n, CAP - 1n, CAP + 1n, CAP + 8n])('refuses to verify an incorrect simulated payment of %s', async payment => {
    expect(await snapshot(CAP + 1n, 7n, payment).read()).toMatchObject({
      outsideP: CAP + 1n, stashP: 7n, claimableP: CAP, payout: 'unverified',
    });
  });

  it('rereads successive payments and the one-unit tail for the new owner at fresh hashes', async () => {
    const initial = 2n * CAP + 1n;
    let paid = 0n;
    for (const [outside, stash, payment, owner, hash] of [
      [CAP + 3n, CAP - 2n, CAP, A, H(101)],
      [3n, CAP - 2n, CAP, B, H(102)],
      [0n, 1n, 1n, B, H(103)],
      [0n, 0n, 0n, B, H(104)],
    ] as const) {
      const got = await snapshot(outside, stash, payment, { ownerOf: owner }, hash).read();
      expect(got).toMatchObject({ hash, owner, outsideP: outside, stashP: stash, claimableP: payment,
        payout: payment === 0n ? 'empty' : 'available' });
      expect(paid + outside + stash).toBe(initial);
      paid += payment;
    }
    expect(paid).toBe(initial);
  });

  it('keeps partial credit retryable on a reverted or missing simulation', async () => {
    const s = snapshot(CAP + 1n, 7n, CAP);
    s.reader.callFromAt.mockRejectedValueOnce(Object.assign(new Error('paused payout'), { code: 3 }));
    expect(await s.read()).toMatchObject({ claimableP: CAP, outsideP: CAP + 1n, stashP: 7n, payout: 'unavailable' });
    s.reader.callFromAt.mockRejectedValueOnce(new Error('RPC unavailable'));
    expect(await s.read()).toMatchObject({ claimableP: CAP, payout: 'unverified' });
    expect(await readItemClaimV2({ callAt: s.reader.callAt }, s.f.row, { id: 1n }, s.hash))
      .toMatchObject({ claimableP: CAP, payout: 'unverified' });
    expect(await s.read()).toMatchObject({ claimableP: CAP, payout: 'available' });
  });

  it('still requires backing for the entire credit, not just the next part', async () => {
    const s = snapshot(CAP + 1n, 7n, CAP, { balanceOf: CAP });
    await expect(s.read()).rejects.toThrow('item credit is not backed');
    expect(s.reader.callFromAt).not.toHaveBeenCalled();
  });

  it.each([{ fundingCursor: 1n }, { lifecycleCursor: 2n }])('withholds partial payments until both histories are synced (case %#)', async overrides => {
    const s = snapshot(CAP + 1n, 7n, CAP, overrides);
    expect(await s.read()).toMatchObject({ claimableP: null, outsideP: null, stashP: null, payout: 'not_ready' });
    expect(s.reader.callFromAt).not.toHaveBeenCalled();
  });

  it('keeps vault-owned and pregraduation credit ineligible', async () => {
    const f = m3Fixture();
    for (const overrides of [{ ownerOf: f.at(3) }, { graduated: false }]) {
      const s = snapshot(CAP + 1n, 7n, CAP, overrides);
      expect(await s.read()).toMatchObject({ outsideP: CAP + 1n, stashP: 7n, claimableP: 0n, payout: 'not_owner_claimable' });
      expect(s.reader.callFromAt).not.toHaveBeenCalled();
    }
  });
});
