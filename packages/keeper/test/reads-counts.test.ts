import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { readsFixture } from './support/reads-fixture';

/**
 * SH-KEEPER-V2-STEPS (STEPS-B) added the journal's `mem.buyBackBudget` after these fixtures were recorded: the buy budget
 * each hook with a waiting mark showed, so a fall (a buy) restarts the mark. SH-236 also adds diagnostic fields (projected below). The
 * recorded decisions are compared without it, byte for byte, and the new field is checked exactly; the fixtures and their
 * digests stay as recorded.
 */
type Skip = { job: string; key: string; why: string; boxId?: string; code?: string };
type Decisions = { report: { skipped: Skip[] }; state: {
  mem: { buyBackSince: Record<string, string>; buyBackBudget?: Record<string, string> };
  skipLog: Record<string, { at: string; repeats: number }>;
} };
const withoutBudget = (d: Decisions) => {
  const mem = { ...d.state.mem };
  delete mem.buyBackBudget;
  // SH-236 adds report metadata and splits throttle keys by box. Project just that diagnostic change back into
  // the recorded shape; keep the old decision digests, all amounts, reservations, reads and sends unchanged.
  const skipLog: Decisions['state']['skipLog'] = {};
  for (const [key, value] of Object.entries(d.state.skipLog)) {
    const skip = d.report.skipped.find(s => s.code !== undefined && `${s.boxId ?? 'unknown'}|${s.job}|${s.code}` === key);
    const legacy = skip ? `${skip.job}|${skip.why}` : key;
    const previous = skipLog[legacy];
    if (previous) expect(value.at).toBe(previous.at); // Each fixture tick starts with an empty journal.
    skipLog[legacy] = { ...value, repeats: value.repeats + (previous ? previous.repeats + 1 : 0) };
  }
  const skipped = d.report.skipped.map(s => { const old = { ...s }; delete old.boxId; delete old.code; return old; });
  return { ...d, report: { ...d.report, skipped }, state: { ...d.state, mem, skipLog } };
};
// The fixture's v2 receivers each hold buyBackP 1000 raw P under an unreadable hook minimum: every waiting mark keeps 1000.
const budgetOf = (d: Decisions) => Object.fromEntries(Object.keys(d.state.mem.buyBackSince).map(hook => [hook, '1000']));

it.each([0, 3])('READS-6 bounds requests and preserves old decisions with %i v2 boxes', async count => {
  const record = process.env.SH_RECORD_READS === '1';
  const fixture = readsFixture(count, !record);
  const ticks = [];
  for (let i = 0; i < 4; i++) {
    ticks.push(await fixture.tick());
    if (!record) {
      const serialized = fixture.requests.map(r => JSON.stringify(r));
      const duplicates = serialized.filter((r, j) => serialized.indexOf(r) !== j).map(r => JSON.parse(r));
      expect(duplicates).toEqual([]);
    }
  }
  if (record) {
    writeFileSync(new URL(`./fixtures/reads-baseline-${count}.json`, import.meta.url), `${JSON.stringify(ticks, null, 2)}\n`);
    return;
  }
  const baseline = JSON.parse(readFileSync(new URL(`./fixtures/reads-baseline-${count}.json`, import.meta.url), 'utf8'));
  expect(ticks.map(t => withoutBudget(t.decisions))).toEqual(baseline.map((t: { decisions: Decisions }) => withoutBudget(t.decisions)));
  expect(ticks.map(t => t.decisions.state.mem.buyBackBudget)).toEqual(ticks.map(t => budgetOf(t.decisions)));
  expect(ticks.map(t => Object.keys(t.decisions.state.mem.buyBackSince).length)).toEqual(Array(4).fill(count));
  // SH-KEEPER-BATCH: supplied counts [19,19,17,11] / [106,69,67,60]; decisions above stay byte-for-byte.
  // SH-247 (SH-190) removes the platform Safe's open range: four cold pages, then one tail a tick ([95,59,57,50] before).
  expect(ticks.map(t => t.count)).toEqual(count === 0 ? [19, 19, 17, 11] : [91, 58, 56, 49]);
  writeFileSync(new URL(`../../../.cache/reads-after-${count}.json`, import.meta.url), JSON.stringify({ boxes: count + 1, before: baseline.map((t: { count: number }) => t.count), after: ticks.map(t => t.count) }));
  for (const tick of ticks) expect(tick.count).toBeLessThanOrEqual(120);
});

it('af1 F1 holds the request bound through saturation and window expiry with unchanged decisions', async () => {
  const fixture = readsFixture(3, true);
  const record = process.env.SH_RECORD_AF1 === '1';
  const ticks = [];
  for (let i = 0; i < 36; i++) {
    if (i === 32) fixture.advance(7200n); // Expire the entire old window, then exercise new finalized tails.
    const tick = await fixture.tick();
    const queries = fixture.requests.filter(r => r.method === 'eth_getLogs').map(r => JSON.stringify(r));
    const all = fixture.requests.map(r => JSON.stringify(r));
    expect(tick.decisions.state.mem.buyBackBudget, `tick ${i + 1} buy budgets`).toEqual(budgetOf(tick.decisions));
    expect(Object.keys(tick.decisions.state.mem.buyBackSince), `tick ${i + 1} waiting marks`).toHaveLength(3);
    ticks.push({ count: tick.count, decisions: createHash('sha256').update(JSON.stringify(withoutBudget(tick.decisions))).digest('hex'),
      duplicateLogs: queries.filter((r, j) => queries.indexOf(r) !== j).length,
      duplicates: all.filter((r, j) => all.indexOf(r) !== j).length });
  }
  const path = new URL('./fixtures/reads-af1-baseline.json', import.meta.url);
  if (record) { writeFileSync(path, `${JSON.stringify(ticks, null, 2)}\n`); return; }
  const baseline = JSON.parse(readFileSync(path, 'utf8')) as typeof ticks;
  writeFileSync(new URL('../../../.cache/reads-af1-after.json', import.meta.url), JSON.stringify(ticks, null, 2));
  expect(ticks.map(t => t.decisions)).toEqual(baseline.map(t => t.decisions));
  // Supplied counts are preserved in SH-KEEPER-BATCH's before/after table. Never regenerate decision digests.
  // SH-247 (SH-190): one fewer log query a tick, four fewer on each cold window, as the Safe is no longer range-read.
  // Before: 95, 59, 57, 50, 51, 49, 50, 49, 49, 49, 49, 50, 50, 48, 47, 48, 49, 48, 48, 47, 47, 50, 49, 48,
  //         49, 49, 49, 48, 48, 48, 46, 47, 87, 50, 51, 51.
  expect(ticks.map(t => t.count)).toEqual([
    91, 58, 56, 49, 50, 48, 49, 48, 48, 48, 48, 49,
    49, 47, 46, 47, 48, 47, 47, 46, 46, 49, 48, 47,
    48, 48, 48, 47, 47, 47, 45, 46, 83, 49, 50, 50,
  ]);
  for (const [i, tick] of ticks.entries()) {
    expect.soft(tick.count, `tick ${i + 1}`).toBeLessThanOrEqual(120);
    expect.soft(tick.duplicateLogs, `tick ${i + 1} log queries`).toBe(0);
    expect.soft(tick.duplicates, `tick ${i + 1} all requests`).toBe(0);
  }
}, shLimit(60_000));
