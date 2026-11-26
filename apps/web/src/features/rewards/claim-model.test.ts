import { canonicalPairId, type AccountClaims, type ClaimView } from '@squarehole/domain';
import { DEMO_PERSONAS, createMockAccountProvider, mockTxHash } from '@squarehole/providers';
import { describe, expect, it } from 'vitest';
import { fixturePair } from '../../test-support/fixture';
import {
  claimActionOf,
  claimButtonLabel,
  claimDeadline,
  claimRequestLabel,
  countClaims,
  demoSettlementOf,
  isQuoteExpired,
  isStartable,
  settledClaimOf,
  withoutQuote,
} from './claim-model';

const address = (id: string) => DEMO_PERSONAS.find((persona) => persona.id === id)?.address ?? '0x00000000000000000000000000000000de000009';
const CURRENT = address('current_holder');
const PAST = address('past_holder');
const ORCHARD = fixturePair('ORCHARD');
const FRAMES = fixturePair('TINY FRAMES');
const ROUND = fixturePair('ROUND TRIP');
const pick = (claims: AccountClaims, pairId: string): ClaimView => {
  const found = claims.claims.find((claim) => canonicalPairId(claim.pairId) === canonicalPairId(pairId));
  if (!found) throw new Error(`no claim for ${pairId}`);
  return found;
};

describe('claimActionOf: what a claim card offers', () => {
  it('R=Q: claims the whole claimable Q (past holder, zero balance)', async () => {
    const claim = pick(await createMockAccountProvider().listClaims(PAST), ORCHARD.pairId);
    const action = claimActionOf(claim);
    expect(action).toEqual({ kind: 'claim_q', payoutRaw: '9705953902720970302', payoutAsset: ORCHARD.quote });
    expect(isStartable(action)).toBe(true);
    expect(claimButtonLabel(action, ORCHARD)).toBe('Claim 9.705953 AAPLx-DEMO');
    expect(claimRequestLabel(action, ORCHARD)).toBe('Claim ORCHARD fee share');
    expect(claimDeadline(action)).toBeUndefined();
  });

  it('R=T with a current quote: claim as T, with the quote deadline', async () => {
    const claim = pick(await createMockAccountProvider().listClaims(PAST), FRAMES.pairId);
    const action = claimActionOf(claim);
    expect(action.kind).toBe('claim_t');
    expect(claimButtonLabel(action, FRAMES)).toBe('Claim as FRAME');
    expect(claimRequestLabel(action, FRAMES)).toBe('Claim TINY FRAMES fee share as FRAME');
    expect(claimDeadline(action)).toBe('2026-09-25T12:20:00Z');
  });

  it('R=T after the quote deadline: waits for a current quote (no request can start)', async () => {
    const claim = pick(await createMockAccountProvider({ now: () => '2026-09-25T12:20:00Z' }).listClaims(PAST), FRAMES.pairId);
    const action = claimActionOf(claim);
    expect(action).toEqual({ kind: 'needs_quote' });
    expect(isStartable(action)).toBe(false);
    expect(claimButtonLabel(action, FRAMES)).toBe('Waiting for a current quote');
  });

  it('a quote known to be stale is not an estimate: claim_t becomes needs_quote, other actions are unchanged', async () => {
    const claims = await createMockAccountProvider().listClaims(PAST);
    const frames = claimActionOf(pick(claims, FRAMES.pairId));
    expect(withoutQuote(frames)).toEqual({ kind: 'needs_quote' });
    expect(isStartable(withoutQuote(frames))).toBe(false);
    const orchard = claimActionOf(pick(claims, ORCHARD.pairId));
    expect(withoutQuote(orchard)).toBe(orchard);
  });

  it('isQuoteExpired: at or after the deadline on the given clock, never for a claim without a quote', async () => {
    const claims = await createMockAccountProvider().listClaims(PAST);
    const frames = pick(claims, FRAMES.pairId);
    const deadline = Date.parse('2026-09-25T12:20:00Z');
    expect(isQuoteExpired(frames, deadline - 1)).toBe(false);
    expect(isQuoteExpired(frames, deadline)).toBe(true);
    expect(isQuoteExpired(pick(claims, ORCHARD.pairId), deadline + 60_000)).toBe(false);
  });

  it('R=T whose minimum rounds to zero is dust: nothing can start, so the entitlement is never consumed for 0 T (ECO-15)', async () => {
    const claim = pick(await createMockAccountProvider().listClaims(PAST), FRAMES.pairId);
    const estimate = claim.convertibleEstimate;
    if (!estimate) throw new Error('fixture has an estimate');
    const dust: ClaimView = { ...claim, convertibleEstimate: { ...estimate, payoutRaw: '1', minPayoutRaw: '0' }, estimatedPayoutRaw: '1' };
    const action = claimActionOf(dust);
    expect(action).toEqual({ kind: 'too_small' });
    expect(isStartable(action)).toBe(false);
    expect(claimButtonLabel(action, FRAMES)).toBe('Too small to convert');
    expect(claimDeadline(action)).toBeUndefined();
    expect(settledClaimOf(dust, action)).toBeNull();
  });

  it('conversion unavailable: the labelled emergency settlement pays Q directly', async () => {
    const claim = pick(await createMockAccountProvider({ scenario: 'conversion_fails' }).listClaims(PAST), FRAMES.pairId);
    const action = claimActionOf(claim);
    expect(action.kind).toBe('fallback');
    expect(claimButtonLabel(action, FRAMES)).toBe('Claim 0.081574 WETH-DEMO directly');
    expect(claimRequestLabel(action, FRAMES)).toBe('Emergency claim: TINY FRAMES fee share in WETH-DEMO');
  });

  it('the fallback is never offered while the conversion is available, even if a fallback object is present', async () => {
    const claim = pick(await createMockAccountProvider().listClaims(PAST), FRAMES.pairId);
    const odd: ClaimView = {
      ...claim,
      directSourceFallbackAvailable: true,
      directSourceFallback: { label: 'emergency_direct_source_q', payoutAsset: FRAMES.quote, payoutRaw: claim.claimableQRaw },
    };
    expect(claimActionOf(odd).kind).toBe('claim_t');
    expect(claimActionOf({ ...odd, convertibleEstimate: null, estimatedPayoutRaw: null }).kind).toBe('needs_quote');
    expect(claimActionOf({ ...odd, conversionAvailable: false, directSourceFallbackAvailable: false, directSourceFallback: null }).kind).toBe('blocked');
  });

  it('zero claimable: "Nothing claimable yet", even with pending harvest (never claimable)', async () => {
    const claim = await createMockAccountProvider().readClaim(ROUND.pairId, CURRENT);
    const action = claimActionOf(claim);
    expect(action).toEqual({ kind: 'nothing' });
    expect(claimButtonLabel(action, ROUND)).toBe('Nothing claimable yet');
    const pendingOnly: ClaimView = { ...claim, pendingHarvestQRaw: '1000' };
    expect(claimActionOf(pendingOnly)).toEqual({ kind: 'nothing' });
  });
});

