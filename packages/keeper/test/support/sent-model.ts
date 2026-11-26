/**
 * SH-249: the scripted node (pool, mining, receipts, finality, lost replies, a lagging pair) and one keeper process on
 * real books, shared by the saved-transaction tests.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, numberToHex, parseTransaction, type Hex } from 'viem';
import { expect } from 'vitest';
import { ViemChain } from '../../src/chain';
import type { Logger } from '../../src/log';
import type { IncomeSnapshot } from '../../src/income';
import { runTick, type KeeperState, type RunConfig } from '../../src/run';
import { StateStore } from '../../src/state';
import { IDENTITY, openProcess } from './sent-harness';
import { dummy, quietFixture } from './sent-quiet';
import { quiet, time } from './v2';

export const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'sent-'));
export const hashOf = (raw: Hex) => keccak256(raw).toLowerCase();

/** A node with a pool and mining; replies can be lost before or after it takes a transaction. */
export function model() {
  const f = quietFixture();
  const me = f.me;
  const m = {
    latest: 7, pool: new Map<number, Hex>(), mined: new Map<string, bigint>(), attempts: [] as Hex[],
    lostBefore: 0, lostAfter: 0, lose: undefined as undefined | ((raw: Hex) => 'before' | 'after' | undefined),
    lag: false, flip: false, staleCount: undefined as number | undefined, onCount: undefined as undefined | (() => void), receiptWindow: undefined as bigint | undefined,
    hookSend: undefined as undefined | ((raw: Hex, phase: 'before' | 'after') => void),
    /** SH-250: mine only transactions whose maximum fee covers the base fee; the block each nonce was used in. */
    respectBase: false, usedAt: new Map<number, bigint>(), raws: new Map<string, Hex>(),
  };
  const pending = () => { let n = m.latest; while (m.pool.has(n)) n++; return n; };
  f.node.countOf = (who, tag) => {
    m.onCount?.();
    if (who !== me) return 0;
    // An endpoint (a backend or the fallback) that answers both counts from an old block.
    if (m.staleCount !== undefined) return m.staleCount;
    if (tag === 'latest') return m.latest;
    // SH-250 B6: the count at a numbered block, from the blocks the nonces were used in.
    if (tag.startsWith('0x')) return 7 + [...m.usedAt.values()].filter(b => b <= BigInt(tag)).length;
    // A load-balanced pair: every other answer comes from a node that never saw our pool.
    if (m.lag) { m.flip = !m.flip; if (m.flip) return m.latest; }
    return pending();
  };
  f.node.onSend = (raw) => {
    m.attempts.push(raw);
    const lost = m.lose?.(raw) ?? (m.lostBefore > 0 ? (m.lostBefore--, 'before') : undefined);
    if (lost === 'before') throw new Error('connection reset');
    m.hookSend?.(raw, 'before');
    const n = parseTransaction(raw).nonce ?? -1;
    if (n < m.latest) throw new Error('nonce too low');
    const prev = m.pool.get(n);
    // A node takes a replacement only when both fee fields rise by a tenth or more (geth's default rule).
    if (prev && prev !== raw) {
      const a = parseTransaction(prev), b = parseTransaction(raw);
      if ((b.maxFeePerGas ?? 0n) * 10n < (a.maxFeePerGas ?? 0n) * 11n || (b.maxPriorityFeePerGas ?? 0n) * 10n < (a.maxPriorityFeePerGas ?? 0n) * 11n) {
        throw new Error('replacement transaction underpriced');
      }
    }
    m.pool.set(n, raw);
    m.hookSend?.(raw, 'after');
    if (lost === 'after' || (m.lostAfter > 0 && (m.lostAfter--, true))) throw new Error('timeout');
  };
  const blockHash = (n: bigint) => `0x${n.toString(16).padStart(64, 'b')}` as Hex;
  f.node.receipt = (hash) => {
    m.onCount?.();
    const at = m.mined.get(hash.toLowerCase());
    if (at === undefined) return null;
    if (m.receiptWindow !== undefined && f.node.block.number - at > m.receiptWindow) throw new Error('receipt outside the window');
    const raw = m.raws.get(hash.toLowerCase());
    return { transactionHash: hash, from: me, to: raw ? parseTransaction(raw).to : null, blockNumber: numberToHex(at), blockHash: blockHash(at),
      gasUsed: '0x1', effectiveGasPrice: '0x1', cumulativeGasUsed: '0x1', status: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`,
      contractAddress: null, transactionIndex: '0x0', type: '0x2' };
  };
  /** Mines the pool in order at the current block and finalizes it. */
  const mine = () => {
    while (m.pool.has(m.latest)) {
      const raw = m.pool.get(m.latest) as Hex;
      if (m.respectBase && (parseTransaction(raw).maxFeePerGas ?? 0n) < f.node.block.baseFeePerGas) break;
      m.mined.set(hashOf(raw), f.node.block.number); m.raws.set(hashOf(raw), raw); m.usedAt.set(m.latest, f.node.block.number); m.latest++;
    }
    f.node.finalized = { number: f.node.block.number, hash: blockHash(f.node.block.number) };
    f.node.blockHashes = Object.fromEntries([...new Set(m.mined.values())].map(b => [b.toString(), blockHash(b)]));
  };
  f.node.blockTxs = (n: bigint) => [...m.raws.entries()].filter(([h]) => m.mined.get(h) === n)
    .map(([h, raw]) => ({ hash: h, from: me, nonce: numberToHex(parseTransaction(raw).nonce ?? 0) }));
  /** Starts this test has seen, so the income double can prove their own final receipts (F182 settlement). */
  let funded = true, proofs = true;
  // The snapshot of the world just read (no second read, as in production: a second read would be another round).
  const income = (_chain: ViemChain, state: () => KeeperState) => async (): Promise<IncomeSnapshot> => {
    const w = { block: { timestamp: f.node.block.timestamp } };
    const starts = (state().incomeSpend ?? []).filter(s => s.start && s.hash && m.mined.has(s.hash.toLowerCase()));
    return { at: w.block.timestamp, platformWei: funded ? 10n ** 30n : 0n, boxes: { [f.rc]: { shareWei: funded ? 10n ** 30n : 0n, tipsWei: 0n } },
      mined: Object.fromEntries([...m.mined].map(([h]) => [h, w.block.timestamp])),
      startReceipts: !proofs ? [] : starts.map(s => ({ box: s.box, hash: s.hash as string, at: w.block.timestamp, shareWei: 0n, tipsWei: 0n, startTipWei: 10n ** 17n })) };
  };
  /** SH-250 B6: a transaction of this wallet that is not in the record takes `nonce` (a send by hand, an older keeper). */
  const foreign = async (nonce: number) => {
    const raw = await dummy.signTransaction({ type: 'eip1559', chainId: 11_155_111, to: dummy.address, value: 0n, gas: 21_000n, nonce,
      maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 10_000_000_000n });
    m.pool.set(nonce, raw);
    return raw;
  };
  return { f, m, mine, income, foreign, setFunded: (x: boolean) => { funded = x; f.setFunded(x); },
    /** Off: no start can prove its own tip, so a landed start stays unpaid. */
    setStartProofs: (x: boolean) => { proofs = x; } };
}

export type Model = ReturnType<typeof model>;

/** One keeper process on `dir` against the model's node: a fresh adapter (fresh memory) and the books from disk. */
export function proc(t: Model, dir: string, log: Logger = quiet) {
  const chain = new ViemChain(t.f.cfg, t.f.client, dummy.address, { public: dummy, private: null }, null, log);
  const p = openProcess(dir, chain);
  let state = p.state;
  let checkpoint: RunConfig['checkpoint'] = p.checkpoint;
  chain.readIncome = t.income(chain, () => state);
  const tick = async (block: bigint, amounts: boolean | Partial<Model['f']['amounts']> = true) => {
    t.f.node.block.number = block;
    t.f.node.block.timestamp = time + (block - 100n) * 12n;
    Object.assign(t.f.amounts, amounts === true ? { buyersP: 10n ** 16n, tip: 10n ** 17n, fit: 7n + block, platform: 9n + block }
      : { buyersP: 0n, tip: 0n, fit: 0n, platform: 0n, ...(amounts === false ? {} : amounts) });
    // As both entries do: the state in hand is the last one written durably, also when a later write of the tick fails.
    const out = await runTick(chain, state, { ...t.f.cfg, checkpoint: async (next, now) => { await checkpoint?.(next, now); state = next; } }, quiet);
    state = out.state;
    return out;
  };
  return { chain, store: p.store, tick, get state() { return state; }, set checkpoint(c: RunConfig['checkpoint']) { checkpoint = c; },
    close: () => p.store.close() };
}

/** Every saved transaction on disk, by hash. */
export function savedHashes(dir: string): Map<string, { state: string; nonce: bigint }> {
  const file = join(dir, 'keeper.json.sent');
  if (!existsSync(file)) return new Map();
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { entries: { state: string; nonce: string; txs: { hash: string }[] }[] };
  return new Map(parsed.entries.flatMap(e => e.txs.map(t => [t.hash, { state: e.state, nonce: BigInt(e.nonce) }] as const)));
}

/**
 * A2 and A3 on a journal and its record: no reservation without a hash; every reserved hash is saved or final; at most one
 * charge per hash; and every nonce that reached the node carries one call only.
 */
export function expectA2(t: Model, state: KeeperState, dir: string) {
  const pending = state.budget?.pending ?? [];
  const spend = state.incomeSpend ?? [];
  expect(pending.filter(r => r.hash === undefined), 'daily reservations without a hash').toEqual([]);
  expect(spend.filter(s => s.hash === undefined), 'income spend without a hash').toEqual([]);
  expect(Object.values(state.drandBounties ?? {}).filter(b => b.hash === undefined)).toEqual([]);
  const hashes = pending.map(r => r.hash as string);
  expect(new Set(hashes).size, 'one charge per transaction').toBe(hashes.length);
  const saved = savedHashes(dir);
  for (const h of hashes) expect(saved.has(h) || t.m.mined.has(h), `reserved ${h} is saved or mined`).toBe(true);
  expectOneCallPerNonce(t);
}

export function expectOneCallPerNonce(t: Model) {
  // Review note 4: one signed transaction per nonce, compared byte for byte (another fee is another transaction).
  const signed = new Map<number, Set<string>>();
  for (const raw of t.m.attempts) {
    const n = parseTransaction(raw).nonce ?? -1;
    signed.set(n, (signed.get(n) ?? new Set()).add(raw.toLowerCase()));
  }
  for (const [n, set] of signed) expect(set.size, `nonce ${n} signed for ${set.size} transactions`).toBe(1);
}

/** A journal as the line writes it: hashless spend (one a first collection), a hashless daily reservation and bounty. */
export function lineJournal(dir: string, rc: string) {
  const store = new StateStore(join(dir, 'keeper.json'), IDENTITY);
  const box = rc as `0x${string}`;
  store.save({
    incomeSpend: [{ box, at: time - 100n, costWei: 5n }, { box, at: time - 50n, costWei: 7n, start: { job: 'collect' } }],
    budget: { day: time / 86_400n, oursWei: 9n, pokesWei: 0n, totalWei: 9n, drandRescueWei: 0n, block: 90n, txInBlock: 0,
      pending: [{ costWei: 9n, ours: 'ours' }] },
    drandBounties: { [`0x${'ab'.repeat(20)}:5`]: {} },
  }, time);
  store.close();
}

