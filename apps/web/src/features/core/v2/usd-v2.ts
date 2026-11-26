/**
 * SH-266: dollar values on the box page, from the indexer's `prices` block (Atlas prices read by the indexer; the
 * browser never talks to a price source). A figure is shown only for a coin with a price no older than the block's
 * own limit at the page's clock; otherwise nothing, and the coin amounts stand alone as before. The source and the age
 * wait behind a closed (i).
 */
export interface UsdPriceV2 {
  readonly role: 'price' | 'pile';
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly feed: string;
  readonly standsInFor: string;
  readonly usdX18: bigint;
  readonly onchainAt: bigint;
  /** The coin's own age limit, as the indexer names it (required: a coin without a well-formed one is dropped). */
  readonly maxAgeSeconds: bigint;
}
export interface UsdPricesV2 { readonly maxAgeSeconds: bigint; readonly coins: readonly UsdPriceV2[] }

const RAW = /^(0|[1-9][0-9]{0,77})$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const text = (v: unknown, max = 120): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[<>]/.test(v);

/** `prices` as the indexer may publish it. Optional and only a hint: anything malformed is dropped, never an error. */
export function usdPricesOf(input: unknown): UsdPricesV2 | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const p = input as { source?: unknown; maxAgeSeconds?: unknown; coins?: unknown };
  if (p.source !== 'Atlas' || typeof p.maxAgeSeconds !== 'string' || !RAW.test(p.maxAgeSeconds) || !Array.isArray(p.coins)) return undefined;
  const coins: UsdPriceV2[] = [];
  for (const c of p.coins.slice(0, 4) as unknown[]) {
    if (c === null || typeof c !== 'object') continue;
    const x = c as Record<string, unknown>;
    if ((x.role !== 'price' && x.role !== 'pile') || typeof x.token !== 'string' || !ADDRESS.test(x.token) || !text(x.symbol, 32) || !text(x.feed, 32)
      || !text(x.standsInFor) || typeof x.decimals !== 'number' || !Number.isInteger(x.decimals) || x.decimals < 0 || x.decimals > 36
      || typeof x.usdX18 !== 'string' || !RAW.test(x.usdX18) || x.usdX18 === '0' || typeof x.onchainAt !== 'string' || !RAW.test(x.onchainAt)
      || typeof x.maxAgeSeconds !== 'string' || !RAW.test(x.maxAgeSeconds) || x.maxAgeSeconds === '0') continue;
    coins.push({ role: x.role, token: x.token.toLowerCase(), symbol: x.symbol, decimals: x.decimals, feed: x.feed, standsInFor: x.standsInFor,
      usdX18: BigInt(x.usdX18), onchainAt: BigInt(x.onchainAt), maxAgeSeconds: BigInt(x.maxAgeSeconds) });
  }
  return coins.length ? { maxAgeSeconds: BigInt(p.maxAgeSeconds), coins } : undefined;
}

/** The coin's price if it is fresh at `nowSec`. */
export function usdPriceFor(prices: UsdPricesV2 | undefined, token: string | undefined | null, nowSec: bigint): UsdPriceV2 | null {
  if (!prices || !token) return null;
  const c = prices.coins.find((x) => x.token === token.toLowerCase());
  if (!c) return null;
  // Each coin's own limit only: never the block's (the largest of its coins').
  return c.onchainAt > nowSec || nowSec - c.onchainAt > c.maxAgeSeconds ? null : c;
}

/** "about $1,234.56", "about $0.42" or "under $0.01". Bigint only; rounded down to the cent. */
export function usdText(raw: bigint, decimals: number, price: UsdPriceV2): string {
  const cents = raw * price.usdX18 / 10n ** BigInt(decimals) / 10n ** 16n;
  if (cents === 0n) return raw === 0n ? '$0' : 'under $0.01';
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `about $${dollars}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** Behind the (i): the source, the feed and the age, and what the test coin stands in for. */
export function usdNote(price: UsdPriceV2, nowSec: bigint): string {
  const age = nowSec > price.onchainAt ? nowSec - price.onchainAt : 0n;
  const standIn = price.symbol === 'BNB' ? '' : ` ${price.symbol} is a test coin priced as ${price.standsInFor}.`;
  return `Price from Atlas (${price.feed}), ${age} s old.${standIn}`;
}
