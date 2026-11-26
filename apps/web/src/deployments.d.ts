// packages/chain's cross-package tests load the site's declarations through this file (their web-types.d.ts imports
// it): an ambient file can only pull another one in by reference (an import would make it a module).
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./build-env.d.ts" />
/**
 * Build-time deployment manifests (apps/web/vite.config.ts, `squareHoleDeployments`). Untrusted JSON until the chain
 * package's manifest parser accepts it; null when the chain has no manifest in this build.
 */
declare module 'virtual:squarehole-deployments' {
  export const LOCAL_MANIFEST: unknown;
  export const SEPOLIA_MANIFEST: unknown;
  /** RPC URL of the local anvil chain for this build (no credentials; checked again by the chain config). Empty in production. */
  export const LOCAL_RPC_URL: string;
  /**
   * The v2 market records (`squarehole.fit-market/v1`): the committed ones in apps/web/fit-markets/ or those named by
   * SH_FIT_MARKET. Untrusted until fit-target.ts parses the one for the chosen chain.
   */
  export const FIT_MARKETS: readonly unknown[];
  /**
   * Core manifests (`squarehole.core-deployment/v1`, S10a): Sepolia's committed file (today `awaiting-broadcast`) or the
   * one SH_CORE_SEPOLIA_MANIFEST names, and the local one SH_CORE_LOCAL_MANIFEST names. Untrusted until the chain
   * package's `parseCoreManifest` accepts it.
   */
  export const CORE_MANIFESTS: readonly unknown[];
  /** RPC URL of the local core v1 chain (an anvil twin of Sepolia; default port 8562). Empty in production. */
  export const CORE_LOCAL_RPC_URL: string;
  /** Live indexer gateway origins per core source, or null (the pages then read the chain directly). */
  export const CORE_INDEXER_ORIGINS: { readonly local: string | null; readonly sepolia: string | null };
  /**
   * Gateways the box pictures are fetched from by raw CID, per core source: the local stack's art gateway
   * (SH_CORE_LOCAL_ART_GATEWAYS, bare loopback origins; never in production) and, in the Sepolia test target only, our
   * own node for Sepolia (https://api.squarehole.fun, SH-TA-26). Every picture is checked against its committed SHA-256
   * before it shows.
   */
  export const CORE_ART_GATEWAYS: { readonly local: readonly string[]; readonly sepolia: readonly string[] };
  /**
   * SH-ARWEAVE-PICTURES-WEB: whether each core source keeps a v2 box's logo and cover on Arweave (deployments-plugin.ts
   * `arweavePictures`): Create shrinks them to Turbo's free tier and publishes them there before its createBox makes
   * their hashes public (fix round 1), and every page looks them up there, checked against their hash. False: neither
   * happens.
   */
  export const CORE_ARWEAVE: { readonly local: boolean; readonly sepolia: boolean };
  /**
   * The existing-NFTs add-on's local manifest (`squarehole.set-release/v1`, SH-EXISTING-NFTS-E08C), the file
   * SH_SET_LOCAL_MANIFEST names in a development build; null otherwise and always null in production. Untrusted until
   * the chain package's `parseSetManifest` accepts it against the local core manifest and the factory's identity reads.
   */
  export const SET_LOCAL_MANIFEST: unknown;
  /**
   * F156 (SH-ALPHA-TRADE-BOX): the 31337 alpha's own manifest (`square-hole-alpha-local/1`), the file
   * SH_ALPHA_LOCAL_MANIFEST names in a development build; null otherwise and always null in production. Untrusted until
   * features/trade-sepolia/trade-target.ts accepts its `localDeployment` against the local core manifest.
   */
  export const ALPHA_LOCAL_MANIFEST: unknown;
  /**
   * SH-258: BNB Chain testnet's trade and test-coin record (packages/chain/src/trade-sepolia/coin-deployment-97.json,
   * the coin-deployment.json shape) under SH_TESTNET=bnb; null without the file and in every Sepolia build (Sepolia's
   * record is pinned in the chain package). Untrusted until trade-target.ts and the coin calls parse it.
   */
  export const TESTNET_COIN_RECORD: unknown;
}
