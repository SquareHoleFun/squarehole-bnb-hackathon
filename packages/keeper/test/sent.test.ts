/**
 * SH-249 stage A (open finding 8.4; CRIT-B findings 1 and 2): the keeper saves every signed transaction before its first
 * broadcast. Through the real scheduler (runTick), the real chain adapter and the real StateStore with its sidecars, on a
 * scripted node with a pool, mining, receipts and finality:
 * - a reply lost before or after the node took the transaction, and a crash at each write boundary, end with every
 *   reservation naming a saved transaction (or none durable), at most one charge per transaction, and no nonce signed
 *   for two different calls (A1, A2, A3);
 * - a first collection whose reply was lost settles and no longer blocks its box (A4);
 * - a lagging pending count, a moving head and an endpoint that refuses old receipts never reuse a nonce or release a
 *   charge; read counts per round are pinned.
 * Each failure test is shown failing on the line's src (the control; see docs/evidence/SH-249.md).
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTransaction, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { ViemChain } from '../src/chain';
import { runTick, type KeeperState } from '../src/run';
import { StateStore } from '../src/state';
import { SENT_INVALID, SENT_MISSING, decodeSent } from '../src/sent';
import { USAGE, sentReport, viemReads } from '../src/sent-report';
import { IDENTITY, crashCopy } from './support/sent-harness';
import { expectA2, expectOneCallPerNonce, hashOf, lineJournal, model, proc, savedHashes, tmp } from './support/sent-model';
import { dummy } from './support/sent-quiet';
import { quiet, time } from './support/v2';

describe('SH-249 A1/A2: a lost reply', () => {
  it('before the node took it: the saved bytes are broadcast again after a restart, mined and charged once', async () => {
    const t = model(), dir = tmp();
    let a = proc(t, dir);
    t.m.lostBefore = 3;
    const first = await a.tick(100n);
    expect(first.report.skipped.filter(s => s.why === 'send error')).toHaveLength(3);
    expect(t.m.pool.size).toBe(0);
    expectA2(t, a.state, dir);
    const reserved = first.state.budget?.pending?.map(r => r.hash) ?? [];
    expect(reserved).toHaveLength(3);
    a.close();
    a = proc(t, dir);
    await a.tick(103n, false);
    // The restarted process broadcast exactly the saved bytes, at nonces 7 to 9, and signed nothing new.
    expect([...t.m.pool.keys()].sort()).toEqual([7, 8, 9]);
    expect([...t.m.pool.values()].map(hashOf).sort()).toEqual([...reserved].sort());
    t.mine();
    const settled = await a.tick(106n, false);
    expect(settled.state.budget?.pending ?? []).toEqual([]);
    expect(savedHashes(dir).size).toBe(0);
    expectA2(t, settled.state, dir);
    // Nonces continue without a gap.
    await a.tick(109n);
    expect([...t.m.pool.keys()].sort((x, y) => x - y)).toEqual([7, 8, 9, 10, 11, 12]);
    a.close();
  });

  it('after the node took it: the hash in the journal settles; nothing is signed again at that nonce', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    t.m.lostAfter = 3;
    const first = await a.tick(100n);
    expect(first.report.skipped.filter(s => s.why === 'send error')).toHaveLength(3);
    expect(t.m.pool.size).toBe(3);
    expectA2(t, a.state, dir);
    t.mine();
    const next = await a.tick(103n, false);
    expect(next.state.budget?.pending ?? []).toEqual([]);
    expect(next.state.incomeSpend?.every(s => s.hash !== undefined)).toBe(true);
    expectA2(t, next.state, dir);
    await a.tick(106n);
    expect([...t.m.pool.keys()].sort((x, y) => x - y)).toEqual([7, 8, 9, 10, 11, 12]);
    expectOneCallPerNonce(t);
    a.close();
  });
});

describe('SH-249 A4: a first collection whose reply was lost', () => {
  it('settles on its own final receipt and no longer blocks its box', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    t.setFunded(false);
    // The collect is the third send of the tick: its reply is lost after the node took it.
    let n = 0;
    t.m.lose = () => (++n === 3 ? 'after' : undefined);
    const first = await a.tick(100n).catch(() => null);
    expect(first).not.toBeNull();
    const start = a.state.incomeSpend?.find(s => s.start);
    expect(start, 'the start reserved').toBeDefined();
    expect(first?.report.skipped).toContainEqual(expect.objectContaining({ job: 'collect', why: 'send error' }));
    expect(start?.hash, 'the start names its saved transaction').toMatch(/^0x[0-9a-f]{64}$/);
    t.m.lose = undefined;
    t.mine();
    const later = await a.tick(103n);
    expect(later.state.incomeSpend?.find(s => s.start)?.start?.settledAt).toBeDefined();
    expect(later.report.skipped).not.toContainEqual(expect.objectContaining({ job: 'collect', why: 'start unpaid' }));
    expect(later.report.sent.map(s => s.job)).toContain('collect');
    a.close();
  });
});

/** A crash at one write boundary: the disk and the node as a process that died there leaves them, then a restart. */
async function crashAt(point: 'sign' | 'record' | 'journal' | 'before-broadcast' | 'after-broadcast', start = false) {
  const t = model(), dir = tmp();
  const a = proc(t, dir);
  // A box without income room: the collect is its first collection (a start, F182), with its own lock.
  if (start) t.setFunded(false);
  let copy: string | undefined;
  let node: { pool: Map<number, Hex>; latest: number } | undefined;
  const take = () => {
    if (copy) return;
    copy = crashCopy(dir); node = { pool: new Map(t.m.pool), latest: t.m.latest };
  };
  // The third send (the collect) is where the process dies.
  let signs = 0, saves = 0;
  const sign = dummy.signTransaction.bind(dummy);
  const spy = Object.assign(dummy, {});
  const original = spy.signTransaction;
  spy.signTransaction = (async (tx: never) => { if (++signs === 3 && point === 'sign') take(); return sign(tx); }) as typeof original;
  const realSave = a.store.saveSent?.bind(a.store) as ((e: never) => void) | undefined;
  // The collect's record write is the fifth (two per earlier send: saved, then marked sent).
  if (realSave) (a.store as unknown as { saveSent: (e: never) => void }).saveSent = e => { realSave(e); if (++saves === 5 && point === 'record') take(); };
  let checkpoints = 0;
  const realCheckpoint = (next: KeeperState, now: bigint) => { a.store.save(next, now); return Promise.resolve(); };
  // Here the journal write that names the third send is the third (the line writes before and after each send).
  a.checkpoint = async (next, now) => { await realCheckpoint(next, now); if (++checkpoints === 3 && point === 'journal') take(); };
  let broadcasts = 0;
  t.m.hookSend = (_raw, phase) => {
    if (phase === 'before' && ++broadcasts === 3 && point === 'before-broadcast') take();
    if (phase === 'after' && broadcasts === 3 && point === 'after-broadcast') take();
  };
  try { await a.tick(100n); } finally { spy.signTransaction = original; a.close(); }
  expect(copy, `crash point ${point} reached`).toBeDefined();
  // What reached the node before the crash stays; nothing after it does.
  t.m.pool = node?.pool ?? new Map(); t.m.latest = node?.latest ?? 7;
  t.m.attempts = t.m.attempts.filter(r => [...t.m.pool.values()].includes(r));
  t.m.hookSend = undefined;
  const b = proc(t, copy as string);
  await b.tick(103n, false);
  t.mine();
  const after = await b.tick(106n, false);
  expectA2(t, after.state, copy as string);
  // Nothing durable was left behind for a transaction that never reached the node, and each mined transaction is charged
  // once, settled to what it paid (gas used 1 at an effective price of 1 wei on this node).
  expect(after.state.budget?.pending ?? []).toEqual([]);
  const charged = after.state.budget?.totalWei ?? 0n;
  expect(charged).toBe(BigInt(t.m.mined.size));
  // A start either never became durable or settled on its own receipt: its box is not blocked.
  expect(after.state.incomeSpend?.filter(s => s.start && s.start.settledAt === undefined && s.start.repaidAt === undefined) ?? []).toEqual([]);
  const later = await b.tick(140n);
  expect(later.report.skipped).not.toContainEqual(expect.objectContaining({ job: 'collect', why: 'start unpaid' }));
  expect(later.report.sent.map(x => x.job)).toContain('collect');
  expectOneCallPerNonce(t);
  b.close();
  return { t, charged, minedCount: t.m.mined.size };
}

