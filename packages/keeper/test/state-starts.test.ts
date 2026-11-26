import { mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { StateStore, encodeState } from '../src/state';
import { activeIncomeSpend, reconcileStarts, startUnpaid, UNKNOWN_INCOME_BOX, type IncomeSpend } from '../src/income';
import { runTick, type KeeperState } from '../src/run';
import { addr, box, options, quiet, time, world } from './support/v2';

const io = vi.hoisted(() => ({ cut: '', before: false, published: '', writes: [] as string[] }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs,
    renameSync: vi.fn<typeof fs.renameSync>((from, to) => {
      if (io.before && String(to) === io.cut) throw new Error('process stopped');
      fs.renameSync(from, to); io.published = String(to); io.writes.push(String(to));
    }),
    fsyncSync: vi.fn<typeof fs.fsyncSync>(fd => {
      fs.fsyncSync(fd);
      // Directory fsync after publication: stop between complete atomic writes.
      if (!io.before && io.published === io.cut && io.cut) { io.published = ''; throw new Error('process stopped'); }
    }),
  };
});
afterEach(() => { io.cut = ''; io.published = ''; io.before = false; });
const C = 15000000000000000n, hash = `0x${'ab'.repeat(32)}`, repaymentHash = `0x${'cd'.repeat(32)}`;
const identity = 'chain:signer:registry';
const debt = (extra: Partial<IncomeSpend> = {}): IncomeSpend => ({ box: addr(3), at: time, costWei: C, hash,
  start: { job: 'collect' }, ...extra });
const path = () => join(mkdtempSync(join(tmpdir(), 'keeper-start-disk-')), 'state');
const save = (file: string, incomeSpend: readonly IncomeSpend[]) => {
  const store = new StateStore(file, identity);
  try { store.load(); store.save({ incomeSpend }, time); } finally { store.close(); }
};
const load = (file: string, now = time) => {
  const store = new StateStore(file, identity);
  try { return store.load(now); } finally { store.close(); }
};
const snapshot = (at: bigint) => ({ at, platformWei: 0n, boxes: {}, mined: { [hash]: time + 12n } });
const raw = z.string().regex(/^\d+$/).transform((s) => BigInt(s));
// Copied literally from `git show 7bb02785e:packages/keeper/src/state.ts`, lines 17–18.
const oldSpend = z.array(z.object({ box: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(s => s as `0x${string}`),
      at: raw, costWei: raw, hash: z.string().min(1).optional() })).optional();
