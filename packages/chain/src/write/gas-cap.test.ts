/**
 * SH-258 fix round 2: the one wallet boundary of every path (internalSendChecked, behind submitWrite and the trade and
 * coin calls) holds the per-transaction gas cap, 16,777,216: a limit above it is refused with a plain message before
 * the wallet is asked. A shop's give whose estimate is 14,000,000 plus its margin (16,800,000) cannot be sent.
 */
import { encodeFunctionData } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { coordinatorV2Abi } from '../core/v2';
import { EIP7825_TX_GAS_CAP } from './chains';
import { submitWrite } from './executor';
import type { Eip1193RequestArguments } from './eip1193';
import { TEST_FEE_READER } from './test-support/index';

const owner = '0x0000000000000000000000000000000000000001' as const;
const token = '0x0000000000000000000000000000000000000002' as const;
const coordinator = '0x0000000000000000000000000000000000000003' as const;
const receiver = '0x0000000000000000000000000000000000000004' as const;
const target = { chainId: 31337, token, coordinator, receiver, p: token };
const claim = { to: coordinator, data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claim', args: [1n, owner] }), value: 0n } as const;

function send(gasLimit: bigint) {
  const wallet = vi.fn(async ({ method }: Eip1193RequestArguments): Promise<unknown> => {
    if (method === 'eth_chainId') return '0x7a69';
    if (method === 'eth_accounts') return [owner];
    return `0x${'ab'.repeat(32)}`;
  });
  return { wallet, sent: submitWrite({ protocol: 'core-v2', target, call: claim, wallet, from: owner, gasLimit, feeReader: TEST_FEE_READER }) };
}

describe('the gas cap at the wallet boundary', () => {
  it('a limit above 16,777,216 is refused before the wallet is asked', async () => {
    const { wallet, sent } = send(14_000_000n + 2_800_000n);
    await expect(sent).rejects.toThrow('The gas estimate plus its safety margin does not fit in one transaction (16,777,216 gas); nothing was sent.');
    expect(wallet.mock.calls.map(([request]) => request.method)).not.toContain('eth_sendTransaction');
  });

  it('round 3: a zero limit has its own sentence (no valid estimate), never "needs more gas"', async () => {
    const { wallet, sent } = send(0n);
    await expect(sent).rejects.toThrow('No valid gas estimate for this transaction; nothing was sent.');
    expect(wallet.mock.calls.map(([request]) => request.method)).not.toContain('eth_sendTransaction');
  });

  it('a limit at the cap is sent as it is', async () => {
    const { wallet, sent } = send(EIP7825_TX_GAS_CAP);
    await sent;
    const request = wallet.mock.calls.find(([r]) => r.method === 'eth_sendTransaction')?.[0] as unknown as { params: [{ gas: string }] };
    expect(BigInt(request.params[0].gas)).toBe(EIP7825_TX_GAS_CAP);
  });
});
