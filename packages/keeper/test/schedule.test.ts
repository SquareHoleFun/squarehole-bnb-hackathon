import { describe, expect, it } from 'vitest';
import { COLLECT_EVERY, COLLECT_GUARD, HOUR, NO_CADENCE, collectDue, deepenDue, noteCollect, noteDeepen } from '../src/schedule';

type Ev = { kind: 'deepen' | 'collect'; block: bigint; time: bigint };

/** 48 hours of 12-second blocks from a time 7 s into an hour; the keeper decides each block as the planner does. */
function day(hours: bigint, startOffset = 7n): Ev[] {
  const events: Ev[] = [];
  let cadence = NO_CADENCE;
  const t0 = 1_791_300_000n - (1_791_300_000n % HOUR) + startOffset;
  for (let block = 1n; (block - 1n) * 12n < hours * HOUR; block += 1n) {
    const time = t0 + (block - 1n) * 12n;
    if (deepenDue(cadence, time)) {
      events.push({ kind: 'deepen', block, time });
      cadence = noteDeepen(cadence, time, block);
    } else if (collectDue(cadence, time, block)) {
      events.push({ kind: 'collect', block, time });
      cadence = noteCollect(cadence, time);
    }
  }
  return events;
}

describe('box 0\'s rhythm for every box (F95 R19U; tickets § 8)', () => {
  const events = day(48n);
  const deepens = events.filter((e) => e.kind === 'deepen');
  const collects = events.filter((e) => e.kind === 'collect');

  it('deepens once every hour slot', () => {
    expect(deepens).toHaveLength(48);
    expect(new Set(deepens.map((e) => e.time / HOUR)).size).toBe(48);
  });

  it('collects every 2 hours', () => {
    expect(collects).toHaveLength(24);
    for (const [i, c] of collects.entries()) {
      const prev = collects[i - 1];
      if (prev) expect(c.time - prev.time >= COLLECT_EVERY).toBe(true);
    }
  });

  it('never sends a collect in the block or the hour slot right before a deepen', () => {
    for (const c of collects) {
      expect(deepens.some((d) => d.block === c.block)).toBe(false);
      const next = deepens.find((d) => d.time > c.time);
      if (next) expect(next.time - c.time >= COLLECT_GUARD).toBe(true);
      const slotDeepen = deepens.find((d) => d.time / HOUR === c.time / HOUR);
      expect(slotDeepen && slotDeepen.block < c.block).toBe(true);
    }
  });

  it('waits for the slot\'s deepen when the keeper starts late in an hour', () => {
    const late = day(3n, 3_000n);
    expect(late[0]?.kind).toBe('deepen');
    for (const c of late.filter((e) => e.kind === 'collect')) {
      expect(c.time % HOUR < HOUR - COLLECT_GUARD).toBe(true);
    }
  });
});
