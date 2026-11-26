/**
 * USD valuation policy (03-FEED: "Use a defined independent USD source, timestamp, deviation/staleness flags, and
 * coverage"). ADR-0012 adopts NO testnet USD source: test tokens have no market value, a stablecoin is not silently
 * $1, and cross-asset USD sorting treats every chain pair as unpriced. The interface exists so a later ADR can plug in
 * a disclosed source; until then every USD field is null with the reason below.
 */
import type { AssetIdentity, DecimalAmount } from '@squarehole/domain';

export interface UsdQuote {
  /** USD per ONE display unit of the asset. */
  readonly usdPerUnit: DecimalAmount;
  /** Named, disclosed source (shown with every USD value). */
  readonly source: string;
  readonly asOf: string;
}

export interface UsdPricePolicy {
  readonly id: string;
  /** User-facing statement of where USD values come from (or why there are none). */
  readonly disclosure: string;
  quote(asset: AssetIdentity, blockTimestamp: bigint, signal?: AbortSignal): Promise<UsdQuote | null>;
}

export const NO_USD_REASON = 'No USD source is adopted for test chains (ADR-0012): USD values are unavailable, never assumed.';

export const NO_USD_PRICE_POLICY: UsdPricePolicy = Object.freeze({
  id: 'none',
  disclosure: NO_USD_REASON,
  async quote(): Promise<UsdQuote | null> {
    return null;
  },
});
