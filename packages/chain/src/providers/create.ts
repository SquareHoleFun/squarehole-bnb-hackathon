/**
 * Entry point for the app: providers for one configured chain, or an honest `not_deployed` state (no providers, so
 * nothing can render an empty feed as if the chain had no launches).
 */
import type { ChainConfig } from '../config/config';
import type { LogIndexer } from '../indexer/indexer';
import { createChainAccountProvider, type ChainAccountProvider } from './account-provider';
import { createChainContext, type ChainContext, type ChainContextOptions } from './context';
import { createChainFeedProvider, type ChainFeedProvider } from './feed-provider';
import { createChainAssetRegistryProvider, type ChainAssetRegistryProvider } from './registry-provider';

export type ChainProviders =
  | {
      readonly status: 'deployed';
      readonly chainId: number;
      readonly config: ChainConfig;
      readonly context: ChainContext;
      readonly feed: ChainFeedProvider;
      readonly accounts: ChainAccountProvider;
      readonly registry: ChainAssetRegistryProvider;
      readonly indexer: LogIndexer;
    }
  | { readonly status: 'not_deployed'; readonly chainId: number; readonly config: ChainConfig; readonly reason: string };

export function createChainProviders(config: ChainConfig, options: ChainContextOptions = {}): ChainProviders {
  if (config.deployment.status !== 'deployed') {
    return Object.freeze({ status: 'not_deployed', chainId: config.chainId, config, reason: config.deployment.reason });
  }
  const context = createChainContext(config, options);
  return Object.freeze({
    status: 'deployed',
    chainId: config.chainId,
    config,
    context,
    feed: createChainFeedProvider(context),
    accounts: createChainAccountProvider(context),
    registry: createChainAssetRegistryProvider(context),
    indexer: context.indexer,
  });
}
