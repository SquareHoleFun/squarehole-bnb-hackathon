/**
 * SH-258 fix round: the fee fields every app send carries, on chain 97's real answers (recorded from the public
 * endpoint, test-support/bnb-testnet-fees.json): base fee 0, `eth_gasPrice` and `eth_maxPriorityFeePerGas` 0.1 gwei.
 * Before the fix the tip was capped at twice the base fee, floored at 0.01 gwei: a send at 0.01 gwei waited in the
 * pool and no validator took it (the first real box creation, 25 November 2026). Every write path reads its fee here:
 * `readFeeEstimate` (the shown fee of creates and claims, run.ts) and `readSendFees` inside `internalSendChecked`
 * (the one `eth_sendTransaction` behind `submitWrite`, the trade and coin calls, the faucet drip, the shop and claims;
 * `internalSendChecked` takes `fees.fee ?? readSendFees(fees.feeReader, chainId)` and puts both fields in its one
 * request, executor.ts; its own tests show the request carries them).
 */
import { encodeFunctionData } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import recorded from './test-support/bnb-testnet-fees.json' with { type: 'json' };
import { checkRequestPrice, NetworkPriceError, readFeeEstimate, readSendFees, sendFeesOf, MIN_PRIORITY_FEE_WEI } from './executor';
import { createChainReader } from './rpc';
import type { Eip1193Request } from './eip1193';

const PRICE = 100_000_000n;
const FROM = '0x00000000000000000000000000000000000000a1' as const;

/** The public endpoint as it answered (only the methods the fee and funds reads ask). */
const endpoint: Eip1193Request = async ({ method }) => {
  switch (method) {
    case 'eth_chainId': return recorded.eth_chainId;
    case 'eth_gasPrice': return recorded.eth_gasPrice;
    case 'eth_maxPriorityFeePerGas': return recorded.eth_maxPriorityFeePerGas;
    case 'eth_getBlockByNumber': return { ...recorded.latestBlock, transactions: [] };
    case 'eth_feeHistory': return recorded.eth_feeHistory;
    case 'eth_getBalance': return '0xde0b6b3a7640000';
    default: throw new Error(`not recorded: ${method}`);
  }
};

