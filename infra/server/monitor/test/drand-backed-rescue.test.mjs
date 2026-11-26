import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { configure } from '../config.mjs';
import * as drand from '../drand.mjs';
import { evaluate } from '../policy.mjs';
import { fixture, configInput } from './drand-fixture.mjs';
import { healthy } from './support.mjs';
const record = JSON.parse(readFileSync(new URL('./fixtures/drand/backup.json', import.meta.url), 'utf8'));
const rt = BigInt(record.roundTime), target = BigInt(record.start.targetBlock);
const cfg = configure(configInput(fixture()), {});
function data(state = 'unstarted', block = target, latestBlock = block) {
  const t = fixture().consumers[0]; t.backups[record.round] = { ...record[state] };
  return { consumers: [t], timestamp: String(rt + 432001n), block: String(block), latestBlock: String(latestBlock) };
}
const work = (d, now, c = cfg) => drand.rescueWork(d, c, now);
it('pins the proof margins and one named 96-second margin to the keeper text', () => {
  expect(drand.CONTRACT).toMatchObject({ historyWindow: 8191n, recentBlocks: 8n });
  expect(drand.START_INCLUSION_SECONDS).toBe(96n);
  const keeper = readFileSync('packages/keeper/src/drand.ts', 'utf8');
  expect(keeper).toContain(`export const START_INCLUSION_SECONDS = ${drand.START_INCLUSION_SECONDS}n;`);
});
it('counts a post before a backup starts, and no post after it starts', () => {
  expect(work(data(), rt + 400000n)?.what).toBe('post');
  expect(work(data('start', target - 1n), rt + 432001n)).toBeNull();
});
for (const [offset, expected] of [[432000n, 'post'], [432001n, 'start the backup'], [496704n, 'start the backup'], [496705n, 'post']]) {
  it(`start admission at round + ${offset}: ${expected}`, () => expect(work(data(), rt + offset)?.what).toBe(expected));
}
for (const [block, admitted] of [[target - 1n, false], [target, true], [target + 8183n, true], [target + 8184n, false]]) {
  it(`fix admission at finalized block ${block}: ${admitted}`, () => {
    expect(work(data('start', block), rt + 440000n)?.what ?? null).toBe(admitted ? 'fix the backup' : null);
  });
}
for (const [block, latest, admitted] of [[target - 1n, target + 63n, false], [target, target + 64n, true],
  [target + 8119n, target + 8183n, true], [target + 8120n, target + 8184n, false]]) {
  it(`fix admission at latest ${latest} with finalized ${block}: ${admitted}`, () => {
    expect(work(data('start', block, latest), rt + 440000n)?.what ?? null).toBe(admitted ? 'fix the backup' : null);
  });
}
it('fix needs exactly 96 seconds before the earliest request deadline, never a later request on the same round', () => {
  const d = data('start'), t = d.consumers[0], deadline = BigInt(t.keys[0].requestedAt) + 604800n;
  t.keys.push({ ...t.keys[0], key: '4', requestedAt: String(BigInt(t.keys[0].requestedAt) + 10n) });
  expect(work(d, deadline - 96n)).toMatchObject({ what: 'fix the backup', key: '3', end: deadline });
  expect(work(d, deadline - 95n)).toBeNull();
});
it('keeps strict rescue windows and picks the nearest deadline', () => {
  const d = data(), now = rt + 432001n, left = rt + 496800n - now;
  expect(work(d, now, { ...cfg, drandRescueWindowSeconds: String(left) })).toBeNull();
  expect(work(d, now, { ...cfg, drandRescueWindowSeconds: String(left + 1n) })?.what).toBe('start the backup');
  const v2 = fixture().consumers[1]; v2.status.wordRequestedAt = String(now - 604700n);
  v2.keys[0].requestedAt = v2.status.wordRequestedAt; d.consumers.push(v2);
  expect(work(d, now)).toMatchObject({ address: v2.address, what: 'post', end: now + 100n });
});
it('a latest post, fixed word, silent head, terminal mode or mismatched source admits no backup work', () => {
  for (const change of [
    t => { t.keys[0].latestWord = '1'; },
    t => { t.backups[record.round] = record.fixed; t.keys[0].word = '1'; t.keys[0].readyAt = record.fixed.fixedAt; },
    t => { t.keys[0].requestedAt = String(rt - 604800n); },
    t => { t.status.terminalAt = String(rt); },
    t => { t.drand = '0x' + 'ab'.repeat(20); },
    t => { t.error = 'read-failed'; },
  ]) {
    const d = data(); change(d.consumers[0]); d.timestamp = String(rt + 440000n);
    expect(work(d, rt + 440000n)).toBeNull();
  }
});
function fee(d, now, c = cfg) {
  const o = healthy({}); o.view.maxFeePerGasWei = '3250000000'; o.drand = { ...d, timestamp: String(now) };
  o.view.identity = c.keeperIdentity; o.keeper.identity = c.keeperIdentity;
  o.view.observedAt = String(now); o.keeper.modifiedAt = String(now); o.keeper.state.budget.day = String(now / 86400n);
  return evaluate(o, c, now).find(r => r.id === 'keeper-fee');
}
it('3.25 gwei is a rescue fee during start or fix and a pause outside admission', () => {
  const c = { ...cfg, drandRescueWindowSeconds: '86400' }, now = rt + 432001n;
  expect(fee(data(), now, c)).toMatchObject({ reason: 'drand-rescue-fee' });
  expect(fee(data(), rt + 432000n, c)).toMatchObject({ reason: 'fee-pause' });
  expect(fee(data(), rt + 496704n, c).detail).toContain('start the backup');
  // Post remains legitimate under default 72 h; a 24 h rescue window isolates the start's own admission here.
  expect(fee(data(), rt + 496705n, c)).toMatchObject({ reason: 'fee-pause' });
  expect(fee(data('start'), now).detail).toContain('fix the backup');
  expect(fee(data('start', target - 1n), now).reason).toBe('fee-pause');
  expect(fee(data('start', target + 8119n, target + 8183n), now).reason).toBe('drand-rescue-fee');
  expect(fee(data('start', target + 8120n, target + 8184n), now).reason).toBe('fee-pause');
  const deadline = BigInt(data().consumers[0].keys[0].requestedAt) + 604800n;
  expect(fee(data('start'), deadline - 96n).reason).toBe('drand-rescue-fee');
  expect(fee(data('start'), deadline - 95n).reason).toBe('fee-pause');
});
