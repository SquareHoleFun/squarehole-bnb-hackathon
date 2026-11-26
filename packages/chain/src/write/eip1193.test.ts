/**
 * SH-254: the wallet's edge passes on no address that the strict check refuses. A wallet that returns a mixed-case
 * address with a wrong checksum (the sample wallet Box wallet B did, and every Create page then failed) gets it passed
 * on in its checksummed form; addresses that pass the check come through as they came.
 */
import { getAddress, isAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { parseAccounts } from './eip1193';

const WRONG_CHECKSUM = '0xDe00000000000000000000000000000000000B22';
const LOWER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const CHECKSUMMED = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('SH-254 parseAccounts at the wallet’s edge', () => {
  it('passes a wrong-checksum mixed-case address on in its checksummed form', () => {
    expect(isAddress(WRONG_CHECKSUM)).toBe(false);
    const [account] = parseAccounts([WRONG_CHECKSUM]);
    expect(account).toBe(getAddress(WRONG_CHECKSUM.toLowerCase()));
    expect(account).toBe('0xdE00000000000000000000000000000000000B22');
    expect(isAddress(account ?? '')).toBe(true);
  });

  it('keeps addresses that pass the check as they came, drops malformed ones and repeats', () => {
    expect(parseAccounts([LOWER, CHECKSUMMED, 'not-an-address', WRONG_CHECKSUM.toLowerCase()])).toEqual([LOWER, WRONG_CHECKSUM.toLowerCase()]);
    expect(parseAccounts([CHECKSUMMED])).toEqual([CHECKSUMMED]);
    for (const account of parseAccounts([LOWER, CHECKSUMMED, WRONG_CHECKSUM, '0xABCDEF0000000000000000000000000000000001'])) expect(isAddress(account), account).toBe(true);
  });
});
