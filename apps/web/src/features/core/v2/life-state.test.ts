/**
 * SH-BOX-LIFE-VIEW § 1: where a box is in its life, per state, on GPU Poor's real answer and its earlier moments
 * (test-support/life-v2.ts): the stage in chain time, the four steps (done, the box's own step, next, the step a closed
 * box ended at) and each one's number, the raise bar (full at 100%, in the real coin, never "P"), the launch window's
 * clock and tax.
 */
import { describe, expect, it } from 'vitest';
import { parseSnapshotV2 } from './indexer-v2';
import { canStillGraduateV2, clockLeftV2, durationShortV2, failedStepV2, lifeStageV2, lifeStepsV2, raiseBarV2, windowTaxV2, type LifeStageV2 } from './life-state';
import { figuresOfV2 } from './StatsV2';
import { gpuPoorLifeV2, sepoliaLifeSourceV2 } from './test-support/life-v2';

const source = sepoliaLifeSourceV2();
const at = (stage: LifeStageV2) => parseSnapshotV2(gpuPoorLifeV2(stage).body, source);
const steps = (stage: LifeStageV2, nowSec?: bigint, graduatedAt: bigint | null = null) => {
  const view = at(stage);
  return lifeStepsV2({ view, nowSec: nowSec ?? view.timestamp, coin: 'tNVDA', ticker: 'VRAM', price: figuresOfV2(view).price, graduatedAt });
};
const table = (stage: LifeStageV2, nowSec?: bigint, graduatedAt: bigint | null = null) => steps(stage, nowSec, graduatedAt).map((s) => [s.id, s.status, s.value, s.sub]);

describe('the stage, in chain time', () => {
  it('reads each moment of GPU Poor’s life from its snapshot', () => {
    expect((['scheduled', 'window', 'raising', 'graduating', 'graduated', 'failed'] as const).map((stage) => lifeStageV2(at(stage)))).toEqual(['scheduled', 'window', 'raising', 'graduating', 'graduated', 'failed']);
    const raising = at('raising');
    // The window is the 384 s after the open (F80); the gate not open yet is scheduled whatever the time.
    expect(lifeStageV2({ ...raising, timestamp: raising.gate.effectiveOpenAt + 383n })).toBe('window');
    expect(lifeStageV2({ ...raising, timestamp: raising.gate.effectiveOpenAt + 384n })).toBe('raising');
    expect(lifeStageV2({ ...raising, timestamp: raising.gate.effectiveOpenAt - 1n })).toBe('scheduled');
    expect(lifeStageV2({ ...raising, gate: { ...raising.gate, open: false } })).toBe('scheduled');
  });
});

