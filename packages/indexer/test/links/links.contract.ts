import { describe, expect, it } from 'vitest';
import type { LinksStore, LinkRow } from '../../src/links/types';
import { ACCOUNT, BODY, CHAIN, TOKEN } from './fixture';

export const row = (issuedAt = BODY.issuedAt): LinkRow => ({ chainId: CHAIN, token: TOKEN, ...BODY, issuedAt,
  signer: ACCOUNT.address.toLowerCase(), signerKind: 'eoa', verifiedBlock: '123' });

export function linksContract(name: string, make: () => LinksStore) {
  describe(`LINKS-SRV store contract: ${name}`, () => {
    it('concurrent upserts keep newest; equal/older keep nothing; all values round-trip', async () => {
      const store = make(); await store.init();
      expect(await store.get(CHAIN, TOKEN)).toBeNull();
      const values = [row('100'), row('300'), row('200')];
      await Promise.all(values.map(value => store.put(value)));
      expect(await store.get(CHAIN, TOKEN)).toEqual(row('300'));
      expect(await store.put({ ...row('300'), website: 'https://other.com' })).toBeNull();
      expect(await store.put(row('299'))).toBeNull();
      expect(await store.list(CHAIN)).toEqual([row('300')]);
      expect(await store.list(CHAIN + 1)).toEqual([]);
      await store.close();
    });
    it('retains empty removal and uint64 values without floating point conversion', async () => {
      const store = make(); await store.init();
      const removal = { ...row('18446744073709551615'), website: '', x: '', telegram: '', signature: '0x' as const };
      expect(await store.put(removal)).toEqual(removal);
      expect(await store.put(row('18446744073709551614'))).toBeNull();
      expect(await store.get(CHAIN, TOKEN)).toEqual(removal);
      await store.close();
    });
  });
}
