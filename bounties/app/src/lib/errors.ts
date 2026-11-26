import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';
import { formatAmount } from './amounts';

/** One plain sentence per contract error the page can meet. The decoded name is always shown beside it. */
export const ERROR_SENTENCES: Record<string, string> = {
  ZeroAmount: 'The amount is zero.',
  ExceedsCirculating: 'That is more than all tokens in circulation.',
  BelowMinimum: 'The payout fell below your minimum, so nothing was done.',
  InexactMovement: 'Something other than the exact amounts moved, so nothing was paid and nothing was taken.',
  InvalidRecipient: 'That address cannot be paid.',
  LaunchMismatch: 'The launch did not go through. Nothing was taken and the sale stays open.',
  NotCompleted: 'Someone traded first, so the launch did not go through. Nothing was taken.',
  PaymentFailed: 'The payout could not be delivered.',
  ExcludedHolder: 'This address cannot redeem.',
  Reentrancy: 'Another call was still running.',
  SaleClosed: 'The sale is closed.',
  NothingToClaim: 'Nothing to claim.',
  NothingToUnwind: 'Nothing to take back.',
  SaleNotFailed: 'The sale is not in its refund phase.',
  NotLaunched: 'The token has not launched yet.',
  FirstBuyCompletesSale: 'A first buy cannot take the whole sale.',
  NotEnoughTokens: 'More than you hold.',
  NothingBought: 'The amount buys nothing.',
  WrongValue: 'The amount sent does not match.',
  BelowLiquidityFloor: 'Below the Portal’s floor.',
  QuoteNotEnabled: 'The Portal does not take BNB right now.',
  LauncherFactoryNotEnabled: 'Flap has not enabled this factory.',
};

/**
 * Sentences for one contract's own errors, where a name means something else in another contract (the stake's and the
 * shop's `TransferFailed`): one map per contract, chosen by the kind a press names (`useTx({ errors })`). A name a
 * contract's map lacks falls back to the shared sentences above.
 */
export type ContractKind = 'stake' | 'shop';

/** SH-290: the holders' stake (bounties/core/src/IRailStake.sol). */
export const STAKE_ERRORS: Record<string, string> = {
  NotStaked: 'More than you have staked.',
  // Raised for the token in stake and unstake, and for the payout in claim.
  TransferFailed: 'A transfer did not go through.',
  WrongAsset: 'This stake is paid in a token, not in the native coin.',
  BalanceUnreadable: 'The token’s balance could not be read, so nothing was staked.',
  BadReceiver: 'That address cannot receive the payout.',
};

/**
 * SH-288: the card shop (bounties/core/src/IRailShop.sol), and its factory's one error (RailShopFactory.sol), which
 * the page meets only on the shop's side. `NotHeld` cannot be met with our collections (a pick needs a listed card the
 * shop owns); kept for completeness.
 */
export const SHOP_ERRORS: Record<string, string> = {
  NotListed: 'The shop does not take cards of this collection.',
  NotHeld: 'The shop does not hold this card.',
  LastCard: 'The last card stays in the shop.',
  BudgetShort: 'The shop’s budget is too small for this card.',
  CapReached: 'This week’s room for gives is too small for this card.',
  PriceAbove: 'The price moved above what you saw.',
  TransferFailed: 'A transfer did not go through.',
  NativeNotAccepted: 'The shop takes no BNB here.',
  NothingWaiting: 'Nothing is waiting.',
  InvalidShop: 'This shop’s settings are refused.',
  BadReceiver: 'The card cannot go to that address.',
  StillHeld: 'The shop still holds this card.',
  AmountAbove: 'That is more than is waiting.',
  TokenNotLive: 'The token is not live yet.',
  BalanceUnreadable: 'A balance could not be read, so nothing moved.',
  OwnerUnknown: 'The collection gave no clear owner for this card, so it stays listed.',
  Reentrancy: 'Another call was still running.',
  NotAccepted: 'The shop factory does not take this.',
};

export const CONTRACT_ERRORS: Record<ContractKind, Record<string, string>> = {
  stake: STAKE_ERRORS,
  shop: SHOP_ERRORS,
};

/** The sentence for an error name: the contract's own when the press names its kind, else the shared one. */
export function sentenceOf(name: string, kind?: ContractKind): string | undefined {
  return (kind ? CONTRACT_ERRORS[kind][name] : undefined) ?? ERROR_SENTENCES[name];
}

export interface DecodedError {
  /** The contract's error name, "rejected" when the wallet's owner said no, the page's own refusal, or "unknown". */
  name: string;
  sentence: string;
}

/** A refusal of the page itself (a changed wallet, a moved quote): nothing was sent. */
export class PageRefusal extends Error {
  constructor(
    readonly refusal: string,
    readonly sentence: string,
  ) {
    super(sentence);
  }
}

/**
 * Reads a thrown value into a decoded error name and one sentence; never a raw hex blob. `decimals`: the payout's
 * decimals for an error that carries amounts (BelowMinimum); `kind`: the contract a press calls, for its own sentences.
 */
export function decodeError(e: unknown, decimals = 18, kind?: ContractKind): DecodedError {
  if (e instanceof PageRefusal) return { name: e.refusal, sentence: e.sentence };
  if (e instanceof BaseError) {
    // a page refusal raised inside the wallet call (the last check at the send) arrives wrapped by viem
    const refused = e.walk((x) => x instanceof PageRefusal);
    if (refused instanceof PageRefusal) return { name: refused.refusal, sentence: refused.sentence };
    const rejected = e.walk((x) => x instanceof UserRejectedRequestError);
    if (rejected) return { name: 'rejected', sentence: 'Cancelled in the wallet.' };
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? (reverted.reason ? 'Error' : 'unknown');
      // A contract's own reason text (InvalidConfig(string), require messages) is shown as the contract says it.
      const reason = name === 'InvalidConfig' ? String(reverted.data?.args?.[0] ?? '') : reverted.reason;
      if (name === 'LaunchMismatch') return { name, sentence: ERROR_SENTENCES.LaunchMismatch! };
      if (name === 'BelowMinimum' || name === 'BelowLiquidityFloor') {
        const [a, b] = (reverted.data?.args ?? []) as unknown[];
        if (typeof a === 'bigint' && typeof b === 'bigint') {
          const sentence =
            name === 'BelowMinimum'
              ? `The payout, ${formatAmount(a, decimals)}, fell below your minimum, ${formatAmount(b, decimals)}, so nothing was done.`
              : `Below the Portal’s floor: the pool would hold $${formatAmount(a, 18)}, it needs $${formatAmount(b, 18)}.`;
          return { name, sentence };
        }
      }
      const known = sentenceOf(name, kind);
      if (!known && reason) return { name, sentence: reason.charAt(0).toUpperCase() + reason.slice(1) + '.' };
      return { name, sentence: known ?? 'The contract refused this call.' };
    }
    return { name: 'unknown', sentence: e.shortMessage.replace(/0x[0-9a-fA-F]{16,}/g, '…') };
  }
  const code = (e as { code?: number } | null)?.code;
  if (code === 4001) return { name: 'rejected', sentence: 'Cancelled in the wallet.' };
  return { name: 'unknown', sentence: 'Something went wrong.' };
}
