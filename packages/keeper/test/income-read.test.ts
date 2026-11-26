import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, type PublicClient } from 'viem';
import { readIncome, type ReceiptLog } from '../src/income-read';
import { receiptLogs } from './support/income-receipts';
import { receiverV2Abi } from '../src/abi';
import { incomeRefusal, INCOME_WINDOW_SECONDS } from '../src/income';
import { openBudget } from '../src/decide';
import { runTick } from '../src/run';
import { addr, box, keeper, options, quiet, time, world } from './support/v2';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
function fixture() {
  const b = box();
  const safe = addr(55), pm = addr(56);
  const logs: Record<string, unknown>[] = [
    { address: b.receiver, eventName: 'PlatformPaid', args: { safe, amount: 101n }, blockNumber: 9n, blockHash: hash(9), transactionHash: hash(90), logIndex: 1, removed: false },
    { address: safe, eventName: 'SafeReceived', args: { sender: pm, value: 101n }, blockNumber: 9n, blockHash: hash(9), transactionHash: hash(90), logIndex: 0, removed: false },
    { address: b.receiver, eventName: 'Collected', args: { tipTo: keeper, tip: 7n }, blockNumber: 9n, blockHash: hash(9), transactionHash: hash(91), logIndex: 0, removed: false },
    { address: b.receiver, eventName: 'BoughtBack', args: { tip: 11n }, blockNumber: 9n, blockHash: hash(9), transactionHash: hash(92), logIndex: 0, removed: false },
  ];
  const pub = {
    getBlock: vi.fn(async ({ blockNumber = 10n }: { blockNumber?: bigint }) => ({ number: blockNumber, hash: hash(Number(blockNumber)), timestamp: time - (10n - blockNumber) * 12n })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'PLATFORM_SAFE') return safe;
      if (functionName === 'q') return addr(0);
      if (functionName === 'poolManager') return pm;
      throw new Error(functionName);
    }),
    getLogs: vi.fn(async ({ address, event, events, fromBlock, toBlock }: { address: string | readonly string[]; event?: { name: string }; events?: readonly { name: string }[]; fromBlock: bigint; toBlock: bigint }) =>
      logs.filter(l => (Array.isArray(address) ? address : [address]).includes(l.address) && (events ?? (event ? [event] : [])).some(e => l.eventName === e.name) && (l.blockNumber as bigint) >= fromBlock && (l.blockNumber as bigint) <= toBlock)),
    getTransaction: vi.fn(async () => ({ to: b.receiver, input: encodeFunctionData({ abi: receiverV2Abi, functionName: 'buyBack', args: [keeper] }) })),
    // SH-247: a receipt holds its transaction's own logs; every payment proof is read from it.
    getTransactionReceipt: vi.fn(async ({ hash: tx }: { hash: string }): Promise<{ blockNumber: bigint; blockHash: string } & Record<string, unknown>> => ({
      transactionHash: tx, status: 'success', blockNumber: 9n, blockHash: hash(9),
      logs: receiptLogs(logs.filter(l => l.transactionHash === tx) as unknown as ReceiptLog[]) })),
  };
  const read = () => readIncome(pub as unknown as PublicClient, [b], keeper, time, 0n, [{ box: b.receiver, at: time, costWei: 1n, hash: hash(99) }]);
  return { b, safe, logs, pub, read };
}

const closerTip = 10_000_000_000_000n;
function failureTipFixture() {
  const f = fixture();
  f.logs.splice(0, f.logs.length, {
    address: f.b.coordinator, eventName: 'PotFixed', args: { pot: 100n, tLeft: 1n, tip: closerTip, closer: keeper },
    blockNumber: 9n, blockHash: hash(9), transactionHash: hash(95), logIndex: 0, removed: false,
  });
  return f;
}

