import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address, type Hex } from 'viem';
import { expect, vi } from 'vitest';
import { A, H, m3Fixture } from '../../src/core/v2/m3-fixture.test-support';

export const TRANCHE = (1n << 127n) - 1n;
export const READ_ABI = parseAbi([
  'function fundingCursor() view returns (uint256)', 'function lifecycleCursor() view returns (uint256)',
  'function itemFundingCount() view returns (uint256)', 'function itemLifecycleCount() view returns (uint256)',
  'function itemCredit(uint256) view returns (uint256,uint256)', 'function ticketCredit(bytes32) view returns (uint256,uint256,bool)',
  'function ownerOf(uint256) view returns (address)', 'function balanceOf(address,uint256) view returns (uint256)',
  'function failed() view returns (bool)', 'function graduated() view returns (bool)',
  'function claim(uint256[],address) returns (uint256)', 'function totalSupply() view returns (uint256)',
  'function asset() view returns (address)', 'function seeder() view returns (address)', 'function seedAmount() view returns (uint256)',
  'function quoteRedeem(uint256) view returns (uint256)',
]);

/** Transport double only. Production reader supplies every selector, role, caller and canonical hash. */
export function reader(overrides: Record<string, unknown> = {}, f = m3Fixture()) {
  const answers: Record<string, unknown> = { fundingCursor: 2n, lifecycleCursor: 3n, itemFundingCount: 2n, itemLifecycleCount: 3n,
    itemCredit: [TRANCHE + 1n, 7n], ticketCredit: [11n, 9n, true], ownerOf: A, balanceOf: 1n << 200n,
    failed: false, graduated: true, totalSupply: 100n, asset: f.record.q, seeder: f.record.creator,
    seedAmount: 1000n, quoteRedeem: 1031n, ...overrides };
  const expectedRole: Record<string, Address> = { fundingCursor: f.at(16), lifecycleCursor: f.at(16), itemCredit: f.at(16), ticketCredit: f.at(16),
    itemFundingCount: f.at(5), itemLifecycleCount: f.at(3), ownerOf: f.at(4), balanceOf: f.row.poolManager,
    failed: f.at(0), graduated: f.at(0), totalSupply: f.at(1), asset: f.at(3), seeder: f.at(3), seedAmount: f.at(3), quoteRedeem: f.at(3) };
  const callAt = vi.fn(async (to: Address, data: Hex, hash: Hex) => {
    expect(hash).toBe(H(101));
    const { functionName } = decodeFunctionData({ abi: READ_ABI, data });
    expect(to).toBe(expectedRole[functionName]);
    const result = answers[functionName];
    if (result instanceof Error) throw result;
    return encodeFunctionResult({ abi: READ_ABI, functionName, result: result as never });
  });
  const callFromAt = vi.fn(async (from: Address, to: Address, data: Hex, hash: Hex) => {
    expect(hash).toBe(H(101)); expect(to).toBe(f.at(16)); expect(from).toBe(answers.ownerOf);
    expect(decodeFunctionData({ abi: READ_ABI, data })).toEqual({ functionName: 'claim', args: [[1n], from] });
    const [outside, stash] = answers.itemCredit as [bigint, bigint];
    const total = outside + stash;
    return encodeFunctionResult({ abi: READ_ABI, functionName: 'claim', result: total > TRANCHE ? TRANCHE : total });
  });
  return { callAt, callFromAt, answers, f };
}
