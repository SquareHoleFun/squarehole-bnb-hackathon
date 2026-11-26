/**
 * SH-EXISTING-NFTS-E08C: picks and returns as E-08B prepares them (`prepareSetConversion`, packages/chain/src/core/
 * set-v2/tx/quotes.ts, tested in its quotes.test.ts and transactions.test.ts): T's supply, the vault's escrow and items
 * inside, and the vault's own quoteWithdraw / quoteReturn, all at one numbered block; E-08A's full-precision quote
 * checked against the vault's principal; the fee-inclusive limit (LIMIT_BPS, 1%, the v2 vault's rule) and the deadline
 * from that block's time (DEADLINE_SECONDS, 20 minutes; never this computer's clock); the block's hash read again after
 * the reads; and the exact approvals and call, each through E-08B's guard. The page shows the quote and its limit; an
 * action prepares again right before it sends and refuses when the limit moved past the one shown.
 */
import type { Address } from 'viem';
import { SetQuoteError, type SetQuoteRefusal } from '@squarehole/box-spec';
import { prepareSetConversion } from '@squarehole/chain/write';
import { DEADLINE_SECONDS, LIMIT_BPS } from '../core/v2/vault-items';
import { setTargetV2Of } from './set-calls';
import type { SetBoxIdentity } from './set-identity';
import type { SetReads } from './set-reads';

export { DEADLINE_SECONDS, LIMIT_BPS };

export type SetConversionKind = 'pick' | 'return';
export type SetConversion = Awaited<ReturnType<typeof prepareSetConversion>>;

/** One short line per refusal, in the page's words. */
export const REFUSAL_WORDS: Readonly<Record<SetQuoteRefusal | 'differs', string>> = /* @__PURE__ */ Object.freeze({
  uint256: 'Not available.',
  snapshot: 'Not available.',
  quantity: 'Too many items for one transaction.',
  'last item': 'The last item stays in the box.',
  'fee preset': 'Not available.',
  'below unit': 'Too small to quote.',
  escrow: 'Not enough held for that return.',
  'supply floor': 'Not enough coins in circulation for that.',
  slippage: 'Not available.',
  deadline: 'Not available.',
  differs: 'The price changed. Refresh and try again.',
});

/** Why no quote: E-08A's refusal, the vault's own figure differing at the block, or the block replaced under the reads. */
export class SetQuoteRefused extends Error {
  override readonly name = 'SetQuoteRefused';
  constructor(readonly reason: SetQuoteRefusal | 'differs') {
    super(REFUSAL_WORDS[reason]);
  }
}

/** The T a prepared pick pulls (its quote's tokenIn) or a prepared return pays (its tokenOut), before the 1% limit. */
export const amountOf = (prepared: SetConversion): bigint => ('tokenIn' in prepared.quote ? prepared.quote.tokenIn : prepared.quote.tokenOut);

/** A quote depends on how many items, never on which: the page's one-item figures name item 0 (prepared, never sent). */
export const ONE_ITEM: readonly bigint[] = /* @__PURE__ */ Object.freeze([0n]);

/**
 * E-08B's prepared pick or return of `ids` for `from` (any address may ask for a figure: the quote does not depend on
 * who asks; an action passes the connected account). E-08A's refusals and E-08B's two price checks come back as
 * SetQuoteRefused; anything else (the chain not answering, another chain) is thrown as it is.
 */
export async function prepareConversion(reads: SetReads, box: SetBoxIdentity, from: Address, kind: SetConversionKind, ids: readonly bigint[]): Promise<SetConversion> {
  try {
    return await prepareSetConversion(reads.chain, setTargetV2Of({ kind: 'box', identity: box }), from, kind, ids, LIMIT_BPS, DEADLINE_SECONDS);
  } catch (error) {
    if (error instanceof SetQuoteError) throw new SetQuoteRefused(error.reason);
    if (error instanceof Error && (error.message === 'set quote differential mismatch' || error.message === 'quote block changed')) throw new SetQuoteRefused('differs');
    throw error;
  }
}

/** The line a quote that could not be prepared shows: the refusal in the page's words, else "Not available." */
export const quoteErrorText = (error: unknown): string => (error instanceof SetQuoteRefused ? error.message : 'Not available.');
