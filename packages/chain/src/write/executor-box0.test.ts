import type { Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { box0Calls, drawValueFor, type Box0Target } from '../core/box0-calls';
import { NotSendableError } from './calls';
import type { Eip1193RequestArguments } from './eip1193';
import { submitWrite, WalletContextChangedError } from './executor';
import { TEST_FEE_READER, TEST_SEND_FEE_FIELDS, testFeeReader } from './test-support/index';

const me = '0x00000000000000000000000000000000000000a1' as const;
const target: Box0Target = {
  chainId: 11155111,
  token: '0x0000000000000000000000000000000000000f17',
  tickets: '0x0000000000000000000000000000000000007777',
  stream: '0x0000000000000000000000000000000000005555',
  service: null,
};
const hash = `0x${'cd'.repeat(32)}` as Hex;

function wallet(chainId = '0xaa36a7', accounts: string[] = [me]) {
  return vi.fn(async ({ method }: Eip1193RequestArguments): Promise<unknown> => {
    if (method === 'eth_chainId') return chainId;
    if (method === 'eth_accounts') return accounts;
    return hash;
  });
}

describe('SH-BOX0-ACTIONS executor: box 0 calls', () => {
  it('sends a draw with its checked value, and every other box 0 call with none', async () => {
    const value = drawValueFor(1_000_000_000n);
    const draw = box0Calls.draw(target, 1_010n, 1_800_000_000n, value);
    const w = wallet();
    await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v1-box0', target: { ...target, drawValue: value }, call: draw, wallet: w, from: me, gasLimit: 400_000n })).resolves.toBe(hash);
    expect(w).toHaveBeenLastCalledWith({ method: 'eth_sendTransaction', params: [{ from: me, to: target.tickets, data: draw.data, value: `0x${value.toString(16)}`, gas: '0x61a80', ...TEST_SEND_FEE_FIELDS, chainId: '0xaa36a7' }] });
    const claim = box0Calls.claim(target, [4100n], me);
    const w2 = wallet();
    await submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v1-box0', target, call: claim, wallet: w2, from: me, gasLimit: 100_000n });
    expect(w2.mock.calls.at(-1)?.[0]).toMatchObject({ params: [{ value: '0x0', to: target.stream }] });
  });

  it('SH-SEND-FEES: the funds check counts a draw\'s value: one wei short refuses before the wallet, exact sends', async () => {
    const value = drawValueFor(1_000_000_000n);
    const draw = box0Calls.draw(target, 1_010n, 1_800_000_000n, value);
    // TEST_FEE_READER's fee: 2 x 1 gwei + 0.1 gwei.
    const need = 400_000n * 2_100_000_000n + value;
    expect(value).toBeGreaterThan(0n);
    const short = wallet();
    await expect(submitWrite({ feeReader: testFeeReader({ balance: need - 1n }), protocol: 'core-v1-box0', target: { ...target, drawValue: value }, call: draw, wallet: short, from: me, gasLimit: 400_000n }))
      .rejects.toMatchObject({ name: 'InsufficientGasFundsError', need, balance: need - 1n });
    expect(short).not.toHaveBeenCalled();
    await expect(submitWrite({ feeReader: testFeeReader({ balance: need }), protocol: 'core-v1-box0', target: { ...target, drawValue: value }, call: draw, wallet: wallet(), from: me, gasLimit: 400_000n })).resolves.toBe(hash);
  });

  it('refuses value on anything but a draw, and an unlisted call, before touching the wallet', async () => {
    const w = wallet();
    const claim = box0Calls.claim(target, [4100n], me);
    await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v1-box0', target, call: { ...claim, value: 1n }, wallet: w, from: me, gasLimit: 1n })).rejects.toBeInstanceOf(NotSendableError);
    await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v1-box0', target, call: { ...claim, data: '0xdeadbeef' }, wallet: w, from: me, gasLimit: 1n })).rejects.toBeInstanceOf(NotSendableError);
    expect(w).not.toHaveBeenCalled();
  });

  it('SH-BOX0-DRAW-VALUE: refuses a draw whose value is not exactly the confirmed one, before touching the wallet', async () => {
    const value = drawValueFor(1_000_000_000n);
    const draw = box0Calls.draw(target, 1_010n, 1_800_000_000n, value);
    const w = wallet();
    await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v1-box0', target, call: draw, wallet: w, from: me, gasLimit: 1n })).rejects.toBeInstanceOf(NotSendableError);
    await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v1-box0', target: { ...target, drawValue: value }, call: { ...draw, value: value + 1n }, wallet: w, from: me, gasLimit: 1n })).rejects.toBeInstanceOf(NotSendableError);
    await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v1-box0', target: { ...target, drawValue: value - 1n }, call: draw, wallet: w, from: me, gasLimit: 1n })).rejects.toBeInstanceOf(NotSendableError);
    expect(w).not.toHaveBeenCalled();
  });

  it('refuses a wallet on another chain or account', async () => {
    const claim = box0Calls.claim(target, [4100n], me);
    const onMainnet = wallet('0x1');
    await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v1-box0', target, call: claim, wallet: onMainnet, from: me, gasLimit: 1n })).rejects.toBeInstanceOf(WalletContextChangedError);
    const elsewhere = wallet('0xaa36a7', ['0x00000000000000000000000000000000000000b2']);
    await expect(submitWrite({ feeReader: TEST_FEE_READER, protocol: 'core-v1-box0', target, call: claim, wallet: elsewhere, from: me, gasLimit: 1n })).rejects.toBeInstanceOf(WalletContextChangedError);
    expect([...onMainnet.mock.calls, ...elsewhere.mock.calls].some(([r]) => r.method === 'eth_sendTransaction')).toBe(false);
  });
});
