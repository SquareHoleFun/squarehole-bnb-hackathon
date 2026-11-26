import { createRequire } from 'node:module';
import { alphaChain } from '../chains.mjs';
const require = createRequire(new URL('../../../../../packages/keeper/package.json', import.meta.url));
export const { createPublicClient, http, getAddress, recoverMessageAddress, keccak256, encodeFunctionData, parseAbi } = require('viem');
export const { privateKeyToAccount } = require('viem/accounts');
export const SEPOLIA = 11155111;
// Chain 97, BNB Chain Testnet (SH-275): its own starter and no admission step (../chains.mjs); else as Sepolia.
export const BNB_TESTNET = 97;
export const STARTER = 50000000000000000n;
// The starter's signed gas limit (estimate padded by 1.2x). A transfer to a used EOA is 21,000 (25,201 signed), but on
// Sepolia today a transfer to a never-used address (every new tester wallet) estimates 207,391 (248,870 signed): the
// new account's creation is priced in (measured 2026-11-02 on publicnode, Tenderly and 0xrpc.io; 60,000 refused the
// first new wallet). An address with code or an EIP-7702 delegation runs that code on the transfer; 400,000 still bounds
// one claim's starter gas, at most 400,000 x the signed max fee (0.02 SepETH at the 50 gwei ceiling).
export const STARTER_GAS_CAP = 400000n;
// Above this max fee per gas the sender waits instead of signing at a spike (Sepolia is normally far below it).
export const MAX_FEE_CEILING = 50000000000n;
export const abi = parseAbi([
  'function admitted(address) view returns (bool)',
  'function setAdmitter(address account, uint256 perDay)',
  'function admitOne(address account)',
]);

// viem wraps a reverted simulation as an error whose cause chain holds ExecutionRevertedError (code 3 or "execution
// reverted"); transport failures carry HttpRequestError, TimeoutError and the like instead.
const reverted = error => { for (let e = error; e; e = e.cause) if (e.name === 'ExecutionRevertedError') return true; return false; };
/** One signer, one journal, no nonce replacement. Only receipt-not-found means absent. */
export function createChain({ rpcUrl, address, teth, account, confirmations = 12n, chainId = SEPOLIA, client =
  createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }), cacheTime: 0 }) }) {
  // The chain's starter (STARTER on Sepolia). The engine checks the node's chain id against chainId before any send.
  const starter = chainId === SEPOLIA ? STARTER : alphaChain(chainId).starter;
  const request = (kind, c) => kind === 'admit'
    ? { to: teth, data: encodeFunctionData({ abi, functionName: 'admitOne', args: [c.address] }), value: 0n }
    : { to: c.address, value: starter };
  return {
    chainId: () => client.getChainId(),
    head: () => client.getBlockNumber({ cacheTime: 0 }),
    balance: () => client.getBalance({ address, blockTag: 'pending' }),
    admitted: target => client.readContract({ address: teth, abi, functionName: 'admitted', args: [target] }),
    async nonces() {
      const [latest, pending] = await Promise.all([
        client.getTransactionCount({ address, blockTag: 'latest' }),
        client.getTransactionCount({ address, blockTag: 'pending' }),
      ]);
      return { latest, pending };
    },
    async quote(c, needsAdmit) {
      const fees = await client.estimateFeesPerGas();
      // Estimate admission before reserving a claim. A contract cap/revocation/revert stops this claim.
      // Padding is paid only if used, but the full signed fee ceilings must fit in the float.
      const pad = gas => gas * 12n / 10n + 1n;
      const admitGas = needsAdmit ? pad(await client.estimateGas({ account: address, ...request('admit', c) })) : 0n;
      let sendGas;
      try { sendGas = pad(await client.estimateGas({ account: address, ...request('send', c) })); }
      catch (error) {
        // The node simulated the 0.05 transfer and it reverted (code at the address, or a 7702 delegation whose receive
        // reverts): an answer about this address, not an outage. Any other error (transport, timeout) stays an outage.
        if (reverted(error)) throw Object.assign(new Error('starter transfer reverts'), { code: 'STARTER_REVERTS' });
        throw error;
      }
      return { admitGas: String(admitGas), sendGas: String(sendGas),
        maxFeePerGas: String(fees.maxFeePerGas), maxPriorityFeePerGas: String(fees.maxPriorityFeePerGas) };
    },
    // The engine names the nonce: a claim's admission and starter are signed together at consecutive nonces (SH-181).
    async prepare(kind, c, quote, nonce) {
      if (!account) throw new Error('signer required');
      if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('nonce required');
      const raw = await account.signTransaction({ ...request(kind, c), chainId, nonce, type: 'eip1559',
        gas: BigInt(kind === 'admit' ? quote.admitGas : quote.sendGas),
        maxFeePerGas: BigInt(quote.maxFeePerGas), maxPriorityFeePerGas: BigInt(quote.maxPriorityFeePerGas) });
      return { kind, nonce, raw, hash: keccak256(raw) };
    },
    broadcast: tx => client.sendRawTransaction({ serializedTransaction: tx.raw }),
    // Whether the node holds this exact transaction, pooled or mined. Only not-found means unknown.
    async known(hash) {
      try { await client.getTransaction({ hash }); return true; }
      catch (error) {
        if (error?.name === 'TransactionNotFoundError') return false;
        throw error;
      }
    },
    async receipt(hash) {
      let receipt;
      try { receipt = await client.getTransactionReceipt({ hash }); }
      catch (error) {
        if (error?.name === 'TransactionReceiptNotFoundError') return null;
        throw error;
      }
      const head = await client.getBlockNumber({ cacheTime: 0 });
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (block.hash !== receipt.blockHash) throw new Error('receipt is not canonical');
      return { status: receipt.status, confirmed: head >= receipt.blockNumber + confirmations - 1n };
    },
  };
}
