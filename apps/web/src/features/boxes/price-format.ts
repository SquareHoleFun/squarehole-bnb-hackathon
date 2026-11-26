/**
 * How the price picture's amounts are written (F49 M1). A charge is never understated and a release never overstated:
 * what taking one out costs is rounded UP to whole tokens, what putting one back releases is rounded DOWN. The ETH price
 * is written per 1M tokens, 5 significant digits, truncated.
 */
import { formatCount, shiftDecimal, significant } from '../fit-pair/fit-format';

const WHOLE = 10n ** 18n;

/** "237,818": a cost in whole tokens, rounded up (237,817.24 FIT is charged as at most 237,818). */
export const costTokens = (raw: bigint): string => formatCount((raw + WHOLE - 1n) / WHOLE);

/** "237,817": a release in whole tokens, rounded down. */
export const releaseTokens = (raw: bigint): string => formatCount(raw / WHOLE);

/** ETH per 1M tokens from ETH per token (the page's one price unit), 5 significant digits, truncated. */
export const perMillion = (priceEthPerToken: string): string => significant(shiftDecimal(priceEthPerToken, 6), 5);
