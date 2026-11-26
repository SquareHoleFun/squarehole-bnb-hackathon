/**
 * SH-254: every sample wallet's address passes the address check that threw for "Box wallet B" (viem's strict
 * `isAddress`, which encoding runs: the spec build of every Launch page encodes the owner), so connecting any of them
 * never turns a page into the error page. Box wallet B's address was written with a wrong checksum until 24 November.
 */
import { encodeAbiParameters, getAddress, isAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { isAddress as isDomainAddress } from '@squarehole/domain';
import { BOX_PERSONAS, DEMO_WALLET_A, DEMO_WALLET_B, PICKER_PERSONAS, WALLET_PERSONAS } from './personas';

describe('SH-254 the sample wallets’ addresses', () => {
  it('each passes the strict check and encodes as an address, as the spec build does', () => {
    for (const persona of [...WALLET_PERSONAS, ...PICKER_PERSONAS]) {
      expect(isAddress(persona.address), persona.label).toBe(true);
      expect(isDomainAddress(persona.address), persona.label).toBe(true);
      expect(() => encodeAbiParameters([{ type: 'address' }], [persona.address]), persona.label).not.toThrow();
    }
  });

  it('the two box wallets are written in their checksummed form, as Box wallet A always was', () => {
    for (const address of [DEMO_WALLET_A, DEMO_WALLET_B]) expect(address).toBe(getAddress(address.toLowerCase()));
    expect(BOX_PERSONAS.map((persona) => persona.address)).toEqual([DEMO_WALLET_A, DEMO_WALLET_B]);
    expect(DEMO_WALLET_B.toLowerCase()).toBe('0xde00000000000000000000000000000000000b22');
  });
});
