// Mock and (later) chain/indexer providers implementing @squarehole/domain boundaries.
export { ProviderUnavailableError } from './errors';
export {
  MAX_MOCK_LATENCY_MS,
  createMockFeedProvider,
  type MockFeedProvider,
  type MockFeedProviderOptions,
  type PairDetailsSource,
} from './mock/mock-feed-provider';
export { MOCK_SCENARIOS, MOCK_SOURCE, type MockScenario } from './mock/scenarios';
// ADR-0008 (M2/M3 mocks)
export { DEMO_BLOCK_CLOCK, demoBlockAt } from './mock/demo-chain';
export {
  DEMO_PERSONAS,
  MOCK_ACCOUNT_SCENARIOS,
  MOCK_ACCOUNT_SOURCE,
  createMockAccountProvider,
  type MockAccountProvider,
  type MockAccountProviderOptions,
  type MockAccountScenario,
} from './mock/mock-account-provider';
export {
  MOCK_LEGACY_WRAPPER_ADDRESS,
  MOCK_REGISTRY_SCENARIOS,
  MOCK_REGISTRY_SOURCE,
  createMockAssetRegistry,
  type MockAssetRegistry,
  type MockAssetRegistryOptions,
  type MockRegistryScenario,
} from './mock/mock-asset-registry';
export {
  MOCK_TX_LABEL,
  MOCK_TX_SCRIPT_NAMES,
  createMockTxExecutor,
  mockTxHash,
  type MockTxExecutor,
  type MockTxScriptName,
  type TxTrace,
} from './mock/mock-tx-executor';
export { MOCK_TEMPLATES, MOCK_TEMPLATE_V0 } from './mock/templates';
