/**
 * The v2 box page's words (F99, F100, F103, F104; the founder's minimal-text rule): a failed box pays everyone still
 * holding its token the closing price from its closing pool, and the button is "Close box"; no other word names that
 * payment (v2-wording.test.ts). Numbers first; one short line where a number needs one.
 */
import { V1_FAILED, type FailedWords } from '../../boxes/failed-words';
import type { FailCauseName } from './v2-frozen';

export const CLOSE_BOX = 'Close box';
export const CONFIRM_CLOSE = 'Confirm close';
export const CLOSED = 'Closed';
export const CLOSING_PRICE = 'Closing price';
export const CLOSING_POOL = 'Closing pool';
export const CLONE_LINE = 'Clone, not upgradeable';
export const IMPLEMENTATION_LINK = 'Verified implementation';
export const IMPLEMENTATION_UNCHECKED = 'Implementation not checked';

/** R43-M3D: the coin pile has no rescue, said plainly, in the creation flow and on the box page. */
export const NO_RESCUE_LINE = 'Coins sent to the pile by mistake cannot be recovered.';

/** F112/F113, ADR-0017 A7: the v2 box page's price-step disclosure; v1 keeps its own rules. */
export const PRICE_STEP_LINE = 'Buy-backs and deepening share one step per block, within 49 ticks at the current price.';

/**
 * The failure claim has no window (RC5-A, F136, superseding F127 R40A's year sweep): claims never expire and nothing is
 * swept to FIT. About & risks and the production Terms say the same.
 */
export const CLAIM_WINDOW_LINE = 'Claims do not expire';

/**
 * The closing price's info: paid in the box's pricing token P, named (ETH, LINK, USDC), never in its own token T. The
 * closing pool is divided over the tokens still counted, so money arriving later goes to the claims made after it.
 */
export const closingPriceInfo = (symbol: string): string =>
  `What each token still held is paid in ${symbol}: the closing pool over the tokens still counted. Money arriving later goes to later claims. Claims do not expire.`;

/** The band of a box anyone may close now: why (every swap reverts from here, so no curve figure is shown). */
export const closableFigure = (cause: FailCauseName): string => (cause === 'deadline' ? 'Deadline passed' : cause === 'graduation-timed-out' ? 'Not graduated after 7 days' : 'Not open after 14 days');

/** The phase line of a box anyone may close now (F104: the closer is paid a capped tip from the closing pool). */
export const closableLine = (tip: string | null, symbol: string): string => `Anyone can close it${tip === null ? '' : ` · tip up to ${tip} ${symbol}`}`;

const HOUR = 3_600n;
const DAY = 86_400n;

/** The phase line of a box before its deadline, from the seconds left: whole days, or hours in its last day, rounded up. */
export function endsInLine(left: bigint): string {
  const [size, unit] = left >= DAY ? [DAY, 'd'] : [HOUR, 'h'];
  return `Ends in ${(left + size - 1n) / size} ${unit} if the curve does not fill`;
}

/** The phase line of a closed box: why, and what its closer was paid. */
export const closedLine = (cause: FailCauseName, tip: string | null, symbol: string): string =>
  `${CLOSED} · ${cause === 'deadline' ? 'deadline passed' : cause === 'graduation-timed-out' ? 'graduation timed out' : 'never opened'}${tip === null ? '' : ` · closer’s tip ${tip} ${symbol}`}`;

const V2_FAILED: FailedWords = Object.freeze({ figure: CLOSED, lead: 'Unused ones go back to the creator.', market: 'Open on Uniswap', phone: CLOSING_PRICE });

/** The failed-state words the shared box parts show: a v2 box's, or v1's Demo words (boxes/failed-words.ts). */
export const failedWords = (v2: boolean): FailedWords => (v2 ? V2_FAILED : V1_FAILED);
