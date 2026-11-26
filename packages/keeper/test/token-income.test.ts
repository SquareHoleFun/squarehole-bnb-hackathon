import { afterEach, describe, expect, it, vi } from 'vitest';
import { shLimit } from '../../../vitest.timeouts.mjs';
import { encodeFunctionData, keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { receiverV2Abi } from '../src/abi';
import { IncomeCache, readIncome, ZeroedIncomeLog, type ReceiptLog, type ZeroedTokenIncome } from '../src/income-read';
import { INCOME_CACHE_LOGS, INCOME_CACHE_PAGES } from '../src/income-cache';
import { incomeRefusal } from '../src/income';
import { openBudget } from '../src/decide';
import { readIncomePrice } from '../src/income-price';
import { runTick } from '../src/run';
import type { BoxState } from '../src/world';
import { addr, box, keeper, options, quiet, time, v2, world } from './support/v2';
import { receiptLogs } from './support/income-receipts';

// Only tests replace the committed manifest; production has no route injection.
const reviewed = vi.hoisted(() => ({ entries: {} as Record<string, {
  chainId: string; registry: Address; listingId: string; p: Address; weth: Address;
  factory: Address; routeId: string; routeVersion: string;
  pools: Address[]; path: Address[]; fees: string[];
}> }));
vi.mock('../../burn-bot/src/listing-route-manifest', () => ({
  get listingRouteManifest() { return reviewed.entries; },
}));
// F164 D3: the committed ETH parity pins, unless a test replaces them (never in production).
const parity = vi.hoisted(() => ({ entries: undefined as Record<string, unknown> | undefined }));
vi.mock('../src/income-parity-manifest', async importOriginal => {
  const real = await importOriginal<typeof import('../src/income-parity-manifest')>();
  return { ...real, get ethParityManifest() { return parity.entries ?? real.ethParityManifest; } };
});

const hash = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as const;
const Q128 = 1n << 128n;
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing test fixture value');
  return value;
}
const zero = addr(0), registry = addr(50), safe = addr(51), pm = addr(52), weth = addr(100), factory = addr(200);
/** The Sepolia alpha's tETH in the reviewed deployment record (packages/chain/src/trade-sepolia/coin-deployment.json). */
const TETH: Address = '0x7156c3e4DD23F5776c26b3F6140BC03fFb7c4D5E';
/** Runtime code stand-ins: tETH's, and another 18-decimal coin's (tLINK, which runTestCoins deploys first). */
const TETH_CODE: Hex = '0x6080604052348015600f57600080fd5b5060aa';
const TLINK_CODE: Hex = '0x6080604052348015600f57600080fd5b5060bb';
const sepoliaPin = (codeHash: Hex | null) => ({ [`11155111:${TETH.toLowerCase()}`]: { chainId: '11155111', token: TETH, decimals: '18', codeHash, weiPerCoin: '1000000000000000000' } });
type Log = ReceiptLog & { eventName: string };
type Pool = { token0: Address; token1: Address; tick: bigint; historicalTick?: bigint;
  spot: bigint; liquidity: bigint; averageLiquidity: bigint; age: bigint; missingHistory?: boolean };
type Read = { address: Address; functionName: string; args?: readonly unknown[]; blockNumber: bigint };
type Topics = Readonly<Record<string, unknown>>;
type LogQuery = { address: Address | readonly Address[]; event?: { name: string }; events?: readonly { name: string }[];
  args?: Topics; fromBlock: bigint; toBlock: bigint };
/** An RPC's indexed-topic filter: each named argument equals the value, or one value of a list (addresses in any case). */
const filtered = (l: Log, args?: Topics) => !args || Object.entries(args).every(([name, want]) => want === undefined
  || want === null || (Array.isArray(want) ? want : [want]).some(w => typeof w === 'string' && typeof l.args[name] === 'string'
    ? w.toLowerCase() === (l.args[name] as string).toLowerCase() : w === l.args[name]));

