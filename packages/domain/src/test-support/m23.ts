/**
 * Test-only builders for ADR-0008 contract values, derived from the handoff feed fixture. Every call returns a fresh,
 * independent, VALID value (safe to mutate in a test). Amounts mirror packages/providers/src/fixtures/accounts.json.
 */
import type { AssetRegistryEntry, ClaimView, PairDetail, PairRecord, Position, Provenance } from '../types';
import { handoffFixture } from './handoff';

export const AS_OF = '2026-09-25T12:00:00Z';
export const CURRENT_HOLDER = '0x00000000000000000000000000000000de000001';
export const PAST_HOLDER = '0x00000000000000000000000000000000de000002';
export const DEMO_PROVENANCE: Provenance = { state: 'mock', asOf: AS_OF, blockNumber: '39600', source: 'test builder (demo)', coverage: 'demo' };

const WHOLE = 10n ** 18n;
export const t = (whole: bigint | number): string => (BigInt(whole) * WHOLE).toString();

export function feedPair(slug: string): PairRecord {
  const pair = handoffFixture().items.find((item) => item.slug === slug);
  if (!pair) throw new Error(`no fixture pair ${slug}`);
  return pair;
}

const feeTerms = (): PairDetail['feeTerms'] => ({
  policyId: 'BURN_NATIVE_T_ROUTE_Q_V1',
  status: 'draft',
  headlineFeeTargetBps: 300,
  qProtocolShare: { num: 1, den: 3 },
});

/** ORCHARD (nft_collection, R = Q): gallery, observed history with a gap, per-asset rewards and demo activity. */
export function orchardDetail(): PairDetail {
  const pair = feedPair('orchard');
  return structuredClone<PairDetail>({
    pairId: pair.pairId,
    description: 'Demo showcase collection. Not deployed; not endorsed by any issuer.',
    artwork: { state: 'ok', artId: 'orchard-hero' },
    canonicalStatus: 'demo_not_deployed',
    showcase: true,
    supply: {
      currentRaw: pair.totalSupplyRaw,
      initialCapRaw: t(260_120),
      initialCapBasis: 'demo_derived_total_plus_burned',
      feeBurnedRaw: pair.burnedRaw,
      wholeUnitCapacity: { count: '260000', basis: 'floor_current_supply_over_unit' },
      activeNftCount: null,
      circulatingRaw: pair.circulatingSupplyRaw,
      exclusionBasis: 'demo_fixture_declared',
    },
    nft: {
      mirrorAddress: pair.mirrorAddress ?? '0x',
      unitRaw: pair.nftUnitRaw ?? '0',
      gallery: [
        { tokenId: '7', artId: 'orchard-tree', name: 'ORCHARD #7', attributes: [{ trait: 'Season', value: 'Summer' }] },
        { tokenId: '58', artId: null, name: 'ORCHARD #58', attributes: [] },
      ],
    },
    priceHistory: {
      state: 'observed',
      unit: 'usd_per_t',
      points: [
        { t: '2026-09-22T12:00:00Z', priceUsd: '1.80' },
        { t: '2026-09-23T12:00:00Z', priceUsd: null },
        { t: AS_OF, priceUsd: '2.40' },
      ],
    },
    rewards: [{ asset: pair.quote, paidRaw: '13588773871356902', accruedRaw: '70186411226128643095' }],
    activity: [
      { kind: 'launch', at: pair.launchedAt, block: '18000', txHash: null, amounts: [{ asset: pair.token, amountRaw: t(260_120) }] },
      { kind: 'swap_observation', at: '2026-09-22T12:10:00Z', block: '18050', txHash: null, amounts: [{ asset: pair.token, amountRaw: t(1000) }] },
      { kind: 'claim', at: '2026-09-23T12:00:00Z', block: '25200', txHash: null, amounts: [{ asset: pair.quote, amountRaw: '13588773871356902' }] },
      { kind: 'burn', at: '2026-09-24T00:00:00Z', block: '28800', txHash: null, amounts: [{ asset: pair.token, amountRaw: t(120) }] },
    ],
    feeTerms: feeTerms(),
    provenance: { ...DEMO_PROVENANCE },
  });
}

/** ROUND TRIP (token, R = T): no NFT mirror, unavailable history, T paid / Q accrued rows. */
export function roundTripDetail(): PairDetail {
  const pair = feedPair('round-trip');
  return structuredClone<PairDetail>({
    pairId: pair.pairId,
    description: 'Demo token.',
    artwork: { state: 'ok', artId: 'shape-sphere' },
    canonicalStatus: 'demo_not_deployed',
    showcase: false,
    supply: {
      currentRaw: pair.totalSupplyRaw,
      initialCapRaw: t(510_120),
      initialCapBasis: 'demo_derived_total_plus_burned',
      feeBurnedRaw: pair.burnedRaw,
      wholeUnitCapacity: null,
      activeNftCount: null,
      circulatingRaw: pair.circulatingSupplyRaw,
      exclusionBasis: 'demo_fixture_declared',
    },
    priceHistory: { state: 'unavailable', reason: 'demo_no_history' },
    rewards: [
      { asset: pair.token, paidRaw: '0', accruedRaw: null },
      { asset: pair.quote, paidRaw: '0', accruedRaw: '1003999999999999999' },
    ],
    activity: [{ kind: 'launch', at: pair.launchedAt, block: '25200', txHash: null, amounts: [{ asset: pair.token, amountRaw: t(510_120) }] }],
    feeTerms: feeTerms(),
    provenance: { ...DEMO_PROVENANCE },
  });
}