function oldTick(file: string, at: bigint) {
  const book = JSON.parse(readFileSync(file, 'utf8')) as { state: KeeperState };
  const spend = oldSpend.parse(book.state.incomeSpend) ?? [];
  expect(JSON.parse(JSON.stringify(spend, (_, v: unknown) => typeof v === 'bigint' ? String(v) : v))).toEqual(book.state.incomeSpend); // The old decoder strips nothing from J.
  book.state = { ...book.state, incomeSpend: spend.filter(s => !s.hash || snapshot(at).mined[s.hash] === undefined
    || (snapshot(at).mined[s.hash] ?? 0n) > at - 86400n) };
  writeFileSync(file, JSON.stringify(book, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v));
}
it.each([1, 25])('rollback for %i hour(s) restores one full unpaid debt and its ordinary-work lock', async hours => {
  const file = path(), s = debt(); save(file, [s]);
  // Another collector gets there first; this final tip is one wei below the signed cost.
  const small = { ...snapshot(time + 24n), startReceipts: [{ box: s.box, hash, at: time + 12n,
    shareWei: 0n, tipsWei: C - 1n, startTipWei: C - 1n }] };
  save(file, reconcileStarts(present(load(file).incomeSpend), small));
  for (const h of hours === 1 ? [1] : [1, 12, 24, 25]) oldTick(file, time + BigInt(h) * 3600n);
  const returned = load(file), at = time + BigInt(hours) * 3600n;
  expect(returned.incomeSpend).toHaveLength(1); expect(returned.incomeSpend?.[0]?.costWei).toBe(C);
  expect(startUnpaid(addr(3), present(returned.incomeSpend))).toBe(true);
  const send = vi.fn(async () => hash);
  const out = await runTick({ read: async () => world(box(), 1000n, at),
    readIncome: async () => ({ ...snapshot(at), boxes: { [addr(3)]: { shareWei: 100n * C, tipsWei: 0n } }, platformWei: 100n * C }),
    simulate: async c => ({ ok: c.job === 'collect', estimate: 100000n, tipWei: null }), send }, returned, { ...options(), dryRun: false }, quiet);
  expect(out.report.skipped).toContainEqual(expect.objectContaining({ code: 'START_UNPAID' }));
  expect(send).not.toHaveBeenCalled(); save(file, present(out.state.incomeSpend)); expect(load(file).incomeSpend).toHaveLength(1);
});
it('starts publish before journal before signing, and hash publication has the same order', async () => {
  const file = path(), store = new StateStore(file, identity);
  const send = vi.fn(async () => {
    expect(io.writes.filter(p => p === file || p === `${file}.starts`)).toEqual([`${file}.starts`, file]);
    const journal = JSON.parse(readFileSync(file, 'utf8'));
    expect(journal.version).toBe(1); expect(journal.state.incomeSpend[0].start).toBeUndefined();
    expect(readFileSync(`${file}.starts`, 'utf8')).toContain('"collect"'); return hash;
  });
  try {
    await runTick({ read: async () => world(box()), readIncome: async () => snapshot(time),
      simulate: async c => ({ ok: c.job === 'collect', estimate: 1190000n, tipWei: C, startTipWei: C }), send }, {},
    { ...options(), dryRun: false, priorityFeeWei: 2999999998n, checkpoint: async (s, now) => { store.save(s, now); } }, quiet);
    expect(send).toHaveBeenCalledOnce();
    expect(io.writes.filter(p => p === file || p === `${file}.starts`).slice(2, 4)).toEqual([`${file}.starts`, file]);
    expect(store.load().incomeSpend?.[0]?.hash).toBe(hash);
  } finally { store.close(); }
});
it.each(['reserve', 'hash', 'settle', 'repay', 'drop'] as const)('stops before and after starts publication during %s preserve debt', event => {
  for (const before of [true, false]) {
    const file = path(), reserved = debt({ hash: undefined }), paid = debt({ start: { job: 'collect', settledAt: time + 12n } });
    const previous = event === 'reserve' ? [] : event === 'hash' ? [reserved] : event === 'drop' ? [paid] : [debt()];
    const next = event === 'reserve' ? [reserved] : event === 'hash' ? [debt()] : event === 'settle' ? [paid]
      : event === 'repay' ? [debt({ start: { job: 'collect', repaidAt: time + 24n, paymentHashes: [repaymentHash] } })] : [];
    save(file, previous);
    const store = new StateStore(file, identity); store.load(); io.cut = `${file}.starts`; io.before = before;
    try { expect(() => store.save({ incomeSpend: next }, event === 'drop' ? time + 86412n : time + 24n)).toThrow('process stopped'); } finally { io.cut = ''; store.close(); }
    const recovered = present(load(file, event === 'drop' ? time + 86412n : time).incomeSpend);
    if (event === 'drop') expect(recovered).toEqual([]);
    else if (before) expect(recovered).toEqual(previous);
    else if (event === 'reserve') expect(recovered).toEqual([reserved]);
    else expect(recovered).toEqual(next);
  }
});
it.each(['reserve', 'hash'] as const)('a stop after journal publication during %s retains one reservation', event => {
  const file = path(), s = debt({ hash: event === 'reserve' ? undefined : hash });
  save(file, event === 'reserve' ? [] : [debt({ hash: undefined })]);
  const store = new StateStore(file, identity); store.load(); io.cut = file;
  try { expect(() => store.save({ incomeSpend: [s] }, time + 24n)).toThrow('process stopped'); } finally { io.cut = ''; store.close(); }
  expect(load(file).incomeSpend).toEqual([s]);
});
it.each([true, false])('a stop around initial marker publication must retain A and permit restart (before=%s)', before => {
  const file = path(); writeFileSync(file, encodeState({}, identity));
  const store = new StateStore(file, identity); io.cut = `${file}.starts-required`; io.before = before;
  try { expect(() => store.save({ incomeSpend: [debt()] }, time + 24n)).toThrow('process stopped'); } finally { io.cut = ''; store.close(); }
  expect(load(file).incomeSpend).toEqual([debt({ hash: undefined })]);
});
it('a paid orphan inside its window retains its payment and remaining debit', () => {
  const file = path(); save(file, [debt({ start: { job: 'collect', settledAt: time + 12n } })]);
  writeFileSync(file, encodeState({ incomeSpend: [] }, identity));
  expect(load(file).incomeSpend).toEqual([debt({ start: { job: 'collect', settledAt: time + 12n } })]);
});
it.each([3600n, 90000n])('payment during rollback settles only with an in-window final proof at +%i', elapsed => {
  const file = path(); save(file, [debt()]); oldTick(file, time + elapsed);
  const receipt = { box: addr(3), hash, at: time + 12n, shareWei: 0n, tipsWei: C, startTipWei: C };
  const result = reconcileStarts(present(load(file).incomeSpend), { ...snapshot(time + elapsed), startReceipts: elapsed < 86400n ? [receipt] : [] });
  expect(startUnpaid(addr(3), result)).toBe(elapsed >= 86400n);
  expect(result[0]?.start?.settledAt).toBe(elapsed < 86400n ? time + 12n : undefined);
});
it('old journals and unknown inline start fields load as ordinary spend', () => {
  const file = path(), ordinary = { box: addr(3), at: time, costWei: C, hash };
  writeFileSync(file, encodeState({ incomeSpend: [ordinary] }, identity)); expect(load(file).incomeSpend).toEqual([ordinary]);
  writeFileSync(file, JSON.stringify({ version: 1, identity, state: { incomeSpend: [debt()] } }, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v));
  save(file, present(load(file).incomeSpend)); expect(load(file).incomeSpend).toEqual([ordinary]);
  expect(readFileSync(file, 'utf8')).not.toContain('"start":');
});
it('a missing starts file after a new write stops despite old-code rewrites', () => {
  const file = path(); save(file, []); oldTick(file, time + 90000n); renameSync(`${file}.starts`, `${file}.starts.saved`);
  expect(() => load(file)).toThrow('keeper starts file missing');
});
it.each(['{broken', '{"version":1,"identity":"other","starts":[]}', '{"version":1,"identity":"chain:signer:registry","starts":{"bad":{}}}'])('damaged starts stop with fixed text: %s', text => {
  const file = path(); save(file, [debt()]); writeFileSync(`${file}.starts`, text);
  expect(() => load(file)).toThrow('keeper starts invalid or belongs to another chain/signer/registry');
});
it('dry books and marker leave all live book bytes unchanged', () => {
  const file = path(); save(file, [debt({ hash: undefined })]);
  const files = [file, `${file}.starts`, `${file}.starts-required`], before = files.map(p => readFileSync(p, 'utf8'));
  save(`${file}.dry`, [{ box: addr(3), at: time, costWei: C }]);
  expect(files.map(p => readFileSync(p, 'utf8'))).toEqual(before);
  expect(startUnpaid(addr(3), present(load(file).incomeSpend))).toBe(true);
  expect(activeIncomeSpend(present(load(`${file}.dry`).incomeSpend), snapshot(time + 86400n), true)).toEqual([]);
});

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}

