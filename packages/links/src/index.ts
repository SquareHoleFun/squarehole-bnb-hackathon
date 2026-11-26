// Reviewed external venue/discovery/explorer link adapters (SH-013). The demo adapter never builds a URL (EXT-08);
// the registry adapter builds one only for an evidenced route on an allowlisted origin (EXT-02, EXT-05, EXT-07).
export {
  DEMO_ROUTE_REASON,
  IDENTITY_MISMATCH_REASON,
  createDemoExternalLinkProvider,
  routeSummary,
} from './demo-links';
export {
  FORBIDDEN_PARAMS,
  REVIEWED_PROVIDERS,
  reviewedProvider,
  vetExternalHref,
  type DestinationKind,
  type HrefRejection,
  type ReviewedProvider,
  type VettedHref,
} from './allowlist';
export {
  DESTINATION_KINDS,
  LINK_REGISTRY_V1,
  LINK_REJECTED_REASON,
  MISMATCH_REASON,
  NOT_TESTED_REASON,
  NO_ROUTE_REASON,
  createReviewedExternalLinkProvider,
  renderableHref,
  type LinkRegistry,
  type RegistryRoute,
  type RouteEvidence,
} from './registry';
// Stage C (ADR-0012): chain-backed pairs on 31337 / 11155111, and the route-evidence record format (none shipped).
export {
  CHAIN_LINK_CHAIN_IDS,
  CHAIN_LINK_ROUTES_V1,
  LOCAL_CHAIN_LINK_REASON,
  NO_CHAIN_ROUTE_REASON,
  SEPOLIA_DISCOVERY_REASON,
  UNISWAP_TESTNET_MODE_WARNING,
  createChainExternalLinkProvider,
  sepoliaExplorerHref,
  TESTNET_EXPLORER_CHAINS,
  isTestnetExplorerId,
  type TestnetExplorerId,
  type ChainLinkProviderOptions,
} from './chain-links';
export {
  ROUTE_EVIDENCE_SCHEMA,
  loadRouteEvidence,
  parseRouteEvidence,
  passingEvidenceFor,
  type LoadedRouteEvidence,
  type RouteEvidenceRecord,
} from './route-evidence';
// v2 FIT pair page (T19): Uniswap (native ETH in), DEX Screener (v4 pool id) and Etherscan for the exact FIT address.
export {
  FIT_DEMO_LINK_REASON,
  FIT_LINK_ROUTES_V1,
  NATIVE_ETH_ADDRESS,
  fitExplorerHref,
  fitMarketDestinations,
  type FitDestination,
  type FitLinkTarget,
} from './fit-links';
// S10a: links out of a core v1 box, built from its registry row; route evidence per template and Q class (v2).
export {
  BOX_DEMO_LINK_REASON,
  BOX_LOCAL_LINK_REASON,
  boxContractHref,
  boxDestinations,
  executionGate as boxExecutionGate,
  type BoxDestination,
  type BoxLinkInput,
  type BoxLinkPhase,
  type BoxLinkState,
  type BoxNetwork,
} from './box-links';
export { ROUTE_EVIDENCE_V2_SCHEMA, parseRouteEvidenceV2, passingEvidenceV2, type RouteEvidenceV2 } from './route-evidence-v2';
