/**
 * One chain session: config, client, typed reader, log indexer, USD policy and an injected clock. The providers share
 * it, so a feed snapshot, a pair detail and an account read use the same index and caches.
 */
import { formatIsoUtc } from '@squarehole/domain';
import { createChainClient, createChainIdGuard, type ChainClientOptions, type ChainPublicClient } from '../client';
import type { ChainConfig } from '../config/config';
import type { DeploymentManifest } from '../config/manifest';
import { ChainNotDeployedError } from '../errors';
import { LogIndexer, type LogIndexerOptions } from '../indexer/indexer';
import type { IndexStore } from '../indexer/store';
import { ChainReader } from '../reads/reader';
import { NO_USD_PRICE_POLICY, type UsdPricePolicy } from './usd';

export interface ChainContextOptions extends ChainClientOptions {
  readonly store?: IndexStore;
  readonly indexer?: Omit<LogIndexerOptions, 'store'>;
  readonly usd?: UsdPricePolicy;
  /** Wall clock in epoch milliseconds (staleness and quote deadlines). Injected; defaults to Date.now. */
  readonly now?: () => number;
  /** Reuse a feed snapshot for this long before reading the chain again (default 4 s). */
  readonly snapshotReuseMs?: number;
  /** Quote validity window for R = T conversion estimates (default 20 minutes, like the mock). */
  readonly quoteTtlMs?: number;
}

export interface ChainContext {
  readonly config: ChainConfig;
  readonly manifest: DeploymentManifest;
  readonly client: ChainPublicClient;
  readonly reader: ChainReader;
  readonly indexer: LogIndexer;
  readonly usd: UsdPricePolicy;
  readonly now: () => number;
  readonly snapshotReuseMs: number;
  readonly quoteTtlMs: number;
  readonly ensureChain: () => Promise<void>;
  /** Short source label for provenance. */
  readonly sourceLabel: string;
}

export function createChainContext(config: ChainConfig, options: ChainContextOptions = {}): ChainContext {
  if (config.deployment.status !== 'deployed') throw new ChainNotDeployedError(config.chainId, config.deployment.reason);
  const manifest = config.deployment.manifest;
  const client = createChainClient(config, options);
  const reader = new ChainReader(config, client);
  const indexer = new LogIndexer(config, client, reader, { ...options.indexer, store: options.store });
  return Object.freeze({
    config,
    manifest,
    client,
    reader,
    indexer,
    usd: options.usd ?? NO_USD_PRICE_POLICY,
    now: options.now ?? (() => Date.now()),
    snapshotReuseMs: options.snapshotReuseMs ?? 4_000,
    quoteTtlMs: options.quoteTtlMs ?? 20 * 60_000,
    ensureChain: createChainIdGuard(client, config.chainId),
    sourceLabel: `Square Hole chain reads (${config.label}, registry ${manifest.contracts.registry.address})`,
  });
}

/** Block timestamp (seconds) → the domain's ISO form. */
export function isoFromSeconds(seconds: bigint): string {
  return formatIsoUtc(Number(seconds) * 1000);
}
