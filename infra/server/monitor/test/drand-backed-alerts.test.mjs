import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { configure } from '../config.mjs';
import { ladder, readDrand } from '../drand.mjs';
import { main } from '../main.mjs';
import { fixture, rpcFixture, configInput, env } from './drand-fixture.mjs';
const record = JSON.parse(readFileSync(new URL('./fixtures/drand/backup.json', import.meta.url), 'utf8'));
const rt = BigInt(record.roundTime), target = BigInt(record.start.targetBlock);
const cfg = configure(configInput(fixture()), {});
function data(state = 'unstarted', block = target, latestBlock = block) {
  const f = fixture(), t = f.consumers[0]; t.backups[record.round] = { ...record[state] };
  return { consumers: [t], timestamp: String(rt + 440000n), block: String(block), latestBlock: String(latestBlock) };
}
const rows = (d, now, c = cfg) => ladder(d, c, now).filter(r => r.reason.startsWith('backup-'));
for (const [offset, reason, detail] of [
  [432001n, 'backup-can-start', 'backup can start until'],
  [496800n - 43200n, 'backup-latest-start-12h', 'latest start in 12 h 0 min'],
  [496800n - 21600n, 'backup-latest-start-6h', 'latest start in 6 h 0 min'],
  [496800n - 7200n, 'backup-latest-start-2h', 'latest start in 2 h 0 min'],
  [496801n, 'backup-start-missed', 'only a drand post before'],
]) it(`${reason} starts at round + ${offset} and replaces the previous backup row`, () => {
  const d = data(), now = rt + offset, t = d.consumers[0];
  expect(rows(d, now - 1n).some(r => r.reason === reason)).toBe(false);
  const r = rows(d, now); expect(r).toHaveLength(1);
  expect(r[0]).toMatchObject({ id: 'drand-words', subject: `${t.address}:3`, level: 'emergency', reason });
  expect(r[0].detail).toContain(detail);
  expect(r[0].detail).toContain(`tickets ${t.address} key 3 round ${record.round}`);
  expect(r[0].detail).toContain('round time 2026-10-21T10:00:12Z');
  expect(r[0].detail).toContain('finalized block 10000');
  expect(r[0].detail).toContain('docs/runbooks/monitoring.md, Box 0 backup');
  expect(r[0].detail).not.toMatch(/https?:/);
  expect(ladder(d, cfg, now).some(r => r.reason === '5d')).toBe(true);
});
it('uses the inclusive latest-start and key deadlines, and suppresses backup-start rows for posts', () => {
  const d = data(), k = d.consumers[0].keys[0], deadline = BigInt(k.requestedAt) + 604800n;
  expect(rows(d, rt + 432000n)).toEqual([]);
  expect(rows(d, rt + 496800n)[0].reason).toBe('backup-latest-start-2h');
  expect(rows(d, deadline)[0].reason).toBe('backup-start-missed');
  expect(rows(d, deadline + 1n)).toEqual([]);
  k.latestWord = '1'; expect(rows(d, rt + 440000n)).toEqual([]);
  k.latestWord = '0'; k.word = '1'; expect(rows(d, rt + 440000n)).toEqual([]);
});
it('reports the start time, target, proof-window last block and request deadline', () => {
  const r = rows(data('start', target - 1n), rt + 440000n);
  expect(r).toHaveLength(1); expect(r[0]).toMatchObject({ reason: 'backup-started', level: 'critical' });
  expect(r[0].detail).toContain('started 2026-10-26T10:00:13Z');
  expect(r[0].detail).toContain('backup started, fix due after block 10000 is final');
  expect(r[0].detail).toContain('last block 18191');
  expect(r[0].detail).toContain('deadline 2026-10-28T10:00:00Z');
});
for (const [offset, reason, prior] of [[300n, 'backup-fix-due', 'backup-started'], [8000n, 'backup-fix-window-closing', 'backup-fix-due']]) {
  it(`${reason} at finalized target + ${offset}, independent of wall time`, () => {
    expect(rows(data('start', target + offset - 1n, target + 8183n), rt + 440000n)[0].reason).toBe(prior);
    const r = rows(data('start', target + offset, target + 8183n), rt + 440000n); expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ reason, level: 'emergency' });
    expect(rows(data('start', target + offset), rt + 440001n)[0].reason).toBe(reason);
  });
}
// rc8 open item 87 / P2CR-2: expiry follows latest while due and closing still follow finalized.
it('backup-fix-window-closed past latest target + 8,183 with finalized lagging or equal, or under 96 s before the deadline', () => {
  expect(rows(data('start', target + 8120n, target + 8183n), rt + 440000n)[0].reason).toBe('backup-fix-window-closing');
  const r = rows(data('start', target + 8120n, target + 8184n), rt + 440000n); expect(r).toHaveLength(1);
  expect(rows(data('start', target + 8183n), rt + 440000n)[0].reason).toBe('backup-fix-window-closing');
  expect(rows(data('start', target + 8184n), rt + 440000n)[0].reason).toBe('backup-fix-window-closed');
  expect(r[0]).toMatchObject({ reason: 'backup-fix-window-closed', level: 'emergency' });
  expect(r[0].detail).toContain('finalized block 18120, latest block 18184');
  expect(r[0].detail).toContain('backup fix window closed');
  expect(r[0].detail).toContain('last block 18191');
  expect(r[0].detail).toContain('docs/runbooks/monitoring.md, Box 0 backup');
  const d = data('start', target + 300n), k = d.consumers[0].keys[0], deadline = BigInt(k.requestedAt) + 604800n;
  expect(rows(d, deadline - 96n)[0].reason).toBe('backup-fix-due');
  expect(rows(d, deadline - 95n)[0].reason).toBe('backup-fix-window-closed');
  // A fixed backup is never "closed": its row stays backup-fixed.
  expect(rows(data('fixed', target + 9000n), rt + 440000n)[0].reason).toBe('backup-fixed');
  // The founder's action for it, beside the other backup rows (the detail names that section).
  const runbook = readFileSync(new URL('../../../../docs/runbooks/monitoring.md', import.meta.url), 'utf8');
  expect(runbook).toContain('| `backup-fix-window-closed` (EMERGENCY) |');
  expect(runbook).toMatch(/closed after target \+8,183/);
});
for (const reverse of [false, true]) it(`every key closes at the shared round's earliest live deadline, reversed keys: ${reverse}`, () => {
  const d = data('start', target + 8000n), t = d.consumers[0], k = t.keys[0], deadline = BigInt(k.requestedAt) + 604800n;
  t.status.drawsRequested = '4';
  t.keys.push({ ...k, key: '4', requestedAt: String(BigInt(k.requestedAt) + 96n) });
  if (reverse) t.keys.reverse();
  expect(rows(d, deadline - 96n).map(r => r.reason)).toEqual(['backup-fix-window-closing', 'backup-fix-window-closing']);
  const closed = rows(d, deadline - 95n);
  expect(closed.map(r => r.reason)).toEqual(['backup-fix-window-closed', 'backup-fix-window-closed']);
  expect(closed.every(r => r.detail.includes('deadline 2026-10-28T10:00:00Z'))).toBe(true);
  // A different round's request does not shorten this round's deadline.
  t.keys.find(other => other.key === '4').round = String(BigInt(k.round) + 1n);
  t.backups[String(BigInt(k.round) + 1n)] = { ...record.start };
  expect(rows(d, deadline - 95n).find(r => r.subject.endsWith(':4')).reason).toBe('backup-fix-window-closing');
});
it('the runbook distinguishes latest expiry, finalized due/closing, and the earliest round deadline', () => {
  const runbook = readFileSync(new URL('../../../../docs/runbooks/monitoring.md', import.meta.url), 'utf8');
  expect(runbook).toContain('Past target +8,183 at the latest block, or under 96 s before the round\'s earliest live deadline');
  expect(runbook).toContain('latest block − target ≤8,183');
  expect(runbook).toContain('due and closing rows use the finalized');
  expect(runbook).toContain('one extra call per run');
});
it('public overrides change the start rungs and fix block thresholds', () => {
  const c = { ...cfg, drandBackupStartLadder: '3600,600', drandBackupFixGraceBlocks: '10', drandBackupFixClosingBlocks: '20' };
  expect(rows(data(), rt + 496800n - 3600n, c)[0].reason).toBe('backup-latest-start-1h');
  expect(rows(data(), rt + 496800n - 600n, c)[0].reason).toBe('backup-latest-start-600s');
  expect(rows(data('start', target + 10n), rt + 440000n, c)[0].reason).toBe('backup-fix-due');
  expect(rows(data('start', target + 20n), rt + 440000n, c)[0].reason).toBe('backup-fix-window-closing');
});
it('a fixed word stays WARN until the graduation is accepted or the draw settles, even when usable', () => {
  const d = data('fixed'), t = d.consumers[0], k = t.keys[0];
  k.word = '123'; k.readyAt = record.fixed.fixedAt;
  let r = rows(d, rt + 440000n); expect(r).toHaveLength(1);
  expect(r[0]).toMatchObject({ reason: 'backup-fixed', level: 'warn' });
  expect(r[0].detail).toContain('fixed 2026-10-26T11:00:12Z');
  expect(r[0].detail).toContain('ready within the deadline');
  expect(ladder(d, cfg, rt + 440000n)).toHaveLength(1);
  t.status.drawsSettled = '3'; expect(rows(d, rt + 440000n)).toEqual([]);
  k.key = '0'; t.status.slots = '1'; t.status.wordRequestedAt = k.requestedAt;
  expect(rows(d, rt + 440000n)[0].reason).toBe('backup-fixed');
  t.status.wordAcceptedAt = String(rt + 440000n); expect(rows(d, rt + 440000n)).toEqual([]);
});
it('a late fix states readiness past the deadline and retains the existing deadline alarm', () => {
  const d = data('fixed'), t = d.consumers[0], k = t.keys[0], late = BigInt(k.requestedAt) + 604801n;
  t.backups[k.round].fixedAt = String(late); k.word = '123'; k.readyAt = String(late); d.timestamp = String(late);
  expect(rows(d, late)[0].detail).toContain('ready after the deadline');
  expect(ladder(d, cfg, late).some(r => r.reason === 'past-deadline')).toBe(true);
});
it('no v2, mismatched, terminal or failed consumer gets a backup row', () => {
  for (const change of [t => { t.version = 2; t.source = cfg.drandSource; }, t => { t.source = cfg.drandSource; },
    t => { t.status.terminalAt = String(rt); }, t => { t.error = 'read-failed'; }]) {
    const d = data('start', target + 8000n); change(d.consumers[0]); expect(rows(d, rt + 440000n)).toEqual([]);
  }
});
it('CLI --drand prints every new backup reason from fake RPC states without delivery or a listener', async () => {
  for (const [state, block, now, reason] of [
    ['unstarted', target, rt + 432001n, 'backup-can-start'],
    ['unstarted', target, rt + 453600n, 'backup-latest-start-12h'],
    ['unstarted', target, rt + 475200n, 'backup-latest-start-6h'],
    ['unstarted', target, rt + 489600n, 'backup-latest-start-2h'],
    ['unstarted', target, rt + 496801n, 'backup-start-missed'],
    ['start', target, rt + 440000n, 'backup-started'],
    ['start', target + 300n, rt + 440000n, 'backup-fix-due'],
    ['start', target + 8000n, rt + 440000n, 'backup-fix-window-closing'],
    ['start', target + 8120n, rt + 440000n, 'backup-fix-window-closed'],
    ['fixed', target + 8000n, rt + 440000n, 'backup-fixed'],
  ]) {
    const h = rpcFixture(); h.f.consumers[0].backups[record.round] = { ...record[state] };
    h.f.rpc.block = String(block); h.f.rpc.latestBlock = String(reason === 'backup-fix-window-closed' ? target + 8184n : block);
    h.f.rpc.timestamp = String(now);
    if (state === 'fixed') Object.assign(h.f.consumers[0].keys[0], { word: '123', readyAt: record.fixed.fixedAt });
    let output = '';
    const ports = { request: h.request, now, readConfig: async () => configInput(h.f), write: s => { output += s; }, error: s => { throw new Error(s); } };
    expect(await main(['--drand'], env, ports)).toBe(1);
    expect(output).toContain(`drand-words: alert (${reason})`);
    if (reason === 'backup-fix-window-closed') expect(output).toContain('finalized block 18120, latest block 18184');
    expect(output).not.toContain('source-mismatch'); expect(output).not.toContain('FAKE_');
    const out = await readDrand(cfg, env, h.f.rpc, { request: h.request });
    expect(rows(out, now)).toHaveLength(1);
  }
});

it('start detail reports actual hours and minutes, rounded down, within the 6h rung', () => {
  expect(rows(data(), rt + 496800n - 10000n)[0]).toMatchObject({ reason: 'backup-latest-start-6h',
    detail: expect.stringContaining('latest start in 2 h 46 min (until ') });
});
