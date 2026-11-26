/**
 * Which core v1 deployment a data source reads (S10a § 2.3): the build's core manifests
 * (`virtual:squarehole-deployments` CORE_MANIFESTS), parsed by the chain package. Sepolia's committed file is
 * `awaiting-broadcast` until the founder broadcasts: the site then says "Core v1 is not on Sepolia yet" and never guesses
 * an address. The local chain's (a twin with Sepolia's chain id, plan § 7.1) is embedded only when a build names it.
 *
 * Links are built by source, never by chain id alone (box-links.ts): a local twin's addresses get no Sepolia explorer
 * link even though its chain id is 11155111.
 */
import { coreDeploymentState, coreVersion1, TESTNET, type CoreVersion, type DeployedCoreManifest } from '@squarehole/chain';
import type { DataSourceId } from '../data-source';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

// SH-258: the test network is the build's profile (Sepolia by default; BNB Chain Testnet under SH_TESTNET=bnb).
export const CORE_NOT_ON_SEPOLIA = DEMO_BUILD
  ? `Core v1 is not on ${TESTNET.networkName} yet: the founder’s broadcast is pending.`
  : `Core v1 is not on ${TESTNET.networkName} yet.`;
export const CORE_NOT_LOCAL = DEMO_BUILD ? 'No local core v1 chain in this build. `pnpm dev:core-local` starts one (anvil, a twin of Sepolia’s chain id) and points the app at it.' : '';

export interface CoreBuild {
  /** Every core manifest the build embeds (untrusted until parsed). */
  readonly manifests: readonly unknown[];
  readonly localRpcUrl: string;
  readonly indexers: { readonly local: string | null; readonly sepolia: string | null };
  /** Where box pictures are fetched by raw CID (checked against their hash before they show); none when absent. */
  readonly artGateways?: { readonly local: readonly string[]; readonly sepolia: readonly string[] };
  /** SH-ARWEAVE-PICTURES-WEB: whether each source keeps v2 logos and covers on Arweave; off when absent. */
  readonly arweave?: { readonly local: boolean; readonly sepolia: boolean };
  /**
   * The existing-NFTs add-on's local manifest (`SET_LOCAL_MANIFEST`, SH-EXISTING-NFTS-E08C), untrusted until
   * `parseSetManifest` accepts it against the local core manifest; absent or null: no add-on in this build.
   */
  readonly set?: unknown;
}

/**
 * The add-on's two inputs on a source (SH-EXISTING-NFTS-E08C): its own manifest and the core manifest it binds to, the
 * build's local one (the add-on is local only until its release ticket, E-09). Null on any other source, in a build
 * without the add-on or the production site, and without exactly one local core manifest. Nothing is parsed or read
 * here: features/set/set-build.ts parses both and checks the factory's identity on chain before showing the add-on.
 */
export function setInputsFor(source: DataSourceId, build: CoreBuild): { readonly set: unknown; readonly core: unknown } | null {
  if (!DEMO_BUILD || source !== 'local' || build.set === undefined || build.set === null) return null;
  try {
    const core = coreManifestFor(build.manifests, 'local');
    return core === null ? null : { set: build.set, core };
  } catch {
    return null;
  }
}

export type CoreSource =
  | {
      readonly status: 'ready';
      readonly network: 'local' | 'sepolia';
      readonly chainId: number;
      readonly manifest: DeployedCoreManifest;
      /** Box 0's factory version; null where the network has no core v1 (BNB Chain testnet: no box 0, SH-258). */
      readonly version1: CoreVersion | null;
      /** The RPC the direct reads use (the local chain's, or the first keyless Sepolia RPC). */
      readonly rpcUrl: string;
      readonly indexerOrigin: string | null;
      /** The box pictures' gateways for this source (box-pictures.ts); empty when the build names none. */
      readonly artGateways: readonly string[];
    }
  | { readonly status: 'awaiting-broadcast' | 'none' | 'invalid'; readonly reason: string };

const network = (value: unknown): unknown => (typeof value === 'object' && value !== null ? (value as { network?: unknown }).network : undefined);

/** The manifest `network` of a slot: `local`, or the test network's (`sepolia`, or `bnb-testnet` under SH_TESTNET=bnb). */
export const manifestNetworkOf = (which: 'local' | 'sepolia'): string => (which === 'local' ? 'local' : TESTNET.manifestNetwork);

