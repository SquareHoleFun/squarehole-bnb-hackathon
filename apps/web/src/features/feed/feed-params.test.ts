import type { AssetIdentity } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEED_STATE,
  FEED_PAGE_SIZE,
  hasActiveFilters,
  parseFeedParams,
  resolveRewardFilter,
  serialiseFeedParams,
  toFeedQuery,
  type FeedUrlState,
} from './feed-params';

const USDC = '0x000000000000000000000000000000000000232a';
const AAPLX = '0x0000000000000000000000000000000000002329';
const parse = (search: string, options?: { allowScenario?: boolean }) => parseFeedParams(new URLSearchParams(search), options);
const asset = (address: string, symbol: string): AssetIdentity =>
  ({ chainId: 31337, address: address as AssetIdentity['address'], symbol, decimals: 6, issuerStatus: 'mock' });

describe('parseFeedParams (sanitise untrusted URL values before they reach the provider)', () => {
  it('returns the defaults for an empty query string', () => {
    expect(parse('')).toEqual(DEFAULT_FEED_STATE);
    expect(DEFAULT_FEED_STATE).toEqual({ q: '', sort: 'market_cap', type: 'all', reward: '', lifecycle: 'all', scenario: 'default' });
  });

  it('reads every valid value', () => {
    expect(parse(`q=orch&sort=new&type=nft_collection&reward=T&lifecycle=curve&scenario=stale`)).toEqual({
      q: 'orch',
      sort: 'new',
      type: 'nft_collection',
      reward: 'T',
      lifecycle: 'curve',
      scenario: 'stale',
    });
    expect(parse('sort=turnover&type=token&lifecycle=graduating').sort).toBe('turnover');
    expect(parse('lifecycle=amm').lifecycle).toBe('amm');
    expect(parse('sort=market_cap').sort).toBe('market_cap');
  });

  it('canonicalises a reward address to lowercase', () => {
    expect(parse(`reward=${USDC.toUpperCase().replace('0X', '0x')}`).reward).toBe(USDC);
  });

  it.each([
    ['sort', ['bogus', '__proto__', 'constructor', 'MARKET_CAP', '', 'new ']],
    ['type', ['__proto__', 'constructor', 'toString', 'all', 'Token', '', 'nft']],
    ['reward', ['t', 'Q', 'q', '0x1234', `${USDC}00`, '__proto__', ' T', '', 'javascript:alert(1)']],
    ['lifecycle', ['unlaunched', 'all', 'Curve', '__proto__', '']],
    ['scenario', ['nope', '__proto__', 'Default', '', 'hasOwnProperty']],
  ] as const)('ignores invalid %s values', (key, values) => {
    for (const value of values) {
      expect(parse(`${key}=${encodeURIComponent(value)}`)[key]).toBe(DEFAULT_FEED_STATE[key]);
    }
  });

  it('normalises the search text: trims, collapses whitespace and caps the length', () => {
    expect(parse('q=%20%20Little%20%20%20Orchard%20').q).toBe('Little Orchard');
    expect(parse('q=%20%09').q).toBe('');
    expect(parse(`q=${'x'.repeat(400)}`).q).toHaveLength(120);
  });

  it('uses the first value of a repeated parameter', () => {
    expect(parse('sort=new&sort=turnover').sort).toBe('new');
    expect(parse('sort=bogus&sort=new').sort).toBe('market_cap');
  });

  it('ignores ?scenario outside demo builds', () => {
    expect(parse('scenario=stale', { allowScenario: false }).scenario).toBe('default');
  });
});