describe('SH-249 A2: a crash at each write boundary', () => {
  it.each((['sign', 'record', 'journal', 'before-broadcast', 'after-broadcast'] as const).flatMap(p => [[p, false], [p, true]] as const))(
    'between steps at %s (a first collection: %s) ends in the A2 state', async (point, start) => {
    const { minedCount } = await crashAt(point, start);
    // Two payouts reached the node in every case; the collect only once it was broadcast (or rebroadcast from its bytes).
    expect(minedCount).toBe(point === 'sign' || point === 'record' ? 2 : 3);
  });
});

describe('SH-249 A3: the pending count is a check, not the source', () => {
  it('a lagging load-balanced pair and replies lost after acceptance, over more than fifty blocks, never sign a nonce twice', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    t.m.lag = true;
    // The first count read comes from the node that sees our pool, the next from the one that does not: right after the
    // first reply is lost (the line gave that nonce back and read it again from the lagging node).
    t.m.flip = true;
    t.m.lostAfter = 1;
    // SH-250: the chain mines each block here; a nonce left unmined for 25 blocks may be taken over by design (rule A).
    for (let block = 100n; block <= 190n; block += 3n) { await a.tick(block); t.mine(); }
    expectOneCallPerNonce(t);
    const nonces = [...t.m.pool.keys()].sort((x, y) => x - y);
    expect(nonces[0]).toBe(7);
    expect(nonces).toEqual(nonces.map((_, i) => 7 + i));
    a.close();
  });

  it('the same lagging pair with nothing mined for 90 blocks: a nonce serves a second call only as a takeover above it (SH-250 rule A)', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    t.m.lag = true;
    t.m.flip = true;
    t.m.lostAfter = 1;
    for (let block = 100n; block <= 190n; block += 3n) await a.tick(block);
    const byNonce = new Map<number, Hex[]>();
    for (const raw of t.m.attempts) {
      const n = parseTransaction(raw).nonce ?? -1;
      const list = byNonce.get(n) ?? [];
      if (!list.includes(raw)) list.push(raw);
      byNonce.set(n, list);
    }
    for (const [n, list] of byNonce) {
      const calls = [...new Set(list.map(r => { const x = parseTransaction(r); return `${x.to}:${x.data}`; }))];
      // At most one takeover per nonce per 25-block period: 90 blocks allow the first call and three takers.
      expect(calls.length, `nonce ${n}`).toBeLessThanOrEqual(4);
      // A second call at a nonce is a takeover: its fees at least an eighth above everything signed there before.
      for (let i = 1; i < list.length; i++) {
        const prior = list.slice(0, i).map(r => parseTransaction(r).maxFeePerGas ?? 0n).reduce((m, f) => f > m ? f : m, 0n);
        expect((parseTransaction(list[i] as Hex).maxFeePerGas ?? 0n) >= prior + (prior + 7n) / 8n, `nonce ${n} tx ${i}`).toBe(true);
      }
    }
    // From the record: the transactions of one nonce were signed at least one hanging period apart.
    const saved = JSON.parse(readFileSync(join(dir, 'keeper.json.sent'), 'utf8')) as { entries: { nonce: string; txs: { block: string }[] }[] };
    for (const e of saved.entries) {
      for (let i = 1; i < e.txs.length; i++) expect(BigInt(e.txs[i]?.block ?? 0) - BigInt(e.txs[i - 1]?.block ?? 0) >= 25n, `nonce ${e.nonce}`).toBe(true);
    }
    const nonces = [...byNonce.keys()].sort((x, y) => x - y);
    expect(nonces).toEqual(nonces.map((_, i) => 7 + i));
    a.close();
  });
});

