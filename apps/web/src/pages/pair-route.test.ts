import { describe, expect, it } from 'vitest';
import { parsePairRoute } from './pair-route';

describe('parsePairRoute (/pair/:chainId/:address, ADR-0003)', () => {
  it('builds the canonical lowercase pairId', () => {
    expect(parsePairRoute('31337', '0x000000000000000000000000000000000000006A')).toBe(
      '31337:0x000000000000000000000000000000000000006a',
    );
  });

  it('rejects malformed chain ids and addresses', () => {
    const address = '0x0000000000000000000000000000000000000066';
    for (const chainId of ['', '0', '-1', '01', '1.5', 'abc', '99999999999', undefined]) {
      expect(parsePairRoute(chainId, address), String(chainId)).toBeNull();
    }
    for (const bad of ['', '0x', '0x123', `${address}00`, '0xZZ00000000000000000000000000000000000066', undefined]) {
      expect(parsePairRoute('31337', bad), String(bad)).toBeNull();
    }
  });
});
