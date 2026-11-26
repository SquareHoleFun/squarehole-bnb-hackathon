/**
 * F156 (SH-ALPHA-TRADE-BOX): one short line for every reason a trade does not go ahead. The founder's rule is minimal
 * text, so each line says what happened in a few words; the code itself is never shown.
 *
 * The reasons come from five places: the plan (`prepareTradeSepolia`, packages/chain/src/trade-sepolia/trade.ts), the
 * coin calls (`prepareFaucetSepolia`, `preparePairSwapSepolia`, `readCoinStateSepolia`: coins.ts, coin-deployment.ts),
 * the sends' guards (guard.ts, coin-guard.ts, submit.ts), the contracts' reverts as the trade folder decodes them
 * (revert.ts), and the pages themselves (the wallet, a receipt, a balance). trade-words.test.ts reads those sources and
 * fails on a reason without a line here.
 */
import { pAmountV2 } from '../core/v2/stats-v2';
import { tolerancePercent } from './trade-amount';
import { GAS_SYMBOL, NATIVE_SYMBOL } from '../data-source/native-coin';

/**
 * The one line a wallet the faucet does not admit gets (SH-ALPHA-TEST-COINS), and the `not_admitted` revert's. Neutral
 * (XR-ALPHA-SITE af2): a tester who claimed with one wallet and connected another reads it too, so it states the fact
 * and the Claim card above the faucet (ClaimCard.tsx) carries the call to sign in and claim. This constant is the one
 * place to change it.
 */
export const NOT_ON_LIST_LINE = 'This wallet is not on the alpha list.';

/**
 * While a send waits for its signature: a browser wallet's window is open, or the made wallet signs on the press with
 * no window of its own (F161 (4), the wallet context's `confirmsInPage`).
 */
export const confirmLabel = (inPage: boolean): string => (inPage ? 'Signing…' : 'Confirm in your wallet…');

/**
 * SH-ONE-PRESS-TRADE: the one press. A press that needs an approval shows its two steps on one line, each with a small
 * tick (Steps.tsx); a trade that needs none shows only its own button and row.
 */
export const STEP_WORDS = Object.freeze({ approve: 'Approve', buy: 'Buy', sell: 'Sell', swap: 'Swap' });
/** What a screen reader hears for each tick. */
export const STEP_STATES = Object.freeze({ waiting: 'next', active: 'under way', done: 'done', stopped: 'stopped' });
/** The name of the line of ticks. */
export const STEPS_LABEL = 'Progress';
/** The button while a press makes its plan again after the approval, before the trade. */
export const CHECKING_LABEL = 'Checking the price…';
/** Behind Details: what one press does. */
export const ONE_PRESS_NOTE = 'One press: the exact approval first when one is needed, then the trade.';