describe('SH-249: a moving head and an endpoint that refuses old receipts', () => {
  it('keeps a saved transaction whose receipt cannot be read, charged and never released or broadcast again', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    const reserved = (await a.tick(100n)).state.budget?.pending?.map(r => r.costWei);
    t.mine();
    // Every read moves the head; receipts older than the window are refused while headers are served.
    t.m.receiptWindow = 0n;
    t.m.onCount = () => { t.f.node.block.number += 1n; };
    const sent = t.f.node.sent.length;
    let state: KeeperState = a.state;
    for (let block = 200n; block < 400n; block += 20n) state = (await a.tick(block, false)).state;
    expect(t.f.node.sent.length, 'no broadcast once the nonce is used').toBe(sent);
    // SH-250 re-check note 1: found in a final block, each is its nonce's winner and leaves the record; nothing released.
    expect(savedHashes(dir).size).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'keeper.json.sent'), 'utf8')).released).toBeUndefined();
    // The journal's charges for the day are whole and every spend entry kept.
    expect(state.budget?.pending?.map(r => r.costWei)).toEqual(reserved);
    expect(state.budget?.pending).toHaveLength(3);
    expect(state.incomeSpend?.filter(s => s.hash)).toHaveLength(1);
    a.close();
  });
});

describe('SH-249: read counts per round', () => {
  it('one latest and one pending count per signer, at most one receipt per unconfirmed saved transaction', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    t.f.node.asked = [];
    await a.tick(100n);
    const count = (tag: string) => (t.f.node.asked ?? []).filter(m => m === `eth_getTransactionCount:${tag}`).length;
    const receipts = () => (t.f.node.asked ?? []).filter(m => m === 'eth_getTransactionReceipt').length;
    // Three sends in the round: one count of each kind.
    expect([count('latest'), count('pending'), receipts()]).toEqual([1, 1, 0]);
    t.f.node.asked = [];
    await a.tick(103n, false);
    // Three unconfirmed saved transactions whose nonces are unused: counts only.
    expect([count('latest'), count('pending'), receipts()]).toEqual([1, 1, 0]);
    t.mine();
    t.f.node.asked = [];
    await a.tick(106n, false);
    // Their nonces are used: one receipt each, shared by settlement and the follow-up.
    expect([count('latest'), count('pending'), receipts()]).toEqual([1, 1, 3]);
    t.f.node.asked = [];
    await a.tick(109n, false);
    // Retired: no reads at all.
    expect([count('latest'), count('pending'), receipts()]).toEqual([0, 0, 0]);
    a.close();
  });
});

