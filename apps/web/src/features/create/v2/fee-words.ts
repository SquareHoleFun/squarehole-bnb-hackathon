/**
 * The words the creation flow and the box page share for the v2.1 choices (SH-V21-FE14): Into the shop's line and the
 * warning the founder accepted (R48B, R48C), and The Alchemist's line and route words. A small module of its own, so
 * the box page does not load the creation flow's steps for them.
 */
import { formatUnits } from '@squarehole/domain';
import type { AlchemistHopV21 } from '../../../../../../packages/chain/src/core/v2';
import { NATIVE_TOKEN, type SiteListing } from './listings';
import { NATIVE_SYMBOL } from '../../data-source/native-coin';

/** The founder's line for Into the shop (R48C, critique 2): what the ceiling does, never framed as profit. */
export const SHOP_FEES_LINE = 'Fees fill the shop up to a ceiling, then go to holders.';
/** The disclosure the founder accepted for every shop with Into the shop (R48B), word for word. */
export const SHOP_FEES_WARNING = 'Whoever picks the collections decides who can sell into a budget the fees pay for.';

/**
 * The Alchemist's one line (step 8): what happens and when, after its route, behind the side's closed Details since
 * SH-ALCHEMIST-LESS-TEXT; the rest is in Fee details.
 */
export const alchemistLine = (pile: string): string => `Fees wait until graduation, then convert into ${pile} along this route.`;
/**
 * SH-251: the line after it (approved by the founder as written, 23 November 2026): a row's route is fixed, so a pool of
 * it that stops working holds the fees in the box. In the same closed Details; nothing is replaced.
 */
export const ALCHEMIST_ROUTE_FIXED = 'This route never changes: if one of its pools stops working after graduation, these fees wait in the box until it works again, or for good if it never does.';
/**
 * G1 (SH-V21-G1-FIX-D, founder pick A): only the module's fixed trigger (`conversionTrigger()`) starts a step until a side
 * has waited seven days without one, then anyone may ("Started by"). The disclosure with the fee rows the creator
 * confirms holds for any trigger: after the fallback anyone may start a step, and a public send (F153) can be seen early.
 * SH-ALCHEMIST-LESS-TEXT: on the Overview it is the last line of the Fees section's Details, before the Terms link.
 */
export const ALCHEMIST_WARNING = 'A trader can move a pool’s price just before any step.';
/**
 * G1-INT, RC5-B: a row's dust size (`dustMax()`, raw price coin), the largest step retained in the box's own pool depth:
 * a step a pool would pay nothing for stays there (P claims for the box's next deepening) only up to it; a larger one
 * refuses and waits, whatever the pool's price.
 */
export const dustText = (amount: string): string => `${amount} or less stays in the box’s pool depth`;
/** An address in short: "0x1F14…4eeE". */
export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
/**
 * A row's fixed trigger (`conversionTrigger()`) by its short address, and when anyone else may start a step. Any address
 * can be a row's trigger (F153: Sepolia's row 4 has the founder's deployer, pressing by hand in public), and the site
 * cannot tell the platform keeper's sending account from another one, nor how it sends; so no word here or on the pile
 * panel names a keeper or a private send (SH-APP8-TRIGGER-WORDS).
 */
export const triggerText = (trigger: string): string => `${shortAddress(trigger)} · anyone after 7 days without a step`;
const KIND_LABEL: Readonly<Record<AlchemistHopV21['kind'], string>> = { 2: 'Uniswap v2', 3: 'Uniswap v3', 4: 'Uniswap v4' };
/** A hop's fee in pips (1,000,000 = 100%) as a percent: 3000 is "0.3%". */
const feePercent = (pips: number): string => `${formatUnits(BigInt(pips), 4)}%`;
/** A coin by its listing's symbol (ETH for the native coin), else its short address. */
export function coinName(token: string, listings: readonly Pick<SiteListing, 'token' | 'symbol'>[]): string {
  if (token.toLowerCase() === NATIVE_TOKEN) return NATIVE_SYMBOL;
  return listings.find((l) => l.token.toLowerCase() === token.toLowerCase())?.symbol ?? shortAddress(token);
}
/** One hop in words: "ETH → WETH · Uniswap v3 · 0.3%". */
export const hopText = (hop: AlchemistHopV21, listings: readonly Pick<SiteListing, 'token' | 'symbol'>[]): string => `${coinName(hop.tokenIn, listings)} → ${coinName(hop.tokenOut, listings)} · ${KIND_LABEL[hop.kind]} · ${feePercent(hop.fee)}`;

/** SH-194: sales pay in T; after graduation the hook sells those fees for P before routing them. */
export const feeInputLine = (side: 'buyers' | 'sellers', ticker: string, price: string): string =>
  side === 'buyers' ? `in ${price}` : `paid in ${ticker}, used as ${price}`;
export const feeLegend = (side: 'buyers' | 'sellers', ticker: string, price: string): string =>
  `${side === 'buyers' ? 'Buyers’' : 'Sellers’'} fees · ${feeInputLine(side, ticker, price)}`;
/** The Burn destination and the in-vault Burn rule both buy the box token first. */
export const buyBackBurnLabel = (ticker: string): string => `Buy back and burn ${ticker}`;
/** A payout in T is distinct from the token the seller paid as fees. */
export const feeClaimLine = (items: boolean, ticker: string): string => `${items ? 'items' : 'holders'} claim ${ticker}`;
