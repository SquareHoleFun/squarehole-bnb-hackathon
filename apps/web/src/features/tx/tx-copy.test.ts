import { DEMO_CHAIN_ID, type TxContext } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import { explainReason, txCopy } from './tx-copy';

const ctx: TxContext = { kind: 'claim', chainId: DEMO_CHAIN_ID, account: '0x00000000000000000000000000000000de000002', deadline: '2026-09-25T12:20:00Z' };

describe('explainReason', () => {
  it('explains a known contract reason and keeps the original code', () => {
    expect(explainReason('min_payout_not_met')).toBe('The payout would have been below the signed minimum. (min_payout_not_met)');
  });

  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'shows an untrusted reason named like an inherited member (%s) as given, never a function body',
    (reason) => {
      expect(explainReason(reason)).toBe(reason);
    },
  );
});

describe('txCopy · quote expiry before signing', () => {
  it('points at the refresh control above the panel and says nothing was signed', () => {
    const copy = txCopy({ status: 'invalidated', ctx, cause: 'deadline_passed' });
    expect(copy.title).toBe('Quote expired');
    expect(copy.body).toBe('The quote deadline passed before signing, so nothing was signed. Refresh the estimate above, then claim again.');
  });
});