describe('fees on chain 97 (recorded answers)', () => {
  it('readSendFees and readFeeEstimate: both fields at least the chain’s price, with a tenth of headroom', async () => {
    const reader = createChainReader(endpoint);
    const fees = await readSendFees(reader, 97);
    expect(fees.maxPriorityFeePerGas).toBeGreaterThanOrEqual(PRICE);
    expect(fees.maxFeePerGas).toBeGreaterThanOrEqual(PRICE);
    expect(fees).toEqual({ maxPriorityFeePerGas: 110_000_000n, maxFeePerGas: 110_000_000n });
    const estimate = await readFeeEstimate(reader, 97, 300_000n, 400_000n);
    expect([estimate.maxPriorityFeePerGas, estimate.maxFeePerGas]).toEqual([110_000_000n, 110_000_000n]);
  });

  it('a reader without eth_gasPrice, a failed read or a zero price: no usable gas price (never a guess)', async () => {
    const { gasPrice: _skip, ...reader } = createChainReader(endpoint);
    void _skip;
    await expect(readSendFees(reader, 97)).rejects.toThrow('The network gave no usable gas price; nothing was sent. Try again.');
    const failing = createChainReader(async (request) => { if (request.method === 'eth_gasPrice') throw new Error('no answer'); return endpoint(request); });
    await expect(readSendFees(failing, 97)).rejects.toThrow(NetworkPriceError);
    await expect(readSendFees(failing, 97)).rejects.toThrow('no usable gas price');
    expect(() => sendFeesOf(0n, 100_000_000n, 97, 0n)).toThrow('no usable gas price');
  });

  it('fix round 3: the RAW price meets the ceiling; both fields at least the price; the headroom fits under the ceiling', () => {
    // 4.6 gwei is under the 5 gwei ceiling: sent, the headroom cut at the ceiling (fix round 2 refused it: 5.06 > 5).
    expect(sendFeesOf(0n, 100_000_000n, 97, 4_600_000_000n)).toEqual({ maxPriorityFeePerGas: 5_000_000_000n, maxFeePerGas: 5_000_000_000n });
    // A high tip suggestion never refuses a price under the ceiling.
    expect(sendFeesOf(0n, 9_000_000_000n, 97, 100_000_000n)).toEqual({ maxPriorityFeePerGas: 5_000_000_000n, maxFeePerGas: 5_000_000_000n });
    // A base fee above zero: both fields still at least the price (fix round 2 gave a tip of 88,000,000 here).
    const based = sendFeesOf(20_000_000n, 10_000_000n, 97, 100_000_000n);
    expect(based.maxPriorityFeePerGas).toBeGreaterThanOrEqual(100_000_000n);
    expect(based.maxFeePerGas).toBeGreaterThanOrEqual(100_000_000n);
    // A raw price above the ceiling is refused whatever the base fee, with the sentence that says so.
    expect(() => sendFeesOf(0n, 100_000_000n, 97, 6_000_000_000n)).toThrow('The network asks 6 gwei for gas, above the 5 gwei this site offers; nothing was sent.');
    expect(() => sendFeesOf(4_000_000_000n, 100_000_000n, 97, 5_100_000_000n)).toThrow('above the 5 gwei');
    // Round 3b: the price to the last wei (5,000,000,001 is not "5 gwei").
    expect(() => sendFeesOf(0n, 100_000_000n, 97, 5_000_000_001n)).toThrow('The network asks 5.000000001 gwei for gas, above the 5 gwei this site offers; nothing was sent.');
  });

  it('fix round 3: the price rises from 100,000,000 to 120,000,000 between the first read and the send: the wallet is never asked', async () => {
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    const [{ submitWrite }, rpc, { coordinatorV2Abi }] = await Promise.all([import('./index'), import('./rpc'), import('../core/v2')]);
    let price = 100_000_000n;
    const asked: string[] = [];
    const node: Eip1193Request = async (request) => (request.method === 'eth_gasPrice' ? `0x${price.toString(16)}` : endpoint(request));
    const wallet: Eip1193Request = async ({ method }) => {
      asked.push(method);
      if (method === 'eth_chainId') return '0x61';
      if (method === 'eth_accounts') return [FROM];
      return `0x${'ab'.repeat(32)}`;
    };
    const reader = rpc.createChainReader(node);
    // The fee set earlier (as a reveal sets it before its estimates, simulation and nonce lookup).
    const fee = await readSendFees(reader, 97);
    expect(fee).toEqual({ maxPriorityFeePerGas: 110_000_000n, maxFeePerGas: 110_000_000n });
    price = 120_000_000n;
    const coordinator = '0x0000000000000000000000000000000000000003' as const;
    const target = { chainId: 97, token: FROM, coordinator, receiver: '0x0000000000000000000000000000000000000004' as const, p: FROM };
    const call = { to: coordinator, data: encodeFunctionData({ abi: coordinatorV2Abi, functionName: 'claim', args: [1n, FROM] }), value: 0n } as const;
    const send = (withFee: boolean) => submitWrite({ protocol: 'core-v2', target, call, wallet, from: FROM, gasLimit: 100_000n, feeReader: reader, ...(withFee ? { fee } : {}) });
    await expect(send(true)).rejects.toThrow("The network's gas price rose to 0.12 gwei; nothing was sent. Press again to read the price again.");
    expect(asked).not.toContain('eth_sendTransaction');
    // A fee read now carries the new price and is sent.
    await send(false);
    expect(asked).toContain('eth_sendTransaction');
    vi.unstubAllEnvs();
  });

  it('round 3b: checkRequestPrice: a request\'s fee fields under a fresh price are refused; at or above it they pass', async () => {
    const reader = (price: string) => createChainReader(async (request) => (request.method === 'eth_gasPrice' ? price : endpoint(request)));
    const tx = { maxFeePerGas: '0x68e7780', maxPriorityFeePerGas: '0x68e7780' }; // 110,000,000
    await expect(checkRequestPrice(reader('0x5f5e100'), 97, tx)).resolves.toBeUndefined();
    await expect(checkRequestPrice(reader('0x7270e00'), 97, tx)).rejects.toThrow('rose to 0.12 gwei');
    await expect(checkRequestPrice(reader('0x0'), 97, tx)).rejects.toThrow('no usable gas price');
    // Round 4: each field alone is compared (a low priority fee or a low max fee is refused) ...
    await expect(checkRequestPrice(reader('0x5f5e100'), 97, { ...tx, maxPriorityFeePerGas: '0x1' })).rejects.toThrow('rose');
    await expect(checkRequestPrice(reader('0x5f5e100'), 97, { ...tx, maxFeePerGas: '0x1' })).rejects.toThrow('rose');
    // ... and both must be RPC hex quantities: decimal, leading zeros, missing: a fee-shape refusal, never "rose".
    for (const bad of [{ ...tx, maxFeePerGas: '999999999999' }, { ...tx, maxFeePerGas: '0x0068e7780' }, { maxFeePerGas: '0x68e7780' }]) {
      await expect(checkRequestPrice(reader('0x5f5e100'), 97, bad)).rejects.toThrow('The network fee is not a valid EIP-1559 fee; nothing was sent.');
    }
    // Sepolia reads nothing here (no price read at all).
    let reads = 0;
    const counting = createChainReader(async (request) => { if (request.method === 'eth_gasPrice') reads += 1; return endpoint(request); });
    await expect(checkRequestPrice(counting, 11_155_111, tx)).resolves.toBeUndefined();
    expect(reads).toBe(0);
  });

  it('a chain price above the suggestion wins', () => {
    expect(sendFeesOf(0n, 50_000_000n, 97, 200_000_000n)).toEqual({ maxPriorityFeePerGas: 220_000_000n, maxFeePerGas: 220_000_000n });
  });

  it('Sepolia keeps its values exactly (tip floored at 0.01 gwei, capped at twice the base fee)', () => {
    expect(sendFeesOf(16n, 472_652n, 11_155_111)).toEqual({ maxPriorityFeePerGas: MIN_PRIORITY_FEE_WEI, maxFeePerGas: 32n + MIN_PRIORITY_FEE_WEI });
    expect(sendFeesOf(16n, 472_652n, 11_155_111, 999_999_999_999n)).toEqual(sendFeesOf(16n, 472_652n, 11_155_111));
    expect(sendFeesOf(1_000_000_000n, 1_500_000_000n, 11_155_111)).toEqual({ maxPriorityFeePerGas: 1_500_000_000n, maxFeePerGas: 3_500_000_000n });
  });
});