it('a repaid orphan inside its window retains its payment time and receipt exclusions', () => {
  const file = path(); save(file, [debt({ start: { job: 'collect', repaidAt: time + 30n, paymentHashes: [repaymentHash] } })]);
  writeFileSync(file, encodeState({ incomeSpend: [] }, identity));
  expect(load(file).incomeSpend).toEqual([debt({ start: { job: 'collect', repaidAt: time + 30n, paymentHashes: [repaymentHash] } })]);
});

it('two paid dry starts at the same box and time retain both costs without colliding in the starts file', async () => {
  const file = `${path()}.dry`, store = new StateStore(file, identity), send = vi.fn(async () => hash);
  try {
    const out = await runTick({ read: async () => world(box({ v2: { ...present(box().v2), depthBudget: 0n, buyBackP: 0n } })),
      readIncome: async () => snapshot(time),
      simulate: async c => ({ ok: c.job === 'collect' || c.job === 'sellFees', estimate: 1190000n, tipWei: C * 200n, startTipWei: C * 200n }), send }, {},
    { ...options(), dryRun: true, priorityFeeWei: 2999999998n, checkpoint: async (s, now) => { store.save(s, now); } }, quiet);
    expect(out.report.sent.map(s => s.job)).toEqual(['collect', 'sellFees']);
    expect(store.load().incomeSpend).toEqual([{ box: addr(3), at: time, costWei: C }, { box: addr(3), at: time, costWei: 24600000000000000n }]);
    expect(JSON.parse(readFileSync(`${file}.starts`, 'utf8')).starts).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  } finally { store.close(); }
});

it('an orphan start preserves the unknown liability of a pre-income journal', () => {
  const file = path(); save(file, [debt({ hash: undefined })]);
  const budget = { day: time / 86400n, block: 100n, totalWei: 4n * C, oursWei: 4n * C, pokesWei: 0n, txInBlock: 1 };
  writeFileSync(file, encodeState({ budget }, identity));
  expect(load(file).incomeSpend).toEqual([{ box: UNKNOWN_INCOME_BOX, at: time, costWei: 4n * C }, debt({ hash: undefined })]);
  save(file, present(load(file).incomeSpend));
  expect(load(file).incomeSpend).toHaveLength(2);
});

