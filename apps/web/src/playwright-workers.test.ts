import { describe, expect, it } from 'vitest';
import { expectOf, expectTimeoutOf, timeoutOf, workersOf } from '../playwright-workers';

// SH-195: SH_E2E_WORKERS is opt-in; unset, the browser suites keep Playwright's default worker count.
describe('SH_E2E_WORKERS', () => {
  it('unset or empty leaves the worker count to Playwright', () => {
    expect(workersOf({})).toBeUndefined();
    expect(workersOf({ SH_E2E_WORKERS: '' })).toBeUndefined();
  });
  it('takes a whole number or a share of the CPUs', () => {
    expect(workersOf({ SH_E2E_WORKERS: '1' })).toBe(1);
    expect(workersOf({ SH_E2E_WORKERS: '2' })).toBe(2);
    expect(workersOf({ SH_E2E_WORKERS: '25%' })).toBe('25%');
    expect(workersOf({ SH_E2E_WORKERS: '100%' })).toBe('100%');
  });
  it('refuses anything else', () => {
    for (const raw of ['0', '-1', '1.5', 'two', '0%', '101%', ' 2', '1000']) expect(() => workersOf({ SH_E2E_WORKERS: raw }), raw).toThrow(/SH_E2E_WORKERS/);
  });
});

// SH_E2E_TIMEOUT is opt-in too; unset, the browser suites keep Playwright's 30 s per test. It can only raise the limit.
describe('SH_E2E_TIMEOUT', () => {
  it('unset or empty leaves the time limit to Playwright', () => {
    expect(timeoutOf({})).toBeUndefined();
    expect(timeoutOf({ SH_E2E_TIMEOUT: '' })).toBeUndefined();
  });
  it('takes whole milliseconds from Playwright’s own 30 s upwards', () => {
    expect(timeoutOf({ SH_E2E_TIMEOUT: '30000' })).toBe(30_000);
    expect(timeoutOf({ SH_E2E_TIMEOUT: '90000' })).toBe(90_000);
    expect(timeoutOf({ SH_E2E_TIMEOUT: '9999999' })).toBe(9_999_999);
  });
  it('refuses a lower limit and anything that is not a whole number of milliseconds', () => {
    for (const raw of ['0', '1', '29999', '-90000', '90000.5', '90s', ' 90000', '90000 ', '9e4', '10000000', 'NaN']) expect(() => timeoutOf({ SH_E2E_TIMEOUT: raw }), raw).toThrow(/SH_E2E_TIMEOUT/);
  });
});

// SH-219: SH_E2E_EXPECT_TIMEOUT is opt-in as well; unset, an expectation keeps Playwright's 5 s. It can only raise the wait.
describe('SH_E2E_EXPECT_TIMEOUT', () => {
  it('unset or empty leaves the wait to Playwright, and the config gets no expect entry at all', () => {
    expect(expectTimeoutOf({})).toBeUndefined();
    expect(expectTimeoutOf({ SH_E2E_EXPECT_TIMEOUT: '' })).toBeUndefined();
    expect(expectOf({})).toEqual({});
    expect('expect' in expectOf({ SH_E2E_EXPECT_TIMEOUT: '' })).toBe(false);
  });
  it('takes whole milliseconds from Playwright’s own 5 s upwards', () => {
    expect(expectTimeoutOf({ SH_E2E_EXPECT_TIMEOUT: '5000' })).toBe(5_000);
    expect(expectTimeoutOf({ SH_E2E_EXPECT_TIMEOUT: '15000' })).toBe(15_000);
    expect(expectTimeoutOf({ SH_E2E_EXPECT_TIMEOUT: '999999' })).toBe(999_999);
    expect(expectOf({ SH_E2E_EXPECT_TIMEOUT: '15000' })).toEqual({ expect: { timeout: 15_000 } });
  });
  it('refuses a shorter wait and anything that is not a whole number of milliseconds', () => {
    for (const raw of ['0', '1', '4999', '-15000', '15000.5', '15s', ' 15000', '15000 ', '1e4', '1000000', 'NaN']) {
      expect(() => expectTimeoutOf({ SH_E2E_EXPECT_TIMEOUT: raw }), raw).toThrow(/SH_E2E_EXPECT_TIMEOUT/);
      expect(() => expectOf({ SH_E2E_EXPECT_TIMEOUT: raw }), raw).toThrow(/SH_E2E_EXPECT_TIMEOUT/);
    }
  });
});
