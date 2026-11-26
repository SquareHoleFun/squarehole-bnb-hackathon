import { AtlasBook, rpcEndpoints, type AtlasPrice } from '../../../chain/src/atlas/atlas-price';
import { atlasFeeds97, coinFeedOf, coinFeeds97, withPublic97, type CoinFeed } from '../../../chain/src/atlas/atlas-feeds';
import { pileConfigV2 } from '../../../chain/src/core/v2/m3-spec-v2';

/**
 * SH-266: Atlas prices for the box page, read by the indexer (the browser never talks to a price source). A box view
 * gets `prices`: its price coin's and its pile coin's USD price with Atlas's two times and the price's age at the
 * view's moment, for each coin of BNB Chain testnet (97) that has a feed in the tracked table, and only while the price
 * is fresh (each feed's own limit: three of its heartbeats). No fresh price: no entry, and the page shows coin amounts only.
 */
export interface BoxPriceV2 {
  readonly role: 'price' | 'pile';
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly feed: string;
  readonly atlasId: number;
  readonly standsInFor: string;
  readonly usdX18: string;
  readonly aggregatedAt: string;
  readonly onchainAt: string;
  readonly ageSeconds: string;
  /** This feed's own age limit (seconds): past it, no dollar figure. */
  readonly maxAgeSeconds: string;
}
export interface BoxPricesV2 { readonly source: 'Atlas'; readonly maxAgeSeconds: string; readonly coins: readonly BoxPriceV2[] }


interface ViewShape {
  readonly row: { readonly record?: { readonly q?: string } | null; readonly spec?: { readonly boxType?: number; readonly contentsParams?: string } | null };
  readonly m3?: { readonly pile?: { readonly asset?: string } | null } | null;
}

export class BoxPrices {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly book: AtlasBook, private readonly now: () => bigint = () => BigInt(Math.floor(Date.now() / 1000)),
    private readonly table: readonly CoinFeed[] = coinFeeds97) {}

  refresh(): Promise<unknown> { return this.book.refresh(this.now()); }

  /** Reads at once, then every `everyMs` (at least the book's own 15 s throttle applies). */
  start(everyMs = 15_000): void {
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, everyMs);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** The block for one box view; null when no coin of the box has a fresh price. */
  of(view: ViewShape): BoxPricesV2 | null {
    const t = this.now();
    const coins: BoxPriceV2[] = [];
    const add = (role: 'price' | 'pile', token: string | undefined) => {
      if (!token || coins.some(c => c.token === token.toLowerCase())) return;
      const coin = coinFeedOf(token, this.table);
      if (!coin) return;
      const a = this.book.price(coin.feed, t);
      const feed = this.book.feeds.find(f => f.name === coin.feed);
      if (!a.ok || !feed) return;
      coins.push(entry(role, coin, a, t, feed.maxAgeSeconds));
    };
    add('price', view.row.record?.q);
    let pile = view.m3?.pile?.asset;
    if (!pile && view.row.spec?.boxType === 5 && view.row.spec.contentsParams) {
      try { pile = pileConfigV2(view.row.spec.contentsParams as `0x${string}`).asset; } catch { pile = undefined; }
    }
    add('pile', pile);
    // The block's limit is the largest of its coins'; each coin carries its own.
    const limit = coins.reduce((m, c) => (BigInt(c.maxAgeSeconds) > m ? BigInt(c.maxAgeSeconds) : m), 0n);
    return coins.length ? { source: 'Atlas', maxAgeSeconds: limit.toString(), coins } : null;
  }
}

const entry = (role: 'price' | 'pile', coin: CoinFeed, a: AtlasPrice, t: bigint, maxAge: bigint): BoxPriceV2 => ({
  role, token: coin.token.toLowerCase(), symbol: coin.symbol, decimals: coin.decimals, feed: a.feed, atlasId: a.atlasId,
  standsInFor: coin.standsInFor, usdX18: a.price.toString(), aggregatedAt: a.aggregatedAt.toString(), onchainAt: a.onchainAt.toString(),
  ageSeconds: (t > a.onchainAt ? t - a.onchainAt : 0n).toString(), maxAgeSeconds: maxAge.toString(),
});

/** Public, keyless BNB mainnet endpoints, in order (failover). */
export const DEFAULT_ATLAS_MAINNET_RPC_URLS: readonly string[] = Object.freeze(['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com']);

/**
 * SH_CORE_ATLAS (default 0; 1 is accepted on chain 97 only) and SH_CORE_ATLAS_MAINNET_RPC_URLS (public https only).
 * BNB/USD is read on chain 97 through the indexer's own endpoints (SH_CORE_HTTP_URLS).
 */
export function boxPricesFrom(env: Record<string, string | undefined>, chainId: number, chain97Urls: readonly string[]): BoxPrices | null {
  // Off unless switched on, on every network (SH_CORE_ATLAS=1).
  const flag = env.SH_CORE_ATLAS ?? '0';
  if (flag !== '0' && flag !== '1') throw new Error('SH_CORE_ATLAS must be 0 or 1');
  if (flag === '0') return null;
  if (chainId !== 97) throw new Error('SH_CORE_ATLAS: Atlas prices are configured for chain 97 only');
  const urls = (env.SH_CORE_ATLAS_MAINNET_RPC_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (const u of urls) {
    const url = new URL(u);
    if (url.protocol !== 'https:' || url.username || url.password || url.search) throw new Error('SH_CORE_ATLAS_MAINNET_RPC_URLS: public https endpoints only');
  }
  const main = rpcEndpoints(urls.length ? urls : DEFAULT_ATLAS_MAINNET_RPC_URLS, { chainId: 56n });
  const test = rpcEndpoints(withPublic97(chain97Urls), { chainId: 97n });
  return new BoxPrices(new AtlasBook(atlasFeeds97, c => (c === 56n ? main : c === 97n ? test : undefined)));
}

