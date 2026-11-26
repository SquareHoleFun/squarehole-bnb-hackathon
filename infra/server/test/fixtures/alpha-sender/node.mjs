import { desk, token, viem } from './helpers.mjs';

const admitOne = viem.parseAbi(['function admitOne(address account)']);
const missing = name => Object.assign(new Error('fixture: not found'), { name });
// The refusals local Anvil and Sepolia nodes give (viem surfaces them as TransactionRejectedRpcError).
const refusal = details => Object.assign(new Error(details), { name: 'TransactionRejectedRpcError', details });

/**
 * A stand-in Sepolia node at exactly the RPC methods the sender's chain adapter (chain.mjs) calls, so tests run the
 * production adapter: real signatures, receipts and the twelve canonical confirmations. One desk sender, one mempool,
 * nonces mined in order, a block only when a test mines one. Like Anvil and geth it refuses a copy of a transaction it
 * already holds ("already known"), a used nonce ("nonce too low") and a second transaction at a pooled nonce. A
 * transaction whose fee ceiling is under the base fee waits in the pool, as on geth.
 */
export function fakeNode({ teth = token } = {}) {
  const pool = new Map(), mined = new Map(), admitted = new Set();
  const node = {
    head: 100n, latest: 0, funds: 10n ** 18n, baseFee: 1000000000n,
    fees: [{ maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n }], gas: { admit: 50000n, send: 21000n },
    reverts: new Set(), pool, mined, admitted, sends: [], blocks: [], sent: [], refused: [],
    receiptFailure: null,
    /** One block: pooled transactions in nonce order from the confirmed count, at most `take`. */
    mine({ take = Infinity } = {}) {
      node.head++;
      const block = { number: node.head, hash: `block-${node.head}`, txs: [] };
      while (block.txs.length < take) {
        const tx = [...pool.values()].find(t => t.nonce === node.latest);
        if (!tx || tx.maxFeePerGas < node.baseFee) break;
        pool.delete(tx.hash); node.latest++;
        let status = 'success';
        if (tx.to?.toLowerCase() === teth.toLowerCase()) {
          const [target] = viem.decodeFunctionData({ abi: admitOne, data: tx.data }).args;
          if (node.reverts.has(target.toLowerCase())) status = 'reverted'; else admitted.add(target.toLowerCase());
        } else if (tx.value) { node.sends.push(tx); node.funds -= tx.value; }
        node.funds -= tx.gas * node.baseFee;
        mined.set(tx.hash, { status, blockNumber: node.head, blockHash: block.hash, transactionHash: tx.hash });
        block.txs.push(tx.hash);
      }
      node.blocks.push(block);
      return block;
    },
    /** Empty blocks, for confirmations. */
    advance(blocks) { node.head += BigInt(blocks); },
    drop(hash) { pool.delete(hash); },
    /** A transaction from the desk key that this sender never journaled (another process holding the key). */
    async foreign(nonce) {
      const raw = await desk.signTransaction({ chainId: 11155111, type: 'eip1559', nonce, to: desk.address, value: 0n,
        gas: 21000n, maxFeePerGas: 9000000000n, maxPriorityFeePerGas: 1000000000n });
      const hash = viem.keccak256(raw);
      pool.set(hash, { ...viem.parseTransaction(raw), raw, hash });
      return hash;
    },
  };
  const pendingCount = () => { let n = node.latest; while ([...pool.values()].some(t => t.nonce === n)) n++; return n; };
  node.client = {
    getChainId: async () => 11155111,
    getBlockNumber: async () => node.head,
    getBlock: async ({ blockNumber }) => ({ hash: `block-${blockNumber}` }),
    getBalance: async () => node.funds,
    readContract: async ({ args: [target] }) => admitted.has(target.toLowerCase()),
    getTransactionCount: async ({ blockTag }) => blockTag === 'pending' ? pendingCount() : node.latest,
    // The last quote repeats; a test can line up rising fees.
    estimateFeesPerGas: async () => node.fees.length > 1 ? node.fees.shift() : node.fees[0],
    estimateGas: async ({ to }) => to.toLowerCase() === teth.toLowerCase() ? node.gas.admit : node.gas.send,
    sendRawTransaction: async ({ serializedTransaction: raw }) => {
      const tx = viem.parseTransaction(raw), hash = viem.keccak256(raw);
      node.sent.push(hash);
      const refuse = details => { node.refused.push([hash, details]); throw refusal(details); };
      if (pool.has(hash)) refuse('already known');
      if (tx.nonce < node.latest) refuse('nonce too low');
      if ([...pool.values()].some(t => t.nonce === tx.nonce)) refuse('replacement transaction underpriced');
      pool.set(hash, { ...tx, raw, hash });
      return hash;
    },
    getTransactionReceipt: async ({ hash }) => {
      if (node.receiptFailure) throw new Error(node.receiptFailure);
      if (!mined.has(hash)) throw missing('TransactionReceiptNotFoundError');
      return mined.get(hash);
    },
    getTransaction: async ({ hash }) => {
      if (!pool.has(hash) && !mined.has(hash)) throw missing('TransactionNotFoundError');
      return { hash, blockNumber: mined.get(hash)?.blockNumber ?? null };
    },
  };
  return node;
}
