import type { PairRecord } from '@squarehole/domain';
import { createDemoExternalLinkProvider } from '@squarehole/links';
import { describe, expect, it } from 'vitest';
import { fixturePair as byName } from '../../test-support/fixture';
import { describeAddressMatches, displaySymbol, formatAsOf, formatHolders, formatPairCount, toPairView } from './format';

const ASOF = '2026-09-25T12:00:00Z';
const links = createDemoExternalLinkProvider();
const view = (pair: PairRecord, asOf = ASOF) => toPairView(pair, { asOf, links });

describe('toPairView (row content, SH-005)', () => {
  it('formats ORCHARD: NFT collection, Q reward, compact USD, age from the snapshot asOf, showcase note', () => {
    expect(view(byName('ORCHARD'))).toEqual({
      pairId: '31337:0x0000000000000000000000000000000000000066',
      href: '/pair/31337/0x0000000000000000000000000000000000000066',
      name: 'ORCHARD',
      symbol: 'ORCH',
      symbolUnset: false,
      type: 'nft_collection',
      typeLabel: 'NFT collection',
      lifecycleLabel: 'AMM',
      quoteSymbol: 'AAPLx-DEMO',
      rewardSide: 'Q',
      rewardSymbol: 'AAPLx-DEMO',
      rewardText: 'Fee share in AAPLx-DEMO',
      marketCap: '$600K',
      turnover24h: '$84.2K',
      holders: '105',
      age: '3d',
      launchedAt: '2026-09-22T12:00:00Z',
      route: 'unverified',
      showcase: true,
      matchKind: null,
      matchLabel: null,
      chain: null,
    });
  });

  it('says holders earn the pair’s own token when R = T', () => {
    const round = view(byName('ROUND TRIP'));
    expect(round.rewardText).toBe('Fee share in ROUND');
    expect(round.rewardSide).toBe('T');
    expect(round.quoteSymbol).toBe('WETH-DEMO');
    expect(round.typeLabel).toBe('Token');
    expect(round.showcase).toBe(false);
  });

  it('keeps unavailable metrics null (rendered as "Not available"), never $0', () => {
    const unpriced = view(byName('NO PRICE YET'));
    expect(unpriced.marketCap).toBeNull();
    expect(unpriced.turnover24h).toBeNull();
    expect(unpriced.lifecycleLabel).toBe('Bonding curve');
  });

  it('formats small values and minutes', () => {
    const fresh = view(byName('NEW SHAPE'));
    expect(fresh.marketCap).toBe('$1K');
    expect(fresh.turnover24h).toBe('$850');
    expect(fresh.age).toBe('15m');
    expect(view(byName('COIN CONFETTI')).age).toBe('2h');
  });

  it('measures age against the injected snapshot time, not the wall clock', () => {
    expect(view(byName('NEW SHAPE'), '2026-09-25T12:05:00Z').age).toBe('20m');
  });

  it('shows "Ticker not set" for the unset root ticker', () => {
    const platform = view(byName('Square Hole'));
    expect(platform.symbol).toBe('Ticker not set');
    expect(platform.symbolUnset).toBe(true);
    expect(platform.rewardText).toBe('Fee share in USDC-DEMO');
    expect(platform.showcase).toBe(false);
  });

  it('canonicalises a mixed-case pair id for data-pair-id and the detail route', () => {
    const orchard = byName('ORCHARD');
    const mixed = { ...orchard, pairId: '31337:0x00000000000000000000000000000000000000AB' } as PairRecord;
    expect(view(mixed).pairId).toBe('31337:0x00000000000000000000000000000000000000ab');
    expect(view(mixed).href).toBe('/pair/31337/0x00000000000000000000000000000000000000ab');
  });

  it('never throws on a launch after the snapshot time: age is unavailable instead', () => {
    expect(view(byName('NEW SHAPE'), '2026-09-25T11:00:00Z').age).toBeNull();
  });

  it('describes a T reward on an unset ticker without inventing one', () => {
    const platform = byName('Square Hole');
    expect(view({ ...platform, rewardSide: 'T' }).rewardText).toBe('Fee share in its own token');
  });

  it('marks the showcase by exact pair identity, not by name', () => {
    const impostor = { ...byName('ROUND TRIP'), name: 'ORCHARD', symbol: 'ORCH' };
    expect(view(impostor).showcase).toBe(false);
  });
});

const AAPLX = '0x0000000000000000000000000000000000002329';
const withQuery = (pair: PairRecord, query: string) => toPairView(pair, { asOf: ASOF, links, query });