export const TRADE_LINES: Readonly<Record<string, string>> = Object.freeze({
  // The plan: what the box, the chain or the amount refuses before anything is signed.
  chain_not_allowed: 'No trading on this network.',
  deployment_required: 'Trading is not set up on this chain.',
  rpc_chain_mismatch: 'The site’s chain reader is on another network.',
  block_unavailable: 'The chain could not be read. Try again.',
  invalid_address: 'Connect a wallet first.',
  invalid_side: 'Pick Buy or Sell.',
  invalid_amount: 'Enter an amount.',
  invalid_tolerance: 'Tolerance is 0.1% to 20%.',
  unregistered_box: 'This box is not in the registry.',
  invalid_box_wiring: 'This box’s contracts do not match. No trade.',
  invalid_pool_key: 'This box’s pool does not match. No trade.',
  upcoming: 'Not open yet.',
  curve_closed: 'Full. Trading resumes after graduation.',
  failed: 'Closed. No more trading.',
  unknown_phase: 'Trading is not open.',
  helper_code_missing: 'The pool helper is missing. No trade.',
  helper_code_hash_mismatch: 'The pool helper does not match. No trade.',
  helper_manager_mismatch: 'The pool helper does not match. No trade.',
  invalid_price: 'The pool price is out of range.',
  price_limit_unavailable: 'The price is at the curve’s end.',
  minimum_output_zero: 'Too small to get any coins.',
  pool_simulation_mismatch: 'The pool quote did not check out. Try again.',
  router_simulation_mismatch: 'The router quote did not check out. Try again.',
  invalid_gas_estimate: 'Gas could not be estimated.',
  gas_cap: 'Too much gas for one transaction.',
  // A failure without a known revert (since SH-ONE-PRESS-TRADE a read the RPC did not answer is rpc_failed); shown only
  // once two quotes in a row failed (one-press.ts).
  read_or_simulation_failed: 'Could not get a quote. Try again.',
  // Not a refusal: the plan's next step is an approval (the box's button says so).
  approval_required: 'Approve the exact amount first.',
  // The one press (SH-ONE-PRESS-TRADE): the plan made after the approval left the person's limit (with the tolerance,
  // `lineFor`), had no figure to compare, or still needed an approval.
  price_moved: 'The price moved. Check the new quote.',
  check_quote: 'Approved. Check the quote, then press again.',
  approval_changed: 'The approval changed. Press again.',
  // af1: the trade itself changed after the approval (the launch window ended, so another spender and kind of trade);
  // the chain read after the approval stayed behind it; the page's read of the box was not current again in time.
  trade_changed: 'The trade changed meanwhile. Check the new quote.',
  plan_behind: 'The chain has not caught up yet. Press again.',
  read_not_current: 'The page is reading the box again. Press again.',
  invalid_floor: 'That price limit is not allowed.',
  // The send's guard: checked again right before the wallet, nothing sent.
  unverified_plan: 'Quote expired. Getting a new one.',
  plan_chain_mismatch: 'This quote is for another network.',
  account_mismatch: 'Your wallet account changed.',
  call_not_allowed: 'That call is not allowed.',
  invalid_gas_limit: 'Gas limit refused.',
  stale_read: 'Quote expired. Getting a new one.',
  phase_changed: 'The box moved on. Getting a new quote.',
  trade_already_submitted: 'Already sent once. Check your wallet first.',
  deployment_chain_mismatch: 'This record is for another network.',
  deployment_not_pinned: 'Not the pinned contracts. Nothing was sent.',
  // The test coins (SH-ALPHA-TEST-COINS): the record, the faucet, the pair pools and their guard.
  deployment_predicted: 'Test coins are not live yet.',
  invalid_deployment: 'The test coins’ record does not check out.',
  coin_code_missing: 'The test coin is missing on this chain.',
  coin_code_hash_mismatch: 'The test coin does not match. Nothing was sent.',
  invalid_block: 'The chain could not be read. Try again.',
  not_admitted: NOT_ON_LIST_LINE,
  cooldown_active: 'The next drip is not due yet.',
  daily_cap_reached: 'Today’s faucet cap is used up.',
  // tETH's admitter role (SH-TETH-ADMITTER): only the server's desk key calls it, never this site; lines for completeness.
  not_admitter: 'Only the alpha desk can admit wallets.',
  invalid_admitter_limit: 'That daily limit is not allowed.',
  admitter_daily_cap_reached: 'Today’s admissions are used up. Try tomorrow.',
  pair_not_allowed: 'This pair is not offered.',
  pair_unavailable: 'This pool is not open yet.',
  insufficient_balance: 'Not enough balance.',
  insufficient_allowance: 'The approval is too low. Approve again.',
  coin_already_submitted: 'Already sent once. Check your wallet first.',
  source_unavailable: 'The site’s chain cannot be read here.',
  // The launch router's reverts (window buys).
  not_open: 'Not open yet.',
  window_closed: 'The launch window has closed.',
  expired: 'Too late: the quote expired.',
  wrong_value: `Wrong ${NATIVE_SYMBOL} amount.`,
  insufficient_output: 'Price moved: below your minimum.',
  amount_too_small: 'Amount too small.',
  recipient_refused: 'That recipient is refused.',
  // The pool's reverts (PoolSwapTest and the box's hook, v4's own price limits).
  buy_through_launch_router: 'In the launch window, buys go through the launch router.',
  trading_not_open: 'Trading is not open yet.',
  failure_pending: 'The box is closing. No trades.',
  below_curve_floor: 'That sale goes below the curve’s start.',
  unknown_pool: 'Unknown pool.',
  price_limit_already_exceeded: 'Price already past your limit.',
  price_limit_out_of_bounds: 'Price limit out of range.',
  unknown_revert: 'The trade reverted.',
  // This box: the wallet, the receipt and the balance.
  wallet_rejected: 'Declined in your wallet.',
  wallet_chain: 'Your wallet is on another network.',
  wallet_account: 'Your wallet account changed.',
  wallet_error: 'Your wallet returned an error. Check it before trying again.',
  rpc_failed: 'The chain could not be read. Try again.',
  receipt_timeout: 'Not confirmed yet. Check your wallet.',
  earlier_send: 'An earlier transaction is still under way.',
  asking: 'Confirm or reject it in your wallet.',
  replaced: 'Replaced or cancelled in your wallet.',
  sent_unseen: 'A transaction went out. See your wallet.',
  not_sent: 'Nothing was sent. Try again.',
  balance_low: 'Not enough balance.',
  // F166 af2: the faucet's drip, before the account holds SepETH for its gas.
  gas_coming: `Your starter ${GAS_SYMBOL} is on its way.`,
  gas_funds: `Needs a little ${GAS_SYMBOL} for gas.`,
  // SH-258 round 3: the chain's price itself (BNB Chain testnet), never a lack of funds.
  gas_price_unread: 'No usable gas price from the network; nothing was sent.',
  gas_price_high: 'Gas costs more than this site offers; nothing was sent.',
  gas_price_rose: 'The gas price rose, so nothing was sent; press again.',
  too_precise: 'Too many decimals for this coin.',
  too_large: 'Amount too large.',
  not_a_number: 'Enter a number.',
});

