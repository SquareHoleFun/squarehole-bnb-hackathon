/**
 * The site's mirror of what M1-00 froze for the box page (wave 1 starts on the frozen interfaces, tickets § 4): the
 * failure causes, the gate's cap and the two close entries, pinned against the Solidity text so a change in the
 * freeze fails here before the page says something the contracts do not do.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { CLOSE_SIGNATURES, FAIL_CAUSE, GATE_CAP_SECONDS, closeCallData, failCauseOf } from './v2-frozen';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const COORDINATOR = readFileSync(resolve(ROOT, 'packages/contracts/src/box-v2/interfaces/IBoxCoordinatorV2.sol'), 'utf8');

describe('the frozen coordinator, as the box page reads it (IBoxCoordinatorV2.sol)', () => {
  it('FailCause: the same members in the same order', () => {
    const body = /enum FailCause \{([\s\S]*?)\}/.exec(COORDINATOR)?.[1] ?? '';
    const members = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z]\w*,?$/.test(line))
      .map((line) => line.replace(/,$/, ''));
    expect(members).toEqual(['None', 'Deadline', 'ClosedPastCap', 'GraduationTimedOut']);
    expect(Object.entries(FAIL_CAUSE).sort((a, b) => a[1] - b[1]).map(([name]) => name)).toEqual(members);
    expect([failCauseOf(0), failCauseOf(1), failCauseOf(2), failCauseOf(3)]).toEqual([null, 'deadline', 'closed-past-cap', 'graduation-timed-out']);
  });

  it('GATE_CAP_SECONDS: 14 days', () => {
    expect(COORDINATOR).toMatch(/uint256 constant GATE_CAP_SECONDS = 14 days;/);
    expect(GATE_CAP_SECONDS).toBe(14n * 86_400n);
  });

  it('fail() and failClosed(): no arguments, so the call is the selector alone', () => {
    expect(COORDINATOR).toMatch(/function fail\(\) external;/);
    expect(COORDINATOR).toMatch(/function failClosed\(\) external;/);
    expect(CLOSE_SIGNATURES).toEqual({ fail: 'fail()', failClosed: 'failClosed()' });
    expect(closeCallData('fail')).toBe(toFunctionSelector('fail()'));
    expect(closeCallData('failClosed')).toBe(toFunctionSelector('failClosed()'));
  });
});
