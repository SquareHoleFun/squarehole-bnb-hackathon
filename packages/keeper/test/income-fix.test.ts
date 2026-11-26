import { appendFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, getAbiItem, keccak256, pad, toEventSelector, type Hex } from 'viem';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { receiverV2Abi } from '../src/abi';
import { INCOME_LOG_GAP_MS, INCOME_UNEXPLAINED_REFUSALS, noAnswer } from '../src/income-cache';
import { IncomeCache, type ZeroedTokenIncome } from '../src/income-read';
import { TETH, TETH_CODE, hash, incomeChain, pm, safe } from './support/income-chain';
import { keeper } from './support/v2';

/**
 * SH-247 fix round (review of 22 November 2026, findings F1 to F8). These tests use the reader's public entry points
 * and the IncomeCache options, so they also run against the reader before the fix round (the control).
 */
const parity = vi.hoisted(() => ({ entries: undefined as Record<string, unknown> | undefined }));
vi.mock('../src/income-parity-manifest', async importOriginal => {
  const real = await importOriginal<typeof import('../src/income-parity-manifest')>();
  return { ...real, get ethParityManifest() { return parity.entries ?? real.ethParityManifest; } };
});
beforeEach(() => {
  parity.entries = { [`11155111:${TETH.toLowerCase()}`]: { chainId: '11155111', token: TETH, decimals: '18',
    codeHash: keccak256(TETH_CODE), weiPerCoin: '1000000000000000000' } };
});
afterEach(() => { parity.entries = undefined; });

const credits = (income: { boxes: Readonly<Record<string, unknown>> }, receivers: readonly string[]) =>
  Object.fromEntries(receivers.map(r => [r, income.boxes[r]]));

describe('F1: the income reading has a time budget; a cycle never passes its limit', () => {
  it('a flood needing hundreds of split queries: every cycle stays inside 240 s, plans reserved jobs, and resumes', async () => {
    const quiet = incomeChain({ final: 2_000n });
    const expected = await quiet.read();
    const f = incomeChain({ final: 2_000n });
    // 60,000 empty collections on box a's receiver, 100 in each of 600 blocks; the node answers at most 150 rows, and
    // every log query costs one second, every header 50 ms (virtual clock).
    f.state.dense = { address: f.a.receiver, from: 100n, blocks: 600, perBlock: 100 };
    f.state.cap = 150;
    f.state.latency = { logs: 1_000, block: 50 };
    const cache = f.cache();
    // The receivers' grouped page and box a's own pieces (rule 3 reads a refused address alone).
    const receivers = `${f.boxes.map(b => b.receiver.toLowerCase()).sort().join(',')}:`, own = `${f.a.receiver.toLowerCase()}:`;
    const covered = () => cache.pages.filter(p => p.key.startsWith(receivers) || p.key.startsWith(own))
      .reduce((n, p) => n + Number(p.to - p.from + 1n), 0);
    const spent: number[] = [], coverage: number[] = [], others: boolean[] = [];
    let through = false;
    for (let tick = 0; tick < 40 && !through; tick++) {
      const start = f.state.clock;
      const out = await f.tick(cache);
      spent.push(f.state.clock - start);
      coverage.push(covered());
      // Reserved jobs are planned and sent on every tick, with or without income.
      expect(out.sent.some(k => k.startsWith('fail:'))).toBe(true);
      expect(out.sent.some(k => k.startsWith('graduate:'))).toBe(true);
      expect(out.income).not.toBeNull();
      others.push([f.b, f.c, f.d].every(x => same(out.income?.boxes[x.receiver], expected.boxes[x.receiver])));
      through = [f.a, f.b, f.c, f.d].every(x => JSON.stringify(out.income?.boxes[x.receiver], (_k, v: unknown) => typeof v === 'bigint' ? String(v) : v)
        === JSON.stringify(expected.boxes[x.receiver], (_k, v: unknown) => typeof v === 'bigint' ? String(v) : v));
      f.state.final += 3n;
    }
    // Numbers for docs/evidence/SH-247.md, written only when asked for.
    if (process.env.SH247_F1_OUT) writeFileSync(process.env.SH247_F1_OUT, JSON.stringify({ ticks: spent.length, spent, coverage, others,
      logQueries: f.pub.getLogs.mock.calls.length }));
    // No cycle passed the service's 240 s limit (each stays near the 90 s budget), several were needed, each kept more
    // of the page than the last, and the page was read through.
    for (const ms of spent) expect(ms).toBeLessThan(100_000);
    // Cheap reads first (re-check N1): boxes b, c and d count in every tick while box a's flood is halved.
    expect(others.every(Boolean)).toBe(true);
    expect(spent.length).toBeGreaterThan(5);
    for (let i = 1; i < coverage.length - 1; i++) expect(coverage[i]).toBeGreaterThan(coverage[i - 1] ?? 0);
    expect(f.pub.getLogs.mock.calls.length).toBeGreaterThan(300);
    expect(through).toBe(true);
  }, shLimit(120_000));
});

