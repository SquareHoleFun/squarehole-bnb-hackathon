import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POKE_TRIGGER_TICKS, countPokes, nextSample, pokeDue, pokeReport, randomWalk, topUpDue } from '../src/poke';

type History = { name: string; pool: string; intervalSeconds: number; ticks: number[] };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/poke-history.json', import.meta.url), 'utf8')) as {
  block: number;
  histories: History[];
};

describe('every-block pokes during big moves (F96 R19G; ADR-0017 § 11)', () => {
  it('starts when spot is more than 1% (100 ticks or more) from the latest sample', () => {
    // Review round 1, L2: 1.0001^100 ≈ 1.01005 is already more than 1%; 1.0001^99 ≈ 1.00995 is not.
    expect(POKE_TRIGGER_TICKS).toBe(100);
    expect(pokeDue(1_000 + POKE_TRIGGER_TICKS - 1, 1_000, undefined, 5n)).toBe(false);
    expect(pokeDue(1_000 + POKE_TRIGGER_TICKS, 1_000, undefined, 5n)).toBe(true);
    expect(pokeDue(-1_000 - POKE_TRIGGER_TICKS, -1_000, undefined, 5n)).toBe(true);
  });

  it('pokes once per block', () => {
    expect(pokeDue(2_000, 1_000, 5n, 5n)).toBe(false);
    expect(pokeDue(2_000, 1_000, 5n, 6n)).toBe(true);
  });

  it('stops once spot is back within 1% of the sample', () => {
    // Spot jumps 350 ticks and holds: 3 pokes walk the sample 100 at a time; then spot comes back: 3 more (the
    // third at exactly 100 ticks, more than 1%: review round 1, L2).
    const ticks = [0, 350, 350, 350, 350, 350, 0, 0, 0, 0, 0];
    expect(countPokes(ticks)).toBe(6);
    expect(nextSample(300, 0)).toBe(200);
    expect(nextSample(0, 50)).toBe(50);
  });

  it('tops a sampler up once its newest checkpoint is a checkpoint spacing old', () => {
    expect(topUpDue(1_000n, 1_514n)).toBe(false);
    expect(topUpDue(1_000n, 1_515n)).toBe(true);
  });

  it('reports pokes per box per day on two volatile mainnet histories and two random walks (not a gate)', () => {
    expect(fixture.histories).toHaveLength(2);
    const reports = [
      ...fixture.histories.map((h) => pokeReport(h.name, h.ticks)),
      pokeReport('random walk, 10% a day', randomWalk(1, 1_000, 7_200)),
      pokeReport('random walk, 30% a day', randomWalk(2, 3_000, 7_200)),
    ];
    for (const r of reports) {
      expect(r.blocks).toBeGreaterThan(0);
      expect(r.pokesPerDay).toBeGreaterThanOrEqual(0);
      expect(r.ethPerMonthPer10BoxesAt1Gwei).toMatch(/^\d+\.\d+$/);
    }
    expect(pokeReport('again', randomWalk(2, 3_000, 7_200))).toEqual({ ...reports[3], name: 'again' });
  });
});