/** `final` is the finalized block, `spacing` the seconds between blocks; receipts sit in the block before `final`. */
function fixture(kind: 'stock' | 'usdc' | 'teth' = 'stock', { coin = TETH, decimals: coinDecimals = 18, final = 100n, spacing = 12n, code = TETH_CODE }:
  { coin?: Address; decimals?: number; final?: bigint; spacing?: bigint; code?: Hex | null } = {}) {
  const at = final - 1n;
  const q = kind === 'stock' ? addr(80) : kind === 'usdc' ? addr(70) : coin;
  const b = box({ qPerEthX18: null, v2: { ...v2, q, qDecimals: kind === 'stock' ? 18 : kind === 'usdc' ? 6 : coinDecimals, depthBudget: 0n } });
  const pools: Record<string, Pool> = {
    [addr(201)]: { token0: q, token1: kind === 'stock' ? addr(90) : weth,
      tick: kind === 'stock' ? -23027n : 200000n, spot: 0n, liquidity: 10n ** 28n, averageLiquidity: 10n ** 28n, age: 12n },
    [addr(202)]: { token0: addr(90), token1: weth, tick: 0n, spot: 0n,
      liquidity: 10n ** 28n, averageLiquidity: 10n ** 28n, age: 12n },
  };
  const route = kind === 'stock' ? [addr(201), addr(202)] : [addr(201)];
  const entry = { chainId: '11155111', registry, listingId: '7', p: q, weth, factory,
    routeId: 'p-eth', routeVersion: '1', pools: route,
    path: kind === 'stock' ? [q, addr(90), weth] : [q, weth], fees: route.map(() => '3000') };
  // The committed listing-route manifest is empty: no Sepolia test coin has a route (F164 D3).
  reviewed.entries = kind === 'teth' ? {} : { [`11155111:${registry}:7:${q}`]: entry };
  const amount = kind === 'usdc' ? 1_000_000_000n : 10n ** 18n;
  const logs: Log[] = [];
  const noise: { address: Address; count: number; row: (i: number) => Log }[] = [];
  // Each registered receiver answers its wiring at finality: its price coin, the Safe and the PoolManager.
  const wiring = new Map<string, Address>([[b.receiver, q]]);
  const coordinators = new Set<string>([b.coordinator]);
  function addBox(over: Partial<BoxState>, p: Address = q) {
    const x = box({ qPerEthX18: p === zero ? 10n ** 18n : null, v2: { ...v2, q: p }, ...over });
    wiring.set(x.receiver, p);
    coordinators.add(x.coordinator);
    return x;
  }
  /** An ETH box beside the token box; its share needs the Safe's SafeReceived, as income-read.test.ts pins. */
  const ethBox = () => addBox({ id: 900n, receiver: addr(31), coordinator: addr(32), hook: addr(33) }, zero);
  function ethReceipt(x: BoxState, name: 'PlatformPaid' | 'Collected' | 'PotFixed' | 'FeesSold', value: bigint, tx: bigint) {
    const base = { blockNumber: at, blockHash: hash(at), transactionHash: hash(tx), removed: false };
    if (name === 'PlatformPaid') {
      logs.push({ ...base, address: safe, eventName: 'SafeReceived', logIndex: 0, args: { sender: pm, value } },
        { ...base, address: x.receiver, eventName: 'PlatformPaid', logIndex: 1, args: { safe, amount: value } });
    } else {
      logs.push({ ...base, address: name === 'PotFixed' ? x.coordinator : name === 'FeesSold' ? x.hook : x.receiver,
        eventName: name, logIndex: 0, args: { tipTo: keeper, closer: keeper, caller: keeper, tip: value } });
    }
  }
  /**
   * F164 D1: a busy coin. P transfers and PoolManager claim events in the window that are none of this box's payouts:
   * ordinary transfers, the PoolManager paying traders, deposits to the Safe or the keeper from others, claim mints,
   * other owners' burns and claim transfers of P, and this box burning another claim id.
   */
  function busy(transfers: number, claims = transfers) {
    const traders = Array.from({ length: 8 }, (_, i) => addr(5000 + i));
    const txs = Array.from({ length: 64 }, (_, i) => hash(5000n + BigInt(i)));
    const next = (i: number) => present(traders[(i + 1) % traders.length]);
    const rows = (address: Address, shapes: readonly Record<string, unknown>[]) => (i: number): Log => {
      const block = at - BigInt(i % 99);
      return { address, eventName: 'Transfer', blockNumber: block, blockHash: hash(block), removed: false,
        transactionHash: present(txs[i % txs.length]), logIndex: 1000 + i, args: present(shapes[i % shapes.length]) };
    };
    noise.push({ address: q, count: transfers, row: rows(q, traders.flatMap((t, i) => [
      { from: t, to: next(i), value: 1n }, { from: pm, to: t, value: 1n }, { from: t, to: safe, value: 1n }, { from: t, to: keeper, value: 1n },
    ])) }, { address: pm, count: claims, row: rows(pm, traders.flatMap((t, i) => [
      { caller: t, from: zero, to: t, id: BigInt(q), amount: 1n }, { caller: t, from: t, to: zero, id: BigInt(q), amount: 1n },
      { caller: t, from: t, to: next(i), id: BigInt(q), amount: 1n },
      { caller: b.receiver, from: b.receiver, to: zero, id: BigInt(addr(90)), amount: 1n },
    ])) });
  }
  /** Other boxes' payouts in this coin to this keeper: PoolManager transfers that pass the D1 filter. */
  function payouts(count: number) {
    noise.push({ address: q, count, row: i => ({ address: q, eventName: 'Transfer', blockNumber: at, blockHash: hash(at), removed: false,
      transactionHash: hash(7000n + BigInt(i)), logIndex: 0, args: { from: pm, to: keeper, value: 1n } }) });
  }
  function payment(name: string, value: bigint, tx: bigint, target = b.receiver, recipient = safe,
    parts: readonly bigint[] = [value]) {
    const base = { blockNumber: at, blockHash: hash(at), transactionHash: hash(tx), removed: false };
    let index = logs.reduce((next, l) => l.transactionHash === base.transactionHash ? Math.max(next, l.logIndex + 1) : next, 0);
    for (const part of parts) {
      logs.push(
        { ...base, address: pm, eventName: 'Transfer', logIndex: index++,
          args: { caller: target, from: target, to: zero, id: BigInt(q), amount: part } },
        { ...base, address: q, eventName: 'Transfer', logIndex: index++, args: { from: pm, to: recipient, value: part } },
      );
      if (name === 'Collected' && parts.length > 1) {
        logs.push({ ...base, address: target, eventName: 'HolderBatchFunded', logIndex: index++,
          args: { batchId: BigInt(index), netP: part * 19n } });
      }
    }
    const event: Log = { ...base, address: target, eventName: name, logIndex: index,
      args: name === 'PlatformPaid' ? { safe, amount: value } : { tipTo: recipient, closer: recipient, caller: recipient, tip: value, tipP: value } };
    logs.push(event);
    return event;
  }
  payment('PlatformPaid', amount, 900n);
  const pub = {
    getChainId: vi.fn(async () => 11155111),
    getBlock: vi.fn(async ({ blockNumber = final }: { blockNumber?: bigint }) => ({
      number: blockNumber, hash: hash(blockNumber), timestamp: time - (final - blockNumber) * spacing })),
    readContract: vi.fn(async (c: Read): Promise<unknown> => {
      const coinOf = wiring.get(c.address);
      if (coinOf !== undefined) {
        if (c.functionName === 'q') return coinOf;
        if (c.functionName === 'PLATFORM_SAFE') return safe;
        if (c.functionName === 'poolManager') return pm;
      }
      if (coordinators.has(c.address) && c.functionName === 'listingRegistry') return registry;
      if (c.address === q && c.functionName === 'decimals') return coinDecimals;
      if (c.address === registry) {
        if (c.functionName === 'weth') return weth;
        if (c.functionName === 'newestListingOf') return [true, 7];
        if (c.functionName === 'listing') return { id: 7, token: q, decimals: kind === 'stock' ? 18 : 6 };
      }
      if (c.address === factory && c.functionName === 'getPool') {
        const [token0, token1, fee] = c.args ?? [];
        return Object.entries(pools).find(([, p]) => p.token0 === token0 && p.token1 === token1 && fee === 3000)?.[0] ?? zero;
      }
      const p = pools[c.address];
      if (p) {
        if (c.functionName === 'token0') return p.token0;
        if (c.functionName === 'token1') return p.token1;
        if (c.functionName === 'fee') return 3000;
        if (c.functionName === 'liquidity') return p.liquidity;
        if (c.functionName === 'slot0') return [p.spot, 0, 1, 2, 2, 0, true];
        if (c.functionName === 'observations') return [time - (final - c.blockNumber) * spacing - p.age, 0n, 0n, true];
        if (c.functionName === 'observe') {
          if (p.missingHistory) throw new Error('OLD');
          const tick = c.blockNumber < final ? p.historicalTick ?? p.tick : p.tick;
          return [[0n, tick * 3600n], [0n, 3600n * Q128 / p.averageLiquidity]];
        }
      }
      throw new Error(`unsupported fake read ${c.functionName}`);
    }),
    // Applies the indexed topics like an RPC. viem drops `args` for a multi-event query, so a family is never filtered.
    getLogs: vi.fn(async ({ address, event, events, args, fromBlock, toBlock }: LogQuery) => {
      const targets: readonly Address[] = Array.isArray(address) ? address : [address];
      const names = (events ?? (event ? [event] : [])).map(e => e.name);
      const keep = (l: Log) => targets.includes(l.address) && names.includes(l.eventName)
        && l.blockNumber >= fromBlock && l.blockNumber <= toBlock && filtered(l, events ? undefined : args);
      const found = logs.filter(keep);
      for (const n of noise) if (targets.includes(n.address)) for (let i = 0; i < n.count; i++) {
        const l = n.row(i);
        if (keep(l)) found.push(l);
      }
      return found;
    }),
    getTransaction: vi.fn(async () => ({ to: b.receiver,
      input: encodeFunctionData({ abi: receiverV2Abi, functionName: 'buyBack', args: [keeper] }) })),
    // SH-247: a receipt holds its transaction's own logs; every payment proof is read from it.
    getTransactionReceipt: vi.fn(async ({ hash: tx }: { hash: Hex }) => ({ transactionHash: tx, status: 'success',
      blockNumber: at, blockHash: hash(at), logs: receiptLogs(logs.filter(l => l.transactionHash === tx)) })),
    // The price coin's runtime code (null: none), read only for a parity pin (F164 D3).
    getBytecode: vi.fn(async ({ address }: { address: Address; blockNumber?: bigint }) => address === q ? code ?? undefined : undefined),
  };
  const read = () => readIncome(pub as unknown as PublicClient, [b], keeper, time, 0n, []);
  return { q, b, amount, pools, route, entry, logs, payment, pub, read, busy, payouts, addBox, ethBox, ethReceipt };
}

