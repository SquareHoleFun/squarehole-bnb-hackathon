import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccountQueryError,
  IdentityError,
  TimeError,
  canonicalPairId,
  parseFeedFixture,
  splitWholeUnits,
  validateAccountClaims,
  validateAccountPositions,
  type Address,
  type ClaimView,
  type PairId,
  type PairRecord,
} from '@squarehole/domain';
import fixtureJson from '../fixtures/feed.json';
import { ProviderUnavailableError } from '../errors';
import { DEMO_PERSONAS, MOCK_ACCOUNT_SCENARIOS, createMockAccountProvider } from '../index';
import { expectAbortError, pid, settles } from '../test-support';

const feed = parseFeedFixture(fixtureJson);
const PAIRS = new Map(feed.items.map((pair) => [canonicalPairId(pair.pairId), pair]));
const pairOf = (pairId: string): PairRecord => {
  const pair = PAIRS.get(canonicalPairId(pairId));
  if (!pair) throw new Error('unknown pair');
  return pair;
};
const ORCHARD = pid('66');
const ROUND_TRIP = pid('67');
const TINY_FRAMES = pid('6a');
const address = (id: string): Address => {
  const persona = DEMO_PERSONAS.find((p) => p.id === id);
  if (!persona) throw new Error(id);
  return persona.address;
};
const CURRENT = address('current_holder');
const PAST = address('past_holder');
const NEVER = address('never_held');
const claimFor = (claims: readonly ClaimView[], pairId: PairId): ClaimView | undefined => claims.find((claim) => claim.pairId === pairId);

afterEach(() => {
  vi.useRealTimers();
});

describe('demo personas', () => {
  it('exposes three labelled demo personas with synthetic addresses', () => {
    expect(DEMO_PERSONAS.map((p) => [p.id, p.label])).toEqual([
      ['current_holder', 'Demo persona: current holder'],
      ['past_holder', 'Demo persona: past holder'],
      ['never_held', 'Demo persona: never held'],
    ]);
    expect(Object.isFrozen(DEMO_PERSONAS)).toBe(true);
    const provider = createMockAccountProvider();
    expect(provider.mode).toBe('demo');
    expect(provider.scenario).toBe('default');
    expect(MOCK_ACCOUNT_SCENARIOS).toEqual(['default', 'conversion_fails', 'unavailable', 'loading']);
  });
});

describe('(a) current holder', () => {
  it('holds whole ORCHARD NFTs plus a fraction, a fraction-only TINY FRAMES position and a token position', async () => {
    const positions = await createMockAccountProvider().listPositions(CURRENT);
    expect(validateAccountPositions(positions, PAIRS)).toEqual(positions);
    expect(positions.provenance).toMatchObject({ state: 'mock', coverage: 'demo' });
    expect(positions.positions.map((p) => p.pairId)).toEqual([ORCHARD, TINY_FRAMES, ROUND_TRIP]);
    const [orchard, frames, round] = positions.positions;
    expect(orchard).toEqual({
      pairId: ORCHARD,
      balanceRaw: '3250000000000000000',
      wholeNftCount: '3',
      fractionalRaw: '250000000000000000',
      nftTokenIds: ['7', '12', '31'],
    });
    expect(frames).toMatchObject({ wholeNftCount: '0', fractionalRaw: '500000000000000000', nftTokenIds: [] });
    expect(round).toMatchObject({ wholeNftCount: null, fractionalRaw: null, nftTokenIds: [] });
  });

  it('has claimable Q on ORCHARD (R=Q), a settled claim and a separately labelled pending harvest', async () => {
    const { claims } = await createMockAccountProvider().listClaims(CURRENT);
    const orchard = claimFor(claims, ORCHARD);
    expect(orchard).toMatchObject({ rewardSide: 'Q', conversionAvailable: false, convertibleEstimate: null, directSourceFallback: null });
    expect(BigInt(orchard?.claimableQRaw ?? '0') > 0n).toBe(true);
    expect(BigInt(orchard?.claimedQRaw ?? '0') > 0n).toBe(true);
    expect(BigInt(orchard?.pendingHarvestQRaw ?? '0') > 0n).toBe(true);
    expect(orchard?.estimatedPayoutRaw).toBe(orchard?.claimableQRaw); // pending harvest is not claimable
    expect(orchard?.history.map((entry) => entry.outcome)).toEqual(['settled']);
  });

  it('lists only non-empty claims: ROUND TRIP was bought after its fees (later buyer, no old entitlement)', async () => {
    const provider = createMockAccountProvider();
    const { claims } = await provider.listClaims(CURRENT);
    expect(claims.map((claim) => claim.pairId)).toEqual([ORCHARD, TINY_FRAMES]);
    const round = await provider.readClaim(ROUND_TRIP, CURRENT);
    expect(round).toMatchObject({ earnedQRaw: '0', claimableQRaw: '0', claimedQRaw: '0', history: [], convertibleEstimate: null, estimatedPayoutRaw: null });
  });
});

