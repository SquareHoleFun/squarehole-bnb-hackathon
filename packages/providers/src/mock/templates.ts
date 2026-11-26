/**
 * Mock launch template registry for the creation wizard's Step 3 review readout (SH-009; 01-PRODUCT: fee policy,
 * curve, supply unit and liquidity preset are protocol-owned templates, not creator settings). No template is
 * approved: supply cap and curve are pending G05/G04, and the admin powers of a real template are not yet known.
 */
import { DRAFT_FEE_TERMS, type LaunchTemplate } from '@squarehole/domain';
import { deepFreeze } from './scenarios';

export const MOCK_TEMPLATE_V0: Readonly<LaunchTemplate> = deepFreeze({
  templateId: 'MOCK_TEMPLATE_V0',
  label: 'mock template – not approved',
  approved: false,
  assetKinds: ['token', 'nft_collection'],
  supplyCap: 'template default, pending G05',
  curve: 'pending G04/ADR-0006',
  // 01-PRODUCT demo denomination: one displayed T = one NFT-equivalent unit, 18 decimals. Not a production value.
  nftUnitRaw: '1000000000000000000',
  adminPowers: [
    'Undetermined: no reviewed template exists yet (pending G05, G07)',
    'Creator cannot edit fee, curve or supply settings (not a template option)',
    'No hidden remint, seizure or fee-exemption authority is permitted; not yet proven by review',
  ],
  feeTerms: { ...DRAFT_FEE_TERMS, qProtocolShare: { ...DRAFT_FEE_TERMS.qProtocolShare } },
} satisfies LaunchTemplate);

export const MOCK_TEMPLATES: readonly Readonly<LaunchTemplate>[] = Object.freeze([MOCK_TEMPLATE_V0]);
