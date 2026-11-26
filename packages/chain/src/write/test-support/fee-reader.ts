// TEST SUPPORT ONLY (never imported by app code): SH-SEND-FEES, the app RPC's fee and balance reads a guarded send
// takes (`SendFeeReader`), fixed: a 1 gwei base fee, a 0.1 gwei tip and 1,000 ETH, unless a test names others.
import type { Address, TxHash } from '@squarehole/domain';
import type { SendFeeReader } from '../executor';

export interface TestFeeReaderOptions {
  readonly baseFee?: bigint;
  readonly tip?: bigint;
  readonly balance?: bigint;
}

export interface TestFeeReader extends SendFeeReader {
  /** Every balance read's account, in order. */
  readonly balanceReads: Address[];
}

export function testFeeReader(options: TestFeeReaderOptions = {}): TestFeeReader {
  const { baseFee = 1_000_000_000n, tip = 100_000_000n, balance = 10n ** 21n } = options;
  const balanceReads: Address[] = [];
  return {
    balanceReads,
    getBlock: async () => ({ number: 1n, hash: `0x${'11'.repeat(32)}` as TxHash, timestamp: 0n, baseFeePerGas: baseFee, transactions: [] }),
    maxPriorityFeePerGas: async () => tip,
    getBalance: async (account) => {
      balanceReads.push(account);
      return balance;
    },
  };
}

/** The default reader, for a send whose fee a test does not look at. */
export const TEST_FEE_READER: SendFeeReader = testFeeReader();

/** The fee fields a send carries with `TEST_FEE_READER`: 2 × 1 gwei + 0.1 gwei, and the 0.1 gwei tip (hex quantities). */
export const TEST_SEND_FEE_FIELDS = Object.freeze({ maxFeePerGas: '0x7d2b7500', maxPriorityFeePerGas: '0x5f5e100' });

/**
 * A test RPC's answer to the sender's fee and funds reads (`eth_getBlockByNumber`, `eth_maxPriorityFeePerGas`,
 * `eth_getBalance`), as `TEST_FEE_READER` answers them; undefined for any other method. For JSON-RPC fakes that answer
 * a fixed list of methods.
 */
export function sendFeeRpcAnswer(method: string): unknown {
  if (method === 'eth_getBlockByNumber') return { number: '0x1', hash: `0x${'11'.repeat(32)}`, timestamp: '0x0', baseFeePerGas: '0x3b9aca00', transactions: [] };
  if (method === 'eth_maxPriorityFeePerGas') return '0x5f5e100';
  if (method === 'eth_getBalance') return '0x3635c9adc5dea00000';
  return undefined;
}