describe('SH-249 A1/A5/A6: the record beside the journal', () => {
  it('is written owner-only beside the journal before the first broadcast, with a marker, and never in dry mode', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    let seen: { record: boolean; hash: boolean } | undefined;
    t.m.hookSend = raw => {
      if (seen) return;
      const file = join(dir, 'keeper.json.sent');
      seen = { record: existsSync(file), hash: existsSync(file) && readFileSync(file, 'utf8').includes(hashOf(raw))
        && readFileSync(join(dir, 'keeper.json'), 'utf8').includes(hashOf(raw)) };
    };
    await a.tick(100n);
    expect(seen).toEqual({ record: true, hash: true });
    expect(statSync(join(dir, 'keeper.json.sent')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, 'keeper.json.sent-required'))).toBe(true);
    a.close();
    // Dry mode, wired as both entries wire it: the `.dry` journal, no signer, no record.
    const dry = model(), dryDir = tmp();
    const store = new StateStore(join(dryDir, 'keeper.json.dry'), IDENTITY);
    const chain = new ViemChain({ ...dry.f.cfg, dryRun: true }, dry.f.client, dummy.address, { public: null, private: null }, null, quiet);
    chain.readIncome = dry.income(chain, () => ({}));
    Object.assign(dry.f.amounts, { buyersP: 10n ** 16n, tip: 1n, fit: 7n, platform: 9n });
    const out = await runTick(chain, store.load(), { ...dry.f.cfg, dryRun: true, checkpoint: async (s, now) => store.save(s, now) }, quiet);
    store.close();
    expect(out.report.sent.length).toBe(3);
    expect(dry.m.attempts).toEqual([]);
    expect(readdirSync(dryDir).filter(n => n.includes('.sent'))).toEqual([]);
  });
});

describe('SH-249: a journal write that fails before a broadcast', () => {
  it('broadcasts nothing it saved, drops the entry and leaves no nonce gap', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    let writes = 0;
    a.checkpoint = async (next, now) => { if (++writes === 1) throw new Error('disk full'); a.store.save(next, now); };
    await expect(a.tick(100n)).rejects.toThrow('disk full');
    expect(t.m.attempts).toEqual([]);
    expect([...savedHashes(dir).values()].map(e => e.state)).toEqual(['signed']);
    await a.tick(103n);
    expect([...t.m.pool.keys()].sort((x, y) => x - y)).toEqual([7, 8, 9]);
    expect([...savedHashes(dir).values()].map(e => e.state)).toEqual(['sent', 'sent', 'sent']);
    expectA2(t, a.state, dir);
    a.close();
  });
});

