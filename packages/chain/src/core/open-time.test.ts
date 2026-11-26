/**
 * Opening at a clock time (open-at-clock-time.md): the contracts' open rule, the 12-second tax steps probed inside a
 * step and at both window edges (the prototype's mutation critique: whole-step probes alone let a rounded-up step and
 * an off-by-one window end survive), and the first block at or after a time on mainnet's and Sepolia's slots.
 */
import { TAX_STEP_SECONDS, WINDOW_SECONDS, WINDOW_STEPS } from '@squarehole/box-spec';
import { describe, expect, it } from 'vitest';
import { effectiveOpenAt, firstBlockTimeAtOrAfter, SLOT_GENESIS_TIME, windowEndsAtOf, windowStepAt } from './open-time';

const SIX_PM = 1_791_309_600n; // 2026-10-06 18:00:00 UTC

describe('the open (hook, router and tickets: openAt, or the creation time + 1)', () => {
  it('Now (0), a time already passed and the creation second itself open one second after the creation block', () => {
    const created = SIX_PM - 600n;
    expect(effectiveOpenAt(0, created)).toBe(created + 1n);
    expect(effectiveOpenAt(Number(created - 3_600n), created)).toBe(created + 1n);
    expect(effectiveOpenAt(created, created)).toBe(created + 1n);
    expect(effectiveOpenAt(created + 1n, created)).toBe(created + 1n);
    expect(effectiveOpenAt(SIX_PM, created)).toBe(SIX_PM);
  });

  it('the window is 32 steps of 12 seconds, 384 seconds', () => {
    expect([WINDOW_STEPS, TAX_STEP_SECONDS, WINDOW_SECONDS]).toEqual([32n, 12n, 384n]);
    expect(windowEndsAtOf(SIX_PM)).toBe(SIX_PM + 384n);
  });
});

describe('the tax step of a block at a time', () => {
  it('is null before the open and from the window end on, never one second early or late', () => {
    expect(windowStepAt(SIX_PM, SIX_PM - 1n)).toBeNull();
    expect(windowStepAt(SIX_PM, SIX_PM)).toBe(0);
    expect(windowStepAt(SIX_PM, SIX_PM + 383n)).toBe(31);
    expect(windowStepAt(SIX_PM, SIX_PM + 384n)).toBeNull();
    expect(windowStepAt(SIX_PM, SIX_PM + 10_000n)).toBeNull();
  });

  it('rounds down inside a step: 0 … 11 s is step 0, 12 … 23 s step 1 (probed off the whole steps)', () => {
    for (const [offset, step] of [
      [1n, 0],
      [11n, 0],
      [12n, 1],
      [13n, 1],
      [23n, 1],
      [24n, 2],
      [371n, 30],
      [372n, 31],
      [377n, 31],
    ] as const) {
      expect(windowStepAt(SIX_PM, SIX_PM + offset), `${offset} s`).toBe(step);
    }
  });

  it('on mainnet a round time is met 11 s into its slot: every block of the window still pays its own step once', () => {
    const genesis = SLOT_GENESIS_TIME[1] as bigint;
    const first = firstBlockTimeAtOrAfter(SIX_PM, genesis);
    const steps: number[] = [];
    for (let time = first; windowStepAt(SIX_PM, time) !== null; time += 12n) steps.push(windowStepAt(SIX_PM, time) as number);
    expect(steps).toEqual(Array.from({ length: 32 }, (_, i) => i));
  });
});

describe('the first block at or after a time', () => {
  it('mainnet: slots fall 11 s into each 12 (genesis 1,606,824,023), so 18:00:00 is met at 18:00:11', () => {
    const genesis = SLOT_GENESIS_TIME[1] as bigint;
    expect(genesis % 12n).toBe(11n);
    expect(firstBlockTimeAtOrAfter(SIX_PM, genesis)).toBe(SIX_PM + 11n);
    expect(firstBlockTimeAtOrAfter(SIX_PM + 11n, genesis)).toBe(SIX_PM + 11n);
    expect(firstBlockTimeAtOrAfter(SIX_PM + 12n, genesis)).toBe(SIX_PM + 23n);
  });

  it('Sepolia: slots fall on whole multiples of 12 (genesis 1,655,733,600), so a round minute is a slot', () => {
    const genesis = SLOT_GENESIS_TIME[11_155_111] as bigint;
    expect(genesis % 12n).toBe(0n);
    expect(firstBlockTimeAtOrAfter(SIX_PM, genesis)).toBe(SIX_PM);
    expect(firstBlockTimeAtOrAfter(SIX_PM + 1n, genesis)).toBe(SIX_PM + 12n);
  });

  it('a chain without known slots (a local anvil) and a time before genesis: the time itself', () => {
    expect(firstBlockTimeAtOrAfter(SIX_PM + 5n, null)).toBe(SIX_PM + 5n);
    expect(firstBlockTimeAtOrAfter(5n, SLOT_GENESIS_TIME[1] as bigint)).toBe(5n);
  });
});
