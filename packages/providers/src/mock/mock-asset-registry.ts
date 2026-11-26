/**
 * Mock `AssetRegistryProvider` (M2 step 1; 03-FEED; G06). DEMO ONLY: the production registry is empty (D07).
 *
 * Supported: exactly the three quote identities of the bundled feed fixture (copied field for field, so identity
 * cannot drift from the feed), admitted as `supported_demo`. Rejected: one mock "legacy wrapper v1" entry that
 * exercises the unsupported state (G06 rejects legacy xStocks wrappers). Lookups are by exact chain + address;
 * an unknown address returns null and never becomes approved, and a symbol never identifies an asset.
 */
import {
  canonicalAddress,
  isChainId,
  IdentityError,
  parseFeedFixture,
  sameAddress,
  validateAssetRegistry,
  type Address,
  type AssetIdentity,
  type AssetRegistryEntry,
  type AssetRegistryProvider,
  type Provenance,
} from '@squarehole/domain';
import { delay, throwIfAborted, waitForAbort } from '../abort';
import { ProviderUnavailableError } from '../errors';
import feedJson from '../fixtures/feed.json';
import { MAX_MOCK_LATENCY_MS } from './mock-feed-provider';
import { deepFreeze } from './scenarios';

export const MOCK_REGISTRY_SCENARIOS = ['default', 'unavailable', 'loading'] as const;
export type MockRegistryScenario = (typeof MOCK_REGISTRY_SCENARIOS)[number];

export const MOCK_REGISTRY_SOURCE = 'Square Hole mock asset registry: demo admissions, not an approved production registry';

/** Address of the mock rejected legacy wrapper (not in the feed fixture). */
export const MOCK_LEGACY_WRAPPER_ADDRESS: Address = '0x0000000000000000000000000000000000002328';

const ISSUER_FAMILY: Readonly<Record<string, string>> = {
  'USDC-DEMO': 'Demo stablecoin',
  'WETH-DEMO': 'Demo wrapped native asset',
  'AAPLx-DEMO': 'Demo tokenized-stock wrapper',
};

function buildRegistry(): readonly AssetRegistryEntry[] {
  const feed = parseFeedFixture(feedJson);
  const provenance: Provenance = { state: 'mock', asOf: feed.asOf, source: MOCK_REGISTRY_SOURCE, coverage: 'demo' };
  const quotes = new Map<string, AssetIdentity>();
  for (const pair of feed.items) {
    const key = `${pair.quote.chainId}:${pair.quote.address.toLowerCase()}`;
    if (!quotes.has(key)) quotes.set(key, pair.quote);
  }
  const supported: AssetRegistryEntry[] = [...quotes.values()]
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0))
    .map((asset) => ({
      asset,
      ...(ISSUER_FAMILY[asset.symbol] === undefined ? {} : { issuerFamily: ISSUER_FAMILY[asset.symbol] }),
      admission: 'supported_demo' as const,
      provenance,
    }));
  const current = [...quotes.values()].find((asset) => asset.symbol === 'AAPLx-DEMO');
  const legacy: AssetRegistryEntry = {
    asset: {
      chainId: feed.chainId,
      address: MOCK_LEGACY_WRAPPER_ADDRESS,
      symbol: 'AAPLx-V1-DEMO',
      decimals: 18,
      issuerStatus: 'mock',
      ...(current?.underlyingAddress === undefined ? {} : { underlyingAddress: current.underlyingAddress }),
      wrapperVersion: 'mock-legacy-v1',
    },
    issuerFamily: 'Demo tokenized-stock wrapper',
    admission: 'rejected',
    rejection: {
      gate: 'G06',
      reason: 'Mock legacy wrapper v1: G06 rejects legacy xStocks wrappers; only the current wrapper version can be admitted.',
    },
    provenance,
  };
  // Validates every entry and the chain + address uniqueness of the whole registry.
  return deepFreeze(validateAssetRegistry([...supported, legacy]));
}

export interface MockAssetRegistryOptions {
  scenario?: MockRegistryScenario;
  latencyMs?: number;
}

export interface MockAssetRegistry extends AssetRegistryProvider {
  readonly mode: 'demo';
  readonly scenario: MockRegistryScenario;
}

export function createMockAssetRegistry(options: MockAssetRegistryOptions = {}): MockAssetRegistry {
  const scenario = options.scenario ?? 'default';
  const latencyMs = options.latencyMs ?? 0;
  if (!MOCK_REGISTRY_SCENARIOS.includes(scenario)) {
    throw new RangeError(`Unknown mock registry scenario; expected one of ${MOCK_REGISTRY_SCENARIOS.join(', ')}`);
  }
  if (!Number.isSafeInteger(latencyMs) || latencyMs < 0 || latencyMs > MAX_MOCK_LATENCY_MS) {
    throw new RangeError(`latencyMs must be an integer between 0 and ${MAX_MOCK_LATENCY_MS}`);
  }
  const entries = buildRegistry();

  async function ready(chainId: number, signal?: AbortSignal): Promise<void> {
    if (!isChainId(chainId)) throw new IdentityError('malformed_chain_id', 'Chain id must be a positive safe integer');
    throwIfAborted(signal);
    if (scenario === 'loading') await waitForAbort(signal);
    if (latencyMs > 0) await delay(latencyMs, signal);
    throwIfAborted(signal);
    if (scenario === 'unavailable') throw new ProviderUnavailableError('Mock asset registry: simulated outage');
  }

  return {
    mode: 'demo',
    scenario,

    async listSupportedQuotes(chainId: number, signal?: AbortSignal): Promise<AssetRegistryEntry[]> {
      await ready(chainId, signal);
      return deepFreeze(entries.filter((entry) => entry.admission === 'supported_demo' && entry.asset.chainId === chainId));
    },

    async readAsset(chainId: number, address: Address, signal?: AbortSignal): Promise<AssetRegistryEntry | null> {
      const wanted = canonicalAddress(address);
      await ready(chainId, signal);
      return entries.find((entry) => entry.asset.chainId === chainId && sameAddress(entry.asset.address, wanted)) ?? null;
    },
  };
}
