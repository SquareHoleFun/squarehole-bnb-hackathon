import { vi } from 'vitest';
import { type Address, type Hex, type PublicClient } from 'viem';
import { IncomeCache, readIncome, type ReceiptLog, type ZeroedTokenIncome } from '../../src/income-read';
import type { IncomeSpend } from '../../src/income';
import { runTick } from '../../src/run';
import type { Candidate, Sim } from '../../src/types';
import type { BoxState, World } from '../../src/world';
import { receiptLogs } from './income-receipts';
import { addr, box, keeper, options, quiet, time, v2 } from './v2';

/**
 * SH-247: a small chain of registered v2 boxes for the income-isolation tests. Two ETH boxes and two boxes priced in
 * the Sepolia tETH test coin (its parity pin is supplied by the test), one box past its deadline (`fail`) and one whose
 * curve filled (`graduate`). getLogs answers every log, filtered like a node (address, event, indexed topics, blocks),
 * so the reader of the line before SH-247 finds its proofs there; getTransactionReceipt answers each transaction's own
 * logs, where the reader after SH-247 finds them. Extra rows that no box's paid income needs can be added as noise.
 */
export const zero = addr(0), safe = addr(51), pm = addr(52);
export const TETH: Address = '0x7156c3e4DD23F5776c26b3F6140BC03fFb7c4D5E';
export const TETH_CODE: Hex = '0x6080604052348015600f57600080fd5b5060aa';
export const hash = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as const;
/** More rows than the tick's 20,000, all in one 2,000-block page (blocks 10 to 59, 500 a block). */
export const FLOOD = 25_000;
export type Log = ReceiptLog & { eventName: string };
type Topics = Readonly<Record<string, unknown>>;
type LogQuery = { address: Address | readonly Address[]; event?: { name: string }; events?: readonly { name: string }[];
  args?: Topics; fromBlock: bigint; toBlock: bigint };
const filtered = (l: Log, args?: Topics) => !args || Object.entries(args).every(([name, want]) => want === undefined
  || want === null || (Array.isArray(want) ? want : [want]).some(w => typeof w === 'string' && typeof l.args[name] === 'string'
    ? w.toLowerCase() === (l.args[name] as string).toLowerCase() : w === l.args[name]));
const lower = (a: string) => a.toLowerCase();

type Dense = { address: Address; from: bigint; blocks: number; perBlock: number };
export type FloodKind = 'safe deposits' | 'empty collections' | 'zero transfers' | 'zero claim burns';

