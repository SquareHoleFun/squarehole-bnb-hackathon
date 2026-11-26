import { expect, it } from 'vitest';
const { gasRows, sizeRow } = await import(new URL('./reports.mjs', import.meta.url).href);
it('requires successful complete gas suites and preserves integers', () => {
  expect(() => gasRows('[FAIL] budget')).toThrow();
  const log = 'Ran 1 test for test/box-v2/existing-nfts/release/ReleaseGasReport.t.sol:ReportSetPoolTradeGasTest\n  router buy: 227293\nRan 16 test suites: 34 tests passed, 0 failed, 0 skipped';
  expect(gasRows(log)['router buy (native)']).toBe('227293');
});
it('includes constructor arguments in the EIP-3860 ceiling', () => {
  expect(() => sizeRow('SetFactoryV2', '0x'+'00'.repeat(22119), '0x00', 0n)).toThrow('runtime');
  expect(() => sizeRow('SetFactoryV2', '0x00', '0x'+'00'.repeat(49100), 64n)).toThrow('initcode');
  expect(sizeRow('SetFactoryV2', '0x00', '0x00', 64n).initcodeBytes).toBe('65');
});