describe('serialiseFeedParams', () => {
  it('omits defaults, so the default feed is a bare "/"', () => {
    expect(serialiseFeedParams(DEFAULT_FEED_STATE)).toBe('');
  });

  it('writes values in a canonical order', () => {
    const state: FeedUrlState = { q: 'tree', sort: 'turnover', type: 'token', reward: USDC, lifecycle: 'amm', scenario: 'partial' };
    expect(serialiseFeedParams(state)).toBe(`q=tree&sort=turnover&type=token&reward=${USDC}&lifecycle=amm&scenario=partial`);
  });

  it('keeps unrelated parameters and drops stale or invalid feed parameters from the base', () => {
    const base = new URLSearchParams('utm=x&sort=bogus&reward=0x12&q=old');
    expect(serialiseFeedParams({ ...DEFAULT_FEED_STATE, sort: 'new' }, base)).toBe('sort=new&utm=x');
  });

  it('encodes untrusted search text instead of interpreting it', () => {
    expect(serialiseFeedParams({ ...DEFAULT_FEED_STATE, q: 'a&b=c #d' })).toBe('q=a%26b%3Dc+%23d');
  });

  it('round-trips every combination through parseFeedParams', () => {
    for (const sort of ['market_cap', 'new', 'turnover'] as const) {
      for (const type of ['all', 'token', 'nft_collection'] as const) {
        for (const reward of ['', 'T', USDC] as const) {
          for (const lifecycle of ['all', 'curve', 'graduating', 'amm'] as const) {
            const state: FeedUrlState = { q: 'Orch Ard', sort, type, reward, lifecycle, scenario: 'default' };
            expect(parse(serialiseFeedParams(state))).toEqual(state);
          }
        }
      }
    }
  });
});

describe('toFeedQuery', () => {
  it('maps the default state to the provider defaults, without a cursor', () => {
    const query = toFeedQuery(DEFAULT_FEED_STATE);
    expect(query).toEqual({ search: '', sort: 'market_cap', type: 'all', lifecycle: 'all', limit: FEED_PAGE_SIZE });
    expect('cursor' in query).toBe(false);
    expect(FEED_PAGE_SIZE).toBe(20);
  });

  it('maps the reward filter to rewardSide or rewardAddress', () => {
    expect(toFeedQuery({ ...DEFAULT_FEED_STATE, reward: 'T' })).toMatchObject({ rewardSide: 'T' });
    expect(toFeedQuery({ ...DEFAULT_FEED_STATE, reward: USDC })).toMatchObject({ rewardAddress: USDC });
    expect(toFeedQuery({ ...DEFAULT_FEED_STATE, reward: USDC }).rewardSide).toBeUndefined();
  });

  it('passes search, sort, type and lifecycle through', () => {
    expect(toFeedQuery({ ...DEFAULT_FEED_STATE, q: 'orch', sort: 'new', type: 'nft_collection', lifecycle: 'curve' })).toEqual({
      search: 'orch',
      sort: 'new',
      type: 'nft_collection',
      lifecycle: 'curve',
      limit: FEED_PAGE_SIZE,
    });
  });
});

describe('resolveRewardFilter (unknown reward assets are treated as the default)', () => {
  const assets = [asset(AAPLX, 'AAPLx-DEMO'), asset(USDC, 'USDC-DEMO')];

  it('keeps a reward address that the snapshot offers', () => {
    expect(resolveRewardFilter({ ...DEFAULT_FEED_STATE, reward: USDC }, assets).reward).toBe(USDC);
  });

  it('drops a well-formed address that the snapshot does not offer', () => {
    const unknown = '0x00000000000000000000000000000000000000ff';
    expect(resolveRewardFilter({ ...DEFAULT_FEED_STATE, reward: unknown }, assets).reward).toBe('');
  });

  it('keeps T and the empty filter untouched', () => {
    expect(resolveRewardFilter({ ...DEFAULT_FEED_STATE, reward: 'T' }, []).reward).toBe('T');
    expect(resolveRewardFilter(DEFAULT_FEED_STATE, assets)).toBe(DEFAULT_FEED_STATE);
  });
});

describe('hasActiveFilters', () => {
  it('is false for the default feed and for a sort change alone', () => {
    expect(hasActiveFilters(DEFAULT_FEED_STATE)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_FEED_STATE, sort: 'new', scenario: 'stale' })).toBe(false);
  });

  it('is true for a search or any filter', () => {
    expect(hasActiveFilters({ ...DEFAULT_FEED_STATE, q: 'x' })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_FEED_STATE, type: 'token' })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_FEED_STATE, reward: 'T' })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_FEED_STATE, lifecycle: 'amm' })).toBe(true);
  });
});