it('A identities must remain unique and duplicate identities must stop loading', () => {
  const file = path(), entries = [debt(), debt({ at: time + 1n, hash: repaymentHash })]; save(file, entries);
  const a = JSON.parse(readFileSync(`${file}.starts`, 'utf8'));
  expect(a.starts).toHaveLength(2); expect(new Set(a.starts.map((s: { id: string }) => s.id)).size).toBe(2);
  expect(load(file).incomeSpend).toEqual(entries);
  a.starts[1].id = a.starts[0].id; writeFileSync(`${file}.starts`, JSON.stringify(a));
  expect(() => load(file)).toThrow('keeper starts invalid or belongs to another chain/signer/registry');
});
it('box/time alone must join a start while identical hashes at other times stay ordinary', () => {
  const file = path(); save(file, [debt()]);
  const ordinary = { box: addr(3), at: time + 1n, costWei: C, hash };
  writeFileSync(file, encodeState({ incomeSpend: [ordinary, debt()] }, identity));
  expect(load(file).incomeSpend).toEqual([ordinary, debt()]);
});
it.each([false, true])('unmatched journal duplicates must remain ordinary (equal cost=%s)', equal => {
  const file = path(), ordinary = { box: addr(3), at: time, costWei: C, hash };
  save(file, [ordinary, { ...ordinary, costWei: equal ? C : C + 1n }]);
  expect(load(file).incomeSpend).toEqual([ordinary, { ...ordinary, costWei: equal ? C : C + 1n }]);
});
it.each(['settle', 'repay'] as const)('a stop after J during %s must retain the final A decision and identity', event => {
  const file = path(); save(file, [debt()]);
  const id = JSON.parse(readFileSync(`${file}.starts`, 'utf8')).starts[0].id;
  const next = debt({ start: event === 'settle' ? { job: 'collect', settledAt: time + 12n }
    : { job: 'collect', repaidAt: time + 24n, paymentHashes: [repaymentHash] } });
  const store = new StateStore(file, identity); io.cut = file;
  try { expect(() => store.save({ incomeSpend: [next] }, time + 24n)).toThrow('process stopped'); } finally { io.cut = ''; store.close(); }
  expect(load(file).incomeSpend).toEqual([next]);
  expect(JSON.parse(readFileSync(`${file}.starts`, 'utf8')).starts[0].id).toBe(id);
});
it('mixed additions and expired removals must retain A around both J changes at every publication', () => {
  for (const cutAt of [1, 2, 3]) {
    const file = path(), old = debt({ start: { job: 'collect', repaidAt: time + 24n } }); save(file, [old]);
    const next = debt({ box: addr(88), at: time + 86424n, hash: undefined });
    const store = new StateStore(file, identity); io.writes = [];
    const rename = vi.mocked(renameSync), original = rename.getMockImplementation();
    let writes = 0;
    rename.mockImplementation((from, to) => {
      original?.(from, to);
      if ((String(to) === file || String(to) === `${file}.starts`) && ++writes === cutAt) throw new Error('process stopped');
    });
    try { expect(() => store.save({ incomeSpend: [next] }, time + 86424n)).toThrow('process stopped'); }
    finally { rename.mockImplementation(present(original)); store.close(); }
    expect(io.writes.filter(p => p === file || p === `${file}.starts`)).toEqual([`${file}.starts`, file, `${file}.starts`].slice(0, cutAt));
    const loaded = load(file, time + 86424n).incomeSpend ?? [];
    expect(activeIncomeSpend(loaded, snapshot(time + 86424n))).toEqual([next]);
    expect(startUnpaid(addr(88), loaded)).toBe(true);
  }
});

it('distinct seconds must preserve equal hashless ordinary and start costs and one lock', () => {
  const file = path(), ordinary = { box: addr(3), at: time, costWei: C };
  save(file, [ordinary, debt({ at: time + 1n, hash: undefined })]);
  const spend = load(file).incomeSpend ?? [];
  expect(spend).toHaveLength(2); expect(spend.map(s => s.costWei)).toEqual([C, C]);
  expect(spend.filter(s => s.start)).toHaveLength(1); expect(startUnpaid(addr(3), spend)).toBe(true);
});

it('paid removal must leave the ordinary cost and permit continued checkpoints', () => {
  const file = path(), ordinary = { box: addr(3), at: time, costWei: C };
  const paid = debt({ at: time + 1n, start: { job: 'collect', repaidAt: time + 24n } }); save(file, [ordinary, paid]);
  const store = new StateStore(file, identity);
  try { store.save({ incomeSpend: [ordinary] }, time + 86424n); }
  finally { store.close(); }
  expect(load(file, time + 86424n).incomeSpend).toEqual([ordinary]);
});

it.each(['.starts-required', '.starts', ''])('first use stopped after %s must have a defined restart before any signature', suffix => {
  const file = path(), store = new StateStore(file, identity), reserved = debt({ hash: undefined });
  io.cut = file + suffix;
  try { expect(() => store.save({ incomeSpend: [reserved] }, time + 24n)).toThrow('process stopped'); }
  finally { io.cut = ''; store.close(); }
  expect(load(file).incomeSpend).toEqual([reserved]);
});