describe('what a finalized request settles', () => {
  it('R=Q consumes and pays the claimable Q; R=T pays the quoted T and credits the position; fallback pays Q', async () => {
    const provider = createMockAccountProvider();
    const orchard = pick(await provider.listClaims(PAST), ORCHARD.pairId);
    expect(settledClaimOf(orchard, claimActionOf(orchard))).toEqual({
      qConsumedRaw: '9705953902720970302',
      payoutRaw: '9705953902720970302',
      payoutAsset: ORCHARD.quote,
      paysPairToken: false,
    });
    const frames = pick(await provider.listClaims(PAST), FRAMES.pairId);
    const settlement = demoSettlementOf(frames, claimActionOf(frames), FRAMES, { hash: mockTxHash(1), block: '39601' });
    expect(settlement).toEqual({
      owner: PAST,
      pairId: FRAMES.pairId,
      qConsumedRaw: '81574883741628284',
      payoutRaw: '163149767483256568000',
      payoutAsset: FRAMES.token,
      tokenCredit: { type: 'nft_collection', nftUnitRaw: FRAMES.nftUnitRaw },
      block: '39601',
      hash: mockTxHash(1),
    });
    const failing = pick(await createMockAccountProvider({ scenario: 'conversion_fails' }).listClaims(PAST), FRAMES.pairId);
    expect(demoSettlementOf(failing, claimActionOf(failing), FRAMES, { hash: mockTxHash(1), block: '39601' })).toMatchObject({
      payoutAsset: FRAMES.quote,
      payoutRaw: '81574883741628284',
      tokenCredit: null,
    });
    expect(demoSettlementOf(frames, { kind: 'nothing' }, FRAMES, { hash: mockTxHash(1), block: '39601' })).toBeNull();
  });
});

describe('countClaims: counts only, never a sum across assets', () => {
  it('counts claimable, pending-harvest and previously claimed pairs per persona', async () => {
    const provider = createMockAccountProvider();
    expect(countClaims((await provider.listClaims(CURRENT)).claims)).toEqual({ claimable: 2, pendingHarvest: 2, claimedBefore: 1 });
    expect(countClaims((await provider.listClaims(PAST)).claims)).toEqual({ claimable: 2, pendingHarvest: 0, claimedBefore: 1 });
    expect(countClaims((await provider.listClaims(address('never_held'))).claims)).toEqual({ claimable: 0, pendingHarvest: 0, claimedBefore: 0 });
  });
});
