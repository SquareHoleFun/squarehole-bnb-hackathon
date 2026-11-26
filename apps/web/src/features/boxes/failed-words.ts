/**
 * The failed-state words of the shared box parts (the card's figure, "What's in the box?", the Market counter, the
 * phone bar). A v2 box takes its own from core/v2/v2-words.ts (F99, F100: never "refund"); these are v1's Demo words,
 * kept until the integrator renames them site-wide together with the tests that pin them (SH-V2-M1-53B.md, change
 * requests).
 */
export interface FailedWords {
  /** The card's and the Token tab's one figure. */
  readonly figure: string;
  /** "What's in the box?" after the items count. */
  readonly lead: string;
  /** The Market counter's link out. */
  readonly market: string;
  /** The phone bar's note before the market's reason. */
  readonly phone: string;
}

export const V1_FAILED: FailedWords = Object.freeze({ figure: 'Refunds open', lead: 'Refunds open.', market: 'Refund on Uniswap', phone: 'Refund' });
