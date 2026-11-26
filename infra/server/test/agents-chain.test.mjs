import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createChain, allowanceAbi, privateKeyToAccount } from '../services/agents/chain.mjs';
import { config, pay } from './fixtures/agents/helpers.mjs';
const { decodeFunctionData, parseTransaction } = createRequire(new URL('../../../packages/keeper/package.json', import.meta.url))('viem');

function fixture(overrides = {}) {
  const c = config(), account = privateKeyToAccount('0x' + '1'.padStart(64, '0')); c.manager.address = account.address;
  const client = { getChainId: vi.fn(async () => 11155111),
    readContract: vi.fn(async ({ functionName }) => functionName === 'decimals' ? 6 : functionName === 'isModuleEnabled' ? true : [300000000n, 200000000n, 10080n, 100000n, 0n]),
    getBlock: vi.fn(async () => ({ timestamp: 100001n * 60n })), getTransactionCount: vi.fn(async () => 0),
    estimateGas: vi.fn(async () => 100000n), estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1n })),
    ...overrides };
  const signer = vi.fn(() => account), chain = createChain({ config: c, client, signer });
  return { c, client, signer, chain };
}
describe('agents Allowance Module adapter', () => {
  it('signs only the documented transfer with zero fee, explicit token, payee and delegate', async () => {
    const f = fixture(), signed = await f.chain.prepare(pay), tx = parseTransaction(signed.raw);
    expect(tx.chainId).toBe(11155111); expect(tx.to.toLowerCase()).toBe(f.c.module); expect(tx.value ?? 0n).toBe(0n);
    const data = decodeFunctionData({ abi: allowanceAbi, data: tx.data });
    expect(data.functionName).toBe('executeAllowanceTransfer');
    expect(data.args).toEqual([f.c.safe, f.c.token, f.c.manager.payees.cleaner, 100000000n,
      '0x0000000000000000000000000000000000000000', 0n, f.c.manager.address, '0x']);
  });
  it('checks allowance before opening a signer and recognizes the weekly reset', async () => {
    const f = fixture(); expect(await f.chain.remaining()).toBe(100000000n);
    await expect(f.chain.prepare({ ...pay, amountRaw: '100000001' })).rejects.toThrow('allowance');
    expect(f.signer).not.toHaveBeenCalled();
    f.client.getBlock.mockResolvedValue({ timestamp: 110080n * 60n }); expect(await f.chain.remaining()).toBe(300000000n);
  });
  it.each([
    [300000001n, 0n, 10080n, 100000n, 0n], [300000000n, 0n, 60n, 100000n, 0n],
    [300000000n, 300000001n, 10080n, 100000n, 0n], [300000000n, 0n, 10080n, 100002n, 0n],
  ])('refuses an unsafe on-chain allowance %s', async (...allowance) => {
    const f = fixture(); f.client.readContract.mockImplementation(async ({ functionName }) => functionName === 'getTokenAllowance' ? allowance : functionName === 'decimals' ? 6 : true);
    await expect(f.chain.remaining()).rejects.toThrow('allowance policy'); expect(f.signer).not.toHaveBeenCalled();
  });
  it('refuses disabled modules, wrong token decimals, changed chain, pending nonces and unknown payees', async () => {
    for (const fault of ['disabled', 'decimals', 'chain', 'nonce', 'payee']) {
      const f = fixture();
      if (fault === 'disabled' || fault === 'decimals') f.client.readContract.mockImplementation(async ({ functionName }) => functionName === 'getTokenAllowance'
        ? [300000000n, 0n, 10080n, 100000n, 0n] : functionName === 'decimals' ? (fault === 'decimals' ? 18 : 6) : false);
      if (fault === 'chain') f.client.getChainId.mockResolvedValue(1);
      if (fault === 'nonce') f.client.getTransactionCount.mockImplementation(async ({ blockTag }) => blockTag === 'pending' ? 1 : 0);
      await expect(f.chain.prepare(fault === 'payee' ? { ...pay, payee: 'unknown' } : pay)).rejects.toThrow();
      expect(f.signer).not.toHaveBeenCalled();
    }
  });
});
