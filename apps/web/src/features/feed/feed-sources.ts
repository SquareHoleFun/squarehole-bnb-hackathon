/**
 * Where feed data comes from. M1 is demo-only: every source is the mock provider over the bundled fixture on chain
 * 31337, one instance per `?scenario=` (created lazily and kept for the app's lifetime, so `ranking_updated` flips
 * exactly once per session). M4 swaps in read-only chain/indexer providers behind the same `FeedProvider` boundary.
 */
import type { FeedProvider } from '@squarehole/domain';
import { createMockFeedProvider, type MockScenario } from '@squarehole/providers';

export type FeedMode = 'demo' | 'live';

export interface FeedSource {
  readonly provider: FeedProvider;
  /** Demo labelling follows the source mode and chain 31337, never `provenance.coverage` (ADR-0003). */
  readonly mode: FeedMode;
}

export type FeedSourceFor = (scenario: MockScenario) => FeedSource;

/**
 * Where the feed reads when no source is given: the production site always has its chain session's, so this one
 * never answers, it fails every read (the pages then say "unavailable").
 */
export const NO_FEED_SOURCES: FeedSourceFor = (() => {
  const fail = (): Promise<never> => Promise.reject(new Error('No feed source in this build'));
  const source: FeedSource = Object.freeze({ provider: Object.freeze({ readFeed: fail, readPair: fail }), mode: 'live' });
  return () => source;
})();

export function createDemoFeedSources(): FeedSourceFor {
  const sources = new Map<MockScenario, FeedSource>();
  return (scenario) => {
    const existing = sources.get(scenario);
    if (existing) return existing;
    const source: FeedSource = Object.freeze({ provider: createMockFeedProvider({ scenario }), mode: 'demo' });
    sources.set(scenario, source);
    return source;
  };
}
