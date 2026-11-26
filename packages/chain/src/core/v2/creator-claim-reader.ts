import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, parseAbi, toFunctionSelector, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { coordinatorV2Abi, receiverV2Abi } from './abi-v2';

/** Supply canonical EIP-1898 reads; simulations must use the stated sender and the same hash. */
export interface CreatorClaimReaderV2 {
  callAt(to: Address, data: Hex, hash: Hex): Promise<Hex>;
  callFromAt?(from: Address, to: Address, data: Hex, hash: Hex): Promise<Hex>;
  /** Exact next bounded payout after reconciliation/lazy settlement, without transferring P. */
  creatorEntitlementAt?(wallet: Address, receiver: Address, asset: Address, hash: Hex): Promise<bigint>;
}

/** Roles and price coin from the authenticated box record, never arbitrary wallet-selected targets. */
export interface CreatorClaimTargetV2 {
  readonly q: Address;
  readonly contracts: { readonly receiver?: Address | null; readonly coordinator?: Address | null };
}

const payoutErrors = parseAbi([
  'error WrappedError(address target,bytes4 selector,bytes reason,bytes details)',
  'error TransferNotExact(uint256 expected,uint256 received)',
  'error BalanceUnreadable(address token,address account)',
]);

/** Recognize only payout-stage refusals, including v4's contextual wrapper. RPC/unknown reverts still fail. */
function payoutRefused(error: unknown, asset: Address, wallet: Address): boolean {
  for (let i = 0; i < 10 && error && typeof error === 'object'; i++) {
    const e = error as { data?: unknown; cause?: unknown };
    if (typeof e.data === 'string' && /^0x[0-9a-f]+$/i.test(e.data)) {
      try {
        const decoded = decodeErrorResult({ abi: payoutErrors, data: e.data as Hex });
        if (decoded.errorName === 'TransferNotExact') return true;
        if (decoded.errorName === 'BalanceUnreadable') return decoded.args[0].toLowerCase() === asset.toLowerCase() && decoded.args[1].toLowerCase() === wallet.toLowerCase();
        if (decoded.errorName === 'WrappedError') {
          const [target, selector, , details] = decoded.args;
          return asset.toLowerCase() === zeroAddress
            ? target.toLowerCase() === wallet.toLowerCase() && selector === '0x00000000' && details === toFunctionSelector('NativeTransferFailed()')
            : target.toLowerCase() === asset.toLowerCase() && selector === '0xa9059cbb' && details === toFunctionSelector('ERC20TransferFailed()');
        }
      } catch { /* Not a decoded payout refusal. Never classify by message or a generic RPC revert code. */ }
    }
    error = e.cause;
  }
  return false;
}

/**
 * Quote the rightful payee's next self-payment at one canonical hash, including lazy settlement and the
 * receiver's bounded payout. Never treat stored creatorOwed as a payment quote. A decoded payout refusal
 * retains entitlement; unknown RPC/contract errors reject. Call again after each confirmed receipt.
 * Read-only: this function never requests wallet access or sends a transaction.
 */
export async function readCreatorClaimV2(r: CreatorClaimReaderV2, row: CreatorClaimTargetV2, wallet: Address, hash: Hex) {
  const receiver = row.contracts.receiver; const coordinator = row.contracts.coordinator;
  if (!receiver || !coordinator) throw new Error('missing creator claim roles');
  const read = async <T>(to: Address, abi: Abi, fn: string): Promise<T> => decodeFunctionResult({
    abi, functionName: fn, data: await r.callAt(to, encodeFunctionData({ abi, functionName: fn }), hash),
  }) as T;
  const [payee, graduated, failed] = await Promise.all([
    read<Address>(receiver, receiverV2Abi, 'creatorPayee'), read<boolean>(coordinator, coordinatorV2Abi, 'graduated'), read<boolean>(coordinator, coordinatorV2Abi, 'failed'),
  ]);
  if (payee.toLowerCase() !== wallet.toLowerCase() || !graduated || failed) return null;
  // The view omits royalty/fee money that claimCreator releases lazily, and the payout is capped at four parts.
  // Simulate the actual rightful call instead of duplicating that money logic off chain.
  if (!r.callFromAt) throw new Error('creator claim requires a sender-aware reader');
  try {
    const data = await r.callFromAt(wallet, receiver, encodeFunctionData({ abi: receiverV2Abi, functionName: 'claimCreator', args: [row.q, wallet] }), hash);
    const amountP = decodeFunctionResult({ abi: receiverV2Abi, functionName: 'claimCreator', data });
    return amountP > 0n ? { amountP, payout: 'available' as const } : null;
  } catch (error) {
    if (!payoutRefused(error, row.q, wallet)) throw error;
    if (!r.creatorEntitlementAt) throw new Error('creator claim requires a payout-independent quote reader', { cause: error });
    const amountP = await r.creatorEntitlementAt(wallet, receiver, row.q, hash);
    return amountP > 0n ? { amountP, payout: 'unavailable' as const } : null;
  }
}
