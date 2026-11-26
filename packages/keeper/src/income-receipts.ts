import { decodeEventLog, keccak256, parseAbiItem, toEventSelector, toHex,
  type AbiEvent, type Address, type PublicClient, type TransactionReceipt } from 'viem';
import { incomeAmounts, type IncomeCache } from './income-cache';
import type { ReceiptLog } from './income-read';

const transfer = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
const claimBurn = parseAbiItem('event Transfer(address caller,address indexed from,address indexed to,uint256 indexed id,uint256 amount)');
const safeReceived = parseAbiItem('event SafeReceived(address indexed sender,uint256 value)');
const zero = '0x0000000000000000000000000000000000000000';
const same = (a: unknown, b: string | null) => typeof a === 'string' && b !== null && a.toLowerCase() === b.toLowerCase();
const positive = (a: unknown): a is bigint => typeof a === 'bigint' && a > 0n;
/**
 * A registered box part (receiver, coordinator or hook) and its box's wiring at finality. A part whose wiring could not
 * be read this tick is still registered: its own events stay in the projection, so no other box can take its proofs.
 */
export interface IncomePart {
  readonly q: Address | null; readonly pm: Address | null; readonly safe: Address | null; readonly events: readonly AbiEvent[];
}
const native = (p: IncomePart | undefined) => p !== undefined && same(p.q, zero);
const token = (p: IncomePart | undefined) => p !== undefined && p.q !== null && !same(p.q, zero);

/**
 * Discover transactions only through registered box events. ERC-20/6909 transfers and Safe deposits are never
 * range-scanned (SH-190). The retained receipt projection contains box events with an amount and positive,
 * box-authenticated payments; unsolicited transfers, claims and deposits cannot consume its row budget, even inside a
 * paying transaction.
 */
