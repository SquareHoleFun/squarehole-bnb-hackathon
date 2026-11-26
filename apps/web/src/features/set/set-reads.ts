/**
 * SH-EXISTING-NFTS-E08C: the add-on's chain reads over the source's RPC (never the wallet's). View calls, code, gas
 * estimates and receipts only: the one way a transaction reaches a wallet is E-08B's executor branch (set-calls.ts
 * `setSubmit`). Offchain lookups (CCIP-Read) are off, so a contract cannot send the browser to a URL of its choosing.
 * `chain` is the same RPC as E-08B's `ChainReader`, for the SDK paths the pages call directly (`prepareSetConversion`,
 * `readSetLoadPlan`).
 */
import {
  BaseError, ContractFunctionRevertedError, ExecutionRevertedError, TransactionNotFoundError, TransactionReceiptNotFoundError, createPublicClient, http,
  type Abi, type Address, type Hex,
} from 'viem';
import { createChainReader, createHttpRequest, type ChainReader } from '@squarehole/chain/write';

export interface SetGasRequest {
  readonly account: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

export interface SetReads {
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  /** A block's timestamp (the latest block's without a number): deadlines follow the chain, never this computer's clock. */
  timestamp(block?: bigint): Promise<bigint>;
  blockGasLimit(): Promise<bigint>;
  read(address: Address, abi: Abi, functionName: string, args?: readonly unknown[], block?: bigint): Promise<unknown>;
  code(address: Address, block?: bigint): Promise<Hex>;
  estimateGas(request: SetGasRequest): Promise<bigint>;
  /** The mined status, or null while there is no receipt. */
  receipt(hash: Hex): Promise<'success' | 'reverted' | null>;
  /** Whether the node still has this transaction (pending or mined). */
  known(hash: Hex): Promise<boolean>;
  wait(hash: Hex): Promise<'success' | 'reverted'>;
  /** The same RPC as E-08B's reader (eth_call, blocks by number with their hashes). */
  readonly chain: ChainReader;
}

export function rpcSetReads(rpc: string, pollingInterval = 1_000): SetReads {
  const client = createPublicClient({ transport: http(rpc, { retryCount: 0 }), ccipRead: false, pollingInterval });
  return {
    chain: createChainReader(createHttpRequest(rpc, { timeoutMs: 8_000 })),
    chainId: () => client.getChainId(),
    // Never viem's cached number (up to 4 s old): a read pinned to it right after a receipt would read the block before.
    blockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    timestamp: async (block) => (await (block === undefined ? client.getBlock({ blockTag: 'latest' }) : client.getBlock({ blockNumber: block }))).timestamp,
    blockGasLimit: async () => (await client.getBlock()).gasLimit,
    read: (address, abi, functionName, args = [], block) =>
      client.readContract({ address, abi, functionName, args, ...(block === undefined ? {} : { blockNumber: block }) } as never) as Promise<unknown>,
    code: async (address, block) => (await client.getCode({ address, ...(block === undefined ? {} : { blockNumber: block }) })) ?? '0x',
    estimateGas: (r) => client.estimateGas({ account: r.account, to: r.to, data: r.data, value: r.value }),
    receipt: async (hash) => {
      try {
        return (await client.getTransactionReceipt({ hash })).status;
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
    known: async (hash) => {
      try {
        await client.getTransaction({ hash });
        return true;
      } catch (error) {
        if (error instanceof TransactionNotFoundError) return false;
        throw error;
      }
    },
    wait: async (hash) => (await client.waitForTransactionReceipt({ hash, timeout: 900_000 })).status,
  };
}

/** Whether a read failed because the contract reverted (an answer), not because the RPC did not answer. */
export function reverted(error: unknown): boolean {
  return error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError || cause instanceof ExecutionRevertedError) !== null;
}

export const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