describe('F2: reads go to the boxes that have something unread, whatever number of boxes is registered', () => {
  it('600 idle registered boxes: every paying box is fully read within ceil(101 / 64) = 2 ticks', async () => {
    const quiet = incomeChain({ final: 2_000n });
    for (let i = 0; i < 100; i++) quiet.nativePaid(quiet.a, 1n, 700_000n + BigInt(i), 1_000n + BigInt(i));
    // The reference has caught up too: a cold read takes 64 of box a's 101 receipts (P4), the second the rest.
    const reference = new IncomeCache();
    await quiet.read(reference);
    const expected = await quiet.read(reference);
    expect(expected.boxes[quiet.a.receiver]?.shareWei).toBe(10n ** 15n + 100n);
    const f = incomeChain({ final: 2_000n });
    for (let i = 0; i < 100; i++) f.nativePaid(f.a, 1n, 700_000n + BigInt(i), 1_000n + BigInt(i));
    f.register(600);
    const paying = [f.a, f.b, f.c, f.d].map(x => x.receiver);
    const cache = new IncomeCache();
    const ticks = [];
    for (let tick = 0; tick < 2; tick++) {
      ticks.push(await f.read(cache));
      f.state.final += 3n;
    }
    expect(credits(ticks[1] ?? { boxes: {} }, paying)).toEqual(credits(expected, paying));
    // The first tick already reads up to 64 receipts of box a: the idle boxes take no share.
    expect(ticks[0]?.boxes[f.a.receiver]?.shareWei).toBeGreaterThanOrEqual(10n ** 15n + 63n);
  }, shLimit(120_000));
});