describe('SH-249 A5 and Q4: old journals', () => {
  it('load without migration; their hashless entries stay exactly as they are and the box keeps waiting', async () => {
    const t = model(), dir = tmp();
    lineJournal(dir, t.f.rc);
    const a = proc(t, dir);
    t.setFunded(false);
    const out = await a.tick(100n);
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: 'collect', why: 'start unpaid' }));
    t.mine();
    const later = await a.tick(103n);
    expect(later.state.incomeSpend?.filter(s => s.hash === undefined)).toEqual([
      { box: t.f.rc, at: time - 100n, costWei: 5n }, { box: t.f.rc, at: time - 50n, costWei: 7n, start: { job: 'collect' } }]);
    expect(later.state.budget?.pending?.filter(r => r.hash === undefined)).toEqual([{ costWei: 9n, ours: 'ours' }]);
    expect(later.state.drandBounties).toEqual({ [`0x${'ab'.repeat(20)}:5`]: {} });
    a.close();
  });
});

describe('SH-249: the record file', () => {
  it('refuses a missing record after its marker, another identity and bytes that do not hash to the saved hash', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    await a.tick(100n);
    a.close();
    const file = join(dir, 'keeper.json.sent');
    const text = readFileSync(file, 'utf8');
    const open = () => { const s = new StateStore(join(dir, 'keeper.json'), IDENTITY); try { s.loadSent(s.load()); } finally { s.close(); } };
    expect(open).not.toThrow();
    renameSync(file, `${file}.moved`);
    expect(open).toThrow(SENT_MISSING);
    writeFileSync(file, text.replace(`"identity":"${IDENTITY}"`, '"identity":"other"'));
    expect(open).toThrow(SENT_INVALID);
    const parsed = JSON.parse(text) as { entries: { txs: { raw: string }[] }[] };
    const raw = parsed.entries[0]?.txs[0]?.raw ?? '';
    writeFileSync(file, text.replace(raw, `${raw.slice(0, -2)}00`));
    expect(open).toThrow(SENT_INVALID);
    expect(decodeSent(text, IDENTITY).entries).toHaveLength(3);
  });
});

describe('SH-249 report mode', () => {
  it('reads a journal copy and its record: counts, saved transactions with what the keeper would do, hashless reservations; writes nothing', async () => {
    const t = model(), dir = tmp();
    lineJournal(dir, t.f.rc);
    const a = proc(t, dir);
    await a.tick(100n);
    a.close();
    // The old start keeps its box waiting: only the two payouts were sent. The second never reached a block.
    t.m.pool.delete(8);
    t.mine();
    t.f.node.block.number = 112n;
    t.f.node.balances = { [t.f.me]: 123_456n };
    t.f.node.transaction = h => t.m.mined.has(h.toLowerCase()) ? { blockNumber: '0x64' } : null;
    const copy = crashCopy(dir);
    const before = readdirSync(copy).sort().map(n => [n, readFileSync(join(copy, n), 'utf8')]);
    t.f.node.asked = [];
    const lines = (await sentReport(join(copy, 'keeper.json'), viemReads(t.f.client))).join('\n');
    expect(readdirSync(copy).sort().map(n => [n, readFileSync(join(copy, n), 'utf8')])).toEqual(before);
    expect(t.f.node.asked).not.toContain('eth_sendRawTransaction');
    expect(lines).toContain(`signer ${t.f.me}: latest 8, pending 8, balance 123456 wei, saved 2, open 1, next from record 9`);
    expect(lines).toMatch(/nonce 7 0x[0-9a-f]{64} job receiverPayFit[^\n]*, signed 12 blocks ago, this endpoint: in a block\n {4}final/);
    expect(lines).toMatch(/nonce 8 0x[0-9a-f]{64} job receiverPayPlatform[^\n]*, signed 12 blocks ago, this endpoint: does not know it\n {4}pending: the keeper broadcasts the saved bytes again/);
    // Once nothing waits at an unused nonce, the report says a rollback or a hand send may proceed.
    t.m.pool.set(8, [...t.m.attempts].find(r => r !== undefined && !t.m.mined.has(hashOf(r))) as Hex);
    t.mine();
    const drained = (await sentReport(join(copy, 'keeper.json'), viemReads(t.f.client))).join('\n');
    expect(drained).toContain('open 0');
    expect(drained).toContain('no open entry: nothing saved waits at an unused nonce');
    expect(lines).toContain('reservations without a hash: 4');
    expect(lines).toContain(`income spend: box ${t.f.rc}, job collect (first collection, unpaid: its box waits)`);
    expect(lines).toContain('daily reservation day');
    expect(lines).toContain('drand bounty');
    expect(USAGE).toBe('usage: SH_KEEPER_RPC_URL=<public endpoint> pnpm --filter @squarehole/keeper sent <copy of keeper.json>');
  });
});

