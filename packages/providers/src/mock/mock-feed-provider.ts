/**
 * Mock `FeedProvider` over the bundled demo fixture (SH-004). Demo only: it refuses non-demo fixtures, never
 * reports verified issuers or available routes (FEED-09) and labels every snapshot as mock/demo provenance.
 *
 * Snapshot rules:
 * - `query.snapshotId` pins a read to a snapshot the provider still holds (else `FeedQueryError('unknown_snapshot')`);
 *   without it the read uses the latest snapshot.
 * - A cursor is bound to its snapshot and query; reusing it against another snapshot throws
 *   `FeedCursorError('snapshot_mismatch')` so the caller resets its cursor state (03-FEED).
 */
import {
  FeedQueryError,
  FeedValidationError,
  canonicalPairId,
  paginateFeed,
  parseFeedFixture,
  parsePairDetailsFixture,
  parsePairId,
  selectFeed,
  type AssetIdentity,
  type FeedFixture,
  type FeedProvider,
  type FeedQuery,
  type FeedSnapshot,
  type PairDetail,
  type PairId,
  type PairRecord,
  type SnapshotHead,
} from '@squarehole/domain';
import { delay, throwIfAborted, waitForAbort } from '../abort';
import { ProviderUnavailableError } from '../errors';
import fixtureJson from '../fixtures/feed.json';
import { detailForRecord } from './pair-details';
import { MOCK_SCENARIOS, buildScenario, deepFreeze, type MockScenario, type ScenarioSnapshot } from './scenarios';

export const MAX_MOCK_LATENCY_MS = 60_000;

/** Loads the raw pair-details fixture (untrusted until `parsePairDetailsFixture` has validated it). */
export type PairDetailsSource = () => Promise<unknown>;

export interface MockFeedProviderOptions {
  scenario?: MockScenario;
  /** Simulated latency per call, an integer from 0 to 60000 ms. Honours AbortSignal while waiting. */
  latencyMs?: number;
  /**
   * Test seam: where pair details come from. Default: the bundled pair-details.json as a separate lazy chunk, loaded
   * and validated once on the first `readPairDetail` of any provider (feed-only pages never download it).
   */
  pairDetailsSource?: PairDetailsSource;
}

export interface MockFeedProvider extends FeedProvider {
  readonly mode: 'demo';
  readonly scenario: MockScenario;
  latestSnapshot(signal?: AbortSignal): Promise<SnapshotHead>;
  /** ADR-0008 (SH-012): read-only pair detail from pair-details.json, adjusted to the served snapshot. */
  readPairDetail(pairId: PairId, signal?: AbortSignal): Promise<PairDetail | null>;
}

function assertOptions(scenario: MockScenario, latencyMs: number): void {
  if (!MOCK_SCENARIOS.includes(scenario)) {
    throw new RangeError(`Unknown mock scenario; expected one of ${MOCK_SCENARIOS.join(', ')}`);
  }
  if (!Number.isSafeInteger(latencyMs) || latencyMs < 0 || latencyMs > MAX_MOCK_LATENCY_MS) {
    throw new RangeError(`latencyMs must be an integer between 0 and ${MAX_MOCK_LATENCY_MS}`);
  }
}

type PairDetailsById = ReadonlyMap<string, PairDetail>;

/** The bundled fixture, as a dynamic import so bundlers emit it as its own chunk (SH-012, M2/M3 review note). */
const bundledPairDetails: PairDetailsSource = () => import('../fixtures/pair-details.json').then((module) => module.default);

/** Loads, validates against feed.json (every pairId must exist there) and deep-freezes the details. */
async function loadPairDetails(source: PairDetailsSource, fixture: FeedFixture): Promise<PairDetailsById> {
  const details = parsePairDetailsFixture(await source(), fixture).details;
  return new Map(details.map((detail) => [canonicalPairId(detail.pairId), deepFreeze(detail)]));
}

/** One shared load of the bundled fixture (immutable) for every provider; a failed load is retried on the next read. */
let bundledDetails: Promise<PairDetailsById> | null = null;

function sharedBundledDetails(fixture: FeedFixture): Promise<PairDetailsById> {
  bundledDetails ??= loadPairDetails(bundledPairDetails, fixture).catch((error: unknown) => {
    bundledDetails = null;
    throw error;
  });
  return bundledDetails;
}

