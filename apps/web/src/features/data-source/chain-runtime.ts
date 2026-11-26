/**
 * The chain half of a chain data source (SH-C, ADR-0012 Part C). Loaded with `import()` only when the person chose the
 * local chain or Sepolia, so demo visitors never download viem, the ABIs or the providers.
 *
 * One manifest, parsed once by the chain package's single parser, feeds both sides:
 * - reads: `createChainConfig` + `createChainProviders` (FeedProvider, AccountProvider, AssetRegistryProvider over RPC);
 * - writes: the writers' projection of the same manifest, the write-chain policy, and an RPC reader on the app's own
 *   endpoint (never the wallet's).
 * A manifest the parser rejects, or a chain without one, is an error here: the pages then show "unavailable", never an
 * empty chain.
 */
import { createChainConfig, createChainProviders, type ChainConfig, type ChainProviders, type DeploymentManifest } from '@squarehole/chain';
import { createChainReader, createHttpRequest, writeChain, writeDeploymentOf, type ChainReader, type WriteChain, type WriteDeployment } from '@squarehole/chain/write';

export type DeployedProviders = Extract<ChainProviders, { status: 'deployed' }>;

export interface ChainRuntimeInput {
  readonly chainId: number;
  readonly manifest: unknown;
  /** Replaces the chain's default RPC list (the local chain's URL from the build; Sepolia uses the keyless list). */
  readonly rpcUrls?: readonly string[];
}

export interface ChainRuntime {
  readonly chainId: number;
  readonly config: ChainConfig;
  readonly manifest: DeploymentManifest;
  readonly providers: DeployedProviders;
  /** What the chain transaction flow needs (see features/tx/chain-requests.ts). */
  readonly write: {
    readonly writeChain: WriteChain;
    readonly deployment: WriteDeployment;
    readonly reader: ChainReader;
  };
}

export function createChainRuntime(input: ChainRuntimeInput): ChainRuntime {
  const config = createChainConfig({ chainId: input.chainId, manifest: input.manifest, rpcUrls: input.rpcUrls });
  const providers = createChainProviders(config);
  if (providers.status !== 'deployed') throw new Error(providers.reason);
  const manifest = providers.context.manifest;
  const [rpcUrl] = config.rpcUrls;
  if (rpcUrl === undefined) throw new Error('The chain configuration has no RPC URL');
  return Object.freeze({
    chainId: config.chainId,
    config,
    manifest,
    providers,
    write: Object.freeze({
      writeChain: writeChain(config.chainId, { localRpcUrl: rpcUrl }),
      deployment: writeDeploymentOf(manifest),
      reader: createChainReader(createHttpRequest(rpcUrl, { timeoutMs: config.requestTimeoutMs })),
    }),
  });
}