describe('SH-MN-07 received token income', () => {
  it.each(['stock', 'usdc'] as const)('values %s receipts from the listing route and full pool history', async kind => {
    const f = fixture(kind), income = await f.read(), credit = present(income.boxes[f.b.receiver]);
    expect(credit.shareWei).toBeGreaterThan(kind === 'stock' ? 99_000_000_000_000_000n : 480_000_000_000_000_000n);
    expect(credit.shareWei).toBeLessThan(kind === 'stock' ? 100_000_000_000_000_000n : 485_000_000_000_000_000n);
    expect(income.platformWei).toBe(credit.shareWei);
    expect(credit.tipsWei).toBe(0n);
    expect(f.pub.readContract.mock.calls.some(([c]) => c.functionName === 'fitRoute')).toBe(false);
    expect(f.pub.readContract.mock.calls.filter(([c]) => c.functionName === 'getPool')).toHaveLength(f.route.length * 2);
    expect(f.pub.readContract.mock.calls.filter(([c]) => c.functionName === 'observe').every(([c]) =>
      JSON.stringify(c.args) === '[[3600,0]]')).toBe(true);
    expect(f.pub.readContract.mock.calls.every(([c]) => c.blockNumber === 99n || c.blockNumber === 100n)).toBe(true);
  });

  it.each([1, 2, 3, 4])('admits only one to three connected hops (hops=%s)', async count => {
    const f = fixture();
    f.route.splice(0); f.entry.path.splice(0, f.entry.path.length, f.q); f.entry.fees.splice(0);
    for (let i = 0; i < count; i++) {
      const token0 = present(f.entry.path.at(-1)), token1 = i === count - 1 ? weth : addr(85 + i);
      const pool = addr(210 + i);
      f.route.push(pool); f.entry.path.push(token1); f.entry.fees.push('3000');
      f.pools[pool] = { ...present(f.pools[addr(201)]), token0, token1, tick: 0n };
    }
    const income = await f.read();
    if (count <= 3) expect(income.platformWei).toBeGreaterThan(0n);
    else expect(income.boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
  });

  it('does not use another P entry under the same listing id', async () => {
    const f = fixture();
    reviewed.entries = { [`11155111:${registry}:7:${addr(77)}`]: { ...f.entry, p: addr(77) } };
    expect((await f.read()).boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
  });

  it('ignores a manipulated spot price; later appreciation cannot inflate old receipts', async () => {
    const f = fixture(), before = await f.read();
    present(f.pools[addr(201)]).spot = (1n << 160n) - 1n;
    expect(await f.read()).toEqual(before);
    present(f.pools[addr(201)]).historicalTick = -23027n;
    present(f.pools[addr(201)]).tick = 0n;
    expect(await f.read()).toEqual(before);
    present(f.pools[addr(201)]).tick = -46054n;
    expect((await f.read()).platformWei).toBeLessThan(before.platformWei);
  });

  it.each(['stale', 'thin now', 'thin window', 'missing history', 'wrong endpoint', 'cycle', 'too long', 'missing manifest entry', 'different P', 'not factory pool', 'disconnected', 'wrong listing'])(
    'gives the entire box zero income for %s', async failure => {
      const f = fixture();
      f.payment('Collected', f.amount / 10n, 901n, f.b.receiver, keeper);
      if (failure === 'stale') present(f.pools[addr(201)]).age = 1801n;
      if (failure === 'thin now') present(f.pools[addr(201)]).liquidity = 1n;
      if (failure === 'thin window') present(f.pools[addr(201)]).averageLiquidity = 1n;
      if (failure === 'missing history') present(f.pools[addr(201)]).missingHistory = true;
      if (failure === 'wrong endpoint') f.route.pop();
      if (failure === 'cycle') f.route.push(addr(201));
      if (failure === 'too long') f.route.push(addr(201), addr(202));
      if (failure === 'missing manifest entry') reviewed.entries = {};
      if (failure === 'different P') f.entry.p = addr(77);
      if (failure === 'disconnected') present(f.pools[addr(202)]).token0 = addr(91);
      if (failure === 'not factory pool' || failure === 'wrong listing') {
        const original = present(f.pub.readContract.getMockImplementation());
        f.pub.readContract.mockImplementation(async c => {
          if (failure === 'not factory pool' && c.functionName === 'getPool') return addr(255);
          if (failure === 'wrong listing' && c.functionName === 'listing') return { id: 7, token: addr(77) };
          return original(c);
        });
      }
      expect((await f.read()).boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    });

  it('fails closed on stale finality and historical factory mismatches', async () => {
    const f = fixture();
    const original = present(f.pub.getBlock.getMockImplementation());
    f.pub.getBlock.mockImplementation(async c => ({ ...await original(c), timestamp: time - 1801n }));
    expect((await f.read()).platformWei).toBe(0n);
    f.pub.getBlock.mockImplementation(original);
    const read = present(f.pub.readContract.getMockImplementation());
    f.pub.readContract.mockImplementation(async c => c.functionName === 'getPool' && c.blockNumber === 99n ? addr(255) : read(c));
    expect((await f.read()).platformWei).toBe(0n);
  });

  it.each(['wrong token', 'wrong sender', 'wrong recipient', 'short transfer', 'unrelated claim', 'removed', 'orphaned', 'unfinalized'])(
    'never values %s payment evidence', async failure => {
      const f = fixture();
      if (failure === 'wrong token') f.logs[1] = { ...present(f.logs[1]), address: addr(77) };
      if (failure === 'wrong sender') present(f.logs[1]).args.from = addr(77);
      if (failure === 'wrong recipient') present(f.logs[1]).args.to = keeper;
      if (failure === 'short transfer') present(f.logs[1]).args.value = f.amount - 1n;
      if (failure === 'unrelated claim') present(f.logs[0]).args.caller = addr(77);
      if (failure === 'removed') f.logs[1] = { ...present(f.logs[1]), removed: true };
      if (failure === 'orphaned') f.logs[1] = { ...present(f.logs[1]), blockHash: hash(77n) };
      if (failure === 'unfinalized') f.logs[1] = { ...present(f.logs[1]), blockNumber: 101n };
      expect((await f.read()).platformWei).toBe(0n);
    });

  it('values actual keeper tips once and does not let another box spend them', async () => {
    const f = fixture();
    f.payment('Collected', f.amount / 10n, 901n, f.b.receiver, keeper);
    f.payment('PotFixed', f.amount / 10n, 902n, f.b.coordinator, keeper);
    f.payment('RewardsBought', f.amount / 10n, 903n, f.b.receiver, keeper);
    f.payment('BoughtBack', f.amount / 10n, 904n, f.b.receiver, keeper);
    f.logs.push(...f.logs.map(l => ({ ...l })));
    const income = await f.read(), credit = present(income.boxes[f.b.receiver]);
    expect(credit.tipsWei).toBeGreaterThan(39_000_000_000_000_000n);
    expect(credit.tipsWei).toBeLessThan(40_000_000_000_000_000n);
    const platformRoom = income.platformWei / 4n + credit.tipsWei;
    expect(incomeRefusal(f.b.receiver, platformRoom, [], income)).toBeNull();
    expect(incomeRefusal(f.b.receiver, platformRoom + 1n, [], income)).toBe('platform income cap');
    expect(incomeRefusal(addr(77), 1n, [], income)).toBe('box income cap');
    const funded = { ...income, platformWei: income.platformWei * 10n };
    expect(incomeRefusal(f.b.receiver, credit.shareWei + credit.tipsWei, [], funded)).toBeNull();
    expect(incomeRefusal(f.b.receiver, credit.shareWei + credit.tipsWei + 1n, [], funded)).toBe('box income cap');
  });

  it.each(['stock', 'usdc'] as const)('credits the sum of two successful %s source tips in both F111 allowances', async kind => {
    const f = fixture(kind), first = f.amount / 100n, second = f.amount / 200n;
    const reference = fixture(kind);
    reference.payment('Collected', first + second, 930n, reference.b.receiver, keeper);
    const expected = present((await reference.read()).boxes[reference.b.receiver]).tipsWei;
    expect(expected).toBeGreaterThan(0n);
    f.payment('Collected', first + second, 930n, f.b.receiver, keeper, [first, second]);
    const income = await f.read(), credit = present(income.boxes[f.b.receiver]);
    expect(credit.tipsWei).toBe(expected);
    const platformRoom = credit.shareWei / 4n + expected;
    expect(incomeRefusal(f.b.receiver, platformRoom, [], income)).toBeNull();
    expect(incomeRefusal(f.b.receiver, platformRoom + 1n, [], income)).toBe('platform income cap');
    const funded = { ...income, platformWei: credit.shareWei * 10n };
    expect(incomeRefusal(f.b.receiver, credit.shareWei + expected, [], funded)).toBeNull();
    expect(incomeRefusal(f.b.receiver, credit.shareWei + expected + 1n, [], funded)).toBe('box income cap');
    expect(incomeRefusal(addr(77), 1n, [], funded)).toBe('box income cap');
  });

  it('credits only the successful source when another source tip is refused', async () => {
    const f = fixture(), paid = f.amount / 100n, refused = f.amount / 200n;
    // A reverted isolated unlock leaves neither burn nor transfer in the receipt.
    const event = f.payment('Collected', paid, 930n, f.b.receiver, keeper, [paid]);
    expect(present((await f.read()).boxes[f.b.receiver]).tipsWei).toBeGreaterThan(0n);
    event.args.tip = paid + refused;
    expect(present((await f.read()).boxes[f.b.receiver]).tipsWei).toBe(0n);
    event.args.tip = 0n;
    expect(present((await f.read()).boxes[f.b.receiver]).tipsWei).toBe(0n);
  });

  it('counts repeated collections in one transaction once, without reusing their proofs', async () => {
    const f = fixture(), first = f.amount / 100n, second = f.amount / 200n;
    const reference = fixture();
    reference.payment('Collected', first + second, 930n, reference.b.receiver, keeper);
    const expected = present((await reference.read()).boxes[reference.b.receiver]).tipsWei;
    f.payment('Collected', first + second, 930n, f.b.receiver, keeper, [first, second]);
    f.payment('Collected', first + second, 930n, f.b.receiver, keeper, []);
    f.payment('Collected', first + second, 930n, f.b.receiver, keeper, [second, first]);
    f.logs.push(...f.logs.map(l => ({ ...l })));
    // RPC order must not change event boundaries or proof consumption.
    f.logs.reverse();
    expect(present((await f.read()).boxes[f.b.receiver]).tipsWei).toBe(expected * 2n);
  });

  it.each(['Collected', 'BoughtBack', 'RewardsBought', 'CreatorClaimed', 'FitPaid', 'PlatformPaid'])(
    'does not borrow uncredited proofs from an earlier %s event', async name => {
      const f = fixture(), paid = f.amount / 100n;
      f.payment(name, 0n, 930n, f.b.receiver, keeper, [paid]);
      f.payment('Collected', paid, 930n, f.b.receiver, keeper, []);
      expect(present((await f.read()).boxes[f.b.receiver]).tipsWei).toBe(0n);
    });

  it.each(['short total', 'extra total', 'wrong recipient', 'wrong owner', 'wrong transaction', 'later proof', 'oversized part'])(
    'refuses a collection with %s', async failure => {
      const f = fixture(), first = f.amount / 100n, second = f.amount / 200n;
      const event = f.payment('Collected', first + second, 930n, f.b.receiver, keeper, [first, second]);
      const burn = present(f.logs.find(l => l.transactionHash === event.transactionHash && l.logIndex === 0));
      const transfer = present(f.logs.find(l => l.transactionHash === event.transactionHash && l.logIndex === 1));
      if (failure === 'short total') event.args.tip = first;
      if (failure === 'extra total') event.args.tip = first + second + 1n;
      if (failure === 'wrong recipient') transfer.args.to = safe;
      if (failure === 'wrong owner') burn.args.from = addr(77);
      if (failure === 'wrong transaction') f.logs[f.logs.indexOf(burn)] = { ...burn, transactionHash: hash(931n) };
      if (failure === 'later proof') f.logs[f.logs.indexOf(event)] = { ...event, logIndex: -1 };
      if (failure === 'oversized part') {
        const oversized = 1n << 127n;
        burn.args.amount = oversized; transfer.args.value = oversized;
        event.args.tip = oversized + second;
      }
      expect(present((await f.read()).boxes[f.b.receiver]).tipsWei).toBe(0n);
    });

  it.each([false, true])('retains int128 chunk validation for platform payouts (valid=%s)', async valid => {
    const f = fixture(), maxPart = (1n << 127n) - 1n;
    // Enough raw-P depth for a multi-int128 payment without weakening the production oracle.
    f.route.splice(1); f.entry.path.splice(1, 2, weth); f.entry.fees.splice(1);
    const pool = present(f.pools[addr(201)]);
    pool.token1 = weth; pool.tick = -200000n;
    pool.liquidity = (1n << 128n) - 1n; pool.averageLiquidity = pool.liquidity;
    f.logs.splice(0);
    const amount = maxPart + 100n;
    f.payment('PlatformPaid', amount, 930n, f.b.receiver, safe,
      valid ? [maxPart, 100n] : [maxPart - 1n, 101n]);
    const income = await f.read();
    if (valid) expect(income.platformWei).toBeGreaterThan(0n);
    else expect(income.platformWei).toBe(0n);
  });

  it('sums source tips even when one source needs multiple int128 redemptions', async () => {
    const f = fixture(), maxPart = (1n << 127n) - 1n;
    f.route.splice(1); f.entry.path.splice(1, 2, weth); f.entry.fees.splice(1);
    const pool = present(f.pools[addr(201)]);
    pool.token1 = weth; pool.tick = -200000n;
    pool.liquidity = (1n << 128n) - 1n; pool.averageLiquidity = pool.liquidity;
    f.logs.splice(0);
    f.payment('Collected', maxPart + 40n, 930n, f.b.receiver, keeper, [maxPart, 17n, 23n]);
    expect(present((await f.read()).boxes[f.b.receiver]).tipsWei).toBeGreaterThan(0n);
  });

  it('token-funded work passes the real admission path; hard daily caps and 3 gwei still win', async () => {
    const f = fixture(), send = vi.fn(async () => hash(800n));
    const port = { read: async () => world(f.b), readIncome: f.read,
      simulate: async (c: { job: string }) => ({ ok: c.job === 'buyBack', estimate: 100_000n, tipWei: null }), send };
    const cfg = { ...options(), dryRun: false, priorityFeeWei: 1n };
    expect((await runTick(port, {}, cfg, quiet)).report.sent.map(s => s.job)).toEqual(['buyBack']);
    for (const budget of [
      { ...openBudget(undefined, 100n, time), totalWei: cfg.limits.totalWeiPerDay },
      { ...openBudget(undefined, 100n, time), oursWei: cfg.limits.oursWeiPerDay - cfg.limits.reserveWeiPerDay },
    ]) {
      const out = await runTick(port, { budget, incomeSpend: [] }, cfg, quiet);
      expect(out.report.sent).toEqual([]);
      expect(out.report.skipped.some(s => s.why === 'daily ceiling reached' || s.why === 'ours budget spent')).toBe(true);
    }
    port.read = async () => ({ ...world(f.b), block: { number: 100n, timestamp: time, baseFeePerGas: 1_500_000_000n } });
    expect((await runTick(port, {}, cfg, quiet)).report.sent).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('rounds fractional average ticks against the input direction (inverse=%s)', async inverse => {
    const f = fixture();
    if (inverse) {
      f.entry.path[1] = addr(60);
      present(f.pools[addr(201)]).token0 = addr(60); present(f.pools[addr(201)]).token1 = f.q;
      present(f.pools[addr(201)]).tick = 23027n; present(f.pools[addr(202)]).token0 = addr(60);
    }
    const read = present(f.pub.readContract.getMockImplementation());
    f.pub.readContract.mockImplementation(async c => {
      const value = await read(c);
      if (c.functionName === 'observe' && c.address === addr(201)) {
        const [ticks, liquidity] = value as [bigint[], bigint[]];
        return [[ticks[0], present(ticks[1]) + (inverse ? 1n : -1n)], liquidity];
      }
      return value;
    });
    const price = await readIncomePrice(f.pub as unknown as PublicClient, f.b.coordinator, f.q, { number: 100n, timestamp: time }, time);
    // Independent exact rational oracle, no floating point or shared TickMath implementation.
    const expected = (f.amount * 997n / 1000n * 10000n ** 23028n / 10001n ** 23028n) * 997n / 1000n;
    expect(price.quote(f.amount)).toBeLessThanOrEqual(expected);
    expect(expected - price.quote(f.amount)).toBeLessThan(10n);
  });

  it('handles the pool cumulative integer wraps without changing value', async () => {
    const f = fixture(), before = await f.read(), read = present(f.pub.readContract.getMockImplementation());
    f.pub.readContract.mockImplementation(async c => {
      const value = await read(c);
      if (c.functionName !== 'observe') return value;
      const [ticks, liquidity] = value as [[bigint, bigint], [bigint, bigint]];
      const startTick = -(1n << 55n) + 1n, startLiquidity = (1n << 160n) - 1n;
      return [[startTick, BigInt.asIntN(56, startTick + ticks[1])],
        [startLiquidity, BigInt.asUintN(160, startLiquidity + liquidity[1])]];
    });
    expect(await f.read()).toEqual(before);
  });

  it('caps aggregate income at one percent of route depth, including split receipts', async () => {
    const f = fixture();
    // First pool input virtual reserve is about 316 P, so one 2 P receipt fits.
    present(f.pools[addr(201)]).liquidity = 10n ** 20n;
    f.logs.splice(0);
    f.payment('PlatformPaid', f.amount * 2n, 910n);
    expect((await f.read()).platformWei).toBeGreaterThan(0n);
    f.payment('PlatformPaid', f.amount * 2n, 911n);
    expect((await f.read()).boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
  });

  it('expires receipts at exactly 24 hours and preserves unknown spend across midnight', async () => {
    const f = fixture(), before = await f.read(), original = present(f.pub.getBlock.getMockImplementation());
    const room = before.platformWei / 4n;
    expect(incomeRefusal(f.b.receiver, 1n, [{ box: f.b.receiver, at: time - 86401n, costWei: room }], before)).toBe('platform income cap');
    f.pub.getBlock.mockImplementation(async c => ({ ...await original(c), timestamp: c.blockNumber !== undefined && c.blockNumber < 100n ? time - 86400n : time }));
    expect((await f.read()).platformWei).toBe(0n);
  });

  it('does not suppress a native box when a token route is unreadable, or reuse its deposits', async () => {
    const f = fixture(), native = box({ receiver: addr(31), coordinator: addr(32), hook: addr(33) });
    present(f.pools[addr(201)]).missingHistory = true;
    const read = present(f.pub.readContract.getMockImplementation());
    f.pub.readContract.mockImplementation(async c => {
      if (c.address === native.receiver) {
        if (c.functionName === 'q') return zero;
        if (c.functionName === 'PLATFORM_SAFE') return safe;
        if (c.functionName === 'poolManager') return pm;
      }
      return read(c);
    });
    const base = { blockNumber: 99n, blockHash: hash(99n), transactionHash: hash(920n), removed: false };
    f.logs.push({ ...base, address: safe, eventName: 'SafeReceived', logIndex: 0, args: { sender: pm, value: 200n } },
      { ...base, address: native.receiver, eventName: 'PlatformPaid', logIndex: 1, args: { safe, amount: 200n } });
    const income = await readIncome(f.pub as unknown as PublicClient, [f.b, native], keeper, time, 0n, []);
    expect(income.platformWei).toBe(200n);
    expect(income.boxes[native.receiver]?.shareWei).toBe(200n);
    expect(income.boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
  });
});

describe('F164 D1: receipt logs filtered by sender and recipient', () => {
  it('keeps a pinned USDC box\'s credit with 1,000,000 unrelated transfers and 1,000,000 claim events in the window', async () => {
    const reference = fixture('usdc');
    reference.payment('Collected', reference.amount / 10n, 901n, reference.b.receiver, keeper);
    const expected = present((await reference.read()).boxes[reference.b.receiver]);
    expect(expected.shareWei).toBeGreaterThan(0n);
    expect(expected.tipsWei).toBeGreaterThan(0n);
    const f = fixture('usdc');
    f.payment('Collected', f.amount / 10n, 901n, f.b.receiver, keeper);
    f.busy(1_000_000);
    const income = await f.read();
    expect(income.boxes[f.b.receiver]).toEqual(expected);
    expect(income.platformWei).toBe(expected.shareWei);
  }, shLimit(120_000));

  it.each(['deposit', 'burn'] as const)('credits nothing for a Safe %s that is not this box\'s own payout', async kind => {
    const f = fixture('usdc');
    f.logs.splice(0);
    const other = f.addBox({ id: 1n, coordinator: addr(41), hook: addr(42), receiver: addr(43) });
    if (kind === 'deposit') {
      // The receiver burns its claim and reports the payment, but the coin reaching the Safe is a deposit by someone else.
      f.payment('PlatformPaid', f.amount, 930n);
      present(f.logs.find(l => l.address === f.q)).args.from = addr(77);
    } else {
      // Another box's claim burn and payout to the same Safe; this box then reports a payment in the same transaction.
      const paid = f.payment('PlatformPaid', f.amount, 930n, other.receiver);
      f.logs.push({ ...paid, address: f.b.receiver, logIndex: paid.logIndex + 1 });
    }
    const income = await readIncome(f.pub as unknown as PublicClient, [f.b, other], keeper, time, 0n, []);
    expect(income.boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    if (kind === 'burn') expect(present(income.boxes[other.receiver]).shareWei).toBeGreaterThan(0n);
    else expect(income.boxes[other.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    expect(income.platformWei).toBe(present(income.boxes[other.receiver]).shareWei);
  });

  it('never reuses a cached page for one recipient set for another', async () => {
    const f = fixture('usdc'), other = addr(98);
    f.payment('Collected', f.amount / 10n, 901n, f.b.receiver, keeper);
    f.payment('Collected', f.amount / 20n, 902n, f.b.receiver, other);
    const fresh = (k: Address) => readIncome(f.pub as unknown as PublicClient, [f.b], k, time, 0n, []);
    const mine = await fresh(keeper), theirs = await fresh(other);
    expect(present(mine.boxes[f.b.receiver]).tipsWei).toBeGreaterThan(present(theirs.boxes[f.b.receiver]).tipsWei);
    expect(present(theirs.boxes[f.b.receiver]).tipsWei).toBeGreaterThan(0n);
    const cache = new IncomeCache();
    const read = (k: Address) => readIncome(f.pub as unknown as PublicClient, [f.b], k, time, 0n, [], cache);
    expect(await read(keeper)).toEqual(mine);
    f.pub.getLogs.mockClear();
    expect(await read(other)).toEqual(theirs);
    // SH-247 (SH-190): no coin transfer is range-read for either recipient set; each receipt's authenticated payments
    // are matched afresh against this reader's recipients, so a cached projection never answers for another.
    expect(f.pub.getLogs.mock.calls.some(([c]) => c.address === f.q || c.address === pm)).toBe(false);
    expect(cache.pages.some(p => p.key.startsWith(`${f.q.toLowerCase()}:`))).toBe(false);
    f.pub.getLogs.mockClear();
    expect(await read(keeper)).toEqual(mine);
    expect(f.pub.getLogs).not.toHaveBeenCalled();
  });

  it.each([INCOME_CACHE_LOGS - 1, 1_000_000])(
    'keeps an ETH box\'s income when a busy token box (%i unrelated transfers) is read first', async count => {
      const f = fixture('usdc'), eth = f.ethBox();
      f.ethReceipt(eth, 'PlatformPaid', 200n, 920n);
      const token = present((await f.read()).boxes[f.b.receiver]);
      expect(token.shareWei).toBeGreaterThan(0n);
      f.busy(count, 0);
      const income = await readIncome(f.pub as unknown as PublicClient, [f.b, eth], keeper, time, 0n, []);
      expect(income.boxes[eth.receiver]).toEqual({ shareWei: 200n, tipsWei: 0n });
      expect(income.boxes[f.b.receiver]).toEqual(token);
      expect(income.platformWei).toBe(200n + token.shareWei);
    }, shLimit(120_000));

  // SH-247: these two pinned the old shared bounds (open claim-burn pages per token box; other boxes' payouts in the
  // coin filling the tick's rows), which zeroed the last token boxes. Proofs now come from each box's own receipts.
  it('keeps every box\'s income with 33 token boxes and an ETH box over a 15-page window', async () => {
    const f = fixture('usdc', { final: 28_900n, spacing: 3n }), eth = f.ethBox();
    f.ethReceipt(eth, 'PlatformPaid', 200n, 920n);
    const tokens = Array.from({ length: 33 }, (_, i) => f.addBox({ id: BigInt(i + 1),
      coordinator: addr(0x100000 + 3 * i), hook: addr(0x100001 + 3 * i), receiver: addr(0x100002 + 3 * i) }));
    const zeroed: ZeroedTokenIncome[] = [];
    const income = await readIncome(f.pub as unknown as PublicClient, [f.b, ...tokens, eth], keeper, time, 0n, [], undefined,
      z => zeroed.push(z));
    expect(income.boxes[eth.receiver]).toEqual({ shareWei: 200n, tipsWei: 0n });
    expect(present(income.boxes[f.b.receiver]).shareWei).toBeGreaterThan(0n);
    expect(income.platformWei).toBe(200n + present(income.boxes[f.b.receiver]).shareWei);
    // Three grouped families on each of 15 pages; one receipt per paying transaction.
    expect(f.pub.getLogs.mock.calls.length).toBe(45);
    expect(f.pub.getLogs.mock.calls.length).toBeLessThan(INCOME_CACHE_PAGES);
    expect(f.pub.getTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(zeroed).toEqual([]);
  }, shLimit(120_000));

  it('keeps a token box\'s income when other boxes\' real payouts in its coin fill a page', async () => {
    const f = fixture('usdc'), eth = f.ethBox();
    f.ethReceipt(eth, 'PlatformPaid', 200n, 920n);
    const alone = present((await f.read()).boxes[f.b.receiver]);
    f.payouts(INCOME_CACHE_LOGS - 1);
    const zeroed: ZeroedTokenIncome[] = [];
    const income = await readIncome(f.pub as unknown as PublicClient, [f.b, eth], keeper, time, 0n, [], undefined, z => zeroed.push(z));
    expect(income.boxes[eth.receiver]).toEqual({ shareWei: 200n, tipsWei: 0n });
    expect(income.boxes[f.b.receiver]).toEqual(alone);
    expect(income.platformWei).toBe(200n + alone.shareWei);
    expect(zeroed).toEqual([]);
  });
});

describe('F164 D3: tETH counts 1:1 like ETH for keeper room, on Sepolia only', () => {
  // The committed pin holds tETH's real runtime code hash (sh-177); most cases pin the fixture's stand-in tETH code.
  const pinned = () => { parity.entries = sepoliaPin(keccak256(TETH_CODE)); };
  afterEach(() => { parity.entries = undefined; });

  it('gives a tETH box on Sepolia the room an ETH box gets from the same receipts', async () => {
    pinned();
    const f = fixture('teth'), eth = f.ethBox();
    f.ethReceipt(eth, 'PlatformPaid', f.amount, 920n);
    const tips = [['Collected', f.amount / 4n], ['PotFixed', f.amount / 100n], ['FeesSold', f.amount / 50n]] as const;
    for (const [i, [name, value]] of tips.entries()) {
      f.payment(name, value, 940n + BigInt(i), name === 'PotFixed' ? f.b.coordinator : name === 'FeesSold' ? f.b.hook : f.b.receiver, keeper);
      f.ethReceipt(eth, name, value, 950n + BigInt(i));
    }
    // A busy tETH: its receipts come through the same filtered ERC-20 path as USDC's (D1).
    f.busy(100_000);
    const income = await readIncome(f.pub as unknown as PublicClient, [f.b, eth], keeper, time, 0n, []);
    const tipsWei = tips.reduce((sum, [, value]) => sum + value, 0n);
    expect(income.boxes[eth.receiver]).toEqual({ shareWei: f.amount, tipsWei });
    expect(income.boxes[f.b.receiver]).toEqual(income.boxes[eth.receiver]);
    expect(income.platformWei).toBe(2n * f.amount);
    const platformRoom = income.platformWei / 4n + 2n * tipsWei, funded = { ...income, platformWei: income.platformWei * 10n };
    for (const r of [f.b.receiver, eth.receiver]) {
      expect(incomeRefusal(r, platformRoom, [], income)).toBeNull();
      expect(incomeRefusal(r, platformRoom + 1n, [], income)).toBe('platform income cap');
      expect(incomeRefusal(r, f.amount + tipsWei, [], funded)).toBeNull();
      expect(incomeRefusal(r, f.amount + tipsWei + 1n, [], funded)).toBe('box income cap');
    }
  }, shLimit(120_000));

  it('counts nothing while the pin has no code hash (the committed pin until the deploy was recorded)', async () => {
    parity.entries = sepoliaPin(null);
    const f = fixture('teth'), zeroed: ZeroedTokenIncome[] = [];
    const income = await readIncome(f.pub as unknown as PublicClient, [f.b], keeper, time, 0n, [], undefined, z => zeroed.push(z));
    expect(income.boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    expect(zeroed).toEqual([{ boxId: f.b.id, receiver: f.b.receiver, code: 'PIN_INVALID' }]);
    expect(f.pub.getBytecode).not.toHaveBeenCalled();
    pinned();
    expect((await f.read()).boxes[f.b.receiver]).toEqual({ shareWei: f.amount, tipsWei: 0n });
  });

  it('counts with the committed pin only for tETH\'s recorded runtime code, not the fixture\'s stand-in code', async () => {
    const f = fixture('teth'), zeroed: ZeroedTokenIncome[] = [];
    const income = await readIncome(f.pub as unknown as PublicClient, [f.b], keeper, time, 0n, [], undefined, z => zeroed.push(z));
    expect(income.boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    expect(zeroed).toEqual([{ boxId: f.b.id, receiver: f.b.receiver, code: 'PIN_INVALID' }]);
    expect(f.pub.getBytecode).toHaveBeenCalledWith({ address: TETH, blockNumber: 100n });
  });

  it.each([['an 18-decimal coin with other code (tLINK)', TLINK_CODE], ['no code', null]] as const)(
    'counts nothing for %s at the pinned address', async (_, code) => {
      pinned();
      const f = fixture('teth', { code }), zeroed: ZeroedTokenIncome[] = [];
      const income = await readIncome(f.pub as unknown as PublicClient, [f.b], keeper, time, 0n, [], undefined, z => zeroed.push(z));
      expect(income.boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
      expect(zeroed.map(z => z.code)).toEqual(['PIN_INVALID']);
      expect(f.pub.getBytecode).toHaveBeenCalledWith({ address: TETH, blockNumber: 100n });
    });

  it.each(['wrong sender', 'wrong recipient', 'unrelated claim', 'another id'])(
    'values no tETH receipt without the box\'s own payout proof (%s)', async failure => {
      pinned();
      const f = fixture('teth');
      if (failure === 'wrong sender') present(f.logs[1]).args.from = addr(77);
      if (failure === 'wrong recipient') present(f.logs[1]).args.to = addr(77);
      if (failure === 'unrelated claim') present(f.logs[0]).args.caller = addr(77);
      if (failure === 'another id') present(f.logs[0]).args.id = BigInt(addr(90));
      expect((await f.read()).boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    });

  it('values a six-decimal tUSDC platform payout and paid keeper tip once, with the existing receipt proofs', async () => {
    const coin: Address = '0x5B397F65571deF193Ba5DBE8b2a353C3963c65F6';
    parity.entries = { [`11155111:${coin.toLowerCase()}`]: { chainId: '11155111', token: coin,
      decimals: '6', codeHash: keccak256(TETH_CODE), weiPerCoin: '10000000000000000000' } };
    const f = fixture('teth', { coin, decimals: 6 });
    f.logs.length = 0;
    const payout = f.payment('PlatformPaid', 65_214n, 900n);
    f.logs.push({ ...payout, logIndex: payout.logIndex + 1 });
    const tip = f.payment('Collected', 11_886n, 901n, f.b.receiver, keeper);
    // An overlapping event cannot consume the same claim/transfer a second time.
    f.logs.push({ ...tip, logIndex: tip.logIndex + 1 });
    // Duplicate RPC logs and duplicate discovery also cannot add credit.
    f.logs.push(...f.logs.map(l => ({ ...l })));
    const income = await readIncome(f.pub as unknown as PublicClient, [f.b, f.b], keeper, time, 0n, []);
    expect(income.boxes[f.b.receiver]).toEqual({ shareWei: 652_140_000_000_000_000n, tipsWei: 118_860_000_000_000_000n });
    expect(income.platformWei).toBe(652_140_000_000_000_000n);
    expect(income.valuationFailures ?? []).toEqual([]);
    expect(f.pub.getBytecode).toHaveBeenCalledWith({ address: coin, blockNumber: 100n });
    const transfer = f.logs.find(l => l.transactionHash === hash(901n) && l.address === coin);
    if (!transfer) throw new Error('missing transfer');
    for (const l of f.logs) if (l.address === coin && l.transactionHash === hash(901n)) l.args.from = addr(77);
    expect((await f.read()).boxes[f.b.receiver]?.tipsWei).toBe(0n);
  });

  it('ignores tETH on mainnet: the same coin on chain 1 gets zero room', async () => {
    pinned();
    const f = fixture('teth');
    f.pub.getChainId.mockResolvedValue(1);
    expect((await f.read()).boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    f.pub.getChainId.mockResolvedValue(11155111);
    expect((await f.read()).boxes[f.b.receiver]).toEqual({ shareWei: f.amount, tipsWei: 0n });
  });

  it('refuses a parity entry for chain 1, and refuses runtime decimals that differ from the tETH pin', async () => {
    const { ethParityPin } = await import('../src/income-parity');
    parity.entries = { [`1:${TETH.toLowerCase()}`]: { chainId: '1', token: TETH, decimals: '18', codeHash: keccak256(TETH_CODE), weiPerCoin: '1000000000000000000' } };
    expect(() => ethParityPin(1n, TETH)).toThrow(/refused/);
    const f = fixture('teth');
    f.pub.getChainId.mockResolvedValue(1);
    expect((await f.read()).boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    // A mainnet entry gives nothing on Sepolia either: only the reviewed Sepolia entry counts.
    f.pub.getChainId.mockResolvedValue(11155111);
    expect((await f.read()).boxes[f.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
    // The pinned code reporting other decimals counts nothing.
    pinned();
    const wrong = fixture('teth', { decimals: 6 });
    expect((await wrong.read()).boxes[wrong.b.receiver]).toEqual({ shareWei: 0n, tipsWei: 0n });
  });
});

describe('typed valuation failures use the per-box hourly throttle', () => {
  it('logs both boxes and distinct codes, expires, and never emits upstream data', () => {
    const warn = vi.fn(), log = new ZeroedIncomeLog(warn);
    const a = { boxId: 1n, receiver: addr(301), code: 'VALUATION_UNAVAILABLE' } as const;
    const b = { boxId: 2n, receiver: addr(302), code: 'INCOME_CAPACITY' } as const;
    const tick = (now: bigint, ...zeroed: ZeroedTokenIncome[]) => { const t = log.tick(now); for (const z of zeroed) t.report(z); t.done(); };
    tick(1n, a, b); tick(2n, a, b); tick(3n);
    tick(4n, a); // recovery cannot bypass the hourly throttle
    expect(warn).toHaveBeenCalledTimes(2);
    tick(5n, { ...a, code: 'PIN_INVALID' });
    tick(3601n, a, b);
    expect(warn).toHaveBeenCalledTimes(5);
    expect(warn.mock.calls[3]).toEqual(['skipped', { boxId: '1', job: 'income', code: 'VALUATION_UNAVAILABLE', repeats: 2 }]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('0x');
  });
});


describe('F182 token starts use the existing authenticated receipt proof', () => {
  it.each(['teth', 'usdc', 'stock'] as const)('%s settles only this transaction inside the rolling window', async kind => {
    const f = fixture(kind);
    if (kind === 'teth') parity.entries = sepoliaPin(keccak256(TETH_CODE));
    f.logs.length = 0;
    f.payment('Collected', f.amount, 901n, f.b.receiver, keeper);
    const start = { box: f.b.receiver, at: time - 24n, costWei: 1n, hash: hash(901n), start: { job: 'collect' as const } };
    // SH-247: the receipt carries its transaction's logs, where the payment proof is now read.
    const pub = { ...f.pub, getTransactionReceipt: async ({ hash: transactionHash }: { hash: string }) => ({ transactionHash, blockNumber: 99n, blockHash: hash(99n),
      status: 'success', from: keeper, to: f.b.receiver, logs: receiptLogs(f.logs.filter(l => l.transactionHash === transactionHash)) }) };
    const read = (now = time) => readIncome(pub as unknown as PublicClient, [f.b], keeper, now, 0n, [start]);
    const first = await read();
    const tip = present(first.boxes[f.b.receiver]).tipsWei;
    expect(tip).toBeGreaterThan(0n);
    expect(first.startReceipts).toEqual([{ box: f.b.receiver, hash: hash(901n), at: time - 12n,
      shareWei: 0n, tipsWei: tip, startTipWei: tip }]);
    // Fixed pins remain readable after downtime; route freshness remains unchanged and may refuse.
    if (kind === 'teth') {
      const old = await read(time + 172800n);
      expect(present(old.boxes[f.b.receiver]).tipsWei).toBe(0n);
      expect(old.startReceipts).toEqual([]);
    }
    for (const l of f.logs) if (l.address === pm) l.args.caller = addr(777);
    expect((await read()).startReceipts?.[0]?.startTipWei ?? 0n).toBe(0n);
  });
});

it('F182 starts through a reviewed chain-1 route without turning ordinary token tips into wei', async () => {
  const { ViemChain } = await import('../src/chain');
  const f = fixture('stock');
  f.pub.getChainId.mockResolvedValue(1);
  reviewed.entries = { [`1:${registry}:7:${f.q}`]: { ...f.entry, chainId: '1' } };
  const cfg = { ...options(), chainId: 1, allowMainnet: true, dryRun: false, priorityFeeWei: 2999999998n };
  const pub = { ...f.pub,
    simulateContract: vi.fn(async () => ({ result: { buyersP: 1n, sellersP: 0n, qToReserve: 0n, tip: 1000000000000000000n } })),
    estimateGas: vi.fn(async () => 1190000n),
  };
  const chain = new ViemChain(cfg, pub as unknown as PublicClient, keeper, { public: null, private: null }, null, quiet);
  Object.assign(chain, { last: world(f.b), now: time });
  const send = vi.fn(async () => hash(999n));
  const out = await runTick({ read: async () => world(f.b), readIncome: async () => ({ at: time, boxes: {}, platformWei: 0n, mined: {} }),
    simulate: async (c, fees, start = false) => {
      if (c.job !== 'collect') return { ok: false, tipWei: null, estimate: 0n };
      const sim = await chain.simulate(c, fees, start);
      expect(sim.tipWei).toBeNull();
      expect(sim.paidTipRaw).toBe(1000000000000000000n);
      if (start) {
        expect(sim.startTipWei).toBeGreaterThan(99000000000000000n);
        expect(sim.startTipWei).toBeLessThan(100000000000000000n);
      } else expect(sim.startTipWei).toBeUndefined();
      return sim;
    }, send }, {}, cfg, quiet);
  expect(out.report.sent.map(s => s.job)).toEqual(['collect']);
  expect(out.state.incomeSpend?.[0]).toMatchObject({ costWei: 15000000000000000n, start: { job: 'collect' } });
  expect(f.pub.getBytecode).not.toHaveBeenCalled();
});
