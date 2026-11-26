import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createChain, STARTER } from '../services/alpha/sender/chain.mjs';
import { desk, token, claim, viem } from './fixtures/alpha-sender/helpers.mjs';

function fixture() {
  const client = {
    getChainId: vi.fn(async () => 11155111), getBalance: vi.fn(async () => 10n ** 18n),
    getTransactionCount: vi.fn(async () => 7), getBlockNumber: vi.fn(async () => 12n),
    getBlock: vi.fn(async () => ({ hash: 'block-a' })),
    getTransactionReceipt: vi.fn(async () => ({ status: 'success', blockNumber: 1n, blockHash: 'block-a' })),
    readContract: vi.fn(async () => false), estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 10n })),
    estimateGas: vi.fn(async () => 21000n), sendRawTransaction: vi.fn(async () => 'hash'),
    getTransaction: vi.fn(async ({ hash }) => ({ hash, blockNumber: null })),
  };
  const chain = createChain({ rpcUrl: 'http://fixture.invalid', address: desk.address, teth: token, account: desk, client });
  return { chain, client };
}
describe('alpha sender RPC adapter', () => {
  beforeAll(() => vi.stubGlobal('fetch', () => { throw new Error('fixture forbids network'); }));
  afterAll(() => vi.unstubAllGlobals());
  it('signs Sepolia calls and exact value at the nonces the engine names, retaining the same raw bytes for retry', async () => {
    const { chain, client } = fixture(), c = await claim(1);
    const quote = await chain.quote(c, true);
    expect(Object.values(quote).every(v => typeof v === 'string')).toBe(true);
    const admit = await chain.prepare('admit', c, quote, 7), send = await chain.prepare('send', c, quote, 8);
    expect(viem.parseTransaction(send.raw)).toMatchObject({ chainId: 11155111, value: STARTER, nonce: 8, to: c.address.toLowerCase() });
    expect(viem.parseTransaction(admit.raw)).toMatchObject({ to: token.toLowerCase(), nonce: 7 });
    expect([admit.nonce, send.nonce]).toEqual([7, 8]); expect(client.getTransactionCount).not.toHaveBeenCalled();
    for (const nonce of [undefined, -1, 1.5, '7']) await expect(chain.prepare('send', c, quote, nonce)).rejects.toThrow('nonce required');
    expect(viem.decodeFunctionData({ abi: viem.parseAbi(['function admitOne(address)']), data: viem.parseTransaction(admit.raw).data }))
      .toMatchObject({ functionName: 'admitOne', args: [c.address] });
    await chain.broadcast(send); await chain.broadcast(send);
    expect(client.sendRawTransaction.mock.calls).toEqual([[{ serializedTransaction: send.raw }], [{ serializedTransaction: send.raw }]]);
  });
  it('requires twelve canonical confirmations and does not treat RPC failures as absence', async () => {
    const { chain, client } = fixture();
    expect(await chain.receipt('hash')).toEqual({ status: 'success', confirmed: true });
    client.getBlockNumber.mockResolvedValue(11n); expect((await chain.receipt('hash')).confirmed).toBe(false);
    client.getBlock.mockResolvedValue({ hash: 'block-b' }); await expect(chain.receipt('hash')).rejects.toThrow('canonical');
    client.getTransactionReceipt.mockRejectedValue(Object.assign(new Error(), { name: 'TransactionReceiptNotFoundError' }));
    expect(await chain.receipt('hash')).toBeNull();
    client.getTransactionReceipt.mockRejectedValue(new Error('timeout')); await expect(chain.receipt('hash')).rejects.toThrow('timeout');
  });
  it('knows a transaction only when the node returns it; an RPC failure is not "unknown"', async () => {
    const { chain, client } = fixture();
    expect(await chain.known('0xabc')).toBe(true);
    expect(client.getTransaction).toHaveBeenCalledWith({ hash: '0xabc' });
    client.getTransaction.mockRejectedValueOnce(Object.assign(new Error(), { name: 'TransactionNotFoundError' }));
    expect(await chain.known('0xabc')).toBe(false);
    client.getTransaction.mockRejectedValueOnce(new Error('timeout'));
    await expect(chain.known('0xabc')).rejects.toThrow('timeout');
  });
  it('reads both nonce views and simulates admission only when needed', async () => {
    const { chain, client } = fixture();
    expect(await chain.nonces()).toEqual({ latest: 7, pending: 7 });
    expect(client.getTransactionCount.mock.calls.map(([v]) => v.blockTag)).toEqual(['latest', 'pending']);
    const quote = await chain.quote(await claim(1), false);
    expect(quote.admitGas).toBe('0'); expect(client.estimateGas).toHaveBeenCalledTimes(1);
  });
});
