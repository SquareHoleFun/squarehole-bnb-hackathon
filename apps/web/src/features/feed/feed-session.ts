/**
 * App-lifetime record of the snapshot each feed scenario is pinned to (03-FEED "stable snapshot/cursor"). It outlives
 * the Feed page so leaving and returning never silently swaps the ranking on screen; only "Show updated ranking"
 * moves the pin forward. It also remembers the pinned snapshot's reward assets, which decide whether a `?reward=`
 * address is known before it is ever sent to the provider.
 */
import type { AssetIdentity } from '@squarehole/domain';
import type { MockScenario } from '@squarehole/providers';

export interface PinnedSnapshot {
  readonly snapshotId: string;
  /** Reward assets of that snapshot; null until a read of it has been seen. */
  readonly rewardAssets: readonly AssetIdentity[] | null;
}

export interface FeedSession {
  get(scenario: MockScenario): PinnedSnapshot | null;
  set(scenario: MockScenario, pin: PinnedSnapshot | null): void;
  subscribe(listener: () => void): () => void;
}

export function createFeedSession(): FeedSession {
  let pins: ReadonlyMap<MockScenario, PinnedSnapshot> = new Map();
  const listeners = new Set<() => void>();
  return {
    get: (scenario) => pins.get(scenario) ?? null,
    set(scenario, pin) {
      const current = pins.get(scenario) ?? null;
      if (current === pin) return;
      const next = new Map(pins);
      if (pin === null) next.delete(scenario);
      else next.set(scenario, Object.freeze({ snapshotId: pin.snapshotId, rewardAssets: pin.rewardAssets }));
      pins = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
