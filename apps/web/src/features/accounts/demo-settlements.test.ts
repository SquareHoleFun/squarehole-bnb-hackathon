import {
  canonicalPairId,
  validateAccountClaims,
  validateAccountPositions,
  type AccountClaims,
  type PairRecord,
} from '@squarehole/domain';
import { DEMO_PERSONAS, createMockAccountProvider, mockTxHash } from '@squarehole/providers';
import { describe, expect, it } from 'vitest';
import { fixturePair } from '../../test-support/fixture';
import {
  applySettlementsToClaims,
  applySettlementsToPositions,
  createDemoSettlementLedger,
  demoBlockTime,
  withDemoSettlements,
  type DemoSettlement,
} from './demo-settlements';

const CURRENT = DEMO_PERSONAS.find((persona) => persona.id === 'current_holder')?.address ?? '0x00000000000000000000000000000000de000001';
const PAST = DEMO_PERSONAS.find((persona) => persona.id === 'past_holder')?.address ?? '0x00000000000000000000000000000000de000002';
const ORCHARD = fixturePair('ORCHARD');
const FRAMES = fixturePair('TINY FRAMES');
const ROUND = fixturePair('ROUND TRIP');
const PAIRS = new Map<string, PairRecord>([ORCHARD, FRAMES, ROUND].map((pair) => [canonicalPairId(pair.pairId), pair]));

const claimOf = (claims: AccountClaims, pair: PairRecord) => claims.claims.find((claim) => canonicalPairId(claim.pairId) === canonicalPairId(pair.pairId));

function settlement(overrides: Partial<DemoSettlement> & Pick<DemoSettlement, 'owner' | 'pairId' | 'qConsumedRaw' | 'payoutRaw' | 'payoutAsset'>): DemoSettlement {
  return { tokenCredit: null, block: '39601', hash: mockTxHash(1), ...overrides };
}

describe('demo block clock', () => {
  it('maps a block to its demo time (genesis + 12 s x n) and rejects malformed blocks', () => {
    expect(demoBlockTime('39600')).toBe('2026-09-25T12:00:00Z');
    expect(demoBlockTime('39601')).toBe('2026-09-25T12:00:12Z');
    expect(demoBlockTime('-1')).toBeNull();
    expect(demoBlockTime('1e9')).toBeNull();
    expect(demoBlockTime('10000000001')).toBeNull();
  });
});

