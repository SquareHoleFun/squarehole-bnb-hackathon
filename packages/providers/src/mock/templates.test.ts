import { describe, expect, it } from 'vitest';
import { DRAFT_FEE_TERMS, parseLaunchDraft } from '@squarehole/domain';
import { MOCK_TEMPLATES, MOCK_TEMPLATE_V0 } from '../index';

describe('MOCK_TEMPLATE_V0 (Step 3 review readout)', () => {
  it('is an unapproved mock with pending supply/curve decisions and draft fee terms', () => {
    expect(MOCK_TEMPLATE_V0).toMatchObject({
      templateId: 'MOCK_TEMPLATE_V0',
      label: 'mock template – not approved',
      approved: false,
      assetKinds: ['token', 'nft_collection'],
      supplyCap: 'template default, pending G05',
      curve: 'pending G04/ADR-0006',
      nftUnitRaw: '1000000000000000000',
    });
    expect(MOCK_TEMPLATE_V0.feeTerms).toEqual(DRAFT_FEE_TERMS);
    expect(MOCK_TEMPLATE_V0.adminPowers.length).toBeGreaterThan(0);
    for (const power of MOCK_TEMPLATE_V0.adminPowers) expect(power).toMatch(/pending|not|undetermined|no /i);
    expect(MOCK_TEMPLATES).toEqual([MOCK_TEMPLATE_V0]);
  });

  it('is frozen (no creator-editable economics)', () => {
    expect(Object.isFrozen(MOCK_TEMPLATE_V0)).toBe(true);
    expect(Object.isFrozen(MOCK_TEMPLATE_V0.adminPowers)).toBe(true);
    expect(Object.isFrozen(MOCK_TEMPLATE_V0.feeTerms)).toBe(true);
  });

  it('its NFT unit and fee terms produce a valid demo launch draft', () => {
    const draft = parseLaunchDraft({
      schemaVersion: '1.0',
      mode: 'demo',
      chainId: 31337,
      assetType: 'nft_collection',
      name: 'Template check',
      symbol: 'TMPL',
      quoteAddress: '0x0000000000000000000000000000000000002329',
      rewardSide: 'Q',
      feePolicyId: MOCK_TEMPLATE_V0.feeTerms.policyId,
      feePolicyStatus: MOCK_TEMPLATE_V0.feeTerms.status,
      headlineFeeTargetBps: MOCK_TEMPLATE_V0.feeTerms.headlineFeeTargetBps,
      qProtocolShareNumerator: MOCK_TEMPLATE_V0.feeTerms.qProtocolShare.num,
      qProtocolShareDenominator: MOCK_TEMPLATE_V0.feeTerms.qProtocolShare.den,
      nftUnitRaw: MOCK_TEMPLATE_V0.nftUnitRaw,
      metadataManifestHash: null,
      rootTokenAddress: null,
      rootNFTAddress: null,
      externalRouteState: 'unverified',
      productionAuthorized: false,
    });
    expect(draft.nftUnitRaw).toBe(MOCK_TEMPLATE_V0.nftUnitRaw);
  });
});
