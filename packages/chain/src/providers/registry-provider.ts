/**
 * `AssetRegistryProvider` over the on-chain SquareHoleRegistry (G06 identity rule: exact chain + address, never a
 * symbol). A quote is admitted exactly when the registry has an ACTIVE latest template for it
 * (`latestTemplateFor(quote)`); the admission is `supported_demo` on the local demo chain and `supported_testnet` on
 * Sepolia (ADR-0012) — neither is a production G06 admission. Unknown addresses return null and never become approved.
 */
import {
  canonicalAddress,
  isChainId,
  IdentityError,
  sameAddress,
  validateAssetRegistry,
  type Address,
  type AssetRegistryEntry,
  type AssetRegistryProvider,
} from '@squarehole/domain';
import { getAddress } from 'viem';
import { LOCAL_CHAIN_ID } from '../config/chains';
import { throwIfAborted } from '../errors';
import type { TemplateState } from '../reads/reader';
import { isoFromSeconds, type ChainContext } from './context';
import { classifyQuote } from './model';
import { quoteIdentity } from './snapshot';

export interface ChainAssetRegistryProvider extends AssetRegistryProvider {
  readonly chainId: number;
  /** Active templates of the registry at the newest block (version, bounds; e.g. `maxCollectionUnits` for the wizard). */
  listTemplates(signal?: AbortSignal): Promise<readonly TemplateState[]>;
}

export function createChainAssetRegistryProvider(ctx: ChainContext): ChainAssetRegistryProvider {
  async function read(signal?: AbortSignal): Promise<{ entries: AssetRegistryEntry[]; templates: TemplateState[] }> {
    throwIfAborted(signal);
    await ctx.ensureChain();
    const block = await ctx.reader.block('latest');
    const templates = await ctx.reader.templates(block.number);
    throwIfAborted(signal);
    const admitted = templates.filter((template) => template.active && template.isLatestForQuote);
    const provenance = {
      state: 'fresh' as const,
      asOf: isoFromSeconds(block.timestamp),
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      source: `${ctx.sourceLabel}; registry templates`,
      coverage: 'canonical_markets' as const,
    };
    const entries: AssetRegistryEntry[] = [];
    for (const template of admitted) {
      const meta = await ctx.reader.assetMeta(template.quote, block.number);
      const quoteClass = classifyQuote(ctx.manifest, template.quote);
      entries.push({
        asset: quoteIdentity(ctx, meta),
        ...(quoteClass.family ? { issuerFamily: quoteClass.family } : {}),
        admission: ctx.config.chainId === LOCAL_CHAIN_ID ? 'supported_demo' : 'supported_testnet',
        provenance,
      });
    }
    entries.sort((a, b) => (a.asset.symbol === b.asset.symbol ? (a.asset.address.toLowerCase() < b.asset.address.toLowerCase() ? -1 : 1) : a.asset.symbol < b.asset.symbol ? -1 : 1));
    return { entries: validateAssetRegistry(entries), templates };
  }

  return {
    chainId: ctx.config.chainId,

    async listSupportedQuotes(chainId: number, signal?: AbortSignal): Promise<AssetRegistryEntry[]> {
      if (!isChainId(chainId)) throw new IdentityError('malformed_chain_id', 'Chain id must be a positive safe integer');
      if (chainId !== ctx.config.chainId) return [];
      return (await read(signal)).entries;
    },

    async readAsset(chainId: number, address: Address, signal?: AbortSignal): Promise<AssetRegistryEntry | null> {
      if (!isChainId(chainId)) throw new IdentityError('malformed_chain_id', 'Chain id must be a positive safe integer');
      const wanted = canonicalAddress(address);
      if (chainId !== ctx.config.chainId) return null;
      const { entries } = await read(signal);
      return entries.find((entry) => sameAddress(entry.asset.address, wanted)) ?? null;
    },

    async listTemplates(signal?: AbortSignal): Promise<readonly TemplateState[]> {
      const { templates } = await read(signal);
      return templates.filter((template) => template.active).map((template) => ({ ...template, quote: getAddress(template.quote) }));
    },
  };
}
