/**
 * SH-SEND-FEES: a send the wallet cannot pay (the executor's balance check, before the wallet is asked) says the plain
 * gas line on every page that sends (trades: trade-sepolia/gas-funds.test.ts), never the generic wallet error
 * ("The wallet did not send this step.").
 */
import { describe, expect, it } from 'vitest';
import { InsufficientGasFundsError, WalletRequestError } from '@squarehole/chain/write';
import { box0ErrorText } from '../core/box0/box0-send';
import { shopErrorText } from '../core/v2/shop-actions';
import { vaultErrorText } from '../core/v2/vault-items';
import { sendFailureText } from '../create/v2/useCreateSend';
import { setFailureText } from '../create/set/useSetCreate';
import { setErrorText } from '../set/set-errors';
import { GAS_WORDS, gasFundsLine } from './gas-words';

const SEPOLIA = 11_155_111;
const short = new InsufficientGasFundsError(13_400_000n * 11_000_000n, 10n ** 15n / 1_000n, SEPOLIA);

describe('SH-SEND-FEES gas line', () => {
  it('names SepETH on Sepolia and ETH elsewhere', () => {
    expect(GAS_WORDS.sepolia).toBe('Needs a little more SepETH for gas.');
    expect(gasFundsLine(SEPOLIA)).toBe(GAS_WORDS.sepolia);
    expect(gasFundsLine(31_337)).toBe(GAS_WORDS.other);
    expect(gasFundsLine(1)).toBe('Needs a little more ETH for gas.');
  });

  it('every send page shows it for the funds check, and keeps its own line for other wallet errors', () => {
    expect(sendFailureText(short, SEPOLIA)).toBe(GAS_WORDS.sepolia);
    expect(sendFailureText(new WalletRequestError('x'), SEPOLIA)).toBe('The wallet did not send this step.');
    expect(setFailureText(short, SEPOLIA)).toBe(GAS_WORDS.sepolia);
    expect(setErrorText(short)).toBe(GAS_WORDS.sepolia);
    expect(box0ErrorText(short)).toBe(GAS_WORDS.sepolia);
    expect(shopErrorText(short, 'give')).toBe(GAS_WORDS.sepolia);
    expect(vaultErrorText(short)).toBe(GAS_WORDS.sepolia);
    expect(gasFundsLine(new InsufficientGasFundsError(2n, 1n, 31_337).chainId)).toBe(GAS_WORDS.other);
  });
});
