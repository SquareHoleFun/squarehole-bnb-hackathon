import { describe, expect, it } from 'vitest';
import { configure } from '../config.mjs';
import { evaluate } from '../policy.mjs';
import { fixture, AT, configInput } from './drand-fixture.mjs';
import * as d from '../drand.mjs';
const cfg = configure(configInput(fixture()), {});
const rows = (t, now, c = cfg) => d.ladder({ consumers: [t], timestamp: String(now), block: fixture().rpc.block }, c, now);
// These assertions pin the original ladders beside the independently tested backup rows.
const incidents = (t, now) => rows(t, now).filter(r => r.status !== 'ok' && !r.reason.startsWith('backup-'));
const requested = () => fixture().consumers[0];
const unrequested = () => {
  const t = fixture().consumers[1]; t.status.wordRequestedAt = '0'; t.keys = []; t.gateOpenedAt = String(AT); return t;
};
describe('independent drand clocks', () => {
  for (const [seconds, reason, level, prior] of [
    [21600, '6h', 'alert', 'round+15m'], [86400, '24h', 'critical', '6h'], [259200, '3d', 'critical', '24h'],
    [432000, '5d', 'emergency', '3d'], [518400, '6d', 'emergency', '5d'],
  ]) it(`requested ${reason}, including one second before`, () => {
    const t = requested();
    expect(incidents(t, AT + BigInt(seconds) - 1n)[0].reason).toBe(prior);
    expect(incidents(t, AT + BigInt(seconds))[0]).toMatchObject({ reason, level, subject: `${t.address}:3` });
  });
  it('brackets the poster, hides a finalizing post only below six hours', () => {
    const t = requested(), roundTime = 1692803367n + (BigInt(t.keys[0].round) - 1n) * 3n;
    expect(incidents(t, roundTime + 899n)).toEqual([]);
    expect(incidents(t, roundTime + 900n)[0]).toMatchObject({ reason: 'round+15m', level: 'warn' });
    t.keys[0].latestWord = '1'; t.keys[0].latestReadyAt = String(AT + 20n);
    expect(incidents(t, roundTime + 900n)).toEqual([]);
    expect(incidents(t, AT + 21600n)[0].reason).toBe('6h');
  });
  it('uses the inclusive deadline, late posts, and timeless usability of timely words', () => {
    const t = requested(), k = t.keys[0];
    expect(incidents(t, AT + 604800n)[0].reason).toBe('6d');
    expect(incidents(t, AT + 604801n)[0]).toMatchObject({ reason: 'past-deadline', level: 'emergency' });
    k.word = '1'; k.readyAt = String(AT + 604801n);
    expect(incidents(t, AT + 604802n)[0].reason).toBe('past-deadline');
    k.readyAt = String(AT + 604800n); expect(incidents(t, AT + 9999999n)).toEqual([]);
    k.readyAt = String(AT - 1n); expect(incidents(t, AT + 9999999n)[0].reason).toBe('past-deadline');
  });
  it('gives a second draw its own clock and skips a usable first draw', () => {
    const t = requested(); t.status.drawsRequested = '2'; t.status.drawsSettled = '0';
    t.keys = [{ ...t.keys[0], key: '1', word: '1', readyAt: String(AT + 20n) }, { ...t.keys[0], key: '2', requestedAt: String(AT + 100n) }];
    expect(incidents(t, AT + 100n + 259200n)).toMatchObject([{ subject: `${t.address}:2`, reason: '3d' }]);
  });
  for (const [seconds, reason, level] of [[3600, '1h', 'alert'], [86400, '1d', 'critical'], [604800, '7d', 'critical'],
    [1728000, '20d', 'critical'], [2332800, '27d', 'emergency'], [2505600, '29d', 'emergency']]) {
    it(`unrequested ${reason}`, () => expect(incidents(unrequested(), AT + BigInt(seconds))[0]).toMatchObject({ reason: `unrequested-${reason}`, level }));
  }
  it('unrequested finality grace, thirty-day rescue, v2 failure clock and future clock', () => {
    const t = unrequested();
    expect(incidents(t, AT + 3599n)).toEqual([]);
    expect(incidents(t, AT + 2592000n)[0].reason).toBe('unrequested-29d');
    const last = incidents(t, AT + 2592001n)[0];
    expect(last.reason).toBe('unrequested-past-30d'); expect(last.detail).toContain('0 d 0 h 0 min left');
    expect(last.detail).toContain('one requestGraduationWord() still saves the box until someone calls enterTerminal');
    t.failureWindowEnds = String(AT + 86400n);
    expect(incidents(t, AT + 3600n)).toEqual([]);
    expect(incidents(t, AT + 90000n)[0].reason).toBe('unrequested-1h');
  });
  it('a finalized word with future readyAt is unusable and zero-slot tickets have no graduation clock', () => {
    const t = requested(); t.keys[0].word = '1'; t.keys[0].readyAt = String(AT + 21601n);
    expect(incidents(t, AT + 21600n)[0].reason).toBe('6h');
    const u = unrequested(); u.status.slots = '0'; expect(incidents(u, AT + 2592001n)).toEqual([]);
  });
  it('terminal tickets has exactly one row even with mismatch and pending keys', () => {
    const t = requested(); t.status.terminalAt = String(AT); t.source = '0x' + 'ab'.repeat(20); t.skipped = '100';
    expect(incidents(t, AT + 9999999n)).toMatchObject([{ reason: 'terminal-mode', subject: t.address, level: 'alert' }]);
  });
  it('mismatch and omitted keys are tickets-level incidents, including their count', () => {
    const t = requested(); t.source = '0x' + 'ab'.repeat(20); t.skipped = '7';
    const r = incidents(t, AT);
    expect(r).toMatchObject([{ reason: 'source-mismatch', level: 'critical', subject: t.address }, { reason: 'keys-not-read', level: 'alert', subject: t.address }]);
    expect(r[1].detail).toContain('7 keys not read');
  });
  it('pins exact draw, graduation and unrequested detail text from recorded states', async () => {
    const { readFileSync } = await import('node:fs');
    const expected = JSON.parse(readFileSync(new URL('./fixtures/drand/details.json', import.meta.url), 'utf8'));
    expect(incidents(requested(), AT + 21601n)[0].detail).toBe(expected.draw);
    expect(incidents(fixture().consumers[1], AT + 21601n)[0].detail).toBe(expected.graduation);
    expect(incidents(unrequested(), AT + 3600n)[0].detail).toBe(expected.unrequested);
  });
  it('evaluate keeps multiple rows with ids and one unknown for a thrown check', () => {
    const drand = { consumers: [requested(), fixture().consumers[1]], timestamp: String(AT + 21600n), block: fixture().rpc.block, canary: { status: 'ok', reason: 'no-posted-word' } };
    const r = evaluate({ drand }, cfg, AT + 21600n).filter(r => r.id === 'drand-words');
    expect(r).toHaveLength(2); expect(r.every(r => r.reason === '6h')).toBe(true);
    expect(evaluate({ drand: {} }, cfg, AT).filter(r => r.id === 'drand-words')).toEqual([{ id: 'drand-words', status: 'unknown', reason: 'missing-stale-or-invalid-data' }]);
    expect(rows(requested(), AT)).toEqual([{ id: 'drand-words', status: 'ok', reason: 'healthy' }]);
  });
});

for (const [word, ready, reason] of [
  ['1', AT + 604500n, 'posted-awaiting-finality'], ['1', AT, 'posted-awaiting-finality'],
  ['1', AT + 604800n, 'posted-awaiting-finality'], ['1', AT + 604801n, 'past-deadline'],
  ['0', 0n, 'past-deadline'], ['1', AT - 1n, 'past-deadline'],
]) it(`past the deadline latest word ${word} at ${ready} reports ${reason}`, () => {
  const t = requested(); Object.assign(t.keys[0], { latestWord: word, latestReadyAt: String(ready) });
  const r = incidents(t, AT + 604860n)[0];
  expect(r).toMatchObject({ reason, level: 'emergency', subject: `${t.address}:3` });
  if (reason === 'posted-awaiting-finality') {
    expect(r.detail).toContain('latest readyAt ' + new Date(Number(ready) * 1000).toISOString().replace('.000Z', 'Z'));
    expect(r.detail).toContain('word counts once final');
  }
});
