import { expect, test } from '@playwright/test';
import {
  AS_OF,
  FIXTURE_ADDRESSES,
  ORGANIC,
  PARTIAL_ORGANIC,
  PLATFORM,
  STALE_ORGANIC,
  UPDATED_ORGANIC,
  VERIFIED_ORDERS,
  byName,
  compareDecimal,
  expectedAge,
  expectedIds,
  idFromSuffix,
  rewardAssetOptions,
  usdPattern,
} from './expected';

// Self-check of the independent oracle (no browser). If the fixture or these helpers drift, the UI tests would compare
// against the wrong expectations, so this runs first and fails loudly. Orders were verified against feed_model.py.

const ids = (list: readonly string[]) => list.map(idFromSuffix);

test('oracle reproduces the orders verified against the Python reference', () => {
  expect(ORGANIC).toHaveLength(11);
  expect(PLATFORM.name).toBe('Square Hole');
  expect(expectedIds({})).toEqual(ids(VERIFIED_ORDERS.marketCap));
  expect(expectedIds({ sort: 'new' })).toEqual(ids(VERIFIED_ORDERS.new));
  expect(expectedIds({ sort: 'turnover' })).toEqual(ids(VERIFIED_ORDERS.turnover));
  expect(expectedIds({ sort: 'turnover' }, PARTIAL_ORGANIC)).toEqual(ids(VERIFIED_ORDERS.partialTurnover));
  expect(expectedIds({}, STALE_ORGANIC)).toEqual(ids(VERIFIED_ORDERS.staleMarketCap));
  expect(expectedIds({}, UPDATED_ORGANIC)).toEqual(ids(VERIFIED_ORDERS.updatedMarketCap));
});

test('oracle: the SOFT CORNERS / WRONG ANGLE tie is a genuine tie on metric and launch time', () => {
  const soft = byName('SOFT CORNERS');
  const wrong = byName('WRONG ANGLE');
  expect(compareDecimal(soft.marketCapUsd ?? '', wrong.marketCapUsd ?? '')).toBe(0);
  expect(compareDecimal(soft.turnover24hUsd ?? '', wrong.turnover24hUsd ?? '')).toBe(0);
  expect(soft.launchedAt).toBe(wrong.launchedAt);
  expect(soft.pairId < wrong.pairId).toBe(true);
  expect(byName('NO PRICE YET').marketCapUsd).toBeNull();
});

test('oracle: exact decimals, ages, USD renderings and reward options', () => {
  expect(compareDecimal('72000.00', '72000')).toBe(0);
  expect(compareDecimal('0.30', '0.3')).toBe(0);
  expect(compareDecimal('100000000000000000000000.1', '100000000000000000000000')).toBe(1);
  expect(expectedAge('2026-09-25T11:54:00Z', AS_OF)).toBe('6m');
  expect(expectedAge('2026-09-24T06:00:00Z', AS_OF)).toBe('1d');
  expect(expectedAge('2026-09-22T12:00:00Z', AS_OF)).toBe('3d');
  for (const good of ['$600K', '$600,000', '$600,000.00', '$600.0K', 'cap $600K ']) expect(good).toMatch(usdPattern('600000.00'));
  for (const bad of ['$60K', '$6,000K', '$600', '$0', '$600.5K']) expect(bad).not.toMatch(usdPattern('600000.00'));
  expect('$84.2K').toMatch(usdPattern('84200'));
  expect('$84K').toMatch(usdPattern('84200'));
  expect('$84.3K').not.toMatch(usdPattern('84200'));
  expect('$850').toMatch(usdPattern('850'));
  expect('$1K').toMatch(usdPattern('1000.00'));
  expect(rewardAssetOptions()).toEqual([
    { label: 'AAPLx-DEMO', value: '0x0000000000000000000000000000000000002329' },
    { label: 'USDC-DEMO', value: '0x000000000000000000000000000000000000232a' },
  ]);
  expect(FIXTURE_ADDRESSES).toContain('0x00000000000000000000000000000000000007d2');
  expect(FIXTURE_ADDRESSES).toContain('0x000000000000000000000000000000000000238d');
});
