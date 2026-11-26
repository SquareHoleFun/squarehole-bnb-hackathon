import type { Address } from 'viem';
import { ATLAS_BNB_USD_TESTNET, ATLAS_MAINNET_REGISTRY, type AtlasFeed } from './atlas-price';

/**
 * SH-266 and SH-272: the Atlas feeds the BNB build reads, and which coin of BNB Chain testnet (97) each one prices. A
 * tracked settings file, changed by review only; its chain-97 feeds and limits are the deployed source's
 * (packages/contracts/deployments/bnb-testnet/97-atlas.json, AtlasRaiseDeploy.s.sol; a test keeps them equal).
 *
 * Where each feed is (Atlas's open feeds on BNB Chain testnet, given on 25 November 2026, read back on chain the same day):
 * - BNB/USD (feed 633) and ETH/USD (632): Atlas's open SingleFeeds on BNB Chain testnet, which answer any caller, a
 *   contract too. (The first BNB/USD feed there, 0xb3d1614b..., refused contracts and stopped updating that evening.)
 * - NVDAB/USD (feed 934 on mainnet's registry) and XAU/USD: SingleFeeds Atlas deployed on BNB Chain testnet for this
 *   build on 25 November 2026; they answer contracts too. XAU/USD has no published Atlas number: its key is the bytes
 *   "XAU".
 * - USDC/USD (650): a SingleFeed on BNB mainnet only.
 * Freshness: at least three times the largest gap between updates seen in a sample of more than 20 minutes
 * (hackathon/evidence/SH-272.md), the same numbers as the on-chain source's: BNB/USD 190 s and ETH/USD 190 s
 * (updates about every 60 s), NVDAB/USD 910 s and XAU/USD 910 s (about every 300 s); USDC/USD (a heartbeat of one
 * day) a day and an hour. A feed that stops (a market closed for the weekend) simply goes stale: its coin's rows
 * wait, the others go on.
 *
 * THE COINS ARE STAND-INS. tNVDA is tied to NVDAB's price by this file only: it shows the pipeline and its safety
 * rules, not that tNVDA is worth NVDAB. On a main-network deployment the same code points at the real token.
 */
export const BNB_MAINNET_ATLAS_REGISTRY = ATLAS_MAINNET_REGISTRY;
/** Two independent public endpoints of BNB Chain testnet: a price needs two endpoints giving the same answer. */
export const ATLAS_TESTNET_PUBLIC_RPC_URLS: readonly string[] = Object.freeze(['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-testnet-dataseed.bnbchain.org']);
/** The configured endpoints first, then the public ones, each once. */
/** De-duplication by normalised url and the one-vote-per-provider rule happen in rpcEndpoints. */
export const withPublic97 = (urls: readonly string[]): string[] => [...urls, ...ATLAS_TESTNET_PUBLIC_RPC_URLS];
export const ATLAS_NVDAB_USD_TESTNET: Address = '0x3ef39d6361efa1e8ca066751f438077da81082a6';
export const ATLAS_XAU_USD_TESTNET: Address = '0xb3c87f255ce00b2692dc0eaf3e5985fbe2489764';
export const ATLAS_ETH_USD_TESTNET: Address = '0x35369decd8c662954b3d24acc2a862c708a34fd2';
/** The key of XAU/USD in our source and mirror (bytes "XAU"): Atlas has published no number for it. */
export const ATLAS_XAU_KEY = 0x58415500;

export const atlasFeeds97: readonly AtlasFeed[] = Object.freeze([
  Object.freeze({ name: 'BNB/USD', atlasId: 633, source: Object.freeze({ kind: 'single', chainId: 97n, address: ATLAS_BNB_USD_TESTNET }), maxAgeSeconds: 190n }),
  Object.freeze({ name: 'NVDAB/USD', atlasId: 934, source: Object.freeze({ kind: 'single', chainId: 97n, address: ATLAS_NVDAB_USD_TESTNET }), maxAgeSeconds: 910n }),
  Object.freeze({ name: 'XAU/USD', atlasId: ATLAS_XAU_KEY, source: Object.freeze({ kind: 'single', chainId: 97n, address: ATLAS_XAU_USD_TESTNET }), maxAgeSeconds: 910n }),
  Object.freeze({ name: 'ETH/USD', atlasId: 632, source: Object.freeze({ kind: 'single', chainId: 97n, address: ATLAS_ETH_USD_TESTNET }), maxAgeSeconds: 190n }),
  Object.freeze({ name: 'USDC/USD', atlasId: 650, source: Object.freeze({ kind: 'single', chainId: 56n, address: '0x2fd873e39e65b5f7f0e03e5079ecd4da7fc4067b' }), maxAgeSeconds: 90_000n }),
]);

export interface CoinFeed {
  readonly symbol: string;
  /** Lower-case address on chain 97; the zero address is the native coin. */
  readonly token: Address;
  readonly decimals: number;
  readonly feed: string;
  /** What the coin stands in for, said wherever its price is shown. */
  readonly standsInFor: string;
}

export const NATIVE: Address = '0x0000000000000000000000000000000000000000';

/** Chain 97's coins with a feed. tPEPE stays on its reviewed pin (no feed). */
export const coinFeeds97: readonly CoinFeed[] = Object.freeze([
  Object.freeze({ symbol: 'BNB', token: NATIVE, decimals: 18, feed: 'BNB/USD', standsInFor: 'BNB (test network coin)' }),
  Object.freeze({ symbol: 'tNVDA', token: '0x2f8029a6447663e0881b0e21f5e4ad0f1717627e', decimals: 18, feed: 'NVDAB/USD', standsInFor: 'NVDAB, a tokenized NVIDIA stock (a Binance bStock) on BNB mainnet' }),
  Object.freeze({ symbol: 'tGOLD', token: '0x4ba04db6044a6f442bdb29b032cb019f663ab164', decimals: 18, feed: 'XAU/USD', standsInFor: 'gold (XAU, one troy ounce)' }),
  Object.freeze({ symbol: 'tETH', token: '0x860822580d4eb2529de0c74c3e2b1d6d7c183302', decimals: 18, feed: 'ETH/USD', standsInFor: 'ETH' }),
  Object.freeze({ symbol: 'tUSDC', token: '0x25c5789b269d8f76309ce961759d643dce291347', decimals: 6, feed: 'USDC/USD', standsInFor: 'USDC' }),
]);

/** Pinned, no feed: the log says so for these. */
export const pinnedNoFeed97: readonly string[] = Object.freeze(['tPEPE']);

export const coinFeedOf = (token: string, table: readonly CoinFeed[] = coinFeeds97): CoinFeed | undefined =>
  table.find(c => c.token === token.toLowerCase());