describe('demo settlement ledger (ECO-07: a finalized claim consumes the entitlement exactly once)', () => {
  it('R=Q past holder with zero balance (ECO-05): the whole claimable ORCHARD entitlement becomes claimed', async () => {
    const provider = createMockAccountProvider();
    const before = await provider.listClaims(PAST);
    const orchard = claimOf(before, ORCHARD);
    expect(orchard?.claimableQRaw).toBe('9705953902720970302');
    const ledger = createDemoSettlementLedger();
    expect(
      ledger.record(settlement({ owner: PAST, pairId: ORCHARD.pairId, qConsumedRaw: '9705953902720970302', payoutRaw: '9705953902720970302', payoutAsset: ORCHARD.quote })),
    ).toBe(true);
    const after = applySettlementsToClaims(before, ledger.forOwner(PAST));
    const settled = claimOf(after, ORCHARD);
    expect(settled).toMatchObject({ claimableQRaw: '0', claimedQRaw: '9705953902720970302', earnedQRaw: '9705953902720970302', estimatedPayoutRaw: '0' });
    expect(settled?.history.at(-1)).toEqual({
      at: '2026-09-25T12:00:12Z',
      block: '39601',
      qConsumedRaw: '9705953902720970302',
      payoutRaw: '9705953902720970302',
      payoutAsset: ORCHARD.quote,
      outcome: 'settled',
    });
    // The read moved to the settlement block, for every claim of the account, and says where the change came from.
    expect(after.asOfBlock).toBe('39601');
    expect(after.claims.every((claim) => claim.asOfBlock === '39601')).toBe(true);
    expect(after.provenance.source).toContain(' + claims settled in this tab');
    // Every identity of the domain contract still holds (earned = claimable + claimed; claimed = settled history; …).
    expect(() => validateAccountClaims(after, PAIRS, { asOf: '2026-09-25T12:00:12Z' })).not.toThrow();
    // The other pair is untouched.
    expect(claimOf(after, FRAMES)?.claimableQRaw).toBe(claimOf(before, FRAMES)?.claimableQRaw);
  });

  it('refuses a duplicate record (same owner, pair and hash) and a zero entitlement', () => {
    const ledger = createDemoSettlementLedger();
    const entry = settlement({ owner: PAST, pairId: ORCHARD.pairId, qConsumedRaw: '5', payoutRaw: '5', payoutAsset: ORCHARD.quote });
    expect(ledger.record(entry)).toBe(true);
    expect(ledger.record({ ...entry })).toBe(false);
    expect(ledger.record({ ...entry, pairId: FRAMES.pairId })).toBe(true); // the demo reuses hashes across requests
    expect(ledger.record({ ...entry, hash: mockTxHash(2), qConsumedRaw: '0' })).toBe(false);
    expect(ledger.record({ ...entry, hash: mockTxHash(3), block: 'soon' })).toBe(false);
    expect(ledger.forOwner(PAST)).toHaveLength(2);
    expect(ledger.forOwner(CURRENT)).toHaveLength(0);
  });

  it('never consumes more than is claimable, even if a second settlement is recorded for the same pair', async () => {
    const before = await createMockAccountProvider().listClaims(PAST);
    const ledger = createDemoSettlementLedger();
    const whole = { owner: PAST, pairId: ORCHARD.pairId, qConsumedRaw: '9705953902720970302', payoutRaw: '9705953902720970302', payoutAsset: ORCHARD.quote };
    ledger.record(settlement(whole));
    ledger.record(settlement({ ...whole, hash: mockTxHash(9), block: '39700' }));
    const settled = claimOf(applySettlementsToClaims(before, ledger.forOwner(PAST)), ORCHARD);
    expect(settled?.claimedQRaw).toBe('9705953902720970302');
    expect(settled?.history.filter((entry) => entry.block === '39700')).toEqual([]);
  });

  it('R=T: paid T is credited to the position (a new FRAME position for the past holder) and the estimate is dropped', async () => {
    const provider = createMockAccountProvider();
    const [claims, positions] = await Promise.all([provider.listClaims(PAST), provider.listPositions(PAST)]);
    expect(positions.positions).toEqual([]);
    const frames = claimOf(claims, FRAMES);
    const estimate = frames?.convertibleEstimate;
    expect(estimate?.payoutRaw).toBe('163149767483256568000');
    const ledger = createDemoSettlementLedger();
    ledger.record(
      settlement({
        owner: PAST,
        pairId: FRAMES.pairId,
        qConsumedRaw: frames?.claimableQRaw ?? '0',
        payoutRaw: estimate?.payoutRaw ?? '0',
        payoutAsset: FRAMES.token,
        tokenCredit: { type: 'nft_collection', nftUnitRaw: FRAMES.nftUnitRaw ?? null },
      }),
    );
    const afterClaims = applySettlementsToClaims(claims, ledger.forOwner(PAST));
    const settled = claimOf(afterClaims, FRAMES);
    expect(settled).toMatchObject({ claimableQRaw: '0', convertibleEstimate: null, estimatedPayoutRaw: null, conversionAvailable: true });
    expect(settled).not.toHaveProperty('estimateAsOf');
    expect(() => validateAccountClaims(afterClaims, PAIRS, { asOf: '2026-09-25T12:00:12Z' })).not.toThrow();

    const afterPositions = applySettlementsToPositions(positions, ledger.forOwner(PAST));
    expect(afterPositions.positions).toEqual([
      { pairId: FRAMES.pairId, balanceRaw: '163149767483256568000', wholeNftCount: '163', fractionalRaw: '149767483256568000', nftTokenIds: [] },
    ]);
    expect(() => validateAccountPositions(afterPositions, PAIRS)).not.toThrow();
  });

  it('emergency settlement (conversion_fails): pays Q directly, credits no T and removes the fallback', async () => {
    const provider = createMockAccountProvider({ scenario: 'conversion_fails' });
    const claims = await provider.listClaims(PAST);
    const frames = claimOf(claims, FRAMES);
    expect(frames?.directSourceFallback?.payoutRaw).toBe('81574883741628284');
    const ledger = createDemoSettlementLedger();
    ledger.record(settlement({ owner: PAST, pairId: FRAMES.pairId, qConsumedRaw: '81574883741628284', payoutRaw: '81574883741628284', payoutAsset: FRAMES.quote }));
    const settled = claimOf(applySettlementsToClaims(claims, ledger.forOwner(PAST)), FRAMES);
    expect(settled).toMatchObject({ claimableQRaw: '0', directSourceFallbackAvailable: false, directSourceFallback: null });
    expect(settled?.history.at(-1)?.payoutAsset).toEqual(FRAMES.quote);
    const positions = applySettlementsToPositions(await provider.listPositions(PAST), ledger.forOwner(PAST));
    expect(positions.positions).toEqual([]);
  });

  it('adds T to an existing NFT position without inventing NFT ids', async () => {
    const provider = createMockAccountProvider();
    const positions = await provider.listPositions(CURRENT);
    const ledger = createDemoSettlementLedger();
    ledger.record(
      settlement({
        owner: CURRENT,
        pairId: FRAMES.pairId,
        qConsumedRaw: '5483445991036',
        payoutRaw: '10966891982072000',
        payoutAsset: FRAMES.token,
        tokenCredit: { type: 'nft_collection', nftUnitRaw: FRAMES.nftUnitRaw ?? null },
      }),
    );
    const after = applySettlementsToPositions(positions, ledger.forOwner(CURRENT));
    const frames = after.positions.find((position) => canonicalPairId(position.pairId) === canonicalPairId(FRAMES.pairId));
    expect(frames).toEqual({
      pairId: FRAMES.pairId,
      balanceRaw: '510966891982072000',
      wholeNftCount: '0',
      fractionalRaw: '510966891982072000',
      nftTokenIds: [],
    });
    const orchard = after.positions.find((position) => canonicalPairId(position.pairId) === canonicalPairId(ORCHARD.pairId));
    expect(orchard?.nftTokenIds).toEqual(['7', '12', '31']);
    expect(() => validateAccountPositions(after, PAIRS)).not.toThrow();
  });

  it('withDemoSettlements wraps every read; other accounts and an empty ledger are unchanged', async () => {
    const mock = createMockAccountProvider();
    const ledger = createDemoSettlementLedger();
    const provider = withDemoSettlements(mock, ledger);
    expect(await provider.listClaims(PAST)).toEqual(await mock.listClaims(PAST));
    ledger.record(settlement({ owner: PAST, pairId: ORCHARD.pairId, qConsumedRaw: '9705953902720970302', payoutRaw: '9705953902720970302', payoutAsset: ORCHARD.quote }));
    expect((await provider.readClaim(ORCHARD.pairId, PAST)).claimableQRaw).toBe('0');
    expect(claimOf(await provider.listClaims(PAST), ORCHARD)?.claimableQRaw).toBe('0');
    expect((await provider.listPositions(PAST)).asOfBlock).toBe('39601');
    expect(await provider.listClaims(CURRENT)).toEqual(await mock.listClaims(CURRENT));
  });
});
