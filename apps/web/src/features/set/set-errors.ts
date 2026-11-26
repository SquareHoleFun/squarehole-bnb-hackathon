/**
 * SH-EXISTING-NFTS-E08C: one plain line for a set action that stopped: the page's own refusal, the wallet's answer,
 * the box's refusal or a read that failed. Never the wallet's or the RPC's own text.
 */
import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError } from 'viem';
import { InsufficientGasFundsError, NotSendableError, WalletContextChangedError, WalletRejectedError, WalletRequestError } from '@squarehole/chain/write';
import { gasFundsLine } from '../tx/gas-words';
import { SetActionError } from './set-actions';
import { SetCallError } from './set-calls';
import { SetIdentityError } from './set-identity';
import { SetQuoteRefused } from './set-conversion';

const reverted = (error: unknown) => error instanceof BaseError && error.walk((cause) => cause instanceof ContractFunctionRevertedError || cause instanceof ExecutionRevertedError) !== null;

export function setErrorText(error: unknown): string {
  if (error instanceof SetActionError || error instanceof SetQuoteRefused) return error.message;
  // The page's own identity check, or the executor's guard re-running it on the same observations: nothing was sent.
  if (error instanceof SetIdentityError || error instanceof NotSendableError || (error instanceof Error && error.message.startsWith('Set identity refused'))) return 'This box could not be checked. Nothing was sent.';
  if (error instanceof SetCallError) return `Not sent: ${error.message}`;
  if (error instanceof WalletRejectedError) return 'Declined in your wallet.';
  if (error instanceof WalletContextChangedError) return error.change === 'chain' ? 'Switch the wallet to this box’s network.' : 'The wallet account changed. Connect it again.';
  if (error instanceof InsufficientGasFundsError) return gasFundsLine(error.chainId);
  if (error instanceof WalletRequestError) return 'The wallet did not send it.';
  if (reverted(error)) return 'The box refused it. Refresh and try again.';
  return 'Nothing confirmed. Try again.';
}
