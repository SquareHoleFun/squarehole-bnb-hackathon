import { expect, it } from 'vitest';
import { readItemClaimV2 } from '../../src/core/v2/m3-reads-v2';
import { H } from '../../src/core/v2/m3-fixture.test-support';
import { reader, TRANCHE } from './reader-double';

it('M363-OC02: an owner can claim the next bounded payment of a fully backed large credit', async () => {
  const r = reader();
  const credit = await readItemClaimV2(r, r.f.row, { id: 1n }, H(101));
  expect(r.callFromAt).toHaveBeenCalledOnce();
  expect(credit.outsideP).toBe(TRANCHE + 1n);
  expect(credit.stashP).toBe(7n);
  // claim() succeeds and returns int128.max; the rest remains owed, not an unavailable payout.
  expect(credit.payout).toBe('available');
  expect(credit.claimableP).toBe(TRANCHE);
});
