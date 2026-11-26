/**
 * The box feed's URL state (`/`): `?q`, `?state`, `?sort`, `?view`, and `?scenario` for the Demo data only. Shared links
 * are untrusted, so each value is looked up in a Map allowlist (`?sort=__proto__` resolves to the default), and the
 * URL is the only store of this state (Back/Forward restore the controls), as in feed-params.ts.
 */
import { isDemoScenario, type DemoScenario } from '../fit-pair/demo-chain';
import { SEARCH_PARAM, normaliseQuery } from '../../shell/search-url';
import type { BoxState } from './box-model';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export type BoxStateFilter = 'all' | BoxState;
export type BoxSort = 'new' | 'progress' | 'mcap' | 'volume';
export type BoxView = 'grid' | 'list';

export interface BoxFeedUrlState {
  readonly q: string;
  readonly state: BoxStateFilter;
  readonly sort: BoxSort;
  readonly view: BoxView;
  readonly scenario: DemoScenario;
}

export const DEFAULT_BOX_FEED: BoxFeedUrlState = Object.freeze({ q: '', state: 'all', sort: 'new', view: 'grid', scenario: 'curve' });

export const BOX_FEED_PARAMS = Object.freeze({ q: SEARCH_PARAM, state: 'state', sort: 'sort', view: 'view', scenario: 'scenario' });

const STATES: ReadonlyMap<string, BoxStateFilter> = new Map<string, BoxStateFilter>([
  ['all', 'all'],
  ['upcoming', 'upcoming'],
  ['window', 'window'],
  ['bonding', 'bonding'],
  ['graduating', 'graduating'],
  ['graduated', 'graduated'],
  ['failed', 'failed'],
]);
const SORTS: ReadonlyMap<string, BoxSort> = new Map<string, BoxSort>([
  ['new', 'new'],
  ['progress', 'progress'],
  ['mcap', 'mcap'],
  ['volume', 'volume'],
]);
const VIEWS: ReadonlyMap<string, BoxView> = new Map<string, BoxView>([
  ['grid', 'grid'],
  ['list', 'list'],
]);

export interface BoxFeedParseOptions {
  /** `?scenario=` picks a Demo scenario for the Demo Misfits; ignored on a chain source. */
  readonly allowScenario: boolean;
}

export function parseBoxFeedParams(params: URLSearchParams, { allowScenario }: BoxFeedParseOptions): BoxFeedUrlState {
  const requested = params.get(BOX_FEED_PARAMS.scenario);
  return {
    q: normaliseQuery(params.get(BOX_FEED_PARAMS.q) ?? ''),
    state: STATES.get(params.get(BOX_FEED_PARAMS.state) ?? '') ?? 'all',
    sort: SORTS.get(params.get(BOX_FEED_PARAMS.sort) ?? '') ?? 'new',
    view: VIEWS.get(params.get(BOX_FEED_PARAMS.view) ?? '') ?? 'grid',
    scenario: DEMO_BUILD && allowScenario && isDemoScenario(requested) ? requested : 'curve',
  };
}

/** The URL for a state: defaults are left out; parameters this feed does not own are kept. */
export function serialiseBoxFeedParams(state: BoxFeedUrlState, base: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const next = new URLSearchParams(base);
  const set = (key: string, value: string, fallback: string) => {
    if (value === fallback) next.delete(key);
    else next.set(key, value);
  };
  set(BOX_FEED_PARAMS.q, normaliseQuery(state.q), '');
  set(BOX_FEED_PARAMS.state, state.state, DEFAULT_BOX_FEED.state);
  set(BOX_FEED_PARAMS.sort, state.sort, DEFAULT_BOX_FEED.sort);
  set(BOX_FEED_PARAMS.view, state.view, DEFAULT_BOX_FEED.view);
  set(BOX_FEED_PARAMS.scenario, state.scenario, DEFAULT_BOX_FEED.scenario);
  return next;
}

/** The pair feed's own parameters and sorts (feed-params.ts), which the box feed does not have. */
const PAIR_ONLY_PARAMS: readonly string[] = ['type', 'reward', 'lifecycle'];
const PAIR_ONLY_SORTS: ReadonlySet<string> = new Set(['market_cap', 'turnover']);

/**
 * An old shared link to the pair feed (it was at `/` before the launch set: `/?type=token`, `/?q=orch&type=…`,
 * `/?sort=turnover`) opens the box feed with what it has of the box feed's own (the search, a box state, view or sort),
 * in one step: the pair feed itself is off in every build (F134 R46B, routes.tsx). Null for a box feed URL.
 */
export function pairFeedRedirect(params: URLSearchParams): string | null {
  const sort = params.get(BOX_FEED_PARAMS.sort);
  const pairSort = sort !== null && PAIR_ONLY_SORTS.has(sort);
  if (!PAIR_ONLY_PARAMS.some((key) => params.has(key)) && !pairSort) return null;
  const kept = new URLSearchParams(params);
  for (const key of PAIR_ONLY_PARAMS) kept.delete(key);
  if (pairSort) kept.delete(BOX_FEED_PARAMS.sort);
  const query = kept.toString();
  return query ? `/?${query}` : '/';
}
