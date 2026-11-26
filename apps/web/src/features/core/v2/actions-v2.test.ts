import { required } from './test-support/required';
import { decodeFunctionData, encodeErrorResult, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { coordinatorV2Abi } from '../../../../../../packages/chain/src/core/v2';
import { sendActionV2, type ActionIO, type ActionTarget } from './actions-v2';
import { TEST_FEE_READER, TEST_SEND_FEE_FIELDS } from '@squarehole/chain/write/test-support';
const owner = '0x0000000000000000000000000000000000000001' as const;
const token = '0x0000000000000000000000000000000000000002' as const;
const coordinator = '0x0000000000000000000000000000000000000003' as const;
const receiver = '0x0000000000000000000000000000000000000004' as const;
const target: ActionTarget = { chainId: 31337, token, coordinator, receiver, p: '0x0000000000000000000000000000000000000000' };
const tx = `0x${'ab'.repeat(32)}` as Hex;
function fixture() {
  const read = vi.fn(async (_to: string, fn: string): Promise<unknown> => ({ failed: true, graduated: false, balanceOf: 100n, allowance: 100n, claimState: [91n, 100n], quoteClaim: 45n, creatorPayee: owner, creatorOwed: [19n, 0n] })[fn]);
  const request = vi.fn(async ({ method }: { method: string }): Promise<unknown> => method === 'eth_chainId' ? '0x7a69' : method === 'eth_accounts' ? [owner] : tx);
  const io: ActionIO = { feeReader: TEST_FEE_READER, read, chainId: async () => 31337, simulate: vi.fn(async () => undefined), estimate: vi.fn(async () => 400000n), receipt: vi.fn(async () => true), request };
  return { io, read, request };
}
describe('CQ11-E4 rightful actions', () => {
  it.each(['fail', 'failClosed'] as const)('binds %s to the checked chain in the wallet payload', async (call) => {
    const { io, request } = fixture();
    await sendActionV2(target, owner, { kind: 'close', call }, io);
    expect(request).toHaveBeenCalledWith({
      method: 'eth_sendTransaction',
      // RR2-LIM-2: 400,000 plus the 1,600,000 inbox sweep margin.
      params: [{ from: owner, to: coordinator, data: expect.any(String), value: '0x0', gas: '0x1e8480', ...TEST_SEND_FEE_FIELDS, chainId: '0x7a69' }],
    });
  });

  it('requires an exact approval before claim; never sends after an insufficient allowance', async () => {
    const { io, read, request } = fixture();
    read.mockImplementation(async (_to, fn) => ({ failed: true, balanceOf: 100n, allowance: 0n, claimState: [91n, 100n], quoteClaim: 45n })[fn]);
    await expect(sendActionV2(target, owner, { kind: 'claim', amount: 50n }, io)).rejects.toThrow(/Approve/);
    expect(request.mock.calls.some(([r]) => r.method === 'eth_sendTransaction')).toBe(false);
    await sendActionV2(target, owner, { kind: 'approve', amount: 50n }, io);
    const sent = required(request.mock.calls.find(([r]) => r.method === 'eth_sendTransaction'))[0] as unknown as { params: { data: Hex; to: string }[] };
    expect(required(sent.params[0]).to).toBe(token);
  });
  it('claims only caller T to that caller, simulates before sending, and waits for success', async () => {
    const { io, request } = fixture();
    await sendActionV2(target, owner, { kind: 'claim', amount: 50n }, io);
    const sent = required(request.mock.calls.find(([r]) => r.method === 'eth_sendTransaction'))[0] as unknown as { params: { data: Hex }[] };
    expect(decodeFunctionData({ abi: coordinatorV2Abi, data: required(sent.params[0]).data })).toMatchObject({ functionName: 'claim', args: [50n, owner] });
    expect(io.simulate).toHaveBeenCalledTimes(1);
    expect(io.receipt).toHaveBeenCalledWith(tx);
  });
  it('has no creator route (FINAL-OC01: the creator’s fees go through sendCreatorFeesV2 on the next payment), and rejects another chain', async () => {
    const { io, request, read } = fixture();
    // The stored-creatorOwed route is gone: an unknown kind reads nothing and sends nothing.
    await expect(sendActionV2(target, owner, { kind: 'creator' } as never, io)).rejects.toThrow('Unknown action');
    expect(read).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([r]) => r.method === 'eth_sendTransaction')).toBe(false);
    request.mockImplementation(async () => '0x1');
    await expect(sendActionV2(target, owner, { kind: 'close', call: 'fail' }, io)).rejects.toThrow(/network/);
  });
  it('SH-RC7 item 29: a claim whose quote refuses sends nothing, the final share with P waiting in the inbox included', async () => {
    // The merged coordinator quotes the final share at its pot plus the inbox's readable P, so its quote refuses only
    // when it cannot read the inbox; the claim would refuse too. The unpriced collect-first route (RC6 R1-3) is gone.
    const inbox = '0x0000000000000000000000000000000000000008' as const;
    const refusal = (errorName: 'ClaimFailed' | 'InvalidClaim') => Object.assign(new Error('execution reverted'), { data: encodeErrorResult({ abi: coordinatorV2Abi, errorName }) });
    const answers = (patch: Record<string, unknown>) => async (_to: string, fn: string): Promise<unknown> => {
      const value = ({ failed: true, balanceOf: 100n, allowance: 100n, claimState: [91n, 100n], quoteClaim: refusal('ClaimFailed'), pendingPriceCoin: 7n, ...patch } as Record<string, unknown>)[fn];
      if (value instanceof Error) throw value;
      return value;
    };
    const sent = (request: ReturnType<typeof fixture>['request']) => request.mock.calls.some(([r]) => r.method === 'eth_sendTransaction');
    for (const [patch, amount, withInbox] of [[{}, 100n, true], [{}, 50n, true], [{ pendingPriceCoin: 0n }, 100n, true], [{ pendingPriceCoin: new Error('inbox read failed') }, 100n, true],
      [{ quoteClaim: refusal('InvalidClaim') }, 100n, true], [{ quoteClaim: new Error('RPC down') }, 100n, true], [{}, 100n, false]] as const) {
      const f = fixture();
      f.read.mockImplementation(answers(patch));
      await expect(sendActionV2(withInbox ? { ...target, royaltyRouter: inbox } : target, owner, { kind: 'claim', amount }, f.io)).rejects.toThrow();
      expect(sent(f.request)).toBe(false);
      expect(f.io.simulate).not.toHaveBeenCalled();
      // Nothing reads the inbox's pending P any more: the quote alone decides.
      expect(f.read.mock.calls.map(([, fn]) => fn)).not.toContain('pendingPriceCoin');
    }
    // A final share the coordinator quotes (pot plus the inbox P) is claimed as any other.
    const g = fixture();
    g.read.mockImplementation(answers({ quoteClaim: 52n }));
    await sendActionV2({ ...target, royaltyRouter: inbox }, owner, { kind: 'claim', amount: 100n }, g.io);
    expect(sent(g.request)).toBe(true);
  });
  it('never announces a reverted receipt as a successful close', async () => {
    const { io } = fixture();
    io.receipt = async () => false;
    await expect(sendActionV2(target, owner, { kind: 'close', call: 'fail' }, io)).rejects.toThrow(/reverted/);
  });
});