export function incomeChain({ final = 100n, spacing = 12n } = {}) {
  /**
   * `cap`: a node that refuses a log answer of more rows, as a too-large answer is refused (viem's body limit).
   * `clock` and `latency` (ms): a virtual clock each log query and header read moves on. `dense`: empty collections on
   * one receiver, `perBlock` in each of `blocks` blocks from `from`, answered without building rows a query leaves out;
   * `moreDense`: the same on further receivers.
   * `refuse`: a node error for a log query (null: answer it).
   */
  const state = { final, oldest: null as bigint | null, cap: null as number | null, clock: 0, latency: { logs: 0, block: 0 },
    dense: null as Dense | null, moreDense: [] as Dense[],
    refuse: null as ((q: { address: readonly string[]; fromBlock: bigint; toBlock: bigint }) => Error | null) | null };
  const stamp = (n: bigint) => time + (n - final) * spacing;
  const at = final - 1n;
  const part = (id: number, n: number) => addr(0x1000 + id * 16 + n);
  const make = (id: number, q: Address, over: Partial<BoxState> = {}) => box({ id: BigInt(id), coordinator: part(id, 1),
    hook: part(id, 2), receiver: part(id, 3), qPerEthX18: q === zero ? 10n ** 18n : null,
    v2: { ...v2, q, royalty: { ...v2.royalty, address: part(id, 4) } }, ...over });
  const a = make(1, zero), b = make(2, zero), c = make(3, TETH), d = make(4, TETH);
  const failing = make(5, zero, { graduated: false, curveClosed: false, deadline: time - 1n });
  const graduating = make(6, zero, { graduated: false });
  const boxes = [a, b, c, d, failing, graduating];
  /** `count` more registered ETH boxes without income, ids from 1,000 (anyone can create a box). */
  const register = (count: number) => {
    const added = Array.from({ length: count }, (_, i) => make(1_000 + i, zero));
    boxes.push(...added);
    return added;
  };
  const logs: Log[] = [];
  const noise: { address: string; count: number; row: (i: number) => Log }[] = [];
  const base = (tx: bigint, block: bigint) => ({ blockNumber: block, blockHash: hash(block), transactionHash: hash(tx), removed: false });
  /** A native platform payment: the Safe's SafeReceived from the PoolManager, then the receiver's PlatformPaid. */
  function nativePaid(x: BoxState, value: bigint, tx: bigint, block = at) {
    logs.push({ ...base(tx, block), address: safe, eventName: 'SafeReceived', logIndex: 0, args: { sender: pm, value } },
      { ...base(tx, block), address: x.receiver, eventName: 'PlatformPaid', logIndex: 1, args: { safe, amount: value } });
  }
  /** A native collection tip to this keeper: the event names the keeper and the paid tip. */
  function nativeTip(x: BoxState, value: bigint, tx: bigint, block = at) {
    logs.push({ ...base(tx, block), address: x.receiver, eventName: 'Collected', logIndex: 0, args: { caller: keeper, tipTo: keeper, tip: value } });
  }
  /** A tETH payout: the part's claim burn, P's transfer to the recipient, then the box event. */
  function tokenPaid(x: BoxState, name: 'PlatformPaid' | 'Collected', value: bigint, tx: bigint, recipient: Address = safe, block = at) {
    logs.push({ ...base(tx, block), address: pm, eventName: 'Transfer', logIndex: 0,
      args: { caller: x.receiver, from: x.receiver, to: zero, id: BigInt(TETH), amount: value } },
    { ...base(tx, block), address: TETH, eventName: 'Transfer', logIndex: 1, args: { from: pm, to: recipient, value } },
    { ...base(tx, block), address: x.receiver, eventName: name, logIndex: 2,
      args: name === 'PlatformPaid' ? { safe, amount: value } : { caller: recipient, tipTo: recipient, tip: value } });
  }
  nativePaid(a, 10n ** 15n, 101n);
  nativeTip(a, 7n * 10n ** 12n, 102n);
  nativePaid(b, 2n * 10n ** 15n, 201n);
  tokenPaid(c, 'PlatformPaid', 10n ** 18n, 301n);
  tokenPaid(c, 'Collected', 10n ** 17n, 302n, keeper);
  tokenPaid(d, 'PlatformPaid', 5n * 10n ** 17n, 401n);

  /** Rows that carry no box's paid income, in one page of the window (blocks 10 to 59), each in its own transaction. */
  function flood(kind: FloodKind, count = FLOOD) {
    const row = (address: string, eventName: string, args: (i: number) => Record<string, unknown>) => (i: number): Log => ({
      address: address as Address, eventName, args: args(i), blockNumber: 10n + BigInt(i % 50), blockHash: hash(10n + BigInt(i % 50)),
      removed: false, transactionHash: hash(5_000_000n + BigInt(i)), logIndex: i % 7 });
    const anyone = (i: number) => addr(7000 + (i % 8));
    if (kind === 'safe deposits') {
      noise.push({ address: safe, count, row: row(safe, 'SafeReceived', i => ({ sender: i % 3 === 0 ? pm : anyone(i), value: BigInt(i % 2) })) });
    } else if (kind === 'empty collections') {
      for (const x of [a, c]) noise.push({ address: x.receiver, count: Math.ceil(count / 2),
        row: row(x.receiver, 'Collected', i => ({ caller: anyone(i), tipTo: i % 2 ? keeper : anyone(i), tip: 0n })) });
    } else if (kind === 'zero transfers') {
      noise.push({ address: TETH, count, row: row(TETH, 'Transfer', i => ({ from: pm, to: i % 2 ? safe : keeper, value: 0n })) });
    } else {
      noise.push({ address: pm, count, row: row(pm, 'Transfer', i => ({ caller: anyone(i), from: [c.receiver, c.coordinator, c.hook, d.receiver][i % 4],
        to: zero, id: BigInt(TETH), amount: 0n })) });
    }
  }
  const old = (n: bigint | undefined) => state.oldest !== null && n !== undefined && n < state.oldest;
  const pub = {
    getChainId: vi.fn(async () => 11155111),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber?: bigint; blockTag?: string }) => {
      state.clock += state.latency.block;
      const n = blockNumber ?? state.final;
      return { number: n, hash: hash(n), timestamp: stamp(n) };
    }),
    readContract: vi.fn(async (c: { address: Address; functionName: string; blockNumber?: bigint }): Promise<unknown> => {
      if (old(c.blockNumber)) throw new Error('state pruned');
      const x = boxes.find(b => lower(b.receiver) === lower(c.address));
      if (x) {
        if (c.functionName === 'q') return x.v2?.q;
        if (c.functionName === 'PLATFORM_SAFE') return safe;
        if (c.functionName === 'poolManager') return pm;
      }
      if (lower(c.address) === lower(TETH) && c.functionName === 'decimals') return 18;
      throw new Error(`unsupported fake read ${c.functionName}`);
    }),
    getBytecode: vi.fn(async ({ address, blockNumber }: { address: Address; blockNumber?: bigint }) => {
      if (old(blockNumber)) throw new Error('state pruned');
      return lower(address) === lower(TETH) ? TETH_CODE : undefined;
    }),
    getLogs: vi.fn(async ({ address, event, events, args, fromBlock, toBlock }: LogQuery) => {
      state.clock += state.latency.logs;
      if (old(fromBlock)) throw new Error('logs pruned');
      const targets = (Array.isArray(address) ? address : [address]).map(lower);
      const refused = state.refuse?.({ address: targets, fromBlock, toBlock });
      if (refused) throw refused;
      const names = (events ?? (event ? [event] : [])).map(e => e.name);
      const keep = (l: Log) => targets.includes(lower(l.address)) && names.includes(l.eventName)
        && l.blockNumber >= fromBlock && l.blockNumber <= toBlock && filtered(l, events ? undefined : args);
      const found = logs.filter(keep);
      for (const n of noise) if (targets.includes(lower(n.address))) for (let i = 0; i < n.count; i++) {
        const l = n.row(i);
        if (keep(l)) found.push(l);
      }
      const asked = [state.dense, ...state.moreDense].flatMap(dense => {
        if (!dense || !targets.includes(lower(dense.address)) || !names.includes('Collected')) return [];
        const lo = fromBlock > dense.from ? fromBlock : dense.from, end = dense.from + BigInt(dense.blocks) - 1n;
        const hi = toBlock < end ? toBlock : end;
        return hi >= lo ? [{ dense, lo, hi }] : [];
      });
      if (state.cap !== null && found.length + asked.reduce((n, x) => n + Number(x.hi - x.lo + 1n) * x.dense.perBlock, 0) > state.cap) {
        throw Object.assign(new Error('answer too large'), { name: 'ResponseBodyTooLargeError' });
      }
      for (const { dense, lo, hi } of asked) for (let n = lo; n <= hi; n++) for (let i = 0; i < dense.perBlock; i++) found.push({
        address: dense.address, eventName: 'Collected', blockNumber: n, blockHash: hash(n), removed: false,
        transactionHash: hash(9_000_000_000n + BigInt(dense.address) % 1_000n * 10_000_000_000n + n * 10_000n + BigInt(i)), logIndex: 0,
        args: { caller: addr(7001), tipTo: addr(7001), tip: 0n } });
      if (state.cap !== null && found.length > state.cap) throw Object.assign(new Error('answer too large'), { name: 'ResponseBodyTooLargeError' });
      return found;
    }),
    getTransaction: vi.fn<(args: { hash: Hex }) => Promise<{ to: Address; input: Hex }>>(async () => ({ to: addr(77), input: '0x' })),
    getTransactionReceipt: vi.fn(async ({ hash: tx }: { hash: Hex }) => {
      const rows = logs.filter(l => l.transactionHash === tx);
      const first = rows[0];
      if (!first || old(first.blockNumber)) throw new Error('receipt unavailable');
      return { transactionHash: tx, status: 'success', blockNumber: first.blockNumber, blockHash: first.blockHash,
        from: keeper, to: first.address, logs: receiptLogs(rows) };
    }),
  };
  const client = pub as unknown as PublicClient;
  const now = () => stamp(state.final);
  /** A cache on this chain's virtual clock: the reader's time budget and its pause between log queries move it. */
  const cache = () => new IncomeCache({ clock: () => state.clock, sleep: async ms => { state.clock += ms; } });
  const read = (cache?: IncomeCache, zeroed?: ZeroedTokenIncome[], spend: readonly IncomeSpend[] = [], list = boxes) =>
    readIncome(client, list, keeper, now(), 0n, spend, cache, z => zeroed?.push(z));
  /** One dry tick of the real runner on this chain: which jobs it sends and why it defers the rest. */
  async function tick(cache?: IncomeCache) {
    const w: World = { block: { number: state.final + 3n, timestamp: now(), baseFeePerGas: 1n }, fitGraduated: false, boxes };
    const sims: Candidate[] = [];
    const port = { read: async () => w, readIncome: (spend: readonly IncomeSpend[]) => read(cache, undefined, spend),
      simulate: async (c: Candidate): Promise<Sim> => { sims.push(c); return { ok: true, estimate: 100_000n, tipWei: null }; },
      send: async () => { throw new Error('dry run never sends'); } };
    const cfg = { ...options(), dryRun: true, priorityFeeWei: 1n, limits: { ...options().limits, maxTxPerBlock: 1000 } };
    const out = await runTick(port, {}, cfg, quiet);
    return { sent: out.report.sent.map(s => s.key).sort(), skipped: out.report.skipped.map(s => `${s.key}:${s.code}`).sort(),
      income: out.observed.income };
  }
  return { state, stamp, boxes, a, b, c, d, failing, graduating, logs, noise, flood, nativePaid, nativeTip, tokenPaid, register, make, pub, client, now, cache, read, tick };
}
