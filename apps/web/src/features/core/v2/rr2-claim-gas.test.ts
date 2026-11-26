import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { sendActionV2, type ActionIO, type ActionTarget, type ActionV2 } from './actions-v2';
import { sendCheckedV2, type SendIO } from './m3-actions';
import { TEST_FEE_READER } from '@squarehole/chain/write/test-support';

// Second release review, RR2-LIM-2: a failed box's claim and close sweep the inbox first. In rc6, on Amsterdam, a sweep
// that became due between the estimate and inclusion (1 raw P of a history-writing P sent to the inbox) cost up to about
// 1.5M gas more, which the estimate's fifth (about 0.67M) could not cover: the later stipend check reverted GasTooLow. The
// site pads coordinator sends by the larger of a fifth and 1,600,000 gas (INBOX_SWEEP_GAS / 2, above the cold 1,512,077),
// clipped at EIP-7825's 16,777,216. Since rc7 the coordinator keeps a 4M reserve after the inbox's allowance
// (SH-RC7-CLAIM-RESERVE), so the estimates below are rc7's measured minima: a holder claim 7,419,257 and the creator's
// no-buyer claim 7,418,909 (Amsterdam), fail() 7,995,295 (native P, menu, default EVM) and failClosed() 10,370,878 (linked
// P, items, P also at the router and the receiver, Amsterdam). The rule is unchanged: below 8M the 1.6M margin wins.
const owner = '0x0000000000000000000000000000000000000001' as Address;
const token = '0x0000000000000000000000000000000000000002' as Address;
const coordinator = '0x0000000000000000000000000000000000000003' as Address;
const receiver = '0x0000000000000000000000000000000000000004' as Address;
const target: ActionTarget = { chainId: 31337, token, coordinator, receiver, p: '0x0000000000000000000000000000000000000000' };
const tx = `0x${'ab'.repeat(32)}` as Hex;

function io(estimate: bigint) {
  const read = vi.fn(async (_to: string, fn: string): Promise<unknown> => ({ failed: true, balanceOf: 100n, allowance: 100n,
    claimState: [91n, 100n], quoteClaim: 45n })[fn]);
  const request = vi.fn(async ({ method }: { method: string }): Promise<unknown> => method === 'eth_chainId' ? '0x7a69' : method === 'eth_accounts' ? [owner] : tx);
  const actions: ActionIO = { feeReader: TEST_FEE_READER, read, chainId: async () => 31337, simulate: vi.fn(async () => undefined), estimate: vi.fn(async () => estimate),
    receipt: vi.fn(async () => true), request };
  const gas = () => {
    const sent = request.mock.calls.find(([r]) => r.method === 'eth_sendTransaction')?.[0] as unknown as { params: { gas: string }[] } | undefined;
    return sent ? BigInt(sent.params[0]?.gas ?? '0x0') : null;
  };
  return { actions, gas };
}

describe('RR2-LIM-2: coordinator claim, close and no-buyer sends carry the inbox sweep\'s margin', () => {
  it.each([
    ['fail', 7_995_295n, 9_595_295n, { kind: 'close', call: 'fail' }],
    ['failClosed', 10_370_878n, 12_445_053n, { kind: 'close', call: 'failClosed' }],
    ['claim', 7_419_257n, 9_019_257n, { kind: 'claim', amount: 50n }],
    ['the no-buyer remainder', 7_418_909n, 9_018_909n, { kind: 'no-buyers' }],
    // A fifth wins above 8,000,000.
    ['claim', 10_000_000n, 12_000_000n, { kind: 'claim', amount: 50n }],
  ] as [string, bigint, bigint, ActionV2][])('%s at estimate %s is sent with %s gas', async (_name, estimate, limit, action) => {
    const f = io(estimate);
    await sendActionV2(target, owner, action, f.actions);
    expect(f.gas()).toBe(limit);
  });
  it('SH-258 round 3: an estimate whose margin passes the EIP-7825 cap is refused, never sent clipped (15,000,000 asks 18,000,000)', async () => {
    const f = io(15_000_000n);
    await expect(sendActionV2(target, owner, { kind: 'close', call: 'fail' }, f.actions)).rejects.toThrow('The gas estimate plus its safety margin does not fit in one transaction (16,777,216 gas); nothing was sent.');
    expect(f.gas()).toBeNull();
  });
  it('an approval to the box token keeps the estimate plus a fifth', async () => {
    const f = io(400_000n);
    await sendActionV2(target, owner, { kind: 'approve', amount: 50n }, f.actions);
    expect(f.gas()).toBe(480_000n);
  });
  it('Claim all: a send to the coordinator gets the margin, any other target keeps its fifth', async () => {
    for (const [to, limit] of [[coordinator, 9_019_257n], [coordinator.toUpperCase().replace('0X', '0x') as Address, 9_019_257n],
      [receiver, 8_903_108n]] as const) {
      const submit = vi.fn(async () => tx);
      const send: SendIO = { chainId: async () => 31337, simulate: async () => undefined, estimate: async () => 7_419_257n, submit,
        request: async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x7a69' : [owner],
        receipt: async () => ({ transactionHash: tx, blockNumber: 1n, blockHash: tx, status: 'success' as const }) } as unknown as SendIO;
      await sendCheckedV2(target, owner, to, '0x1234', send);
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ gasLimit: limit }));
    }
  });
});