describe('(b) past holder (ECO-05)', () => {
  it('has no current positions', async () => {
    const positions = await createMockAccountProvider().listPositions(PAST);
    expect(positions.positions).toEqual([]);
  });

  it('keeps an earned-unclaimed ORCHARD claim with zero balance, and an R=T entitlement with a convertible estimate', async () => {
    const { claims } = await createMockAccountProvider().listClaims(PAST);
    expect(claims.map((claim) => claim.pairId)).toEqual([ORCHARD, TINY_FRAMES]);
    const orchard = claimFor(claims, ORCHARD);
    expect(BigInt(orchard?.claimableQRaw ?? '0') > 0n).toBe(true);
    expect(orchard?.pendingHarvestQRaw).toBe('0');
    const frames = claimFor(claims, TINY_FRAMES);
    expect(frames).toMatchObject({
      rewardSide: 'T',
      conversionAvailable: true,
      directSourceFallbackAvailable: false,
      estimateAsOf: '2026-09-25T12:00:00Z',
      convertibleEstimate: { source: 'demo_quote', tPerQ: '2000', deadline: '2026-09-25T12:20:00Z', toleranceBps: 100, asOfBlock: '39600' },
    });
    expect(frames?.payoutAsset).toEqual(pairOf(TINY_FRAMES).token);
    expect(frames?.estimatedPayoutRaw).toBe(frames?.convertibleEstimate?.payoutRaw);
    expect(frames?.history.map((entry) => [entry.outcome, entry.reason ?? null])).toEqual([
      ['settled', null],
      ['reverted', 'min_payout_not_met'],
    ]);
  });
});

describe('(c) never held', () => {
  it('has no positions, no claims and a zero claim view for any pair', async () => {
    const provider = createMockAccountProvider();
    expect((await provider.listPositions(NEVER)).positions).toEqual([]);
    expect((await provider.listClaims(NEVER)).claims).toEqual([]);
    const orchard = await provider.readClaim(ORCHARD, NEVER);
    expect(orchard).toMatchObject({ earnedQRaw: '0', claimableQRaw: '0', claimedQRaw: '0', pendingHarvestQRaw: '0', estimatedPayoutRaw: '0', history: [] });
    const unledgered = await provider.readClaim(pid('6b'), NEVER);
    expect(unledgered).toMatchObject({ claimableQRaw: '0', rewardSide: 'Q', payoutAsset: pairOf(pid('6b')).quote });
  });
});

describe('every served view is valid and honest', () => {
  it.each(MOCK_ACCOUNT_SCENARIOS.filter((s) => s !== 'unavailable' && s !== 'loading'))('%s: all personas x all pairs validate (ECO-04 reward side)', async (scenario) => {
    const provider = createMockAccountProvider({ scenario });
    for (const persona of DEMO_PERSONAS) {
      const claims = await provider.listClaims(persona.address);
      expect(validateAccountClaims(claims, PAIRS, { asOf: '2026-09-25T12:00:00Z' })).toEqual(claims);
      for (const pair of feed.items) {
        const claim = await provider.readClaim(pair.pairId, persona.address);
        expect(claim.rewardSide).toBe(pair.rewardSide);
        expect(claim.provenance).toMatchObject({ state: 'mock', coverage: 'demo', blockNumber: '39600' });
        expect(claim.asOfBlock).toBe('39600');
        expect(validateAccountClaims({ ...claims, claims: [claim] }, PAIRS, { asOf: '2026-09-25T12:00:00Z' }).claims[0]).toEqual(claim);
      }
    }
  });

  it('returns deeply frozen data', async () => {
    const claims = await createMockAccountProvider().listClaims(PAST);
    expect(Object.isFrozen(claims)).toBe(true);
    expect(Object.isFrozen(claims.claims[0]?.history)).toBe(true);
    const positions = await createMockAccountProvider().listPositions(CURRENT);
    expect(Object.isFrozen(positions.positions[0]?.nftTokenIds)).toBe(true);
  });

  it('matches a position to its whole-unit split exactly', async () => {
    const { positions } = await createMockAccountProvider().listPositions(CURRENT);
    for (const position of positions) {
      const pair = pairOf(position.pairId);
      if (pair.nftUnitRaw === undefined) continue;
      const { whole, fraction } = splitWholeUnits(BigInt(position.balanceRaw), BigInt(pair.nftUnitRaw));
      expect([position.wholeNftCount, position.fractionalRaw]).toEqual([whole.toString(), fraction.toString()]);
    }
  });

  it('accepts account addresses in any case and pair ids in any case', async () => {
    const provider = createMockAccountProvider();
    const upper = `0x${PAST.slice(2).toUpperCase()}` as Address;
    const claim = await provider.readClaim(`31337:0x${'6A'.padStart(40, '0')}` as PairId, upper);
    expect(claim.pairId).toBe(TINY_FRAMES);
    expect(claim.owner).toBe(PAST);
  });
});

