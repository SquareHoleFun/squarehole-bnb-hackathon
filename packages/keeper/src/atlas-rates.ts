import type { Address } from 'viem';
import { AtlasBook, nativeWeiOf, rpcEndpoints, type AtlasAnswer, type EthCall } from '../../chain/src/atlas/atlas-price';
import { atlasFeeds97, coinFeedOf, coinFeeds97, NATIVE, withPublic97, type CoinFeed } from '../../chain/src/atlas/atlas-feeds';
import { IncomeValuationError } from './income-failure';

/**
 * SH-266: live Atlas prices replace the reviewed rate literal of a MAPPED coin on BNB Chain testnet (97) when the keeper
 * values income in a price coin for its rule "a box's upkeep only when its own income pays for it". The value of a raw
 * amount in tBNB wei is amount * coinUSD / BNBUSD (both Atlas, 18 decimals, one floor division).
 *
 * Fail closed: a mapped coin without a fresh price of its own feed AND of BNB/USD throws VALUATION_UNAVAILABLE, which
 * counts the box's income as zero for this tick, so the box gets no upkeep (an old rate could spend more than the
 * income). An unmapped coin (tGOLD, tPEPE: Atlas has no feed) keeps its reviewed pin and the log says "pinned, no feed".
 * Everything else stays pinned: the coin's address, decimals and code hash, the receipt proofs, the box and platform
 * caps, the daily budgets.
 *
 * Off unless the keeper's process sets a provider (main.ts, chain 97 only): tests and every other chain keep the pins.
 */
export interface LiveQuote { readonly route: string; quote(amount: bigint): bigint }
export interface AtlasRates {
  readonly chainId: string;
  /** null: no feed for this coin (keep the pin). Throws IncomeValuationError when a mapped coin has no fresh price. */
  quoteFor(token: Address): LiveQuote | null;
}

let provider: AtlasRates | null = null;
export const setAtlasRates = (rates: AtlasRates | null) => { provider = rates; };
export const atlasRates = (): AtlasRates | null => provider;

export interface AtlasRatesLog {
  info(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
}

const age = (a: AtlasAnswer, now: bigint) => (a.ok ? (now > a.onchainAt ? now - a.onchainAt : 0n).toString() : null);

/** Quotes from a book of Atlas answers, judged for age at the moment of use. Logs each coin's state when it changes. */
export function bookRates(book: AtlasBook, chainId: string, now: () => bigint, log?: AtlasRatesLog,
  table: readonly CoinFeed[] = coinFeeds97, held: () => string | null = () => null): AtlasRates {
  const said = new Map<string, string>();
  const once = (coin: string, state: string, emit: () => void) => { if (said.get(coin) !== state) { said.set(coin, state); emit(); } };
  return {
    chainId,
    quoteFor(token) {
      const coin = coinFeedOf(token, table);
      if (!coin || coin.token === NATIVE) {
        once(token.toLowerCase(), 'pinned', () => log?.info('atlas: pinned, no feed', { token }));
        return null;
      }
      // The band's references could not be restored or saved: no valuation until they are (never the pin instead).
      const reason = held();
      if (reason) throw new IncomeValuationError('VALUATION_UNAVAILABLE', `atlas prices held: ${reason}`);
      const t = now();
      const native = book.price('BNB/USD', t), price = book.price(coin.feed, t);
      if (!native.ok || !price.ok) {
        const refused = !price.ok ? price : native;
        const why = refused.ok ? 'OK' : refused.refusal;
        once(coin.symbol, `refused:${refused.feed}:${why}`, () => log?.warn('atlas: no fresh price, no upkeep paid by this coin', { coin: coin.symbol, feed: refused.feed, refusal: why }));
        throw new IncomeValuationError('VALUATION_UNAVAILABLE', `atlas price unavailable: ${refused.feed} ${why}`);
      }
      once(coin.symbol, `ok:${price.onchainAt}:${native.onchainAt}`, () => log?.info('atlas: income valued at live prices', {
        coin: coin.symbol, feed: coin.feed, priceUsdX18: price.price.toString(), priceAgeSeconds: age(price, t),
        bnbUsdX18: native.price.toString(), bnbAgeSeconds: age(native, t),
        tbnbWeiPerCoin: nativeWeiOf(10n ** BigInt(coin.decimals), coin.decimals, price, native).toString(), source: 'Atlas',
      }));
      return {
        route: ['atlas', chainId, coin.token, coin.feed, 'BNB/USD'].join(':').toLowerCase(),
        // Checked again at each use: a quote held past either price's age refuses, never the old value.
        quote: amount => {
          const u = now();
          const n = book.price('BNB/USD', u), c = book.price(coin.feed, u);
          if (!n.ok || !c.ok) {
            throw new IncomeValuationError('VALUATION_UNAVAILABLE', `atlas price unavailable: ${!c.ok ? c.feed : n.feed} expired at use`);
          }
          // Computed with the two answers just checked, never with a pair captured earlier.
          return nativeWeiOf(amount, coin.decimals, c, n);
        },
      };
    },
  };
}

/** Public, keyless BNB mainnet endpoints, in order (failover). */
export const DEFAULT_ATLAS_MAINNET_RPC_URLS = Object.freeze(['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com']);

export interface AtlasSettings { readonly enabled: boolean; readonly mainnetRpcUrls: readonly string[] }

/** SH_KEEPER_ATLAS (default 0; 1 is accepted on chain 97 only) and SH_KEEPER_ATLAS_MAINNET_RPC_URLS (comma list, keyless). */
export function atlasSettingsFrom(env: Record<string, string | undefined>, chainId: number): AtlasSettings {
  // Off unless switched on, on every network (SH_KEEPER_ATLAS=1).
  const flag = env.SH_KEEPER_ATLAS ?? '0';
  if (flag !== '0' && flag !== '1') throw new Error('SH_KEEPER_ATLAS must be 0 or 1');
  if (flag === '1' && chainId !== 97) throw new Error('SH_KEEPER_ATLAS: Atlas prices are configured for chain 97 only');
  const urls = (env.SH_KEEPER_ATLAS_MAINNET_RPC_URLS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (const u of urls) {
    const url = new URL(u);
    if (url.protocol !== 'https:' || url.username || url.password || url.search) throw new Error('SH_KEEPER_ATLAS_MAINNET_RPC_URLS: public https endpoints only, no credentials or query');
  }
  return { enabled: flag === '1', mainnetRpcUrls: urls.length > 0 ? urls : DEFAULT_ATLAS_MAINNET_RPC_URLS };
}

/** The live book: BNB/USD on chain 97 through the keeper's own endpoints, the others through BNB mainnet's. */
export function atlasBook(settings: AtlasSettings, chain97Urls: readonly string[], calls?: { main?: EthCall; test?: EthCall }): AtlasBook {
  const main = calls?.main ? [calls.main] : rpcEndpoints(settings.mainnetRpcUrls, { chainId: 56n });
  const test = calls?.test ? [calls.test] : rpcEndpoints(withPublic97(chain97Urls), { chainId: 97n });
  return new AtlasBook(atlasFeeds97, chainId => (chainId === 56n ? main : chainId === 97n ? test : undefined));
}
