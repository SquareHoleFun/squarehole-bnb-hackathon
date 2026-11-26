import { createRequire } from 'node:module';
import { requireThat, SEPOLIA, WEEKLY_CAP, validateDecision } from './policy.mjs';
const require = createRequire(new URL('../../../../packages/keeper/package.json', import.meta.url));
export const { createPublicClient, http, parseAbi, encodeFunctionData, keccak256 } = require('viem');
export const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
// Safe Allowance Module ABI: delegate == msg.sender uses an empty signature; fees are explicitly zero.
export const allowanceAbi = parseAbi([
  'function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])',
  'function executeAllowanceTransfer(address safe, address token, address to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)',
]);
const safeAbi = parseAbi(['function isModuleEnabled(address module) view returns (bool)']);
export const tokenAbi = parseAbi(['function decimals() view returns (uint8)', 'function transfer(address to, uint256 amount) returns (bool)']);
const ZERO = '0x0000000000000000000000000000000000000000';
export function proposal(c, job) {
  const net = BigInt(job.incomeRaw) > BigInt(job.expensesRaw) ? BigInt(job.incomeRaw) - BigInt(job.expensesRaw) : 0n;
  return { version: 1, chainId: c.chainId, safe: c.safe, month: job.month, netIncomeRaw: String(net),
    note: 'Proposed net income into the box inbox. Founder must verify ledger, token, inbox and Safe balance before signing.',
    transactions: net === 0n ? [] : [{ to: c.token, value: '0', operation: 0,
      data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [c.inbox, net] }) }] };
}
export function createChain({ config: c, rpcUrl, signer, confirmations = 12n,
  client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 15000 }), cacheTime: 0 }) }) {
  const remaining = async () => {
    requireThat(await client.getChainId() === SEPOLIA, 'Sepolia required');
    const [enabled, decimals, allowance, block] = await Promise.all([
      client.readContract({ address: c.safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [c.module] }),
      client.readContract({ address: c.token, abi: tokenAbi, functionName: 'decimals' }),
      client.readContract({ address: c.module, abi: allowanceAbi, functionName: 'getTokenAllowance', args: [c.safe, c.manager.address, c.token] }),
      client.getBlock(),
    ]);
    const [amount, spent, reset, lastReset] = allowance;
    requireThat(enabled && decimals === 6 && amount > 0n && amount <= WEEKLY_CAP
      && amount <= BigInt(c.manager.weeklyCapRaw) && reset === 10080n && spent <= amount && lastReset <= block.timestamp / 60n, 'allowance policy refused');
    return block.timestamp / 60n >= lastReset + reset ? amount : amount - spent;
  };
  return { chainId: () => client.getChainId(), remaining,
    async prepare(decision) {
      validateDecision(decision, { kind: 'expense' }, c);
      requireThat(await remaining() >= BigInt(decision.amountRaw), 'allowance too low');
      const [latest, pending] = await Promise.all(['latest', 'pending'].map(blockTag => client.getTransactionCount({ address: c.manager.address, blockTag })));
      requireThat(latest === pending, 'manager nonce busy');
      const tx = { to: c.module, value: 0n, data: encodeFunctionData({ abi: allowanceAbi, functionName: 'executeAllowanceTransfer',
        args: [c.safe, c.token, c.manager.payees[decision.payee], BigInt(decision.amountRaw), ZERO, 0n, c.manager.address, '0x'] }) };
      const gas = await client.estimateGas({ account: c.manager.address, ...tx });
      const fees = await client.estimateFeesPerGas();
      const account = signer();
      requireThat(account.address.toLowerCase() === c.manager.address.toLowerCase(), 'manager address mismatch');
      const serialized = await account.signTransaction({ ...tx, chainId: SEPOLIA, nonce: latest, type: 'eip1559',
        gas: gas * 12n / 10n + 1n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      return { raw: serialized, hash: keccak256(serialized), nonce: latest };
    },
    async broadcast(tx) {
      requireThat(await client.getChainId() === SEPOLIA, 'Sepolia required');
      return client.sendRawTransaction({ serializedTransaction: tx.raw });
    },
    async receipt(hash) {
      let r;
      try { r = await client.getTransactionReceipt({ hash }); }
      catch (e) { if (e?.name === 'TransactionReceiptNotFoundError') return null; throw e; }
      const [head, block] = await Promise.all([client.getBlockNumber({ cacheTime: 0 }), client.getBlock({ blockNumber: r.blockNumber })]);
      requireThat(block.hash === r.blockHash, 'receipt is not canonical');
      return { status: r.status, confirmed: head >= r.blockNumber + confirmations - 1n };
    },
  };
}