describe('F3: a refused page is split whatever the wording, and one block too large leaves out only its box', () => {
  it.each([
    ['the result-limit code with other words', -32005, 'backend says no'],
    ['another refusal', -32000, 'query could not be served'],
  ] as const)('%s on ranges of more than 16 blocks: every box as without it from the next tick', async (_, code, details) => {
    const f = incomeChain(), expected = await f.read();
    f.state.refuse = q => q.toBlock - q.fromBlock >= 16n
      ? Object.assign(new Error('RPC Request failed.'), { name: 'RpcRequestError', code, details }) : null;
    // Fifth round (halving last): the first tick halves after every box's own reads, so each box waiting on it counts
    // INCOME_CAPACITY there; the next tick reads every box from the kept pieces.
    const cache = f.cache(), zeroed: ZeroedTokenIncome[] = [];
    const first = await f.read(cache);
    expect(new Set((first.valuationFailures ?? []).map(v => v.code))).toEqual(new Set(['INCOME_CAPACITY']));
    expect(await f.read(cache, zeroed)).toEqual(expected);
    expect(zeroed).toEqual([]);
  });

  it('one block above the node\'s limit for one receiver: only that box counts zero; the others keep the page', async () => {
    const f = incomeChain(), expected = await f.read();
    f.state.dense = { address: f.a.receiver, from: 50n, blocks: 1, perBlock: 300 };
    f.state.cap = 200;
    const cache = new IncomeCache(), zeroed: ZeroedTokenIncome[] = [];
    const first = await f.read(cache, zeroed);
    expect(first.boxes[f.a.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    expect(zeroed.map(z => z.receiver)).toEqual([f.a.receiver]);
    for (const x of [f.b, f.c, f.d]) expect(first.boxes[x.receiver]).toEqual(expected.boxes[x.receiver]);
    f.state.final += 1n;
    const second = await f.read(cache);
    for (const x of [f.b, f.c, f.d]) {
      expect(second.boxes[x.receiver]).toEqual(expected.boxes[x.receiver]);
      expect(cache.reads?.boxes[x.receiver]?.rows).toBe(0);
    }
    expect(second.boxes[f.a.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
  });
});

describe('F5: one payment is never credited to two boxes', () => {
  it('a kept projection without a late box, and an incomplete fresh read, in either order', async () => {
    const f = incomeChain({ final: 2_000n });
    f.logs.splice(0);
    const T = 555n, x = 10n ** 15n, base = { blockNumber: 1_500n, blockHash: hash(1_500n), transactionHash: hash(T), removed: false };
    f.logs.push({ ...base, address: safe, eventName: 'SafeReceived', logIndex: 0, args: { sender: pm, value: x } },
      { ...base, address: f.a.receiver, eventName: 'PlatformPaid', logIndex: 1, args: { safe, amount: x } },
      { ...base, address: f.b.receiver, eventName: 'PlatformPaid', logIndex: 2, args: { safe, amount: x } });
    const cache = new IncomeCache();
    // Round one: box b is not registered yet; box a's projection of T is kept.
    const one = await f.read(cache, undefined, [], [f.a]);
    expect(one.boxes[f.a.receiver]?.shareWei).toBe(x);
    // Then b is registered and ranks first, and T's receipt now carries a log of a registered part that fails to decode.
    const original = f.pub.getTransactionReceipt.getMockImplementation();
    if (!original) throw new Error('missing fixture receipts');
    const fitPaid = toEventSelector(getAbiItem({ abi: receiverV2Abi, name: 'FitPaid' }));
    f.pub.getTransactionReceipt.mockImplementation(async args => {
      const receipt = await original(args);
      return { ...receipt, logs: [...receipt.logs, { ...base, address: f.a.receiver, topics: [fitPaid, pad(safe)] as [Hex, Hex], data: '0x01' as Hex,
        logIndex: 9, eventName: 'FitPaid', args: {} }] };
    });
    // Every round, whichever box is read first: the line's order gives the one Safe receipt to b, ranked first (R2).
    for (let round = 0; round < 3; round++) {
      const income = await f.read(cache, undefined, [], [f.b, f.a]);
      expect(income.boxes[f.b.receiver]?.shareWei).toBe(x);
      expect(income.boxes[f.a.receiver]?.shareWei).toBe(0n);
    }
  });
});

describe('F6: a transaction answer is kept only when it names the transaction asked for', () => {
  it('an answer for another hash serves one tick and is read again; a matching one is kept', async () => {
    const f = incomeChain();
    const tx = hash(800n);
    f.logs.push({ address: f.a.receiver, eventName: 'BoughtBack', blockNumber: 70n, blockHash: hash(70n), transactionHash: tx, logIndex: 0,
      removed: false, args: { pSpent: 10n, tBought: 1n, tBurned: 1n, tip: 5n } });
    const input = encodeFunctionData({ abi: receiverV2Abi, functionName: 'buyBack', args: [keeper] });
    f.pub.getTransaction.mockImplementation(async () => ({ hash: hash(801n), to: f.a.receiver, input }) as never);
    const cache = new IncomeCache();
    await f.read(cache);
    f.pub.getTransaction.mockClear();
    await f.read(cache);
    expect(f.pub.getTransaction).toHaveBeenCalledTimes(1);
    f.pub.getTransaction.mockImplementation(async () => ({ hash: tx, blockHash: hash(70n), blockNumber: 70n, to: f.a.receiver, input }) as never);
    await f.read(cache);
    f.pub.getTransaction.mockClear();
    expect((await f.read(cache)).boxes[f.a.receiver]?.tipsWei).toBe(7n * 10n ** 12n + 5n);
    expect(f.pub.getTransaction).not.toHaveBeenCalled();
  });
});

describe('F8: one box past the tick\'s rows leaves the page kept for every other box', () => {
  it('the next tick charges the other boxes nothing again and reads the left-out box on its own', async () => {
    const f = incomeChain(), expected = await f.read();
    for (let i = 0; i < 10_001; i++) f.logs.push({ address: f.a.receiver, eventName: 'Collected', blockNumber: 60n, blockHash: hash(60n),
      transactionHash: hash(900_000n + BigInt(i)), logIndex: 0, removed: false, args: { caller: f.d.receiver, tipTo: f.d.receiver, tip: 1n } });
    const cache = new IncomeCache();
    const first = await f.read(cache);
    expect(first.boxes[f.a.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    for (const x of [f.b, f.c, f.d]) expect(first.boxes[x.receiver]).toEqual(expected.boxes[x.receiver]);
    f.state.final += 1n;
    f.pub.getLogs.mockClear();
    const second = await f.read(cache);
    for (const x of [f.b, f.c, f.d]) {
      expect(second.boxes[x.receiver]).toEqual(expected.boxes[x.receiver]);
      expect(cache.reads?.boxes[x.receiver]?.rows).toBe(0);
    }
    // Box a's receiver is asked on its own, not the whole page again.
    expect(f.pub.getLogs.mock.calls.some(([c]) => typeof c.address === 'string' && c.address.toLowerCase() === f.a.receiver.toLowerCase())).toBe(true);
    expect(second.boxes[f.a.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
  }, shLimit(60_000));
});

/**
 * Third round (re-check of 23 November 2026, the coordinator's rules 1 to 5): no hold, no learned size, no size words.
 * Each node kind below runs a day of 2,880 rounds at the server's 30-second cadence on a virtual clock (68 ms a log
 * query, the real run's mean; 40 ms a header), six boxes, three new blocks a round.
 */
const rpcError = (name: string, code: number, details: string) => Object.assign(new Error('RPC Request failed.'), { name, code, details });
// The real provider's two answers (scratchpad sh247-real/new2-keyed.jsonl).
const rateLimited = () => rpcError('RpcRequestError', 429,
  'Your app has exceeded its compute units per second capacity. If you have retries enabled, you can safely ignore this message.');
const tenBlocks = (from: bigint) => rpcError('InvalidRequestRpcError', -32600, 'Under the Free tier plan, you can make eth_getLogs requests '
  + `with up to a 10 block range. Based on your parameters, this block range should work: [0x${from.toString(16)}, 0x${(from + 9n).toString(16)}]. `
  + 'Upgrade to PAYG for expanded block range.');
type Kind = 'quiet' | 'keeps 1,000 blocks' | 'refuses everything' | '429 above 5 a second' | '10 blocks' | '10 blocks, 429 above 5 a second'
  | 'a first block too large' | 'every other query refused' | '10 % refused at random';
const same = (a: unknown, b: unknown) => JSON.stringify(a, (_k, v: unknown) => typeof v === 'bigint' ? String(v) : v)
  === JSON.stringify(b, (_k, v: unknown) => typeof v === 'bigint' ? String(v) : v);

async function day(kind: Kind, rounds = 200) {
  const quiet = incomeChain({ final: 7_300n });
  const expected = await quiet.read();
  const f = incomeChain({ final: 7_300n });
  f.state.latency = { logs: 68, block: 40 };
  const times: number[] = [];
  let asked = 0, rate = 0, window = 0, seed = 12_345;
  // Box a's own rows over the node's limit in the cold walk's first block and in the first block of round 10's tail.
  const flooded = new Set<bigint>([101n, 7_300n + 9n * 3n + 1n]);
  f.state.refuse = q => {
    times.push(f.state.clock);
    asked++;
    while ((times[window] ?? Infinity) <= f.state.clock - 1_000) window++;
    if (kind.includes('429') && times.length - window > 5) { rate++; return rateLimited(); }
    if (kind.startsWith('10 blocks') && q.toBlock - q.fromBlock + 1n > 10n) return tenBlocks(q.fromBlock);
    if ((kind === 'keeps 1,000 blocks' && q.fromBlock < f.state.final - 1_000n) || kind === 'refuses everything') {
      return rpcError('RpcRequestError', -32000, 'history not available');
    }
    if (kind === 'every other query refused' && asked % 2 === 0) return rpcError('RpcRequestError', -32603, 'internal error');
    if (kind.endsWith('at random')) {
      // A fixed-seed linear congruential sequence: the same refusals on every run.
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      if (seed / 2 ** 32 < 0.1) return rpcError('RpcRequestError', -32603, 'internal error');
    }
    if (kind === 'a first block too large' && q.address.includes(f.a.receiver.toLowerCase())
      && [...flooded].some(b => b >= q.fromBlock && b <= q.toBlock)) {
      return rpcError('LimitExceededRpcError', -32005, 'query returned more than 10000 results');
    }
    return null;
  };
  const cache = f.cache();
  const perRound: number[] = [], full: boolean[] = [], others: boolean[] = [], codes: Record<string, number> = {};
  let gap = Infinity;
  for (let round = 0; round < rounds; round++) {
    const before = f.pub.getLogs.mock.calls.length, first = times.length;
    const income = await f.read(cache);
    perRound.push(f.pub.getLogs.mock.calls.length - before);
    for (let i = first + 1; i < times.length; i++) gap = Math.min(gap, (times[i] ?? 0) - (times[i - 1] ?? 0));
    for (const v of income.valuationFailures ?? []) codes[v.code] = (codes[v.code] ?? 0) + 1;
    {
      full.push((income.valuationFailures ?? []).length === 0 && f.boxes.every(x => same(income.boxes[x.receiver], expected.boxes[x.receiver])));
      others.push(f.boxes.filter(x => x !== f.a).every(x => same(income.boxes[x.receiver], expected.boxes[x.receiver])));
    }
    f.state.final += 3n;
    f.state.clock += 30_000;
  }
  const logs = f.pub.getLogs.mock.calls.length;
  // From this round on every round is full (-1: none such).
  const firstFull = full.every(Boolean) ? 0 : full.lastIndexOf(false) + 1 < full.length ? full.lastIndexOf(false) + 1 : -1;
  const othersFrom = others.every(Boolean) ? 0 : others.lastIndexOf(false) + 1 < others.length ? others.lastIndexOf(false) + 1 : -1;
  // A day at the server's cadence: these rounds, then the last 100 rounds' rate for the rest of 2,880.
  const steadyRate = perRound.slice(-100).reduce((n, x) => n + x, 0) / 100;
  return { kind, logs, perDay: Math.round(logs + steadyRate * (2_880 - rounds)), steadyRate, cold: perRound.slice(0, 3), max: Math.max(...perRound), firstFull,
    othersFrom, codes, rate, gap };
}

describe('Third round: log queries per day and ticks to a full read, by node kind', () => {
  // The quiet node's day: 12 cold queries, then 3 grouped tails a round.
  const QUIET = 8_649;
  // `perDay`: measured over 200 rounds, the last 100 rounds' rate for the rest of 2,880. `firstFull`: the first round
  // (0-based) from which every box counts as on the quiet node in every later round; -1: never for good, as on the line.
  // `others`: the same for every box but box a.
  const expected: Record<Kind, { perDay: number; firstFull: number; others: number; codes: Record<string, number> }> = {
    'quiet': { perDay: QUIET, firstFull: 0, others: 0, codes: {} },
    // The walk's first page and both its probes, each asked twice: six queries a round, every box INCOME_CAPACITY.
    'keeps 1,000 blocks': { perDay: 17_280, firstFull: -1, others: -1, codes: { INCOME_CAPACITY: 6 * 200 } },
    'refuses everything': { perDay: 17_280, firstFull: -1, others: -1, codes: { INCOME_CAPACITY: 6 * 200 } },
    // Paced at five a second, the node never answers 429.
    '429 above 5 a second': { perDay: QUIET, firstFull: 0, others: 0, codes: {} },
    // Every address refused alone, so the grouped range is halved, after the boxes' own reads, to pieces of ten blocks
    // or fewer: 450 queries a tick (the pace inside 90 s); every box counts from round 18.
    '10 blocks': { perDay: 16_310, firstFull: 18, others: 18, codes: { INCOME_CAPACITY: 108 } },
    '10 blocks, 429 above 5 a second': { perDay: 16_310, firstFull: 18, others: 18, codes: { INCOME_CAPACITY: 108 } },
    // Box a alone is left out of its flooded blocks (waiting on its halving in round 0 and round 10, then left out at the
    // block, so never for good); every other box is read every round.
    'a first block too large': { perDay: 14_435, firstFull: -1, others: 0, codes: { INCOME_CAPACITY: 2, OTHER: 189 } },
    // A refusal is believed only when given twice: every box read in every round, at about twice the quiet count.
    'every other query refused': { perDay: 17_297, firstFull: 0, others: 0, codes: {} },
    '10 % refused at random': { perDay: 9_746, firstFull: 0, others: 0, codes: {} },
  };
  it.each(Object.keys(expected) as Kind[])('%s', async kind => {
    const t = Date.now();
    const out = await day(kind);
    if (process.env.SH247_R3_OUT) appendFileSync(process.env.SH247_R3_OUT, `${JSON.stringify({ ...out, ms: Date.now() - t })}\n`);
    const want = expected[kind];
    expect(out.perDay).toBe(want.perDay);
    expect(out.firstFull).toBe(want.firstFull);
    expect(out.othersFrom).toBe(want.others);
    expect(out.codes).toEqual(want.codes);
    // Rule 5 in every kind: log queries at least 200 ms apart, at most 450 in a tick, and no rate-limit answer.
    expect(out.gap).toBeGreaterThanOrEqual(INCOME_LOG_GAP_MS);
    expect(out.max).toBeLessThanOrEqual(450);
    expect(out.rate).toBe(0);
    // The fifth round's bounds: refusing nodes six a round, the every-other node within about 2.2 times the quiet one.
    if (kind === 'refuses everything' || kind === 'keeps 1,000 blocks') expect(out.steadyRate).toBe(6);
    if (kind === 'every other query refused') expect(out.perDay).toBeLessThanOrEqual(2.2 * QUIET);
    if (kind.startsWith('10 blocks')) expect(out.firstFull).toBeLessThanOrEqual(18);
  }, shLimit(300_000));
});

describe('Rule 1: no answer stops log discovery for the tick; nothing is remembered', () => {
  it('tells no answer from a refusal by kind and code, never by size words', () => {
    const http = (status: number) => Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError', status });
    for (const error of [Object.assign(new Error('The request took too long to respond.'), { name: 'TimeoutError' }), http(429), http(503),
      rateLimited(), rpcError('RpcRequestError', -32007, 'request limit reached'),
      rpcError('LimitExceededRpcError', -32005, 'rate limit exceeded'), rpcError('LimitExceededRpcError', -32005, 'Too Many Requests'),
      rpcError('LimitExceededRpcError', -32005, 'Your app has exceeded its compute units per second capacity'),
      Object.assign(new Error('fetch'), { cause: rateLimited() })]) expect(noAnswer(error)).toBe(true);
    for (const error of [rpcError('LimitExceededRpcError', -32005, 'query returned more than 10000 results'), tenBlocks(5n),
      rpcError('RpcRequestError', -32000, 'history not available'), rpcError('RpcRequestError', -32603, 'internal error'),
      Object.assign(new Error('answer too large'), { name: 'ResponseBodyTooLargeError' }), new Error('logs pruned')]) {
      expect(noAnswer(error)).toBe(false);
    }
  });

  it('a rate-limit answer in a cold start: no split, every box INCOME_CAPACITY, the next tick resumes where it stopped', async () => {
    const quiet = incomeChain({ final: 7_300n }), expected = await quiet.read();
    const f = incomeChain({ final: 7_300n });
    let asked = 0;
    f.state.refuse = () => ++asked === 5 ? rateLimited() : null;
    const cache = f.cache();
    const one = await f.read(cache);
    // Four pages answered, the fifth got no answer, and nothing more was asked: no probe, no split.
    expect(f.pub.getLogs.mock.calls.length).toBe(5);
    expect(new Set(f.pub.getLogs.mock.calls.map(([q]) => q.fromBlock))).toEqual(new Set([101n, 2_101n, 4_101n, 6_101n]));
    expect([...one.valuationFailures ?? []].sort((x, y) => Number(x.boxId - y.boxId)))
      .toEqual(f.boxes.map(x => ({ boxId: x.id, code: 'INCOME_CAPACITY' })));
    f.state.final += 3n;
    f.pub.getLogs.mockClear();
    const two = await f.read(cache);
    // The kept receivers' pages serve; the rest of the walk and the receivers' new tail: 4 + 4 + 1 queries.
    expect(f.pub.getLogs.mock.calls.length).toBe(9);
    expect(two.valuationFailures ?? []).toEqual([]);
    expect(two.boxes).toEqual(expected.boxes);
  });
});

describe('Rules 2 and 3: a refusal that its first or last block explains is about size; addresses first, then halves', () => {
  it('a flood on one box\'s own events: every other box is read in the same tick, the flooded box in the next', async () => {
    const f = incomeChain({ final: 2_000n }), expected = await f.read();
    // 4,000 empty collections on box a's receiver, 100 in each of 40 blocks; the node answers at most 1,000 rows.
    f.state.dense = { address: f.a.receiver, from: 1_000n, blocks: 40, perBlock: 100 };
    f.state.cap = 1_000;
    f.pub.getLogs.mockClear();
    const cache = f.cache();
    const income = await f.read(cache);
    for (const x of f.boxes.filter(x => x !== f.a)) expect(income.boxes[x.receiver]).toEqual(expected.boxes[x.receiver]);
    // Box a waits for its halving, which runs after every box's own reads: INCOME_CAPACITY, never a silent zero.
    expect(income.valuationFailures).toEqual([{ boxId: f.a.id, code: 'INCOME_CAPACITY' }]);
    expect((await f.read(cache)).boxes).toEqual(expected.boxes);
    // Each receiver asked alone once; only box a's receiver asked in pieces.
    const alone = f.pub.getLogs.mock.calls.map(([q]) => q).filter(q => typeof q.address === 'string');
    for (const x of f.boxes.filter(x => x !== f.a)) expect(alone.filter(q => q.address === x.receiver)).toHaveLength(1);
    expect(alone.filter(q => q.address === f.a.receiver).length).toBeGreaterThan(1);
  });
});

describe('Rule 4: refusals no answer explains stop discovery for the rest of the tick', () => {
  it('a block refused for every address: each tick stops after 16 refusals no answer explains; then 16 boxes left out there', async () => {
    const f = incomeChain({ final: 2_000n });
    f.register(20);
    const B = 1_000n;
    f.state.refuse = q => q.fromBlock <= B && q.toBlock >= B ? rpcError('RpcRequestError', -32000, 'block not available') : null;
    const cache = f.cache(), ticks: { queries: number; other: number; capacity: number }[] = [];
    for (let tick = 0; tick < 4; tick++) {
      f.pub.getLogs.mockClear();
      const codes = ((await f.read(cache)).valuationFailures ?? []).map(v => v.code);
      ticks.push({ queries: f.pub.getLogs.mock.calls.length, other: codes.filter(c => c === 'OTHER').length,
        capacity: codes.filter(c => c === 'INCOME_CAPACITY').length });
      f.state.final += 3n;
    }
    if (process.env.SH247_R3_OUT) appendFileSync(process.env.SH247_R3_OUT, `${JSON.stringify({ rule4: ticks })}\n`);
    // Every address refused alone: every box waits in the first tick while the grouped range is halved toward the block
    // after the boxes' own reads (both halves asked before either is halved again); from the second tick 16 boxes are
    // left out at the block and the 17th refusal stops the tick.
    for (const t of ticks) expect(t.other + t.capacity).toBe(f.boxes.length);
    for (const t of ticks) expect(t.other).toBeLessThanOrEqual(INCOME_UNEXPLAINED_REFUSALS);
    expect(ticks).toEqual([{ queries: 207, other: 0, capacity: 26 }, { queries: 36, other: 16, capacity: 10 },
      { queries: 36, other: 16, capacity: 10 }, { queries: 36, other: 16, capacity: 10 }]);
  });
});

const FLOODED_1S = '000001111111';
// Box a's halving comes first (registry order) and is through in tick 6; box b's in tick 11.
const TWO_FLOODS = { a: '00000011111111111111', b: '00000000000111111111' };
describe('Fourth and fifth rounds: cheap reads first, halving last, a refusal believed when given twice, the grouped range halved', () => {
  it('two flooded boxes in one tick: both read in later ticks, every other box read in every tick', async () => {
    const quiet = incomeChain({ final: 2_000n }), expected = await quiet.read();
    const f = incomeChain({ final: 2_000n });
    // Empty collections on box a's and box b's receivers, 100 in each of 200 blocks; the node answers at most 150 rows
    // and takes 1 s a log query, so their halving needs several ticks.
    f.state.dense = { address: f.a.receiver, from: 300n, blocks: 200, perBlock: 100 };
    f.state.moreDense = [{ address: f.b.receiver, from: 900n, blocks: 200, perBlock: 100 }];
    f.state.cap = 150;
    f.state.latency = { logs: 1_000, block: 40 };
    const cache = f.cache(), a: number[] = [], b: number[] = [], others: number[] = [];
    for (let tick = 0; tick < 20; tick++) {
      const income = await f.read(cache);
      a.push(Number(same(income.boxes[f.a.receiver], expected.boxes[f.a.receiver])));
      b.push(Number(same(income.boxes[f.b.receiver], expected.boxes[f.b.receiver])));
      others.push(Number([f.c, f.d, f.failing, f.graduating].every(x => same(income.boxes[x.receiver], expected.boxes[x.receiver]))));
      f.state.final += 3n;
      f.state.clock += 30_000;
    }
    if (process.env.SH247_R3_OUT) appendFileSync(process.env.SH247_R3_OUT, `${JSON.stringify({ twoFloods: { a: a.join(''), b: b.join(''),
      others: others.join('') } })}\n`);
    expect(others.join('')).toBe('1'.repeat(20));
    expect(a.join('')).toBe(TWO_FLOODS.a);
    expect(b.join('')).toBe(TWO_FLOODS.b);
  }, shLimit(120_000));

  it('a flood at 1 s a query (1.2 million empty collections, a 10,000-row node): the other boxes\' payments count every tick', async () => {
    const quiet = incomeChain({ final: 7_300n }), expected = await quiet.read();
    const f = incomeChain({ final: 7_300n });
    // The review's refusal-load6 scenario: 2,000 empty collections on box a's receiver in each of 600 blocks.
    f.state.dense = { address: f.a.receiver, from: 4_300n, blocks: 600, perBlock: 2_000 };
    f.state.cap = 10_000;
    f.state.latency = { logs: 1_000, block: 40 };
    const cache = f.cache(), paid: number[] = [], flooded: number[] = [];
    for (let tick = 0; tick < 12; tick++) {
      const income = await f.read(cache);
      paid.push(Number([f.b, f.c, f.d].every(x => same(income.boxes[x.receiver], expected.boxes[x.receiver]))));
      flooded.push(Number(same(income.boxes[f.a.receiver], expected.boxes[f.a.receiver])));
      f.state.final += 3n;
      f.state.clock += 30_000;
    }
    if (process.env.SH247_R3_OUT) appendFileSync(process.env.SH247_R3_OUT, `${JSON.stringify({ flood1s: { paid: paid.join(''), flooded: flooded.join('') } })}\n`);
    for (const x of [f.b, f.c, f.d]) expect(expected.boxes[x.receiver]?.shareWei).toBeGreaterThan(0n);
    expect(paid.join('')).toBe('111111111111');
    expect(flooded.join('')).toBe(FLOODED_1S);
  }, shLimit(240_000));

  it('N3: on the 10-block provider every address is asked alone only in the cheap pass; the grouped range is halved', async () => {
    const f = incomeChain({ final: 7_300n });
    f.state.latency = { logs: 68, block: 40 };
    f.state.refuse = q => q.toBlock - q.fromBlock + 1n > 10n ? tenBlocks(q.fromBlock) : null;
    const cache = f.cache();
    for (let tick = 0; tick < 3; tick++) {
      await f.read(cache);
      f.state.final += 3n;
      f.state.clock += 30_000;
    }
    const alone = f.pub.getLogs.mock.calls.map(([q]) => q).filter(q => typeof q.address === 'string');
    // Single-address queries: the cheap pass's, over whole pages or what is left of them, never a halving piece.
    expect(alone.length).toBeGreaterThan(0);
    expect(alone.filter(q => q.toBlock - q.fromBlock + 1n <= 10n)).toEqual([]);
  }, shLimit(120_000));
});
