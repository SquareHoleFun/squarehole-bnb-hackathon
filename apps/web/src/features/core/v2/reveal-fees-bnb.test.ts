// @vitest-environment node
/**
 * SH-258 fix round 2: the reveal reader's fee on chain 97, on the answers recorded from its public endpoint (base fee 0,
 * `eth_gasPrice` and `eth_maxPriorityFeePerGas` 0.1 gwei, the latest block's median reward 0). Both reveal paths, the
 * open items' (reveal-items.ts) and the hidden draws' (reveal-hidden.ts), send with the fee this reader gives (the
 * session hands both `adapter.feeReader`, reveal-session.ts). Before the fix the reader took the median reward as the
 * tip and read no gas price: 11,000,000 for both fields. Sepolia's reader stays the median-reward one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toHex } from 'viem';
import recorded from '../../../../../../packages/chain/src/write/test-support/bnb-testnet-fees.json' with { type: 'json' };
import { NetworkPriceError, readSendFees } from '../../../../../../packages/chain/src/write/executor';
import type { Eip1193Request } from '../../../../../../packages/chain/src/write/eip1193';
import { createRevealRPC, type RevealBox } from './reveal-rpc';
import type { V2Source } from './indexer-v2';
import { installRevealTestSeam } from './reveal-test-seam.test-support';
import { runFixture } from './reveal-items.test-support';

vi.mock('./reveal-test-seam', async () => import('./reveal-test-seam.test-support'));
afterEach(() => vi.restoreAllMocks());

const PRICE = 100_000_000n;

/** The reveal reader on `chainId`, over the recorded answers; `price` replaces `eth_gasPrice`'s answer (null: it fails). */
function revealReader(chainId: number, price: string | null = recorded.eth_gasPrice) {
  const f = runFixture(4);
  const release = { registry: { address: f.identity.registry } };
  const source = { rpc: 'http://127.0.0.1:8571', manifest: { chainId, releases: [release] } } as unknown as Pick<V2Source, 'manifest' | 'rpc'>;
  const box = { record: f.record, spec: {}, release } as unknown as RevealBox;
  const asked: string[] = [];
  const request: Eip1193Request = async ({ method }) => {
    asked.push(method);
    switch (method) {
      case 'eth_chainId': return toHex(chainId);
      case 'eth_getBlockByNumber': return { ...recorded.latestBlock, transactions: [] };
      case 'eth_gasPrice': if (price === null) throw new Error('no answer'); return price;
      case 'eth_maxPriorityFeePerGas': return recorded.eth_maxPriorityFeePerGas;
      // The last recorded block's median reward is 0 (bnb-testnet-fees.json).
      case 'eth_feeHistory': return { ...recorded.eth_feeHistory, reward: [['0x0']] };
      case 'eth_getBalance': return '0xde0b6b3a7640000';
      default: throw new Error(`not recorded: ${method}`);
    }
  };
  installRevealTestSeam(source, { rpc: request });
  return { adapter: createRevealRPC(source, box), asked };
}

describe('the reveal reader’s fee on chain 97 (recorded answers)', () => {
  it('both fields at least the chain’s price (both reveal paths send with this reader’s fee)', async () => {
    const { adapter, asked } = revealReader(97);
    const fees = await readSendFees(adapter.feeReader, 97);
    expect(fees.maxPriorityFeePerGas).toBeGreaterThanOrEqual(PRICE);
    expect(fees.maxFeePerGas).toBeGreaterThanOrEqual(PRICE);
    expect(asked).toContain('eth_gasPrice');
    expect(asked).not.toContain('eth_feeHistory');
  });

  it('a missing or zero price stops the send with a plain message, never a guess', async () => {
    await expect(readSendFees(revealReader(97, null).adapter.feeReader, 97)).rejects.toThrow('The network gave no usable gas price; nothing was sent. Try again.');
    await expect(readSendFees(revealReader(97, '0x0').adapter.feeReader, 97)).rejects.toThrow(NetworkPriceError);
    await expect(readSendFees(revealReader(97, '0x0').adapter.feeReader, 97)).rejects.toThrow('The network gave no usable gas price; nothing was sent.');
  });

  it('a price above the site’s 5 gwei ceiling is refused, never sent under it', async () => {
    await expect(readSendFees(revealReader(97, toHex(6_000_000_000n)).adapter.feeReader, 97)).rejects.toThrow('The network asks 6 gwei for gas, above the 5 gwei this site offers; nothing was sent.');
  });

  it('Sepolia’s reveal reader is the median-reward one, as before (no gas price read)', async () => {
    const { adapter, asked } = revealReader(11_155_111);
    const fees = await readSendFees(adapter.feeReader, 11_155_111);
    expect(fees).toEqual({ maxPriorityFeePerGas: 10_000_000n, maxFeePerGas: 10_000_000n });
    expect(asked).toContain('eth_feeHistory');
    expect(asked).not.toContain('eth_gasPrice');
  });

  it('round 3: a price error reaches both reveal paths as its own reason and line, not "store failed" or "wallet refused"', async () => {
    const [{ priceReason }, { reasonText }] = await Promise.all([import('./reveal-items'), import('./reveal-words')]);
    expect(priceReason(new NetworkPriceError('no_price', null))).toBe('gas-price-unread');
    expect(priceReason(new NetworkPriceError('rose', 120_000_000n))).toBe('gas-price-rose');
    expect(priceReason(new Error('other'))).toBeNull();
    expect(reasonText('gas-price-unread')).toBe('The network gave no usable gas price; nothing was sent. Try again.');
    expect(reasonText('gas-price-rose')).toBe('The network’s gas price rose; nothing was sent. Prepare again to see the new cost.');
  });

  it('round 3b: the price is checked after the journal write, right before the provider; a refusal never reaches it', async () => {
    const { forwardRevealSend } = await import('./reveal-items');
    const order: string[] = [];
    const sent = forwardRevealSend({ chainId: async () => 97 } as never, 97, async () => { order.push('journal'); }, async () => { order.push('provider'); return '0x'; },
      async () => { order.push('price'); throw new NetworkPriceError('rose', 120_000_000n); });
    await expect(sent).rejects.toThrow(NetworkPriceError);
    expect(order).toEqual(['journal', 'price']);
  });
});