describe('SH-249 review note 2: the nonce mark outlives retired entries', () => {
  it('an endpoint whose counts lag behind finality after every entry retired gets the next nonce, never a used one', async () => {
    const t = model(), dir = tmp();
    const a = proc(t, dir);
    await a.tick(100n);
    t.mine();
    await a.tick(103n, false);
    await a.tick(106n, false);
    expect(savedHashes(dir).size).toBe(0);
    expect(t.m.latest).toBe(10);
    // The reviewer's sequence: one round whose counts come from an endpoint at count 7.
    t.m.staleCount = 7;
    await a.tick(200n);
    t.m.staleCount = undefined;
    expect([...savedHashes(dir).values()].map(e => e.nonce)).toEqual([10n, 11n, 12n]);
    expectOneCallPerNonce(t);
    // The mark is in the file: a restart keeps it.
    a.close();
    const record = JSON.parse(readFileSync(join(dir, 'keeper.json.sent'), 'utf8')) as { next: Record<string, string> };
    expect(record.next[t.f.me]).toBe('13');
  });
});

describe('SH-249 review note 5: rebroadcasts are logged; "already known" counts as a broadcast', () => {
  it('logs nonce and hash, and waits for the next mark after an already-known reply', async () => {
    const t = model(), dir = tmp();
    let a = proc(t, dir);
    t.m.lostBefore = 3;
    await a.tick(100n);
    a.close();
    const warn = vi.fn();
    a = proc(t, dir, { info: () => {}, warn, error: () => {} });
    // The node already holds nonce 7's bytes: it answers "already known".
    const held = savedHashes(dir);
    const first = [...held.entries()].find(([, e]) => e.nonce === 7n)?.[0];
    const onSend = t.f.node.onSend;
    let broadcasts = 0;
    t.f.node.onSend = (raw, endpoint) => { broadcasts++; if (hashOf(raw) === first) throw new Error('already known'); onSend(raw, endpoint); };
    await a.tick(103n, false);
    const logged = warn.mock.calls.filter(([m]) => m === 'saved transaction broadcast again').map(([, d]) => (d as { nonce: bigint }).nonce);
    expect(logged.sort()).toEqual([7n, 8n, 9n]);
    expect(warn.mock.calls.find(([m]) => m === 'saved transaction broadcast again')?.[1]).toMatchObject({ hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    // Nothing goes out again before the next mark, also for the already-known one.
    expect(broadcasts).toBe(3);
    for (const block of [106n, 112n, 127n]) await a.tick(block, false);
    expect(broadcasts).toBe(3);
    await a.tick(128n, false);
    expect(broadcasts).toBe(6);
    a.close();
  });
});

describe('SH-249 re-check R3: private sends in the report', () => {
  it('marks a private entry as not visible on a public endpoint and never asks the endpoint about it', async () => {
    const dir = tmp();
    const store = new StateStore(join(dir, 'keeper.json'), IDENTITY);
    store.save({}, time);
    const raw = '0x02c0ffee' as Hex;
    const signer = `0x${'cd'.repeat(20)}`;
    store.saveSent({ entries: [{ signer, nonce: 4n, privately: true, job: 'executeModule', key: 'executeModule:x', to: `0x${'ef'.repeat(20)}`,
      state: 'sent', txs: [{ hash: hashOf(raw), raw, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, block: 90n }] }], next: {} });
    store.close();
    const known = vi.fn(async () => 'unknown' as const);
    const lines = (await sentReport(join(dir, 'keeper.json'), { chainId: async () => 11_155_111, head: async () => ({ number: 100n, timestamp: time }),
      finalized: async () => null, blockHash: async () => null, count: async () => 3n, receipt: async () => null, balance: async () => 0n, known })).join('\n');
    expect(known).not.toHaveBeenCalled();
    expect(lines).toContain(`signer ${signer} (private sends: their pending transactions never show in this public count)`);
    expect(lines).toMatch(/nonce 4 0x[0-9a-f]{64} job executeModule \(private\)[^\n]*this endpoint: a private send, not visible on a public endpoint/);
  });
});