describe('search match kind (FEED-04: address matches are labelled)', () => {
  it('labels address matches by what the address is, and leaves name/symbol matches unlabelled', () => {
    const orchard = byName('ORCHARD');
    expect(withQuery(orchard, AAPLX.toUpperCase().replace('0X', '0x'))).toMatchObject({ matchKind: 'quote', matchLabel: 'Quote address' });
    expect(withQuery(orchard, '0x00000000000000000000000000000000000003ea')).toMatchObject({ matchKind: 'token', matchLabel: 'Token address' });
    expect(withQuery(orchard, '0x00000000000000000000000000000000000007d2')).toMatchObject({ matchKind: 'mirror', matchLabel: 'NFT mirror address' });
    expect(withQuery(orchard, '0x0000000000000000000000000000000000000066')).toMatchObject({ matchKind: 'pair', matchLabel: 'Pair id' });
    expect(withQuery(orchard, 'orch')).toMatchObject({ matchKind: 'name', matchLabel: null });
    expect(withQuery(orchard, '')).toMatchObject({ matchKind: null, matchLabel: null });
    expect(view(orchard)).toMatchObject({ matchKind: null, matchLabel: null });
  });

  it('a hostile name that contains the address is a name match, not an address match', () => {
    const spoof = { ...byName('ROUND TRIP'), name: `fake ${AAPLX}` };
    expect(withQuery(spoof, AAPLX)).toMatchObject({ matchKind: 'name', matchLabel: null });
  });

  it('summarises an address search by match kind for the results bar', () => {
    const quoteRows = ['ORCHARD', 'APPLEHOLE', 'WRONG ANGLE', 'LITTLE ORCHARD', 'NO PRICE YET'].map((name) => withQuery(byName(name), AAPLX));
    expect(describeAddressMatches(quoteRows, AAPLX)).toBe('5 pairs paired with this quote address (AAPLx-DEMO)');
    const spoof = withQuery({ ...byName('ROUND TRIP'), name: `fake ${AAPLX}` }, AAPLX);
    expect(describeAddressMatches([...quoteRows, spoof], AAPLX)).toBe(
      '5 pairs paired with this quote address (AAPLx-DEMO) · 1 pair only by name or ticker text',
    );
    const token = withQuery(byName('ORCHARD'), '0x00000000000000000000000000000000000003ea');
    expect(describeAddressMatches([token], '0x00000000000000000000000000000000000003ea')).toBe('1 pair with this token address (ORCH)');
  });

  it('adds no summary for a text search or an empty result', () => {
    expect(describeAddressMatches([withQuery(byName('ORCHARD'), 'orch')], 'orch')).toBeNull();
    expect(describeAddressMatches([], AAPLX)).toBeNull();
    expect(describeAddressMatches([view(byName('ORCHARD'))], '')).toBeNull();
  });
});

describe('displaySymbol', () => {
  it('replaces the unset demo ticker and keeps everything else as text', () => {
    expect(displaySymbol('UNSET-DEMO')).toBe('Ticker not set');
    expect(displaySymbol('ORCH')).toBe('ORCH');
    expect(displaySymbol('<b>x</b>')).toBe('<b>x</b>');
  });
});

describe('formatAsOf', () => {
  it('formats in UTC, deterministically', () => {
    expect(formatAsOf('2026-09-25T12:00:00Z')).toBe('25 Sep 2026, 12:00 UTC');
    expect(formatAsOf('2026-09-25T10:00:00Z')).toBe('25 Sep 2026, 10:00 UTC');
    expect(formatAsOf('2026-01-02T03:04:05+02:00')).toBe('2 Jan 2026, 01:04 UTC');
  });

  it('returns null for a malformed timestamp', () => {
    expect(formatAsOf('yesterday')).toBeNull();
  });
});

describe('formatPairCount and formatHolders', () => {
  it('pluralises the organic count', () => {
    expect(formatPairCount(0)).toBe('0 pairs');
    expect(formatPairCount(1)).toBe('1 pair');
    expect(formatPairCount(11)).toBe('11 pairs');
    expect(formatPairCount(1234)).toBe('1,234 pairs');
  });

  it('groups holder counts and keeps null unavailable', () => {
    expect(formatHolders(105)).toBe('105');
    expect(formatHolders(24391)).toBe('24,391');
    expect(formatHolders(null)).toBeNull();
    expect(formatHolders(-1)).toBeNull();
    expect(formatHolders(1.5)).toBeNull();
  });
});
