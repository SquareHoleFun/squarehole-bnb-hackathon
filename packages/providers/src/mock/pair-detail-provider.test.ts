import { describe, expect, it } from 'vitest';
import { IdentityError, canonicalPairId, parseFeedFixture, validatePairDetail, type FeedProvider, type PairId } from '@squarehole/domain';
import feedJson from '../fixtures/feed.json';
import detailsJson from '../fixtures/pair-details.json';
import { ProviderUnavailableError } from '../errors';
import { MOCK_SCENARIOS, createMockFeedProvider } from '../index';
import { expectAbortError, pid, query, settles } from '../test-support';

const feed = parseFeedFixture(feedJson);
const ORCHARD = pid('66');

describe('FeedProvider.readPairDetail (mock, SH-012)', () => {
  it('is implemented by the mock (optional on the FeedProvider contract)', () => {
    const provider: FeedProvider = createMockFeedProvider();
    expect(typeof provider.readPairDetail).toBe('function');
  });

  it('serves the fixture detail for every feed pair, validated against its record', async () => {
    const provider = createMockFeedProvider();
    for (const pair of feed.items) {
      const detail = await provider.readPairDetail(pair.pairId);
      expect(detail).not.toBeNull();
      expect(validatePairDetail(detail, pair, { asOf: feed.asOf })).toEqual(detail);
      expect(detail).toEqual(detailsJson.details.find((d) => d.pairId === pair.pairId));
    }
  });

  it('returns deeply frozen data', async () => {
    const detail = await createMockFeedProvider().readPairDetail(ORCHARD);
    expect(Object.isFrozen(detail)).toBe(true);
    expect(Object.isFrozen(detail?.nft?.gallery[0]?.attributes)).toBe(true);
  });

  it('is case-insensitive on the address; unknown ids and other chains are null; malformed ids reject', async () => {
    const provider = createMockFeedProvider();
    expect((await provider.readPairDetail(`31337:0x${'6A'.padStart(40, '0')}` as PairId))?.pairId).toBe(pid('6a'));
    expect(await provider.readPairDetail(pid('99'))).toBeNull();
    expect(await provider.readPairDetail(`1:0x${'66'.padStart(40, '0')}` as PairId)).toBeNull();
    await expect(provider.readPairDetail('31337:0x66' as PairId)).rejects.toBeInstanceOf(IdentityError);
  });

  it('unavailable rejects; loading stays pending until aborted', async () => {
    await expect(createMockFeedProvider({ scenario: 'unavailable' }).readPairDetail(ORCHARD)).rejects.toBeInstanceOf(ProviderUnavailableError);
    const controller = new AbortController();
    const read = createMockFeedProvider({ scenario: 'loading' }).readPairDetail(ORCHARD, controller.signal);
    expect(await settles(read)).toBe(false);
    controller.abort();
    await expectAbortError(read);
  });

  it('stale: a launch after the snapshot is absent, history/activity end at the snapshot asOf, provenance is stale', async () => {
    const provider = createMockFeedProvider({ scenario: 'stale' });
    expect(await provider.readPairDetail(pid('70'))).toBeNull();
    const detail = await provider.readPairDetail(ORCHARD);
    expect(detail?.provenance).toMatchObject({ state: 'stale', asOf: '2026-09-25T10:00:00Z' });
    if (detail?.priceHistory.state !== 'observed') throw new Error('expected observed history');
    expect(detail.priceHistory.points.every((point) => point.t <= '2026-09-25T10:00:00Z')).toBe(true);
    expect(detail.activity.every((row) => row.at <= '2026-09-25T10:00:00Z')).toBe(true);
  });

  it('partial: curve-stage pairs carry partial provenance; the rest stay mock', async () => {
    const provider = createMockFeedProvider({ scenario: 'partial' });
    expect((await provider.readPairDetail(pid('6b')))?.provenance).toMatchObject({ state: 'partial', coverage: 'partial' });
    expect((await provider.readPairDetail(ORCHARD))?.provenance).toMatchObject({ state: 'mock', coverage: 'demo' });
  });

  it.each(MOCK_SCENARIOS.filter((s) => s !== 'unavailable' && s !== 'loading'))('%s: every served detail validates against the served record', async (scenario) => {
    const provider = createMockFeedProvider({ scenario });
    await provider.readFeed(query());
    const head = await provider.latestSnapshot();
    for (const pair of feed.items) {
      const record = await provider.readPair(pair.pairId);
      const detail = await provider.readPairDetail(pair.pairId);
      expect(detail === null).toBe(record === null);
      if (record && detail) {
        expect(canonicalPairId(detail.pairId)).toBe(canonicalPairId(record.pairId));
        expect(validatePairDetail(detail, record, { asOf: head.asOf })).toEqual(detail);
      }
    }
  });
});