export function createMockFeedProvider(options: MockFeedProviderOptions = {}): MockFeedProvider {
  const scenario = options.scenario ?? 'default';
  const latencyMs = options.latencyMs ?? 0;
  assertOptions(scenario, latencyMs);

  const fixture = parseFeedFixture(fixtureJson);
  if (fixture.mode !== 'demo') {
    throw new FeedValidationError('mock fixture', [{ path: 'mode', message: 'the mock provider only serves demo fixtures' }]);
  }
  const data = buildScenario(fixture, scenario);
  const detailCache = new Map<string, PairDetail | null>();
  let completedFeedReads = 0;

  const published = (): readonly ScenarioSnapshot[] =>
    data.next !== null && completedFeedReads > 0 ? [data.initial, data.next] : [data.initial];
  const latest = (): ScenarioSnapshot => published().at(-1) ?? data.initial;

  let details: Promise<PairDetailsById> | null = null;
  /** Pair details, loaded on the first `readPairDetail` only; a failed load rejects that read and is retried later. */
  function baseDetails(): Promise<PairDetailsById> {
    if (details === null) {
      const source = options.pairDetailsSource;
      const load = source ? loadPairDetails(source, fixture) : sharedBundledDetails(fixture);
      details = load.catch((error: unknown) => {
        details = null;
        throw error;
      });
    }
    return details;
  }

  function resolveSnapshot(snapshotId: string | undefined): ScenarioSnapshot {
    if (snapshotId === undefined) return latest();
    const found = published().find((snapshot) => snapshot.snapshotId === snapshotId);
    if (!found) throw new FeedQueryError('unknown_snapshot', 'The provider no longer holds this snapshot');
    return found;
  }

  /** Scenario gate: cancellation first, then simulated latency, then the scenario's failure mode. */
  async function ready(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (scenario === 'loading') await waitForAbort(signal);
    if (latencyMs > 0) await delay(latencyMs, signal);
    throwIfAborted(signal);
    if (scenario === 'unavailable') throw new ProviderUnavailableError('Mock feed provider: simulated outage');
  }

  return {
    mode: 'demo',
    scenario,

    async readFeed(query: FeedQuery, signal?: AbortSignal): Promise<FeedSnapshot> {
      await ready(signal);
      const snapshot = resolveSnapshot(query.snapshotId);
      const selection = selectFeed(snapshot.records, query);
      const page = paginateFeed(selection.rows, {
        snapshotId: snapshot.snapshotId,
        query,
        cursor: query.cursor,
        limit: query.limit,
      });
      completedFeedReads += 1;
      return deepFreeze({
        snapshotId: snapshot.snapshotId,
        platform: selection.platform,
        platformMatchesQuery: selection.platformMatchesQuery,
        items: page.items,
        nextCursor: page.nextCursor,
        totalMatches: page.totalMatches,
        rewardAssets: snapshot.rewardAssets as AssetIdentity[],
        provenance: snapshot.provenance,
      });
    },

    async readPair(pairId: PairId, signal?: AbortSignal): Promise<PairRecord | null> {
      await ready(signal);
      const wanted = parsePairId(pairId).pairId;
      return latest().records.find((pair) => canonicalPairId(pair.pairId) === wanted) ?? null;
    },

    async latestSnapshot(signal?: AbortSignal): Promise<SnapshotHead> {
      await ready(signal);
      const { snapshotId, asOf } = latest();
      return { snapshotId, asOf };
    },

    async readPairDetail(pairId: PairId, signal?: AbortSignal): Promise<PairDetail | null> {
      await ready(signal);
      const wanted = parsePairId(pairId).pairId;
      const loaded = await baseDetails();
      throwIfAborted(signal);
      const snapshot = latest();
      const cacheKey = `${snapshot.snapshotId}|${wanted}`;
      if (!detailCache.has(cacheKey)) {
        const record = snapshot.records.find((pair) => canonicalPairId(pair.pairId) === wanted);
        const base = loaded.get(wanted);
        detailCache.set(cacheKey, record && base ? deepFreeze(detailForRecord(base, record, snapshot.asOf)) : null);
      }
      return detailCache.get(cacheKey) ?? null;
    },
  };
}