/** The build's manifest for one network (at most one; two is a build error, reported, never chosen between). */
export function coreManifestFor(manifests: readonly unknown[], which: 'local' | 'sepolia'): unknown {
  const matching = manifests.filter((m) => network(m) === manifestNetworkOf(which));
  if (matching.length > 1) throw new Error(`the build carries ${matching.length} core manifests for ${which}`);
  return matching[0] ?? null;
}

/** The core deployment a data source reads, or why there is none. Never throws. */
export function coreSourceFor(source: DataSourceId, build: CoreBuild, sepoliaRpcUrl: string): CoreSource {
  if (DEMO_BUILD && source === 'demo') return { status: 'none', reason: 'No core deployment.' };
  const which = source === 'local' ? 'local' : 'sepolia';
  let input: unknown;
  try {
    input = coreManifestFor(build.manifests, which);
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
  const state = coreDeploymentState(input);
  switch (state.status) {
    case 'none':
      return { status: 'none', reason: which === 'local' ? CORE_NOT_LOCAL : CORE_NOT_ON_SEPOLIA };
    case 'awaiting-broadcast':
      return { status: 'awaiting-broadcast', reason: which === 'local' ? CORE_NOT_LOCAL : CORE_NOT_ON_SEPOLIA };
    case 'invalid':
      return { status: 'invalid', reason: `The core v1 manifest in this build is invalid: ${state.reason}` };
    case 'deployed': {
      if (state.manifest.network !== manifestNetworkOf(which)) return { status: 'invalid', reason: `The ${which} core manifest says network ${state.manifest.network}` };
      return {
        status: 'ready',
        network: which,
        chainId: state.manifest.chainId,
        manifest: state.manifest,
        version1: state.manifest.versions.length === 0 ? null : coreVersion1(state.manifest),
        rpcUrl: which === 'local' ? build.localRpcUrl : sepoliaRpcUrl,
        indexerOrigin: build.indexers[which],
        artGateways: build.artGateways?.[which] ?? [],
      };
    }
  }
}

/**
 * The chain a local core v2 deployment's box actions run on (its manifest's chain id: the local twin of Sepolia, an
 * anvil with Sepolia's id), or null when the build's local core manifest is not a deployed v2 one. The wallet is checked
 * against it on that source (SH-V21-EXAMPLES-E2E-FIX2 O-2); a core v1 twin stays read only.
 */
export function localV2WalletChainId(manifests: readonly unknown[]): number | null {
  try {
    const input = coreManifestFor(manifests, 'local');
    if (typeof input !== 'object' || input === null || !('releases' in input)) return null;
    const state = coreDeploymentState(input);
    return state.status === 'deployed' && Number.isSafeInteger(state.manifest.chainId) && state.manifest.chainId > 0 ? state.manifest.chainId : null;
  } catch {
    return null;
  }
}

/**
 * The chain the wallet is checked against on the local core twin: a deployed v2 deployment's (above), else a deployed
 * core v1 twin's, whose box 0 draws, opens and claims there since SH-BOX0-ACTIONS; null for anything else.
 */
export function localCoreWalletChainId(manifests: readonly unknown[]): number | null {
  const v2 = localV2WalletChainId(manifests);
  if (v2 !== null) return v2;
  try {
    const state = coreDeploymentState(coreManifestFor(manifests, 'local'));
    return state.status === 'deployed' && state.manifest.network === 'local' && Number.isSafeInteger(state.manifest.chainId) && state.manifest.chainId > 0 ? state.manifest.chainId : null;
  } catch {
    return null;
  }
}

/** For the data source options: what the build's core manifests make available. */
export function coreAvailability(manifests: readonly unknown[]): { readonly sepolia: 'deployed' | 'awaiting-broadcast' | 'none' | 'invalid'; readonly local: boolean } {
  const of = (which: 'local' | 'sepolia') => {
    try {
      return coreDeploymentState(coreManifestFor(manifests, which)).status;
    } catch {
      return 'invalid' as const;
    }
  };
  return { sepolia: of('sepolia'), local: of('local') === 'deployed' };
}