export function incomeReceipts(pub: PublicClient, cache: IncomeCache, parts: ReadonlyMap<string, IncomePart>) {
  // Any change in the registered boxes or their wiring invalidates every kept projection (re-check R2): a projection
  // then always holds every registered box's events of its transaction, whichever box reads it first.
  const population = keccak256(toHex([...parts].map(([a, p]) => [a, p.q ?? '-', p.pm ?? '-', p.safe ?? '-'].join(':').toLowerCase()).sort().join('|')));
  const scope = (rows: readonly ReceiptLog[]) => {
    const touched = new Set<string>();
    for (const l of rows) {
      if (l.eventName !== 'Transfer' && l.eventName !== 'SafeReceived') touched.add(l.address.toLowerCase());
      else if (l.eventName === 'Transfer' && typeof l.args.amount === 'bigint' && typeof l.args.from === 'string') {
        touched.add(l.args.from.toLowerCase());
      }
    }
    return keccak256(toHex(population + [...touched].sort().map(a => {
      const p = parts.get(a);
      return p ? [a, p.q ?? '-', p.pm ?? '-', p.safe ?? '-', ...p.events.map(toEventSelector)].join(':').toLowerCase() : a;
    }).join('|')));
  };
  const transferSelector = toEventSelector(transfer);
  const zeroWord = '0'.repeat(64);
  const knownEvents = new Map<string, Map<string, AbiEvent>>();
  const addEvents = (address: string, events: readonly AbiEvent[]) => {
    const known = knownEvents.get(address) ?? new Map<string, AbiEvent>();
    for (const e of events) known.set(toEventSelector(e), e);
    knownEvents.set(address, known);
  };
  for (const [address, part] of parts) addEvents(address, part.events);
  const managers = new Set([...parts.values()].flatMap(p => p.pm === null ? [] : [p.pm.toLowerCase()]));
  const safes = new Set([...parts.values()].filter(native).flatMap(p => p.safe === null ? [] : [p.safe.toLowerCase()]));
  for (const manager of managers) addEvents(manager, [claimBurn]);
  for (const safe of safes) addEvents(safe, [safeReceived]);

  const hasAnchor = (rows: readonly ReceiptLog[], anchor: ReceiptLog) => rows.some(l =>
    same(l.address, anchor.address) && l.eventName === anchor.eventName && l.logIndex === anchor.logIndex
    && l.transactionHash === anchor.transactionHash && l.blockHash === anchor.blockHash);

  function project(receipt: TransactionReceipt, anchor: ReceiptLog) {
    const decoded = new Map<number, ReceiptLog>();
    let complete = true;
    function decode(log: TransactionReceipt['logs'][number], event: AbiEvent) {
      if (log.removed || log.transactionHash !== receipt.transactionHash || log.blockHash !== receipt.blockHash
        || log.blockNumber !== receipt.blockNumber || log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) {
        complete = false;
        return;
      }
      try {
        const eventData = decodeEventLog({ abi: [event], data: log.data, topics: log.topics, strict: true });
        decoded.set(log.logIndex, { address: log.address, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
          transactionHash: receipt.transactionHash, logIndex: log.logIndex, removed: false,
          eventName: eventData.eventName, args: eventData.args as Record<string, unknown> });
      } catch { complete = false; }
    }
    // First find box events and positive claims. Unrelated claims and zero payments need no ABI decode or storage.
    for (const log of receipt.logs) {
      const event = knownEvents.get(log.address.toLowerCase())?.get(log.topics[0] ?? '');
      if (!event) continue;
      if (event === claimBurn) {
        const from = log.topics[1];
        if (!from || !parts.has(`0x${from.slice(-40)}`.toLowerCase()) || log.data.endsWith(zeroWord)) continue;
      } else if (event === safeReceived && log.data.endsWith(zeroWord)) continue;
      decode(log, event);
    }
    // Only the transfer immediately following an authentic positive box burn is a candidate.
    const expectedTransfers = new Map<number, Address>();
    for (const l of decoded.values()) {
      if (l.eventName !== claimBurn.name || !positive(l.args.amount) || typeof l.args.from !== 'string') continue;
      const owner = parts.get(l.args.from.toLowerCase());
      if (owner && token(owner) && owner.q !== null && same(l.address, owner.pm) && same(l.args.caller, l.args.from)
        && same(l.args.to, zero) && l.args.id === BigInt(owner.q)) expectedTransfers.set(l.logIndex + 1, owner.q);
    }
    for (const log of receipt.logs) {
      const q = log.logIndex === null ? undefined : expectedTransfers.get(log.logIndex);
      if (q && same(log.address, q) && log.topics[0] === transferSelector) decode(log, transfer);
    }
    const keep = new Map<number, ReceiptLog>();
    const previousCompletion = new Map<string, ReceiptLog>();
    for (const l of [...decoded.values()].sort((a, b) => a.logIndex - b.logIndex)) {
      const address = l.address.toLowerCase(), part = parts.get(address);
      if (part?.events.some(e => e.name === l.eventName)) {
        // Zero amounts have no proof role. For tokens, only the immediately preceding completion
        // can bound a positive collection; retain that boundary, not every empty call in the receipt.
        if (l.args[incomeAmounts[l.eventName ?? ''] ?? ''] !== 0n) {
          keep.set(l.logIndex, l);
          if (l.eventName === 'Collected' && !native(part)) {
            const previous = previousCompletion.get(address);
            if (previous) keep.set(previous.logIndex, previous);
          }
        }
        previousCompletion.set(address, l);
      }
      // An actual box claim redemption: caller is not indexed, and must equal its registered owner.
      if (l.eventName !== 'Transfer' || !positive(l.args.amount) || typeof l.args.from !== 'string') continue;
      const owner = parts.get(l.args.from.toLowerCase());
      if (!owner || !token(owner) || owner.q === null || !same(l.address, owner.pm) || !same(l.args.caller, l.args.from)
        || !same(l.args.to, zero) || l.args.id !== BigInt(owner.q)) continue;
      const paid = decoded.get(l.logIndex + 1);
      if (!paid || !same(paid.address, owner.q) || paid.eventName !== 'Transfer'
        || !same(paid.args.from, owner.pm) || paid.args.value !== l.args.amount) continue;
      keep.set(l.logIndex, l); keep.set(paid.logIndex, paid);
    }
    // Native receipts keep the original exact SafeReceived/PlatformPaid rule, within this receipt only.
    const payments = [...keep.values()].filter(l => l.eventName === 'PlatformPaid' && positive(l.args.amount));
    for (const l of decoded.values()) if (l.eventName === 'SafeReceived' && positive(l.args.value)) {
      if (payments.some(p => {
        const owner = parts.get(p.address.toLowerCase());
        return owner && native(owner) && same(l.address, owner.safe) && same(p.args.safe, owner.safe)
          && same(l.args.sender, owner.pm) && l.args.value === p.args.amount && l.logIndex < p.logIndex;
      })) keep.set(l.logIndex, l);
    }
    const rows = [...keep.values()].sort((a, b) => a.logIndex - b.logIndex);
    if (!hasAnchor(rows, anchor)) throw new Error('income receipt missing box event');
    return { rows, complete };
  }
  return async (anchor: ReceiptLog): Promise<readonly ReceiptLog[]> => {
    const rows = await cache.receipt(pub, anchor, scope, rows => hasAnchor(rows, anchor), receipt => project(receipt, anchor));
    if (!hasAnchor(rows, anchor)) throw new Error('income receipt missing box event');
    return rows;
  };
}

/**
 * The line's native proof order, over one receipt: native boxes first in registry order (`rank`), each box's payments in
 * log order, each taking the first unused SafeReceived of its Safe from its PoolManager, of its exact amount, before it.
 * Every registered native payment in the transaction takes part, whether or not its own box could be read this tick,
 * so a box that waits never leaves its proof to another box. Returns the proved payments' `transactionHash:logIndex`.
 */
export function nativeProofs(rows: readonly ReceiptLog[], rank: ReadonlyMap<string, number>, parts: ReadonlyMap<string, IncomePart>) {
  const payments = rows.filter(l => {
    const part = parts.get(l.address.toLowerCase());
    return l.eventName === 'PlatformPaid' && rank.has(l.address.toLowerCase()) && native(part)
      && same(l.args.safe, part?.safe ?? null) && positive(l.args.amount);
  }).sort((a, b) => (rank.get(a.address.toLowerCase()) ?? 0) - (rank.get(b.address.toLowerCase()) ?? 0) || a.logIndex - b.logIndex);
  const received = rows.filter(l => l.eventName === 'SafeReceived').sort((a, b) => a.logIndex - b.logIndex);
  const used = new Set<number>(), proved = new Set<string>();
  for (const p of payments) {
    const part = parts.get(p.address.toLowerCase());
    const proof = received.find(r => !used.has(r.logIndex) && r.transactionHash === p.transactionHash && r.blockHash === p.blockHash
      && same(r.address, part?.safe ?? null) && r.logIndex < p.logIndex && same(r.args.sender, part?.pm ?? null) && r.args.value === p.args.amount);
    if (!proof) continue;
    used.add(proof.logIndex);
    proved.add(`${p.transactionHash}:${p.logIndex}`);
  }
  return proved;
}
