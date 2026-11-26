/**
 * Feed URL state (SH-006, FEED-04). `?q`, `?sort`, `?type`, `?reward`, `?lifecycle` and the demo-only `?scenario` are
 * untrusted (shared links), so every value is checked against a Map/allowlist before it can reach the provider:
 * unknown values fall back to the default instead of throwing `FeedQueryError`/`FeedCursorError` later.
 * The URL is the only store of this state, so the header trigger, the feed controls and Back/Forward always agree.
 */
import type { Address, AssetIdentity, AssetKind, FeedQuery, FeedSort } from '@squarehole/domain';
import { MOCK_SCENARIOS, type MockScenario } from '@squarehole/providers';
import { parseFeedType, TYPE_PARAM } from '../../pages/feed-type';
import { SEARCH_PARAM, normaliseQuery } from '../../shell/search-url';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export const FEED_PAGE_SIZE = 20;

export type LifecycleFilter = 'all' | 'curve' | 'graduating' | 'amm';
/** '' = any reward, 'T' = pays in its own token, or the lowercase address of a reward asset. */
export type RewardFilter = '' | 'T' | Address;

export interface FeedUrlState {
  readonly q: string;
  readonly sort: FeedSort;
  readonly type: 'all' | AssetKind;
  readonly reward: RewardFilter;
  readonly lifecycle: LifecycleFilter;
  readonly scenario: MockScenario;
}

export const DEFAULT_FEED_STATE: FeedUrlState = Object.freeze({
  q: '',
  sort: 'market_cap',
  type: 'all',
  reward: '',
  lifecycle: 'all',
  scenario: 'default',
});

export const FEED_PARAMS = Object.freeze({
  q: SEARCH_PARAM,
  sort: 'sort',
  type: TYPE_PARAM,
  reward: 'reward',
  lifecycle: 'lifecycle',
  scenario: 'scenario',
});

const OWNED_KEYS: ReadonlySet<string> = new Set(Object.values(FEED_PARAMS));

// Maps, not objects: `?sort=__proto__` must not resolve to an inherited member.
const SORTS: ReadonlyMap<string, FeedSort> = new Map<string, FeedSort>([
  ['market_cap', 'market_cap'],
  ['new', 'new'],
  ['turnover', 'turnover'],
]);
const LIFECYCLES: ReadonlyMap<string, LifecycleFilter> = new Map<string, LifecycleFilter>([
  ['curve', 'curve'],
  ['graduating', 'graduating'],
  ['amm', 'amm'],
]);
// The mock scenarios exist only with the Demo (the production site reads none of them).
const SCENARIOS: ReadonlyMap<string, MockScenario> = DEMO_BUILD ? new Map(MOCK_SCENARIOS.map((s) => [s, s] as const)) : new Map();
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isRewardAddress(reward: RewardFilter): reward is Address {
  return reward !== '' && reward !== 'T';
}

function parseReward(raw: string | null): RewardFilter {
  if (raw === 'T') return 'T';
  return raw !== null && ADDRESS.test(raw) ? (raw.toLowerCase() as Address) : '';
}

export interface ParseOptions {
  /** `?scenario=` selects a mock scenario in demo builds only. */
  allowScenario?: boolean;
}

export function parseFeedParams(params: URLSearchParams, { allowScenario = true }: ParseOptions = {}): FeedUrlState {
  const scenario = allowScenario ? SCENARIOS.get(params.get(FEED_PARAMS.scenario) ?? '') : undefined;
  return {
    q: normaliseQuery(params.get(FEED_PARAMS.q) ?? ''),
    sort: SORTS.get(params.get(FEED_PARAMS.sort) ?? '') ?? 'market_cap',
    type: parseFeedType(params.get(FEED_PARAMS.type)),
    reward: parseReward(params.get(FEED_PARAMS.reward)),
    lifecycle: LIFECYCLES.get(params.get(FEED_PARAMS.lifecycle) ?? '') ?? 'all',
    scenario: scenario ?? 'default',
  };
}

/**
 * Canonical query string (no leading "?") for a state: defaults omitted, feed keys in a fixed order, then any
 * unrelated parameters from `base`. Feed keys in `base` are always replaced, so invalid values never survive.
 */
export function serialiseFeedParams(state: FeedUrlState, base?: URLSearchParams): string {
  const out = new URLSearchParams();
  if (state.q) out.set(FEED_PARAMS.q, state.q);
  if (state.sort !== 'market_cap') out.set(FEED_PARAMS.sort, state.sort);
  if (state.type !== 'all') out.set(FEED_PARAMS.type, state.type);
  if (state.reward) out.set(FEED_PARAMS.reward, state.reward);
  if (state.lifecycle !== 'all') out.set(FEED_PARAMS.lifecycle, state.lifecycle);
  if (state.scenario !== 'default') out.set(FEED_PARAMS.scenario, state.scenario);
  if (base) {
    for (const [key, value] of base) {
      if (!OWNED_KEYS.has(key)) out.append(key, value);
    }
  }
  return out.toString();
}

export type FeedFilterQuery = Pick<FeedQuery, 'search' | 'sort' | 'type' | 'lifecycle' | 'rewardSide' | 'rewardAddress' | 'limit'>;

/** Provider query for a sanitised state. Cursor and snapshot id are added by the data hook, never from the URL. */
export function toFeedQuery(state: FeedUrlState): FeedFilterQuery {
  const query: FeedFilterQuery = { search: state.q, sort: state.sort, type: state.type, lifecycle: state.lifecycle, limit: FEED_PAGE_SIZE };
  if (state.reward === 'T') return { ...query, rewardSide: 'T' };
  if (isRewardAddress(state.reward)) return { ...query, rewardAddress: state.reward };
  return query;
}

/** A reward address the snapshot does not offer is unknown: it is treated as "any reward" (never sent). */
export function resolveRewardFilter(state: FeedUrlState, rewardAssets: readonly AssetIdentity[]): FeedUrlState {
  if (!isRewardAddress(state.reward)) return state;
  const known = rewardAssets.some((asset) => asset.address.toLowerCase() === state.reward);
  return known ? state : { ...state, reward: '' };
}

/** A search or a filter narrows the organic set (a sort alone does not). */
export function hasActiveFilters(state: FeedUrlState): boolean {
  return state.q !== '' || state.type !== 'all' || state.reward !== '' || state.lifecycle !== 'all';
}
