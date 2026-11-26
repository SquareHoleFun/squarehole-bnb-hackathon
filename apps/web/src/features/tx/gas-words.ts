/**
 * SH-SEND-FEES: the line a step shows when the wallet cannot pay a send's gas. The executor checks the balance against
 * gasLimit × maxFeePerGas + value before the wallet is asked (`InsufficientGasFundsError`); nothing was sent. Minimal
 * text (the founder's rule); the founder edits the words here.
 *
 * SH-258: `sepolia` is the build's test network; on BNB Chain testnet the coin is the wallet's tBNB.
 */
import { TESTNET } from '@squarehole/chain/write/wallet';
import { GAS_SYMBOL } from '../data-source/native-coin';

const TESTNET_CHAIN_ID = TESTNET.chainId;
const GAS_COIN = GAS_SYMBOL;

export const GAS_WORDS = Object.freeze({
  sepolia: `Needs a little more ${GAS_COIN} for gas.`,
  other: 'Needs a little more ETH for gas.',
  /** The v1 flow: the fee read at the press is above the one shown; the new fee is shown, nothing was sent. */
  feeRose: 'The network fee went up. Check it and confirm again.',
});

/** The line for a send the wallet cannot pay, by the chain it was for. */
export const gasFundsLine = (chainId: number): string => (chainId === TESTNET_CHAIN_ID ? GAS_WORDS.sepolia : GAS_WORDS.other);