/** The line for `reason`; one generic line for anything unknown (the code is not shown). */
export function tradeLine(reason: string): string {
  return Object.hasOwn(TRADE_LINES, reason) ? (TRADE_LINES[reason] as string) : 'Not possible right now.';
}

/**
 * SH-ONE-PRESS-TRADE item 2: a price that moved past the person's limit, said with their tolerance and what to do. The
 * pool's limit already passed when the trade landed (`price_limit_already_exceeded`), a window buy below its minimum
 * (`insufficient_output`), or a press's plan made after its approval beyond their limit of the quote they saw.
 */
const TOLERANCE_LINES: Readonly<Record<string, string>> = Object.freeze({
  price_limit_already_exceeded: 'Raise it or trade less.',
  insufficient_output: 'Raise it or trade less.',
  price_moved: 'Check the new quote.',
});

/** The line for `reason`, naming the tolerance (in basis points) when the reason is a price past the person's limit. */
export function lineFor(reason: string, toleranceBps: bigint | null): string {
  const next = Object.hasOwn(TOLERANCE_LINES, reason) ? TOLERANCE_LINES[reason] : undefined;
  return next !== undefined && toleranceBps !== null ? `Price moved over your ${tolerancePercent(toleranceBps)} tolerance. ${next}` : tradeLine(reason);
}

/** Phases with no trading: one line each, before any amount is typed. */
export const STAGE_LINES = Object.freeze({
  upcoming: 'Not open yet.',
  closed: 'Full. Trading resumes after graduation.',
  failed: 'Closed. No more trading.',
});

/** Display-only quote: another trade can change both the closing spend and whether this buy fills the raise. */
export function raiseEndLine(spent: bigint, decimals: number, coin: string): string {
  return `Quote: about ${pAmountV2(spent, decimals)} ${coin} fills the raise; the box can graduate.`;
}
/** The remaining partial-fill cause: a pool price limit. */
export const PARTIAL_FILL_WARNING = 'Can fill in part; no deadline.';
export const partialFillLine = (spent: string, offered: string, coin: string): string => `Fills ≈ ${spent} of ${offered} ${coin}`;
