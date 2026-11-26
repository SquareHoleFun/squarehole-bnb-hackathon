/**
 * SH-249 review note 1: a first collection (a start, F182) whose starts-file write landed but whose journal write did
 * not. Its bytes never reached a node (the broadcast follows the journal and the record's `sent` mark), so the start is
 * dropped with its record entry instead of staying unpaid without a hash and blocking its box for good. Two ways in:
 * a crash between the two renames of one save, and a journal write that fails (disk full) in a running process, both
 * with and without a restart. On the line's src the box stays blocked (`start unpaid`) in every case.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SentEntry } from '../src/sent';
import { sentReport, viemReads } from '../src/sent-report';
import { expectA2, model, proc, tmp, type Model } from './support/sent-model';

const io = vi.hoisted(() => ({ failJournal: false, failed: 0 }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: (from: string, to: string) => {
    if (io.failJournal && to.endsWith('/keeper.json')) {
      io.failJournal = false; io.failed++;
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return fs.renameSync(from, to);
  } };
});

const copyDir = (from: string) => {
  const to = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'sent-start-'));
  for (const n of readdirSync(from)) if (!n.includes('.lock') && !n.endsWith('.pending')) copyFileSync(join(from, n), join(to, n));
  return to;
};
type Store = { saveSent: (r: { entries: readonly SentEntry[] }) => void };
const unpaid = (t: { state: { incomeSpend?: readonly { start?: { settledAt?: bigint; repaidAt?: bigint } }[] } }) =>
  (t.state.incomeSpend ?? []).filter(s => s.start && s.start.settledAt === undefined && s.start.repaidAt === undefined);

/** The box is not blocked: a later first collection goes out, then settles; A2 holds and no nonce serves two transactions. */
async function expectBoxFree(t: Model, p: ReturnType<typeof proc>, dir: string, from: bigint) {
  // SH-250: what reached the node lands first, as on a live chain; a nonce left unmined for 25 blocks may be taken over.
  t.mine();
  const later = await p.tick(from);
  expect(later.report.skipped).not.toContainEqual(expect.objectContaining({ job: 'collect', why: 'start unpaid' }));
  expect(later.report.sent.map(s => s.job)).toContain('collect');
  t.mine();
  const settled = await p.tick(from + 3n, false);
  expect(unpaid(p)).toEqual([]);
  expectA2(t, settled.state, dir);
}