describe('scenario hooks', () => {
  it('conversion_fails: R=T claims switch to the labelled emergency direct-Q fallback; R=Q unchanged', async () => {
    const { claims } = await createMockAccountProvider({ scenario: 'conversion_fails' }).listClaims(PAST);
    const frames = claimFor(claims, TINY_FRAMES);
    expect(frames).toMatchObject({
      conversionAvailable: false,
      convertibleEstimate: null,
      estimatedPayoutRaw: null,
      directSourceFallbackAvailable: true,
      directSourceFallback: { label: 'emergency_direct_source_q', payoutAsset: pairOf(TINY_FRAMES).quote, payoutRaw: frames?.claimableQRaw },
    });
    expect(frames).not.toHaveProperty('estimateAsOf');
    // ECO-07: the entitlement itself is untouched by a failing conversion route.
    const normal = claimFor((await createMockAccountProvider().listClaims(PAST)).claims, TINY_FRAMES);
    expect([frames?.claimableQRaw, frames?.claimedQRaw, frames?.earnedQRaw]).toEqual([normal?.claimableQRaw, normal?.claimedQRaw, normal?.earnedQRaw]);
    const orchard = claimFor(claims, ORCHARD);
    expect(orchard).toMatchObject({ directSourceFallbackAvailable: false, directSourceFallback: null });
  });

  it('unavailable: every read rejects with ProviderUnavailableError (never a zero balance)', async () => {
    const provider = createMockAccountProvider({ scenario: 'unavailable' });
    await expect(provider.listPositions(CURRENT)).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(provider.listClaims(CURRENT)).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(provider.readClaim(ORCHARD, CURRENT)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('loading: stays pending until aborted', async () => {
    const controller = new AbortController();
    const read = createMockAccountProvider({ scenario: 'loading' }).listClaims(CURRENT, controller.signal);
    expect(await settles(read)).toBe(false);
    controller.abort();
    await expectAbortError(read);
  });

  it('honours an already aborted signal and aborts during latency', async () => {
    vi.useFakeTimers();
    const aborted = new AbortController();
    aborted.abort();
    await expectAbortError(createMockAccountProvider().listClaims(CURRENT, aborted.signal));
    const controller = new AbortController();
    const read = createMockAccountProvider({ latencyMs: 500 }).listPositions(CURRENT, controller.signal);
    controller.abort();
    await expectAbortError(read);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('injected clock', () => {
  it('drops an expired quote: after the deadline there is no estimate (conversion still available)', async () => {
    const provider = createMockAccountProvider({ now: () => '2026-09-25T12:20:00Z' });
    const frames = await provider.readClaim(TINY_FRAMES, PAST);
    expect(frames).toMatchObject({ conversionAvailable: true, convertibleEstimate: null, estimatedPayoutRaw: null });
    expect(frames).not.toHaveProperty('estimateAsOf');
    const before = await createMockAccountProvider({ now: () => '2026-09-25T12:19:59Z' }).readClaim(TINY_FRAMES, PAST);
    expect(before.convertibleEstimate).not.toBeNull();
  });

  it('rejects a clock before the demo data or a malformed clock', async () => {
    await expect(createMockAccountProvider({ now: () => '2026-09-25T11:59:59Z' }).listClaims(PAST)).rejects.toBeInstanceOf(RangeError);
    await expect(createMockAccountProvider({ now: () => 'now' }).listClaims(PAST)).rejects.toBeInstanceOf(TimeError);
  });

  it('never reads the wall clock', async () => {
    vi.useFakeTimers({ now: new Date('2031-01-01T00:00:00Z') });
    const frames = await createMockAccountProvider().readClaim(TINY_FRAMES, PAST);
    expect(frames.convertibleEstimate).not.toBeNull();
  });
});

describe('input validation', () => {
  it('rejects malformed ids and unknown pairs with typed errors', async () => {
    const provider = createMockAccountProvider();
    await expect(provider.readClaim('31337:0x12' as PairId, CURRENT)).rejects.toBeInstanceOf(IdentityError);
    await expect(provider.readClaim(ORCHARD, '0x12' as Address)).rejects.toBeInstanceOf(IdentityError);
    await expect(provider.listClaims('0xzz' as Address)).rejects.toBeInstanceOf(IdentityError);
    await expect(provider.readClaim(pid('99'), CURRENT)).rejects.toBeInstanceOf(AccountQueryError);
    await expect(provider.readClaim(`1:0x${'66'.padStart(40, '0')}` as PairId, CURRENT)).rejects.toBeInstanceOf(AccountQueryError);
  });

  it('rejects unknown scenarios and invalid latency at construction', () => {
    expect(() => createMockAccountProvider({ scenario: 'bogus' as 'default' })).toThrow(RangeError);
    expect(() => createMockAccountProvider({ latencyMs: -1 })).toThrow(RangeError);
  });
});
