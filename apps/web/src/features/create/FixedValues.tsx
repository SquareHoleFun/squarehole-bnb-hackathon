/**
 * Fixed for every box (box creation flow § 2.3): read-only, behind the Box kind step's (i) and in the Overview's
 * closed group. Every figure comes from the version's constants; both sides' 2/15 are paired and locked into the box's
 * own pool (F72 (B), built in core v1: BoxHookExtension's pair kind).
 */
import { CURVE_SHARE_TARGET, CURVE_SPAN_TICKS, FEE_SHARE_DENOMINATOR, FEE_SHARE_DEPTH, FEE_SHARE_FIT, FEE_SHARE_Q_STREAM, ISSUANCE, LP_FEE, TAX_STEP_SECONDS, WINDOW_SECONDS, WINDOW_STEPS } from '@squarehole/box-spec';
import { formatCount } from '../fit-pair/fit-format';

/** "6.4": the launch window in minutes (32 steps of 12 s, WINDOW_SECONDS), from the version's constants. */
export function windowMinutes(): string {
  const seconds = WINDOW_SECONDS;
  const tenths = ((seconds % 60n) * 10n) / 60n;
  return `${seconds / 60n}${tenths === 0n ? '' : `.${tenths}`}`;
}

/** The pool fee in percent from LP_FEE (hundredths of a basis point): 10,000 → "1%". */
export const feePercent = (): string => `${LP_FEE / 10_000}%`;

const share = (n: bigint) => `${n}/${FEE_SHARE_DENOMINATOR}`;

/** "80%": the curve's share of the supply (CURVE_SHARE_TARGET of ISSUANCE). */
export const curveSharePercent = (): string => `${(CURVE_SHARE_TARGET * 100n) / ISSUANCE}%`;
/** "14.7": the curve's price ratio from the first trade to the last (1.0001 per tick over its span; a ratio, not an amount). */
export const curvePriceRatio = (): string => (1.0001 ** CURVE_SPAN_TICKS).toFixed(1);

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
const VULGAR: Readonly<Record<string, string>> = Object.freeze({ '1/2': '½', '1/3': '⅓', '2/3': '⅔', '1/4': '¼', '3/4': '¾', '1/5': '⅕', '2/5': '⅖', '3/5': '⅗', '4/5': '⅘' });

/** A share in its plainest form: 10/15 → "⅔", 5/15 → "⅓" (a reduced fraction where there is no glyph). */
export function plainShare(n: bigint): string {
  const d = gcd(n, FEE_SHARE_DENOMINATOR);
  const reduced = `${n / d}/${FEE_SHARE_DENOMINATOR / d}`;
  return VULGAR[reduced] ?? reduced;
}

/**
 * "1% fee: ⅔ picked · ⅓ fixed": the line the Box kind step leads with, in plain fractions (the 10/15, 3/15 FIT burn and
 * 2/15 pool are behind its (i) and in the Overview's "Fixed for every box"; three words keep the phone's worst Box kind
 * screen at 40).
 */
export const feeSplitLine = (): string => `${feePercent()} fee: ${plainShare(FEE_SHARE_Q_STREAM)} picked · ${plainShare(FEE_SHARE_FIT + FEE_SHARE_DEPTH)} fixed`;

/** How the pool share is added, § 2.3 verbatim (F72 (B) pair and lock). */
export const POOL_DEPTH_LINE = 'Paired and locked: the box adds both sides together and owns the liquidity for good';

/** The Pool row: buyers' and sellers' 2/15 into the box's own pool, then how (§ 2.3; acceptance criterion 11). */
export const poolLine = (): string => `${share(FEE_SHARE_DEPTH)} of buyers’ fees and ${share(FEE_SHARE_DEPTH)} of sellers’ fees into this box’s pool. ${POOL_DEPTH_LINE}`;

export function FixedValues({ ticker, q }: { ticker: string; q: string }) {
  const rows: readonly (readonly [string, string])[] = [
    ['Your share', `${share(FEE_SHARE_Q_STREAM)} of each fee goes where you pick on Box kind`],
    ['Supply', `${formatCount(ISSUANCE / 10n ** 18n)} ${ticker}`],
    ['Fee', `${feePercent()} of every trade, buyers in ${q}, sellers in ${ticker}`],
    ['FIT', `${share(FEE_SHARE_FIT)} of each fee: FIT buy-and-burn`],
    ['Pool', poolLine()],
    ['Launch window', `First ${windowMinutes()} minutes (${WINDOW_STEPS} steps of ${TAX_STEP_SECONDS} s): a falling tax, kept in the box: its pool at graduation, the refunds if it fails`],
    ['Your fees on the curve', 'Held until graduation; into the refunds if the box fails'],
    // F61 L7: the one graduated layout, the same for every box (gradLayout ASK_FULL_BID_SENTINEL; curve CURVE_V1).
    ['Curve, then pool', `${curveSharePercent()} of ${ticker} on the curve, its price ×${curvePriceRatio()} from the first trade to the last; after graduation the pool spreads over all prices`],
  ];
  return (
    <dl className="sh-newbox-fixed">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