describe('SH-249 note 1: a first collection whose journal write never landed', () => {
  it('a crash between the starts rename and the journal rename: the start goes with its never-broadcast entry', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    t.setFunded(false);
    let R: string | undefined, J: string | undefined, poolAtR: Model['m']['pool'] | undefined, hash: string | undefined;
    const store = a.store as unknown as Store;
    const realSave = store.saveSent?.bind(a.store);
    if (realSave) store.saveSent = r => {
      realSave(r);
      const c = r.entries.find(e => e.job === 'collect' && e.state === 'signed');
      if (c && !R) { R = copyDir(dir); poolAtR = new Map(t.m.pool); hash = c.txs[0]?.hash; }
    };
    a.checkpoint = async (next, now) => {
      a.store.save(next, now);
      if (R && !J && next.incomeSpend?.some(s => s.start && s.hash === hash)) J = copyDir(dir);
    };
    await a.tick(100n);
    a.close();
    expect(R && J, 'both crash copies taken').toBeTruthy();
    // The disk of a process that died between the two renames: record and journal as at R, starts file as at J.
    const C = copyDir(R as string);
    for (const n of ['keeper.json.starts', 'keeper.json.starts-required']) if (existsSync(join(J as string, n))) copyFileSync(join(J as string, n), join(C, n));
    expect(readFileSync(join(C, 'keeper.json.starts'), 'utf8')).toContain(hash);
    expect(readFileSync(join(C, 'keeper.json'), 'utf8')).not.toContain(hash);
    t.m.pool = poolAtR ?? new Map();
    t.m.attempts = t.m.attempts.filter(r => [...t.m.pool.values()].includes(r));
    const b = proc(t, C);
    expect(unpaid(b)).toEqual([]);
    expect(readFileSync(join(C, 'keeper.json.starts'), 'utf8')).not.toContain(hash);
    expect(readFileSync(join(C, 'keeper.json.sent'), 'utf8')).not.toContain(hash);
    await expectBoxFree(t, b, C, 140n);
    b.close();
  });

  it.each([false, true])('a journal write that fails after the starts write (restart: %s) leaves the box free', async restart => {
    const t = model(), dir = tmp();
    let a = proc(t, dir);
    t.setFunded(false);
    io.failed = 0;
    const store = a.store as unknown as Store;
    const realSave = store.saveSent?.bind(a.store);
    if (realSave) store.saveSent = r => { realSave(r); if (r.entries.some(e => e.job === 'collect' && e.state === 'signed') && !io.failed) io.failJournal = true; };
    await expect(a.tick(100n)).rejects.toThrow('ENOSPC');
    expect(io.failed).toBe(1);
    const collect = t.m.attempts.length;
    expect(collect, 'the collect never reached the node').toBe(2);
    if (restart) { a.close(); a = proc(t, dir); expect(unpaid(a)).toEqual([]); }
    else {
      // The same process: the next tick neither throws nor keeps the start.
      await a.tick(103n, false);
      expect(unpaid(a)).toEqual([]);
    }
    await expectBoxFree(t, a, dir, 140n);
    a.close();
  });

  it('books restored out of step keep a landed, unpaid first collection (no proof it never left): the box waits, as before', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    t.setStartProofs(false);
    await a.tick(97n);
    t.mine();
    const older = copyDir(dir);
    t.setFunded(false);
    await a.tick(100n);
    const start = a.state.incomeSpend?.find(s => s.start);
    expect(start?.hash).toMatch(/^0x[0-9a-f]{64}$/);
    // The start landed and is final; its record entry retires; without a proof of its own tip it stays unpaid.
    t.mine();
    await a.tick(103n, false);
    expect(t.m.mined.has(start?.hash as string)).toBe(true);
    expect(readFileSync(join(dir, 'keeper.json.sent'), 'utf8')).not.toContain(start?.hash);
    expect(unpaid(a)).toHaveLength(1);
    a.close();
    // A restore out of step: the journal from before the start, every other book from after it.
    copyFileSync(join(older, 'keeper.json'), join(dir, 'keeper.json'));
    expect(readFileSync(join(dir, 'keeper.json'), 'utf8')).not.toContain(start?.hash);
    const b = proc(t, dir);
    expect(unpaid(b), 'the landed start is kept').toHaveLength(1);
    expect(readFileSync(join(dir, 'keeper.json.starts'), 'utf8')).toContain(start?.hash);
    const later = await b.tick(140n);
    expect(later.report.skipped).toContainEqual(expect.objectContaining({ job: 'collect', why: 'start unpaid' }));
    b.close();
    const lines = (await sentReport(join(dir, 'keeper.json'), viemReads(t.f.client))).join('\n');
    expect(lines).toContain(`income spend: box ${t.f.rc}, job collect (first collection, unpaid: its box waits)`);
  });

  it('SH-250 B7: a crash right after the record dropped the entry of a never-broadcast start leaves its box free', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    t.setFunded(false);
    io.failed = 0;
    const store = a.store as unknown as Store;
    const realSave = store.saveSent?.bind(a.store);
    let C: string | undefined;
    if (realSave) store.saveSent = r => {
      realSave(r);
      if (r.entries.some(e => e.job === 'collect' && e.state === 'signed') && !io.failed) io.failJournal = true;
      // The first record write without the collect's entry (the follow-up dropping it): the process dies right after.
      if (io.failed && !C && !r.entries.some(e => e.job === 'collect')) C = copyDir(dir);
    };
    await expect(a.tick(100n)).rejects.toThrow('ENOSPC');
    await a.tick(103n, false);
    a.close();
    expect(C, 'crash copy taken').toBeDefined();
    const b = proc(t, C as string);
    expect(unpaid(b)).toEqual([]);
    await expectBoxFree(t, b, C as string, 140n);
    b.close();
  });
});