describe('the four steps, one number each', () => {
  it('scheduled: Launch is the box’s step with its countdown and time; the raise as the bar shows it (the bootstrap buy’s part) of the exact raise in tNVDA', () => {
    expect(table('scheduled')).toEqual([
      ['launch', 'current', 'in 2 h 14 min', '27 Oct, 08:38 UTC'],
      ['raise', 'next', '0.0%', '0.03529 / 100 tNVDA'],
      ['graduate', 'next', 'at 100%', null],
      ['pool', 'next', '—', null],
    ]);
    // The countdown counts down with the reader's clock.
    const view = at('scheduled');
    expect(steps('scheduled', view.gate.effectiveOpenAt - 45n)[0]?.value).toBe('in 45 s');
    // The strip and the bar say the same; unpublished, a dash and the raise (SH-255 round 3: a start buy can have
    // raised some before the box opens, so "0.0%" and "0 / 100" were not known).
    expect(steps('scheduled')[1]?.sub).toBe(raiseBarV2(view, 'tNVDA')?.amount);
    expect(lifeStepsV2({ view: { ...view, statistics: null }, nowSec: view.timestamp, coin: 'tNVDA', ticker: 'VRAM', price: '—', graduatedAt: null })[1]).toMatchObject({ value: '—', sub: '100 tNVDA' });
  });

  it('the launch window: Launch with the minutes left and the next block’s launch tax; the raise filling', () => {
    const view = at('window');
    expect(table('window')).toEqual([
      ['launch', 'current', '3:36 left', 'tax 76.02%'],
      ['raise', 'next', '42.1%', '42.1 / 100 tNVDA'],
      ['graduate', 'next', 'at 100%', null],
      ['pool', 'next', '—', null],
    ]);
    expect(steps('window', view.timestamp + 200n)[0]?.value).toBe('0:16 left');
    expect(steps('window')[0]?.spoken).toBe('Launch: now, 3:36 left, tax 76.02% (the launch window: buys pay a launch tax that falls every 12 s)');
  });

  it('raising: Launch done (when), Raise the box’s step with its percent and the amount in tNVDA', () => {
    expect(table('raising')).toEqual([
      ['launch', 'done', '53 min ago', null],
      ['raise', 'current', '42.1%', '42.1 / 100 tNVDA'],
      ['graduate', 'next', 'at 100%', null],
      ['pool', 'next', '—', null],
    ]);
  });

  it('SH-255 (the coordinator’s look): raising past its deadline, unfilled: Graduate reads as on a closed box, not "at 100%"', () => {
    const view = at('raising');
    const past = { ...view, timestamp: view.gate.deadline + 3600n };
    expect(canStillGraduateV2(past)).toBe(false);
    const out = lifeStepsV2({ view: past, nowSec: past.timestamp, coin: 'tNVDA', ticker: 'VRAM', price: figuresOfV2(past).price, graduatedAt: null });
    expect(out.find((s) => s.id === 'graduate')).toMatchObject({ status: 'next', value: '—', sub: null });
    const closed = steps('failed').find((s) => s.id === 'graduate');
    expect(closed).toMatchObject({ status: 'next', value: '—', sub: null });
    // Before its deadline it still can: "at 100%".
    expect(steps('raising').find((s) => s.id === 'graduate')?.value).toBe('at 100%');
  });
  it('raise full, graduating: Raise done at 100 tNVDA (full 40 s ago), Graduate pending', () => {
    expect(table('graduating')).toEqual([
      ['launch', 'done', '10 min ago', null],
      ['raise', 'done', '100 tNVDA', 'full 40 s ago'],
      ['graduate', 'current', 'Pending', null],
      ['pool', 'next', '—', null],
    ]);
  });

  it('graduated: Graduate done (when, from the activity), Pool the box’s step with its price in tNVDA per 1M VRAM', () => {
    expect(table('graduated', undefined, 1_793_082_888n)).toEqual([
      ['launch', 'done', '17 min ago', null],
      ['raise', 'done', '100 tNVDA', null],
      ['graduate', 'done', '6 min ago', null],
      ['pool', 'current', '0.4872', 'tNVDA per 1M VRAM'],
    ]);
    // Before the activity is read the graduation's time is not known: "Done", never a guess.
    expect(steps('graduated')[2]?.value).toBe('Done');
  });

  it('closed: the step where the box ended is marked (the deadline at the raise), later ones dim', () => {
    expect(table('failed').map(([id, status, value]) => [id, status, value])).toEqual([['launch', 'done', '30 d ago'], ['raise', 'failed', 'Closed'], ['graduate', 'next', '—'], ['pool', 'next', '—']]);
    expect([failedStepV2('Deadline'), failedStepV2('ClosedPastCap'), failedStepV2('GraduationTimedOut')]).toEqual(['raise', 'launch', 'graduate']);
  });
});

describe('the raise bar', () => {
  it('in the real coin, full at 100% once the curve closed, absent after graduation (no progress published)', () => {
    expect(raiseBarV2(at('raising'), 'tNVDA')).toEqual({ bps: 4210, full: false, percent: '42.1%', amount: '42.1 / 100 tNVDA' });
    expect(raiseBarV2(at('graduating'), 'tNVDA')).toEqual({ bps: 10_000, full: true, percent: '100.0%', amount: '100 / 100 tNVDA' });
    expect(raiseBarV2(at('graduated'), 'tNVDA')).toBeNull();
    // A filled curve whose statistics are not published yet is still full.
    expect(raiseBarV2({ ...at('graduating'), statistics: null }, 'tNVDA')?.full).toBe(true);
    expect(raiseBarV2({ ...at('raising'), statistics: null }, 'tNVDA')).toBeNull();
  });
});

describe('clocks and the window’s tax', () => {
  it('waits truncated, never more than is left; the tax rounded up like the router charges it, none outside the window', () => {
    expect([durationShortV2(0n), durationShortV2(59n), durationShortV2(3_599n), durationShortV2(3_600n), durationShortV2(8_040n), durationShortV2(90_061n), durationShortV2(-5n)]).toEqual(['0 s', '59 s', '59 min', '1 h', '2 h 14 min', '1 d 1 h', '0 s']);
    expect([clockLeftV2(384n), clockLeftV2(61n), clockLeftV2(0n), clockLeftV2(-3n)]).toEqual(['6:24', '1:01', '0:00', '0:00']);
    expect([windowTaxV2(1_000n, 988n), windowTaxV2(1_000n, 1_000n), windowTaxV2(1_000n, 1_360n), windowTaxV2(1_000n, 1_372n)]).toEqual(['93.20%', '92.61%', '8.06%', null]);
  });
});
