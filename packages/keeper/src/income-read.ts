import { valuationFailureCode, type ValuationFailure } from './income-failure';
import { logSkips, type SkipLog } from './skips';
import { IncomeCache, type LogTopics } from './income-cache';
export { IncomeCache } from './income-cache';
import { rewardTipsV21 } from './pay-in-t-income-v21';
import { decodeFunctionData, getAbiItem, type AbiEvent, type Address, type Hex, type PublicClient } from 'viem';
import { receiverPayInTV21Abi } from '../../chain/src/core/v2/abi-v2';
import { coordinatorV2Abi, hookV2Abi, receiverV2Abi } from './abi';
import { INCOME_WINDOW_SECONDS, type IncomeSnapshot, type IncomeSpend, type IncomeReceipt } from './income';
import type { BoxState } from './world';
import { tokenIncomeValuer } from './income-token';
import { readWindows } from './tick-reads';
import { incomeReceipts, nativeProofs, type IncomePart } from './income-receipts';

const same = (a: string | null | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
const raw = (x: unknown): bigint => {
  if (typeof x !== 'bigint' || x < 0n) throw new Error('invalid income amount');
  return x;
};
export interface ReceiptLog {
  readonly eventName?: string;
  readonly address: Address;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly removed: boolean;
  readonly args: Record<string, unknown>;
}
const identity = (l: ReceiptLog) => `${l.transactionHash}:${l.logIndex}`;

/** A box that counts zero this tick. No raw upstream error is retained. */
export interface ZeroedTokenIncome extends ValuationFailure {
  readonly receiver: Address;
}

/** Uses the same per-box/job/code throttle as admission deferrals. `income` names the read job. */
export class ZeroedIncomeLog {
  private last: SkipLog = {};
  constructor(private readonly warn: (msg: string, data: Record<string, unknown>) => void) {}
  tick(now: bigint) {
    const failures: ZeroedTokenIncome[] = [];
    return {
      report: (z: ZeroedTokenIncome) => { failures.push(z); },
      done: () => { this.last = logSkips(this.last, failures.map(z => ({ boxId: z.boxId, job: 'income', code: z.code })), now,
        { info() {}, error() {}, warn: this.warn }); },
    };
  }
}

/**
 * Finalized, canonical receipts only. PLATFORM_SAFE comes from each registered receiver.
 * Exact PlatformPaid + SafeReceived pairs prove its realized 1/15; no gross-volume division,
 * accrued debt or wallet balance difference is used. Tokens require authenticated claim redemptions
 * and the listing's full-window pool averages. Unavailable/thin/stale routes give that box zero credit.
 *
 * SH-247 (SH-190 ported): only the registered boxes' own events are range-read; every proof comes from the receipt of
 * the transaction that emitted the box's event. Each box reads within its own allowance (income-cache.ts); a box whose
 * reading fails counts zero this tick and no other box's reading changes. A native payment or tip whose receipt or
 * call this tick cannot read waits for a later tick; a token box counts zero until all of its proofs are read.
 */
export async function readIncome(pub: PublicClient, boxes: readonly BoxState[], keeper: Address,
  now: bigint, fromBlock: bigint, spend: readonly IncomeSpend[], cache = new IncomeCache(),
  zeroed?: (z: ZeroedTokenIncome) => void): Promise<IncomeSnapshot> {
  if (!boxes.some(b => b.version === 2) && spend.length === 0) return { at: now, platformWei: 0n, boxes: {}, mined: {} };
  const final = await pub.getBlock({ blockTag: 'finalized' });
  if (final.number === null || final.hash === null || final.timestamp > now) throw new Error('income finality unavailable');
  const finalNumber = final.number;
  const anchor = { number: finalNumber, hash: final.hash, timestamp: final.timestamp };
  const work = await cache.begin(pub, anchor);
  const header = (number: bigint) => work.header(pub, number);
  const cutoff = now - INCOME_WINDOW_SECONDS;
  const starts = spend.filter(s => s.start && s.start.settledAt === undefined && s.start.repaidAt === undefined);
  const startBoxes = new Set(starts.map(s => s.box.toLowerCase()));
  const receiptCredits = new Map<string, IncomeReceipt & { blockHash: Hex }>();
  // Binary search timestamps, never assume a block duration or convert money/time through Number.
  let lo = fromBlock, hi = final.number + 1n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await header(mid)).timestamp <= cutoff) lo = mid + 1n;
    else hi = mid;
  }
  const families = new Map<string, readonly AbiEvent[]>();
  const owners = new Map<string, string>();
  for (const box of boxes) if (box.version === 2) {
    for (const address of [box.receiver, box.coordinator, box.hook]) owners.set(address.toLowerCase(), box.receiver.toLowerCase());
    families.set(box.receiver.toLowerCase(), [
      ...(['PlatformPaid', 'Collected', 'BoughtBack', 'FitPaid', 'CreatorClaimed'] as const).map(name => getAbiItem({ abi: receiverV2Abi, name })),
      getAbiItem({ abi: receiverPayInTV21Abi, name: 'RewardsBought' }),
    ]);
    families.set(box.coordinator.toLowerCase(), [getAbiItem({ abi: coordinatorV2Abi, name: 'PotFixed' })]);
    families.set(box.hook.toLowerCase(), (['Deepened', 'FeesSold'] as const).map(name => getAbiItem({ abi: hookV2Abi, name })));
  }
  work.boundDiscovery(owners);
  // Cheap reads first (re-check N1): every family's pages, with their probes and single-address queries, then every box's
  // own reads; only then is a refused range halved, with what is left of the tick. A flood delays only its own box.
  work.deferHalving();
  const groups = new Map<string, { addresses: Address[]; family: readonly AbiEvent[] }>();
  for (const [address, events] of families) {
    const group = groups.get(events[0]?.name ?? '') ?? { addresses: [], family: events };
    group.addresses.push(address as Address);
    groups.set(events[0]?.name ?? '', group);
  }
  try {
    for (const { addresses, family } of groups.values()) {
      const [first] = addresses, [event] = family;
      if (!first || !event) continue;
      for (let start = lo; start <= finalNumber;) {
        const end = work.endOfPage(first, event, start, finalNumber, undefined, family, addresses);
        await work.discover(pub, first, event, start, end, family, addresses);
        start = end + 1n;
      }
    }
  } catch { /* No query can be sent this tick: what is unread counts with INCOME_CAPACITY below. */ }
  // `args` filters by indexed topics (F164 D1); such a read is its own query and page, never a grouped family's.
  const logs = async (address: Address, event: AbiEvent, args?: LogTopics): Promise<ReceiptLog[]> => {
    const result = new Map<string, ReceiptLog>();
    for (let start = lo; start <= finalNumber;) {
      const known = args ? undefined : families.get(address.toLowerCase());
      const family = known?.some(e => e.name === event.name) ? known : undefined;
      const addresses = family ? [...families].filter(([, events]) => events[0]?.name === family[0]?.name).map(([a]) => a as Address) : [address];
      const end = work.endOfPage(address, event, start, finalNumber, args, family, addresses);
      const rows = await work.logs(pub, address, event, start, end, family, addresses, args);
      for (const row of rows) {
        const l = row as unknown as ReceiptLog;
        if (l.removed || l.blockNumber === null || l.blockNumber < start || l.blockNumber > end || l.blockNumber > finalNumber
          || !l.transactionHash || !same(l.address, address)) continue;
        const b = await work.canonicalHeader(pub, l);
        if (!b || b.timestamp <= cutoff || b.timestamp > now) continue;
        result.set(identity(l), l);
      }
      start = end + 1n;
    }
    return [...result.values()];
  };
  const credits: Record<string, { shareWei: bigint; tipsWei: bigint }> = {};
  for (const box of boxes) if (box.version === 2) credits[box.receiver.toLowerCase()] ??= { shareWei: 0n, tipsWei: 0n };
  const consumed = new Set<string>();
  let platformWei = 0n;
  const valuationFailures: ValuationFailure[] = [];
  // Only the plain wiring views run together. Receipt consumption and credit accumulation follow the order below.
  const receivers = new Map<string, Address>();
  for (const box of boxes) if (box.version === 2 && !receivers.has(box.receiver.toLowerCase())) {
    receivers.set(box.receiver.toLowerCase(), box.receiver);
  }
  const wiringByReceiver = new Map(await readWindows(receivers, async ([key, address]) => {
    const call = (functionName: string) => pub.readContract({ address, abi: receiverV2Abi, functionName,
      blockNumber: finalNumber } as never) as Promise<Address>;
    // A new receiver may not exist at finality yet. Only that box loses credit.
    const wiring = await Promise.all([call('q'), call('PLATFORM_SAFE'), call('poolManager')] as const).catch(() => null);
    return [key, wiring] as const;
  }));
  // Every registered box's parts, with or without wiring this tick: a receipt's projection then holds every box event in
  // that transaction, so the native proof order below never depends on which boxes could be read.
  const parts = new Map<string, IncomePart>();
  for (const box of boxes) if (box.version === 2) {
    const wiring = wiringByReceiver.get(box.receiver.toLowerCase()) ?? null;
    for (const address of [box.receiver, box.coordinator, box.hook]) {
      const key = address.toLowerCase();
      parts.set(key, { q: wiring?.[0] ?? null, safe: wiring?.[1] ?? null, pm: wiring?.[2] ?? null, events: families.get(key) ?? [] });
    }
  }
  const receipt = incomeReceipts(pub, work, parts);
  // Native boxes are read first (F164 D1); credits keep the boxes' order. That order is also the native proof order.
  const isNative = (box: BoxState) => /^0x0{40}$/i.test(wiringByReceiver.get(box.receiver.toLowerCase())?.[0] ?? '');
  const lineOrder = [...boxes.filter(isNative), ...boxes.filter(b => !isNative(b))];
  const rank = new Map<string, number>();
  for (const box of lineOrder) if (box.version === 2 && isNative(box) && !rank.has(box.receiver.toLowerCase())) rank.set(box.receiver.toLowerCase(), rank.size);
  // Proofs of one transaction are assigned once per tick, whichever box reads it first (review F5).
  const proofsOf = new Map<string, ReadonlySet<string>>();
  const abiEvent = (abi: typeof receiverV2Abi | typeof coordinatorV2Abi | typeof hookV2Abi | typeof receiverPayInTV21Abi, name: string) =>
    getAbiItem({ abi, name } as never) as AbiEvent;
  // Every box's own events first (the grouped pages serve all boxes), then how many receipts and calls each box still
  // has to read: allowances are shared among the boxes that have something unread, never among idle ones (review F2).
  const unread = async (box: BoxState): Promise<number> => {
    const wiring = wiringByReceiver.get(box.receiver.toLowerCase());
    if (box.version !== 2 || !wiring) return 0;
    const [q, safe] = wiring;
    const token = !/^0x0{40}$/i.test(q);
    const want = new Set<string>();
    const needReceipt = (l: ReceiptLog) => { if (!work.keptReceipt(l.transactionHash)) want.add(`r:${l.transactionHash}`); };
    for (const address of [box.receiver, box.coordinator, box.hook]) {
      const first = families.get(address.toLowerCase())?.[0];
      if (first) await logs(address, first);
    }
    for (const l of await logs(box.receiver, abiEvent(receiverV2Abi, 'PlatformPaid'))) if (same(l.args.safe as string, safe)) needReceipt(l);
    if (token) {
      for (const l of await logs(box.receiver, abiEvent(receiverV2Abi, 'Collected'))) if (same(l.args.tipTo as string, keeper)) needReceipt(l);
      for (const l of await logs(box.coordinator, abiEvent(coordinatorV2Abi, 'PotFixed'))) if (same(l.args.closer as string, keeper)) needReceipt(l);
      for (const l of await logs(box.hook, abiEvent(hookV2Abi, 'FeesSold'))) if (same(l.args.caller as string, keeper)) needReceipt(l);
    }
    for (const [target, abi, name, kind] of [[box.receiver, receiverPayInTV21Abi, 'RewardsBought', 'receiver'],
      [box.receiver, receiverV2Abi, 'BoughtBack', 'receiver'], [box.hook, hookV2Abi, 'Deepened', 'hook']] as const) {
      for (const l of await logs(target, abiEvent(abi, name))) {
        if (!work.keptCall(l.transactionHash, kind)) want.add(`c:${l.transactionHash}:${kind}`);
        if (token) needReceipt(l);
      }
    }
    return want.size;
  };
  const needs = new Map<string, number>();
  for (const box of lineOrder) {
    const key = box.receiver.toLowerCase();
    if (!needs.has(key)) needs.set(key, await unread(box).catch(() => 0));
  }
  let needing = [...needs.values()].filter(n => n > 0).length;
  // The box served first moves on by one each tick, so no box is always last to share the tick's reads.
  const turn = lineOrder.length > 0 ? work.turn % lineOrder.length : 0;
  const order = [...lineOrder.slice(turn), ...lineOrder.slice(0, turn)];
  const done = new Set<string>();
  for (const box of order) {
    const key = box.receiver.toLowerCase(), credit = credits[key];
    if (box.version !== 2 || !credit || done.has(key)) continue;
    done.add(key);
    const wiring = wiringByReceiver.get(key);
    if (!wiring) continue;
    const [q, safe, pm] = wiring;
    const native = /^0x0{40}$/i.test(q);
    const share = needing;
    if ((needs.get(key) ?? 0) > 0) needing--;
    try {
      // Discovery was read above for every box; a box whose discovery failed fails here again, alone.
      for (const address of [box.receiver, box.coordinator, box.hook]) {
        const first = families.get(address.toLowerCase())?.[0];
        if (first) await logs(address, first);
      }
      work.allocateReads(key, share);
      const token = native ? null : await tokenIncomeValuer(pub, box, q, pm, safe, keeper,
        { number: finalNumber, timestamp: final.timestamp }, now,
        async n => ({ number: n, timestamp: (await header(n)).timestamp }), consumed, receipt);
      const add = async (l: ReceiptLog, kind: 'shareWei' | 'tipsWei', value: bigint, startJob?: 'collect' | 'sellFees') => {
        const at = (await header(l.blockNumber)).timestamp;
        credit[kind] += value;
        if (!startBoxes.has(key)) return;
        const id = `${key}:${l.transactionHash}`;
        const r = receiptCredits.get(id) ?? { box: box.receiver, hash: l.transactionHash, at, blockHash: l.blockHash,
          shareWei: 0n, tipsWei: 0n, startTipWei: 0n };
        receiptCredits.set(id, { ...r, [kind]: r[kind] + value,
          startTipWei: r.startTipWei + (starts.some(s => s.box.toLowerCase() === key && s.hash === l.transactionHash
            && s.start?.job === startJob) ? value : 0n) });
      };
      const tipValue = (l: ReceiptLog, amount: bigint) => token ? token.value(l, amount, keeper) : Promise.resolve(amount);
      // A native payment whose receipt or call cannot be read this tick waits and counts nothing now; a token box's
      // read failure counts the whole box zero, as any token route failure does.
      const wait = async <T>(read: () => Promise<T>, otherwise: T): Promise<T> => {
        if (token) return read();
        try { return await read(); } catch { return otherwise; }
      };
      // These events omit tipTo. Credit only a directly decoded call; nested/unknown callers get no credit.
      const direct = (l: ReceiptLog, target: Address, abi: typeof receiverV2Abi | typeof hookV2Abi, fn: string) => wait(async () => {
        const call = await work.call(pub, l, abi === hookV2Abi ? 'hook' : 'receiver', input => {
          const decoded = decodeFunctionData({ abi, data: input });
          return { fn: decoded.functionName, arg0: (decoded.args as readonly unknown[] | undefined)?.[0] };
        });
        return same(call.to, target) && call.fn === fn && same(call.arg0, keeper);
      }, false);
      for (const paid of await logs(box.receiver, getAbiItem({ abi: receiverV2Abi, name: 'PlatformPaid' }))) {
        if (!same(paid.args.safe as string, safe)) continue;
        const amount = raw(paid.args.amount);
        if (token) { await add(paid, 'shareWei', await token.value(paid, amount, safe)); continue; }
        const rows = await wait<readonly ReceiptLog[] | null>(() => receipt(paid), null);
        if (!rows) continue;
        let proved = proofsOf.get(paid.transactionHash);
        if (!proved) { proved = nativeProofs(rows, rank, parts); proofsOf.set(paid.transactionHash, proved); }
        if (!proved.has(identity(paid))) continue;
        await add(paid, 'shareWei', amount);
      }
      for (const l of await logs(box.receiver, getAbiItem({ abi: receiverV2Abi, name: 'Collected' }))) {
        if (same(l.args.tipTo as string, keeper)) {
          const amount = raw(l.args.tip);
          await add(l, 'tipsWei', token ? await token.value(l, amount, keeper, 'collection') : amount, 'collect');
        }
      }
      // Failure reports the amount actually paid after the capped transfer; a refused tip is zero.
      for (const l of await logs(box.coordinator, getAbiItem({ abi: coordinatorV2Abi, name: 'PotFixed' }))) {
        if (same(l.args.closer as string, keeper)) await add(l, 'tipsWei', await tipValue(l, raw(l.args.tip)));
      }
      await rewardTipsV21(l => direct(l, box.receiver, receiverV2Abi, 'buyBack'), box.receiver, logs, async (l, amount) => {
        const value = await tipValue(l, amount);
        await add(l, 'tipsWei', value);
        return value;
      });
      for (const [target, abi, name, fn] of [
        [box.receiver, receiverV2Abi, 'BoughtBack', 'buyBack'], [box.hook, hookV2Abi, 'Deepened', 'deepen'],
      ] as const) {
        const event = getAbiItem({ abi, name } as never) as AbiEvent;
        for (const l of await logs(target, event)) {
          if (raw(l.args.tip) === 0n) continue;
          if (await direct(l, target, abi, fn)) await add(l, 'tipsWei', await tipValue(l, raw(l.args.tip)));
        }
      }
      // F137: FeesSold names its caller, who received the tip (a refused tip is reported as zero).
      for (const l of await logs(box.hook, getAbiItem({ abi: hookV2Abi, name: 'FeesSold' }) as AbiEvent)) {
        if (same(l.args.caller as string, keeper) && raw(l.args.tip) > 0n) await add(l, 'tipsWei', await tipValue(l, raw(l.args.tip)), 'sellFees');
      }
      token?.checkTotal();
      platformWei += credit.shareWei;
    } catch (error) {
      // A failure anywhere in this box's reading invalidates all of this box's credit for this tick, and nothing else.
      credit.shareWei = 0n; credit.tipsWei = 0n;
      for (const [id, r] of receiptCredits) if (r.box.toLowerCase() === key) receiptCredits.delete(id);
      const failure = { boxId: box.id, code: valuationFailureCode(error) };
      valuationFailures.push(failure);
      zeroed?.({ ...failure, receiver: box.receiver });
    }
  }
  // Halving last: after every box's receipt and call reads, so a flood never takes the other boxes' reads.
  await work.halveDeferred(pub);
  const mined: Record<string, bigint> = {};
  for (const s of spend) {
    if (s.start || !s.hash || !/^0x[0-9a-fA-F]{64}$/.test(s.hash)) continue;
    try {
      const receipt = await pub.getTransactionReceipt({ hash: s.hash as Hex });
      if (receipt.blockNumber > final.number) continue;
      const b = await header(receipt.blockNumber);
      if (b.hash === receipt.blockHash) mined[s.hash] = b.timestamp;
    } catch { /* Not proved mined: keep the entire reservation indefinitely. */ }
  }
  const startReceipts: IncomeReceipt[] = [];
  for (const r of receiptCredits.values()) {
    // Read only transactions already found in the rolling window. Failure never discards ordinary income.
    const p = await pub.getTransactionReceipt({ hash: r.hash as Hex }).catch(() => null);
    if (!p || !same(p.transactionHash, r.hash) || p.blockNumber > finalNumber
      || p.status !== 'success' || p.blockHash !== r.blockHash) continue;
    const b = await pub.getBlock({ blockNumber: p.blockNumber }).catch(() => null);
    if (!b || b.hash !== p.blockHash || b.timestamp !== r.at) continue;
    const s = starts.find(s => s.hash === r.hash && same(s.box, r.box));
    const box = boxes.find(b => same(b.receiver, r.box));
    const target = s?.start?.job === 'collect' ? box?.receiver : box?.hook;
    const startTipWei = s && target && same(p.from, keeper) && same(p.to, target) ? r.startTipWei : 0n;
    startReceipts.push({ box: r.box, hash: r.hash, at: r.at, shareWei: r.shareWei, tipsWei: r.tipsWei, startTipWei });
  }
  // Refuse a finalized-chain change during this read instead of mixing histories.
  const end = await pub.getBlock({ blockNumber: final.number });
  if (end.hash !== final.hash) { cache.clear(); throw new Error('income finality changed'); }
  cache.commit(work, anchor, lo);
  return { at: now, platformWei, boxes: credits, mined, ...(starts.length ? { startReceipts } : {}), ...(valuationFailures.length ? { valuationFailures } : {}) };
}