describe('F111 finalized chain receipts', () => {
  it('T31 counts actual reward tips once, with the same finality and beneficiary rules', async () => {
    const f = fixture();
    const reward = { ...f.logs[3], eventName: 'RewardsBought', args: { tipP: 13n }, transactionHash: hash(93) };
    f.logs.push(reward, { ...reward });
    expect((await f.read()).boxes[f.b.receiver]?.tipsWei).toBe(31n);
    f.pub.getTransaction.mockImplementation(async () => ({ to: addr(77), input: '0x' }));
    expect((await f.read()).boxes[f.b.receiver]?.tipsWei).toBe(7n);
    f.logs[4] = { ...reward, removed: true }; f.logs[5] = { ...reward, blockHash: hash(88) };
    expect((await f.read()).boxes[f.b.receiver]?.tipsWei).toBe(7n);
  });
  it('credits a paid closer tip once to its own box and the full platform tip allowance', async () => {
    const f = failureTipFixture();
    f.logs.push({ ...f.logs[0] });
    const income = await readIncome(f.pub as unknown as PublicClient, [f.b, f.b], keeper, time, 0n, []);
    expect(income.platformWei).toBe(0n);
    expect(income.boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: closerTip });
    expect(incomeRefusal(f.b.receiver, closerTip, [], income)).toBeNull();
    expect(incomeRefusal(f.b.receiver, closerTip + 1n, [], income)).toBe('box income cap');
    const other = addr(88);
    const funded = { ...income, boxes: { ...income.boxes, [other]: { shareWei: closerTip + 1n, tipsWei: 0n } } };
    expect(incomeRefusal(other, closerTip, [], funded)).toBeNull();
    expect(incomeRefusal(other, closerTip + 1n, [], funded)).toBe('platform income cap');
  });
  it.each([
    ['refused payment', { args: { pot: closerTip + 100n, tLeft: 1n, tip: 0n, closer: keeper } }],
    ['another closer', { args: { pot: 100n, tLeft: 1n, tip: closerTip, closer: addr(88) } }],
    ['removed receipt', { removed: true }],
    ['orphaned receipt', { blockHash: hash(88) }],
    ['unfinalized receipt', { blockNumber: 11n, blockHash: hash(11) }],
    ['unregistered coordinator', { address: addr(88) }],
  ] as const)('does not credit a failure tip from %s', async (_, changes) => {
    const f = failureTipFixture();
    f.logs[0] = { ...f.logs[0], ...changes };
    const income = await f.read();
    expect(income.boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    expect(incomeRefusal(f.b.receiver, 1n, [], income)).toBe('box income cap');
  });
  it('expires a closer tip exactly at the rolling-window boundary', async () => {
    const f = failureTipFixture();
    const receivedAt = time - 12n;
    const readAt = (at: bigint) => readIncome(f.pub as unknown as PublicClient, [f.b], keeper, at, 0n, []);
    expect((await readAt(receivedAt + INCOME_WINDOW_SECONDS - 1n)).boxes[f.b.receiver]?.tipsWei).toBe(closerTip);
    expect((await readAt(receivedAt + INCOME_WINDOW_SECONDS)).boxes[f.b.receiver]?.tipsWei).toBe(0n);
    expect((await readAt(receivedAt + INCOME_WINDOW_SECONDS + 1n)).boxes[f.b.receiver]?.tipsWei).toBe(0n);
  });
  it('does not value a non-native closer tip as wei', async () => {
    const f = failureTipFixture();
    const original = f.pub.readContract.getMockImplementation();
    if (!original) throw new Error('missing fixture reader');
    f.pub.readContract.mockImplementation(async c => c.functionName === 'q' ? addr(77) : original(c));
    expect((await f.read()).boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
  });
  it('received closer tips never replenish the fixed daily ceiling', async () => {
    const f = failureTipFixture();
    const cfg = { ...options(), dryRun: false, priorityFeeWei: 1n };
    const budget = { ...openBudget(undefined, 100n, time), totalWei: cfg.limits.totalWeiPerDay };
    const send = vi.fn(async () => hash(99));
    const out = await runTick({ read: async () => world(f.b), readIncome: f.read,
      simulate: async c => ({ ok: c.job === 'buyBack', estimate: 100_000n, tipWei: null }), send },
    { budget, incomeSpend: [] }, cfg, quiet);
    expect(out.report.skipped).toContainEqual(expect.objectContaining({ job: 'buyBack', why: 'daily ceiling reached' }));
    expect(out.state.budget).toEqual(budget);
    expect(send).not.toHaveBeenCalled();
  });
  it('reads native platform receipts and actual tips, with no valuation or whole-balance inference', async () => {
    const f = fixture();
    expect(await f.read()).toEqual({ at: time, platformWei: 101n, boxes: { [f.b.receiver]: { shareWei: 101n, tipsWei: 18n } }, mined: { [hash(99)]: time - 12n } });
    expect(f.pub.getBlock).toHaveBeenCalledWith({ blockTag: 'finalized' });
    expect(f.pub.readContract.mock.calls.every(([c]) => 'blockNumber' in c)).toBe(true);
  });
  it('requires the platform Safe receipt, rejects wrong destinations and deduplicates logs', async () => {
    const f = fixture();
    f.logs.push({ ...f.logs[0] });
    expect((await f.read()).platformWei).toBe(101n);
    f.logs[1] = { ...f.logs[1], args: { sender: addr(88), value: 101n } };
    expect((await f.read()).platformWei).toBe(0n);
    f.logs[0] = { ...f.logs[0], args: { safe: addr(88), amount: 101n } };
    expect((await f.read()).boxes[f.b.receiver]?.shareWei).toBe(0n);
  });
  it('does not credit ERC-20 units as wei, even for an 18-decimal token', async () => {
    const f = fixture();
    const original = f.pub.readContract.getMockImplementation();
    if (!original) throw new Error('missing fixture reader');
    f.pub.readContract.mockImplementation(async c => c.functionName === 'q' ? addr(77) : original(c));
    expect((await f.read()).boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
  });
  it('excludes removed, orphaned, future and exactly expired receipts', async () => {
    const f = fixture();
    f.logs[0] = { ...f.logs[0], removed: true };
    expect((await f.read()).platformWei).toBe(0n);
    f.logs[0] = { ...f.logs[0], removed: false, blockHash: hash(88) };
    expect((await f.read()).platformWei).toBe(0n);
    f.logs[0] = { ...f.logs[0], blockHash: hash(9) };
    f.pub.getBlock.mockImplementation(async ({ blockNumber = 10n }) => ({ number: blockNumber, hash: hash(Number(blockNumber)), timestamp: blockNumber < 10n ? time - 86_400n : time }));
    expect((await f.read()).platformWei).toBe(0n);
  });
  it('never assigns another recipient or nested call tip to this keeper', async () => {
    const f = fixture();
    f.logs[2] = { ...f.logs[2], args: { tipTo: addr(77), tip: 7n } };
    f.pub.getTransaction.mockImplementation(async () => ({ to: addr(77), input: '0x' }));
    expect((await f.read()).boxes[f.b.receiver]?.tipsWei).toBe(0n);
  });
  it('keeps missing or orphaned transaction receipts fully reserved', async () => {
    const f = fixture();
    f.pub.getTransactionReceipt.mockRejectedValue(new Error('not mined'));
    expect((await f.read()).mined).toEqual({});
    f.pub.getTransactionReceipt.mockResolvedValue({ blockNumber: 9n, blockHash: hash(88) });
    expect((await f.read()).mined).toEqual({});
  });
  it('a new box unavailable at finality cannot suppress another box receipts', async () => {
    const f = fixture();
    const original = f.pub.readContract.getMockImplementation();
    if (!original) throw new Error('missing fixture reader');
    f.pub.readContract.mockImplementation(async c => {
      if ((c as { address?: string }).address === addr(99)) throw new Error('not deployed at finality');
      return original(c);
    });
    const result = await readIncome(f.pub as unknown as PublicClient,
      [f.b, box({ id: 1n, receiver: addr(99), hook: addr(98) })], keeper, time, 0n, []);
    expect(result.platformWei).toBe(101n);
    expect(result.boxes[addr(99)]).toEqual({ shareWei: 0n, tipsWei: 0n });
  });
  // SH-247 (P2): this pinned the old whole-snapshot failure. A box whose reading fails counts zero, with its code,
  // and the snapshot stays available; no partial credit is kept for that box. Third round (rule 2): a refused range
  // whose first and last block are refused too stops log discovery for the tick, so the code is INCOME_CAPACITY.
  it('counts a box zero on a discovery RPC failure and keeps the snapshot available', async () => {
    const f = fixture();
    f.pub.getLogs.mockRejectedValue(new Error('unavailable'));
    const income = await f.read();
    expect(income.platformWei).toBe(0n);
    expect(income.boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    expect(income.valuationFailures).toEqual([{ boxId: f.b.id, code: 'INCOME_CAPACITY' }]);
  });
});

it('READS-2 reuses finalized headers and logs, preserving credits and rolling expiry', async () => {
  const f = fixture();
  const { IncomeCache } = await import('../src/income-read');
  const cache = new IncomeCache();
  const read = (now = time) => readIncome(f.pub as unknown as PublicClient, [f.b], keeper, now, 0n, [], cache);
  const first = await read();
  f.pub.getLogs.mockClear(); f.pub.getBlock.mockClear();
  expect(await read()).toEqual(first);
  expect(f.pub.getLogs).not.toHaveBeenCalled();
  expect(f.pub.getBlock.mock.calls.length).toBeLessThanOrEqual(2);
  expect((await read(time + INCOME_WINDOW_SECONDS)).platformWei).toBe(0n);
});
it('READS-2 discards cached history when its finalized anchor changes', async () => {
  const f = fixture();
  const { IncomeCache } = await import('../src/income-read');
  const cache = new IncomeCache();
  const read = () => readIncome(f.pub as unknown as PublicClient, [f.b], keeper, time, 0n, [], cache);
  await read();
  f.pub.getBlock.mockImplementation(async ({ blockNumber = 10n }) => ({ number: blockNumber, hash: hash(88), timestamp: time }));
  await expect(read()).rejects.toThrow(/finality/);
  f.pub.getLogs.mockClear();
  expect((await read()).platformWei).toBe(0n);
  expect(f.pub.getLogs).toHaveBeenCalled();
});

it('READS-2 queries only newly finalized blocks and does not commit a failed finality recheck', async () => {
  const f = fixture();
  const { IncomeCache } = await import('../src/income-read');
  const cache = new IncomeCache();
  const read = () => readIncome(f.pub as unknown as PublicClient, [f.b], keeper, time + 24n, 0n, [], cache);
  await read();
  f.pub.getLogs.mockClear();
  f.pub.getBlock.mockImplementation(async ({ blockNumber = 11n }) => ({ number: blockNumber, hash: hash(Number(blockNumber)), timestamp: time - (10n - blockNumber) * 12n }));
  expect((await read()).platformWei).toBe(101n);
  expect(f.pub.getLogs.mock.calls.every(([c]) => c.fromBlock === 11n && c.toBlock === 11n)).toBe(true);
  f.pub.getBlock.mockImplementation(async ({ blockNumber }) => ({ number: blockNumber ?? 12n, hash: hash(blockNumber === 12n ? 88 : Number(blockNumber ?? 12n)), timestamp: time }));
  await expect(read()).rejects.toThrow('income finality changed');
  expect(cache.pages).toHaveLength(0);
});

it('READS-2 bounds retained pages, rows and headers; eviction rereads instead of losing income', async () => {
  const { IncomeCache, INCOME_CACHE_HEADERS, INCOME_CACHE_PAGES, INCOME_CACHE_LOGS } = await import('../src/income-cache');
  const { parseAbiItem } = await import('viem');
  const f = fixture(), cache = new IncomeCache();
  const event = parseAbiItem('event SafeReceived(address indexed sender, uint256 value)');
  // Disjoint intervals still exercise eviction after adjacent intervals are coalesced.
  for (let n = 0; n <= INCOME_CACHE_PAGES; n++) await cache.logs(f.pub as unknown as PublicClient, f.safe, event, BigInt(n * 2), BigInt(n * 2));
  expect(cache.pages.length).toBe(INCOME_CACHE_PAGES);
  expect(cache.pages.reduce((n, p) => n + p.rows.length, 0)).toBeLessThanOrEqual(INCOME_CACHE_LOGS);
  for (let n = 0; n <= INCOME_CACHE_HEADERS; n++) await cache.header(f.pub as unknown as PublicClient, BigInt(n));
  expect(cache.headers.size).toBe(INCOME_CACHE_HEADERS);
  const staged = await cache.begin(f.pub as unknown as PublicClient, { number: 20000n, hash: hash(20000), timestamp: time });
  expect(staged.headers.size).toBeLessThanOrEqual(INCOME_CACHE_HEADERS);
  f.pub.getLogs.mockClear();
  await cache.logs(f.pub as unknown as PublicClient, f.safe, event, 0n, 0n);
  expect(f.pub.getLogs).toHaveBeenCalledOnce();
});

it('af1 F1 coalesces adjacent and overlapping intervals, deduplicates rows and trims expired coverage', async () => {
  const { IncomeCache } = await import('../src/income-cache');
  const { parseAbiItem } = await import('viem');
  const f = fixture(), cache = new IncomeCache();
  const event = parseAbiItem('event SafeReceived(address indexed sender, uint256 value)');
  f.logs.push({ ...f.logs[1] });
  for (const [from, to] of [[8n, 10n], [6n, 9n], [11n, 12n]] as const) {
    await cache.logs(f.pub as unknown as PublicClient, f.safe, event, from, to);
  }
  expect(cache.pages).toMatchObject([{ from: 6n, to: 12n, rows: [{ blockNumber: 9n }] }]);
  const committed = new IncomeCache();
  committed.commit(cache, { number: 12n, hash: hash(12), timestamp: time }, 10n);
  expect(committed.pages).toMatchObject([{ from: 10n, to: 12n, rows: [] }]);
});

it.each(['log', 'header'])('af1 F2 retries a transient orphan %s and matches uncached income after recovery', async source => {
  const { IncomeCache } = await import('../src/income-cache');
  const f = fixture(), cache = new IncomeCache();
  const read = () => readIncome(f.pub as unknown as PublicClient, [f.b], keeper, time, 0n, [], cache);
  const getBlock = f.pub.getBlock.getMockImplementation();
  if (!getBlock) throw new Error('missing fixture headers');
  if (source === 'log') f.logs[0] = { ...f.logs[0], blockHash: hash(88) };
  else f.pub.getBlock.mockImplementation(async args => {
    const block = await getBlock(args);
    return { ...block, hash: args.blockNumber === 9n ? hash(88) : block.hash };
  });
  expect((await read()).platformWei).toBe(0n);
  f.logs[0] = { ...f.logs[0], blockHash: hash(9) };
  f.pub.getBlock.mockImplementation(getBlock);
  f.pub.getLogs.mockClear();
  const recovered = await read();
  expect(recovered.platformWei).toBe(101n);
  expect(f.pub.getLogs).toHaveBeenCalled();
  expect(recovered).toEqual(await readIncome(f.pub as unknown as PublicClient, [f.b], keeper, time, 0n, []));
});

it.each(['staged', 'retained', 'retained with evicted header'] as const)(
  'af2 F1 retries %s Safe coverage after a disputed block and matches fresh income on both recovered ticks', async coverage => {
    const { IncomeCache } = await import('../src/income-cache');
    const { parseAbiItem } = await import('viem');
    const f = fixture(), cache = new IncomeCache();
    const pub = f.pub as unknown as PublicClient;
    const read = () => readIncome(pub, [f.b], keeper, time, 0n, [], cache);
    const getBlock = f.pub.getBlock.getMockImplementation();
    if (!getBlock) throw new Error('missing fixture headers');
    f.pub.getBlock.mockImplementation(async args => {
      const block = await getBlock(args);
      return { ...block, hash: args.blockNumber === 9n ? hash(88) : block.hash };
    });
    // The Safe response agrees with the stale header, but PlatformPaid is canonical.
    f.logs[1] = { ...f.logs[1], blockHash: hash(88) };
    if (coverage !== 'staged') {
      const final = { number: 10n, hash: hash(10), timestamp: time };
      const work = await cache.begin(pub, final);
      await work.logs(pub, f.safe, parseAbiItem('event SafeReceived(address indexed sender, uint256 value)'), 0n, 10n);
      cache.commit(work, final, 0n);
      expect(cache.pages).toMatchObject([{ from: 0n, to: 10n, rows: [{ blockHash: hash(88) }] }]);
      if (coverage === 'retained with evicted header') {
        // Header and page capacities are independent: the retained row must be revalidated.
        cache.headers.delete(9n);
        f.pub.getBlock.mockImplementation(getBlock);
      }
    }
    expect((await read()).platformWei).toBe(0n);
    f.logs[1] = { ...f.logs[1], blockHash: hash(9) };
    f.pub.getBlock.mockImplementation(getBlock);
    const fresh = await readIncome(pub, [f.b], keeper, time, 0n, []);
    expect(fresh.platformWei).toBe(101n);
    for (let tick = 0; tick < 2; tick++) {
      f.pub.getLogs.mockClear();
      const recovered = await read();
      expect.soft(recovered, `recovered tick ${tick + 1}`).toEqual(fresh);
      // SH-247: the Safe's deposits are never range-read; the proof comes from the paying transaction's receipt.
      expect(f.pub.getLogs.mock.calls.some(([c]) => c.address === f.safe)).toBe(false);
      if (tick > 0) expect(f.pub.getLogs).not.toHaveBeenCalled();
    }
  },
);

it('af1 F1 memoizes grouped queries within a staged read even when page capacity evicts their coverage', async () => {
  const { IncomeCache, INCOME_CACHE_PAGES } = await import('../src/income-cache');
  const { parseAbiItem } = await import('viem');
  const f = fixture(), cache = new IncomeCache();
  const event = parseAbiItem('event SafeReceived(address indexed sender, uint256 value)');
  const final = { number: 10n, hash: hash(10), timestamp: time };
  const work = await cache.begin(f.pub as unknown as PublicClient, final);
  const addresses = Array.from({ length: INCOME_CACHE_PAGES + 1 }, (_, i) => addr(i + 1000));
  const first = addresses[0];
  if (!first) throw new Error('fixture needs addresses');
  await work.logs(f.pub as unknown as PublicClient, first, event, 0n, 10n, [event], addresses);
  // SH-247 (SH-190): a grouped family keeps one page for all its addresses, so it no longer fills the page bound.
  expect(work.pages).toHaveLength(1);
  expect(INCOME_CACHE_PAGES).toBe(512);
  await work.logs(f.pub as unknown as PublicClient, first, event, 0n, 10n, [event], addresses);
  expect(f.pub.getLogs).toHaveBeenCalledOnce();
  cache.commit(work, final, 0n);
  const next = await cache.begin(f.pub as unknown as PublicClient, final);
  await next.logs(f.pub as unknown as PublicClient, first, event, 0n, 10n, [event], addresses);
  expect(f.pub.getLogs).toHaveBeenCalledOnce();
});

it('af1 F1 bounds staged query memory and fails closed instead of evicting its deduplication memo', async () => {
  const { IncomeCache, INCOME_CACHE_PAGES, INCOME_CACHE_LOGS } = await import('../src/income-cache');
  const { parseAbiItem } = await import('viem');
  // SH-247 third round: log queries are paced (200 ms apart); this test's 512 queries skip the wait.
  const f = fixture(), cache = new IncomeCache({ sleep: async () => {} });
  const event = parseAbiItem('event SafeReceived(address indexed sender, uint256 value)');
  const final = { number: 10n, hash: hash(10), timestamp: time };
  const work = await cache.begin(f.pub as unknown as PublicClient, final);
  for (let i = 0; i < INCOME_CACHE_PAGES; i++) await work.logs(f.pub as unknown as PublicClient, addr(i + 1000), event, 0n, 10n);
  await expect(work.logs(f.pub as unknown as PublicClient, f.safe, event, 0n, 10n)).rejects.toThrow('income tick query capacity');
  expect(f.pub.getLogs).toHaveBeenCalledTimes(INCOME_CACHE_PAGES);
  const rows = await cache.begin(f.pub as unknown as PublicClient, final);
  f.pub.getLogs.mockResolvedValue(Array.from({ length: INCOME_CACHE_LOGS + 1 }, () => ({ ...f.logs[1] })));
  await expect(rows.logs(f.pub as unknown as PublicClient, f.safe, event, 0n, 10n)).rejects.toThrow('income tick log capacity');
  expect(rows.pages).toEqual([]);
  expect(cache.pages).toEqual([]);
});


describe('F182 transaction-specific final tip proof', () => {
  it('never reads an old start proof after downtime', async () => {
    const f = fixture();
    const s = { box: f.b.receiver, at: time - 24n, costWei: 7n, hash: hash(91), start: { job: 'collect' as const } };
    const pub = { ...f.pub, getTransactionReceipt: vi.fn(async ({ hash: transactionHash }: { hash: string }) => ({ transactionHash, blockNumber: 9n, blockHash: hash(9),
      status: 'success', from: keeper, to: f.b.receiver })) };
    const income = await readIncome(pub as unknown as PublicClient, [f.b], keeper, time + 172800n, 0n, [s]);
    expect(income.boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    expect(income.startReceipts).toEqual([]);
    expect(pub.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it.each(['reverted', 'wrong sender', 'wrong target', 'wrong transaction', 'wrong receipt hash', 'wrong beneficiary', 'unfinalized', 'orphaned', 'unreadable'] as const)(
    'does not release a start with %s proof', async mode => {
      const f = fixture();
      const s = { box: f.b.receiver, at: time - 24n, costWei: 7n, hash: hash(91), start: { job: 'collect' as const } };
      if (mode === 'wrong transaction') f.logs[2] = { ...f.logs[2], transactionHash: hash(777) };
      if (mode === 'wrong beneficiary') f.logs[2] = { ...f.logs[2], args: { tipTo: addr(77), tip: 7n } };
      const pub = { ...f.pub, getTransactionReceipt: async ({ hash: transactionHash }: { hash: string }) => {
        if (mode === 'unreadable') throw new Error('unreadable');
        return { transactionHash: mode === 'wrong receipt hash' ? hash(777) : transactionHash, blockNumber: mode === 'unfinalized' ? 11n : 9n, blockHash: mode === 'orphaned' ? hash(88) : hash(9),
          status: mode === 'reverted' ? 'reverted' : 'success', from: mode === 'wrong sender' ? addr(77) : keeper,
          to: mode === 'wrong target' ? addr(77) : f.b.receiver };
      } };
      const income = await readIncome(pub as unknown as PublicClient, [f.b], keeper, time, 0n, [s]);
      expect(income.startReceipts?.find(r => r.hash === s.hash)?.startTipWei ?? 0n).toBe(0n);
    });
  it('does not reopen final settlement when a later proof becomes unreadable', async () => {
    const f = fixture();
    const { IncomeCache } = await import('../src/income-read');
    const { reconcileStarts, startUnpaid } = await import('../src/income');
    const cache = new IncomeCache();
    const s = { box: f.b.receiver, at: time - 24n, costWei: 7n, hash: hash(91), start: { job: 'collect' as const } };
    const pub = { ...f.pub, getTransactionReceipt: async ({ hash: transactionHash }: { hash: string }) => ({ transactionHash, blockNumber: 9n, blockHash: hash(9),
      status: 'success', from: keeper, to: f.b.receiver }) };
    const read = () => readIncome(pub as unknown as PublicClient, [f.b], keeper, time, 0n, [s], cache);
    const settled = reconcileStarts([s], await read());
    expect(startUnpaid(f.b.receiver, settled)).toBe(false);
    const original = f.pub.getBlock.getMockImplementation();
    if (!original) throw new Error('missing fixture headers');
    f.pub.getBlock.mockImplementation(async args => ({ ...await original(args), hash: args.blockNumber === 9n ? hash(88) : hash(10) }));
    expect(startUnpaid(f.b.receiver, reconcileStarts(settled, await read()))).toBe(false);
  });
});