export function orchardPosition(): Position {
  return {
    pairId: feedPair('orchard').pairId,
    balanceRaw: '3250000000000000000',
    wholeNftCount: '3',
    fractionalRaw: '250000000000000000',
    nftTokenIds: ['7', '12', '31'],
  };
}

export function roundTripPosition(): Position {
  return { pairId: feedPair('round-trip').pairId, balanceRaw: t(1500), wholeNftCount: null, fractionalRaw: null, nftTokenIds: [] };
}

/** ORCHARD (R = Q) claim for the current holder: claimable + one settled claim + pending harvest. */
export function orchardClaim(): ClaimView {
  const pair = feedPair('orchard');
  return structuredClone<ClaimView>({
    owner: CURRENT_HOLDER,
    pairId: pair.pairId,
    rewardSide: 'Q',
    earnedQRaw: '14400438949530922',
    pendingHarvestQRaw: '10400000000000',
    estimatedPayoutRaw: '811665078174020',
    payoutAsset: pair.quote,
    conversionAvailable: false,
    directSourceFallbackAvailable: false,
    provenance: { ...DEMO_PROVENANCE },
    claimableQRaw: '811665078174020',
    claimedQRaw: '13588773871356902',
    convertibleEstimate: null,
    asOfBlock: '39600',
    history: [
      {
        at: '2026-09-23T12:00:00Z',
        block: '25200',
        qConsumedRaw: '13588773871356902',
        payoutRaw: '13588773871356902',
        payoutAsset: pair.quote,
        outcome: 'settled',
      },
    ],
    directSourceFallback: null,
  });
}

/** TINY FRAMES (R = T) claim for the past holder: zero balance, convertible estimate, settled + reverted history. */
export function framesClaim(): ClaimView {
  const pair = feedPair('tiny-frames');
  return structuredClone<ClaimView>({
    owner: PAST_HOLDER,
    pairId: pair.pairId,
    rewardSide: 'T',
    earnedQRaw: '331574883741628284',
    pendingHarvestQRaw: '0',
    estimatedPayoutRaw: '163149767483256568000',
    payoutAsset: pair.token,
    estimateAsOf: AS_OF,
    conversionAvailable: true,
    directSourceFallbackAvailable: false,
    provenance: { ...DEMO_PROVENANCE },
    claimableQRaw: '81574883741628284',
    claimedQRaw: '250000000000000000',
    convertibleEstimate: {
      payoutRaw: '163149767483256568000',
      tPerQ: '2000',
      source: 'demo_quote',
      asOfBlock: '39600',
      deadline: '2026-09-25T12:20:00Z',
      minPayoutRaw: '161518269808424002320',
      toleranceBps: 100,
    },
    asOfBlock: '39600',
    history: [
      { at: '2026-09-25T03:00:00Z', block: '36900', qConsumedRaw: '250000000000000000', payoutRaw: t(500), payoutAsset: pair.token, outcome: 'settled' },
      {
        at: '2026-09-25T08:00:00Z',
        block: '38400',
        qConsumedRaw: '0',
        payoutRaw: '0',
        payoutAsset: pair.token,
        outcome: 'reverted',
        reason: 'min_payout_not_met',
      },
    ],
    directSourceFallback: null,
  });
}

/** The same claim in the `conversion_fails` shape: no estimate, labelled emergency direct-Q fallback. */
export function framesClaimConversionFails(): ClaimView {
  const claim = framesClaim();
  const pair = feedPair('tiny-frames');
  const rest: ClaimView = { ...claim };
  delete rest.estimateAsOf;
  return {
    ...rest,
    conversionAvailable: false,
    convertibleEstimate: null,
    estimatedPayoutRaw: null,
    directSourceFallbackAvailable: true,
    directSourceFallback: { label: 'emergency_direct_source_q', payoutAsset: pair.quote, payoutRaw: claim.claimableQRaw },
  };
}

export function supportedEntry(slug = 'misfit-studio'): AssetRegistryEntry {
  return { asset: feedPair(slug).quote, issuerFamily: 'Demo stablecoin', admission: 'supported_demo', provenance: { ...DEMO_PROVENANCE } };
}

export function rejectedEntry(): AssetRegistryEntry {
  return {
    asset: {
      chainId: 31337,
      address: '0x0000000000000000000000000000000000002328',
      symbol: 'AAPLx-V1-DEMO',
      decimals: 18,
      issuerStatus: 'mock',
      underlyingAddress: '0x000000000000000000000000000000000000238d',
      wrapperVersion: 'mock-legacy-v1',
    },
    issuerFamily: 'Demo tokenized-stock wrapper',
    admission: 'rejected',
    rejection: { gate: 'G06', reason: 'Legacy wrapper v1 (mock): G06 rejects legacy xStocks wrappers.' },
    provenance: { ...DEMO_PROVENANCE },
  };
}
