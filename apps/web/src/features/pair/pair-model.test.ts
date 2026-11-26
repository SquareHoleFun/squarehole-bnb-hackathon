import { DRAFT_FEE_TERMS, type PairDetail } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import detailsJson from '../../../../../packages/providers/src/fixtures/pair-details.json';
import { fixturePair } from '../../test-support/fixture';
import {
  activityRows,
  claimHref,
  feeTermsText,
  formatAssetAmount,
  fractionModel,
  isWrapperQuote,
  networkLabel,
  payoutText,
  rewardRows,
  supplyRows,
} from './pair-model';

const details = detailsJson.details as unknown as PairDetail[];
const detailOf = (name: string): PairDetail => {
  const pair = fixturePair(name);
  const found = details.find((detail) => detail.pairId === pair.pairId);
  if (!found) throw new Error(`no detail for ${name}`);
  return found;
};

describe('fee terms readout (D02, D03)', () => {
  it('reads DRAFT_FEE_TERMS exactly', () => {
    expect(feeTermsText(DRAFT_FEE_TERMS)).toBe(
      'Draft policy: 3% target · native T fees burned · realized Q split 1/3 protocol : 2/3 holders',
    );
  });

  it('every fixture detail carries the same terms', () => {
    for (const detail of details) expect(feeTermsText(detail.feeTerms)).toBe(feeTermsText(DRAFT_FEE_TERMS));
  });

  it('converts basis points without floating point', () => {
    expect(feeTermsText({ ...DRAFT_FEE_TERMS, headlineFeeTargetBps: 250 })).toContain('2.5% target');
  });
});

describe('supply rows (FEED-07: separate concepts, never summed)', () => {
  it('ORCHARD: six separate concepts, the cap labelled demo-derived, active NFTs unavailable', () => {
    const rows = supplyRows(detailOf('ORCHARD'), fixturePair('ORCHARD'));
    expect(rows.map((row) => [row.id, row.value])).toEqual([
      ['current', '260,000 ORCH'],
      ['initial', '260,120 ORCH'],
      ['burned', '120 ORCH'],
      ['circulating', '250,000 ORCH'],
      ['capacity', '260,000 NFTs at most'],
      ['active', null],
    ]);
    expect(rows.find((row) => row.id === 'initial')?.basis).toBe('Current supply + fee-burned.');
    for (const row of rows) expect(row.basis).not.toMatch(/demo/i);
    expect(rows.find((row) => row.id === 'capacity')?.basis).toMatch(/not the number of NFTs/);
    expect(rows.find((row) => row.id === 'active')?.basis).toMatch(/Never derived from supply/);
  });

  it('a token pair has no NFT capacity or count', () => {
    const rows = supplyRows(detailOf('ROUND TRIP'), fixturePair('ROUND TRIP'));
    expect(rows.map((row) => row.id)).toEqual(['current', 'initial', 'burned', 'circulating']);
  });

  it('unknown circulation stays unavailable, with the reason', () => {
    const detail = detailOf('ROUND TRIP');
    const rows = supplyRows(
      { ...detail, supply: { ...detail.supply, circulatingRaw: null, exclusionBasis: 'unavailable' } },
      fixturePair('ROUND TRIP'),
    );
    const circulating = rows.find((row) => row.id === 'circulating');
    expect(circulating?.value).toBeNull();
    expect(circulating?.basis).toMatch(/cannot be established/);
  });
});

describe('fractions (ADR-0009: 1 NFT = r fractions)', () => {
  it('ORCHARD: 1 NFT = 1 ORCH, with an example split', () => {
    expect(fractionModel(detailOf('ORCHARD'), fixturePair('ORCHARD'))).toEqual({
      perNft: '1',
      symbol: 'ORCH',
      example: { balance: '3.25', whole: '3', fraction: '0.25' },
    });
  });

  it('a larger ratio (r = 10^6) is read from the unit, never assumed', () => {
    const detail = detailOf('ORCHARD');
    if (!detail.nft) throw new Error('ORCHARD has an nft block');
    const model = fractionModel({ ...detail, nft: { ...detail.nft, unitRaw: `1${'0'.repeat(24)}` } }, fixturePair('ORCHARD'));
    expect(model).toMatchObject({ perNft: '1,000,000', example: { balance: '3,250,000', fraction: '250,000' } });
  });

  it('tokens have no fraction model', () => {
    expect(fractionModel(detailOf('ROUND TRIP'), fixturePair('ROUND TRIP'))).toBeNull();
  });
});

describe('rewards (per asset, never summed; 6 decimals like the account figures)', () => {
  it('R=Q: one row in the quote asset', () => {
    expect(rewardRows(detailOf('ORCHARD'), fixturePair('ORCHARD'))).toEqual([
      { symbol: 'AAPLx-DEMO', role: 'Credited and paid in the paired asset', paid: '0.013588 AAPLx-DEMO', accrued: '70.186411 AAPLx-DEMO' },
    ]);
    expect(payoutText(fixturePair('ORCHARD'))).toBe('Holder fee share paid in AAPLx-DEMO');
  });

  it('R=T: T paid out, entitlement accrued in Q, each in its own units', () => {
    const rows = rewardRows(detailOf('TINY FRAMES'), fixturePair('TINY FRAMES'));
    expect(rows.map((row) => [row.symbol, row.paid, row.accrued])).toEqual([
      ['FRAME', '500 FRAME', null],
      ['WETH-DEMO', '0 WETH-DEMO', '4.969999 WETH-DEMO'],
    ]);
    expect(payoutText(fixturePair('TINY FRAMES'))).toBe('Holder fee share paid in FRAME, converted from credited WETH-DEMO');
  });

  it('the claim link is an internal /rewards route carrying the pair id as a query value', () => {
    expect(claimHref('31337:0x0000000000000000000000000000000000000066')).toBe(
      '/rewards?pair=31337%3A0x0000000000000000000000000000000000000066',
    );
    expect(new URLSearchParams(claimHref('31337:0xab').split('?')[1]).get('pair')).toBe('31337:0xab');
  });
});

describe('activity and labels', () => {
  it('newest first, with readable kinds and no transaction links', () => {
    const rows = activityRows(detailOf('ORCHARD'));
    expect(rows[0]).toMatchObject({ label: 'Observed external trade', amounts: '2,000 ORCH', block: '38400' });
    expect(rows.at(-1)).toMatchObject({ kind: 'launch', label: 'Launch', amounts: '260,120 ORCH', when: '22 Sep 2026, 12:00 UTC' });
    expect(rows.filter((row) => row.kind === 'burn').map((row) => row.amounts)).toEqual(['30 ORCH', '50 ORCH', '40 ORCH']);
  });

  it('network, wrapper detection and malformed amounts', () => {
    expect(networkLabel(31337)).toBe('Local chain 31337');
    expect(networkLabel(11155111)).toBe('Chain 11155111');
    expect(isWrapperQuote(fixturePair('ORCHARD'))).toBe(true);
    expect(isWrapperQuote(fixturePair('ROUND TRIP'))).toBe(false);
    expect(formatAssetAmount('12.5', { decimals: 18, symbol: 'X' })).toBeNull();
    expect(formatAssetAmount(null, { decimals: 18, symbol: 'X' })).toBeNull();
    expect(formatAssetAmount('1', { decimals: 18, symbol: 'X' })).toBe('<0.0001 X');
    expect(formatAssetAmount('120000000000000000000', { decimals: 18, symbol: 'UNSET-DEMO' })).toBe('120 T');
  });
});
