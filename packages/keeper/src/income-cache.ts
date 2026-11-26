import { encodeEventTopics, toEventSelector, type AbiEvent, type Address, type Hex, type PublicClient, type TransactionReceipt } from 'viem';
import { IncomeValuationError } from './income-failure';
import type { ReceiptLog } from './income-read';

type Header = { number: bigint; hash: Hex; timestamp: bigint };
/** `missing`: boxes (receiver keys) whose rows this page left out; their addresses are read on their own (SH-247). */
interface Page { key: string; from: bigint; to: bigint; rows: readonly ReceiptLog[]; missing?: ReadonlySet<string>; }
interface Projection { blockNumber: bigint; blockHash: Hex; scope: string; rows: readonly ReceiptLog[]; }
/** The direct call behind a tipped event, decoded with its target's ABI. A transaction's content never changes. */
export interface IncomeCall { readonly blockNumber: bigint; readonly to: string | null; readonly fn: string | null; readonly arg0: string | null; }
export const INCOME_CACHE_HEADERS = 16_384;
/** A tick's new log, receipt and transaction queries together, and the retained page count. */
export const INCOME_CACHE_PAGES = 512;
/** A tick's new rows together, the retained page rows, the retained receipt rows and the retained calls. */
export const INCOME_CACHE_LOGS = 20_000;
/**
 * New discovery rows of one tick, shared max-min among the boxes that have rows in an answer: a box whose rows fit the
 * remaining budget divided by the boxes with rows in that answer is never left out, however many boxes are registered.
 */
export const INCOME_DISCOVERY_LOGS = 10_000;
/**
 * New receipt and transaction reads one box may make in a tick, at most its fair share of the tick's remaining
 * queries. What a box cannot read waits for a later tick; reads already made stay cached, so catch-up is bounded.
 */
export const INCOME_BOX_READS = 64;
/**
 * Wall-clock budget of one income reading, well inside the service's 240-second cycle (infra/server/services/runtime.mjs).
 * Past it every new query or header read stops with INCOME_CAPACITY; what was read is kept and the next tick resumes.
 */
export const INCOME_READ_BUDGET_MS = 90_000;
/** The smallest gap between two log queries of one reading: at most five a second, whatever the node answers. */
export const INCOME_LOG_GAP_MS = 200;
/**
 * Refusals in one tick that no answer explains as size (a single block refused for one address alone, or a range whose
 * first and last block are refused too). Past this count log discovery stops for the tick, as without an answer.
 */
export const INCOME_UNEXPLAINED_REFUSALS = 16;

/** No proof is guessed: a payment whose read this box's allowance cannot pay for waits for a later tick. */
export class IncomeProofPending extends IncomeValuationError {
  constructor() { super('INCOME_CAPACITY', 'income box read capacity'); }
}

/** The amount argument of each income discovery event. A zero row carries no income and has no proof role. */
export const incomeAmounts: Readonly<Record<string, string>> = {
  PlatformPaid: 'amount', Collected: 'tip', PotFixed: 'tip', BoughtBack: 'tip', RewardsBought: 'tipP',
  Deepened: 'tip', FeesSold: 'tip', FitPaid: 'amount', CreatorClaimed: 'amount',
};

/** One box's reads in one tick, against its limits. Shared discovery queries and headers are counted once per tick. */
export interface IncomeBoxReads {
  /** New nonzero discovery rows charged to the box's receiver, coordinator and hook. */
  rows: number; rowsLimit: number;
  /** New receipt and transaction reads. */
  reads: number; readsLimit: number;
  /** Rows its new receipts retained. */
  receiptRows: number; receiptRowsLimit: number;
}
export interface IncomeReads {
  /** Shared grouped discovery queries and every new query of the tick. */
  discoveryQueries: number; queries: number;
  /** Every new row of the tick (discovery and receipts). */
  rows: number;
  boxes: Record<string, IncomeBoxReads>;
}

/** Indexed arguments of one event, as viem's getLogs `args`: a value, or a list any value of which matches (F164 D1). */
export type LogTopics = Readonly<Record<string, unknown>>;

/**
 * One filter, one text: each indexed position's topics in lowercase, a list deduplicated and sorted, a free position
 * '*', free trailing positions dropped. No filter, or one that filters nothing, is ''. The page and query keys carry it,
 * so a page read for one sender/recipient set never answers for another (F164 D1).
 */
function topicKey(event: AbiEvent, args?: LogTopics): string {
  if (!args) return '';
  const indexed = new Set(event.inputs.filter(i => i.indexed).map(i => i.name));
  for (const [name, value] of Object.entries(args)) {
    if (!indexed.has(name)) throw new Error('income log filter names no indexed argument');
    if (Array.isArray(value) && value.length === 0) throw new Error('income log filter list empty');
  }
  const topics = (encodeEventTopics({ abi: [event], eventName: event.name, args } as never) as readonly (Hex | readonly Hex[] | null)[])
    .slice(1).map(t => t === null ? '*' : typeof t === 'string' ? t.toLowerCase() : [...new Set(t.map(x => x.toLowerCase()))].sort().join('|'));
  while (topics.at(-1) === '*') topics.pop();
  return topics.length === 0 ? '' : `:${topics.join(',')}`;
}

/** A grouped family's page is one page for all its addresses (SH-190): no per-member copies fill the page bound. */
function pageKey(addresses: readonly Address[], event: AbiEvent, family?: readonly AbiEvent[], args?: LogTopics) {
  return `${addresses.map(a => a.toLowerCase()).sort().join(',')}:${(family ?? [event]).map(toEventSelector).sort().join(',')}${topicKey(event, args)}`;
}

type ErrorLink = { name?: unknown; message?: unknown; details?: unknown; code?: unknown; cause?: unknown } | undefined;
const chain = (error: unknown): NonNullable<ErrorLink>[] => {
  const out: NonNullable<ErrorLink>[] = [];
  for (let e = error as ErrorLink, depth = 0; e && depth < 8; e = e.cause as ErrorLink, depth++) out.push(e);
  return out;
};

type ErrorText = NonNullable<ErrorLink> & { status?: unknown };
const text = (e: ErrorText) => `${typeof e.message === 'string' ? e.message : ''} ${typeof e.details === 'string' ? e.details : ''}`;

/**
 * No answer from the node (rule 1): a timeout, a failed HTTP exchange (HTTP 429 among them), a JSON-RPC error with code
 * 429 or -32007, or code -32005 in rate words. Log discovery stops for the tick; such a read is never split. Any other
 * error is a refusal, whatever its words; probes decide whether it was about size.
 */
export function noAnswer(error: unknown): boolean {
  return chain(error).some(link => {
    const e = link as ErrorText;
    return e.name === 'TimeoutError' || e.name === 'HttpRequestError' || e.status === 429 || e.code === 429 || e.code === -32007
      || (e.code === -32005 && /\brate|capacity|too many requests|compute units/i.test(text(e)));
  });
}

/** This reader's own limits (time budget, tick query and row bounds, a stopped discovery): they are never split. */
const ownLimit = (error: unknown) => error instanceof IncomeValuationError
  || (error instanceof Error && ['income tick query capacity', 'income tick log capacity'].includes(error.message));
const missingKey = (p: Page) => [...(p.missing ?? [])].sort().join(',');
const stoppedError = () => new IncomeValuationError('INCOME_CAPACITY', 'income log discovery stopped');
const refusedError = () => new Error('income log page refused');
const pendingError = () => new IncomeValuationError('INCOME_CAPACITY', 'income log halving pending');
/** A refused range to halve once the tick's cheap reads are done (re-check N1); `grouped`: the range, not one address. */
interface Deferred {
  readonly grouped: boolean; readonly key: string; readonly address: Address; readonly addresses: readonly Address[];
  readonly event: AbiEvent; readonly from: bigint; readonly to: bigint; readonly family: readonly AbiEvent[] | undefined;
  readonly args: LogTopics | undefined; readonly topics: string;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Only committed after the finality recheck. Eviction causes a reread, never missing income. */
export class IncomeCache {
  /** `clock`, `budgetMs` and `sleep` are for tests; production uses Date.now, INCOME_READ_BUDGET_MS and a timer. */
  constructor(private readonly options: { readonly clock?: () => number; readonly budgetMs?: number;
    readonly sleep?: (ms: number) => Promise<void> } = {}) {}
  anchor: Header | null = null;
  /** Committed ticks so far: the box served first moves on by one each tick. */
  turn = 0;
  headers = new Map<bigint, Header>();
  pages: Page[] = [];
  /** Box-anchored receipts, by transaction: box events and authenticated payments only, never third-party rows. */
  receipts = new Map<string, Projection>();
  /** Direct calls behind tipped events, by transaction and target ABI. */
  calls = new Map<string, IncomeCall>();
  /** The last committed read's counts. */
  reads: IncomeReads | null = null;
  // Staged reads keep a bounded query memo even if retained coverage is evicted.
  private queries: Map<string, Promise<unknown>> | null = null;
  private queryCount = 0;
  private queryRows = 0;
  private discoveryQueries = 0;
  private discoveryOwners: ReadonlyMap<string, string> = new Map();
  private discoveryTotal = 0;
  private readonly discoveryFailed = new Set<string>();
  /** Boxes whose own address the node refused even for one block alone this tick. */
  private readonly discoveryRefused = new Set<string>();
  private incompleteAnswers = 0;
  /** Rule 1 this tick: no new log query; what was read is kept and the next tick resumes. Never carried to a later tick. */
  private halted = false;
  private unexplained = 0;
  private lastLog: number | null = null;
  /**
   * From deferHalving() to halveDeferred(): the tick's cheap reads and every box's own reads. Nothing is halved then
   * (refused ranges wait in `deferred`), and a refusal is believed only when given twice.
   */
  private deferring = false;
  private readonly deferred: Deferred[] = [];
  /** Boxes with a range waiting to be halved: they count INCOME_CAPACITY this tick, never a silent zero. */
  private readonly waiting = new Set<string>();
  private deadline: number | null = null;
  private readonly rejectedHeaders = new Set<bigint>();
  private owner: string | null = null;
  private readsLeft = INCOME_CACHE_PAGES;
  private receiptRowsLeft = INCOME_CACHE_LOGS;
  private readonly boxReads = new Map<string, IncomeBoxReads>();

  clear() { this.anchor = null; this.headers.clear(); this.pages = []; this.receipts.clear(); this.calls.clear(); }

  /** Each part (lower case) to its box's receiver key: one box's three parts share its discovery rows. */
  boundDiscovery(owners: ReadonlyMap<string, string>) {
    this.discoveryOwners = owners;
  }

  /**
   * Before a box's receipt and transaction reads: at most 64, and the fair share of the tick's remaining queries and
   * rows among the boxes that still have something unread (`needing`, this one included when it has), never less
   * than one read while queries remain.
   */
  allocateReads(owner: string, needing: number) {
    this.owner = owner;
    const remaining = INCOME_CACHE_PAGES - this.queryCount;
    this.readsLeft = remaining <= 0 ? 0 : Math.min(INCOME_BOX_READS, Math.max(1, Math.floor(remaining / Math.max(1, needing))));
    this.receiptRowsLeft = Math.floor((INCOME_CACHE_LOGS - this.queryRows) / Math.max(1, needing));
    const stats = this.stats(owner);
    stats.readsLimit = this.readsLeft; stats.receiptRowsLimit = this.receiptRowsLeft;
  }

  keptReceipt(tx: Hex) { return this.receipts.has(`receipt:${tx}`); }
  keptCall(tx: Hex, kind: string) { return this.calls.has(`call:${tx}:${kind}`); }

  private now() { return (this.options.clock ?? Date.now)(); }

  /** The time budget: past it, no new query or header read starts this tick. */
  private checkTime() {
    if (this.deadline !== null && this.now() >= this.deadline) throw new IncomeValuationError('INCOME_CAPACITY', 'income tick time budget');
  }

  private stats(owner: string): IncomeBoxReads {
    let s = this.boxReads.get(owner);
    if (!s) {
      s = { rows: 0, rowsLimit: INCOME_DISCOVERY_LOGS, reads: 0, readsLimit: 0, receiptRows: 0, receiptRowsLimit: 0 };
      this.boxReads.set(owner, s);
    }
    return s;
  }

  async begin(pub: PublicClient, final: Header) {
    if (this.anchor) {
      const known = this.anchor.number === final.number ? final : await pub.getBlock({ blockNumber: this.anchor.number });
      if (final.number < this.anchor.number || known.hash !== this.anchor.hash) {
        this.clear();
        throw new Error('income finality changed');
      }
    }
    const work = new IncomeCache(this.options);
    work.queries = new Map();
    work.turn = this.turn;
    work.deadline = work.now() + (this.options.budgetMs ?? INCOME_READ_BUDGET_MS);
    work.headers = new Map(this.headers);
    work.headers.set(final.number, final);
    work.trimHeaders();
    work.pages = [...this.pages];
    work.receipts = new Map(this.receipts);
    work.calls = new Map(this.calls);
    return work;
  }

  private add(page: Page) {
    const siblings = [...this.pages.filter(p => p.key === page.key), page]
      .sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0);
    const merged: Page[] = [];
    for (const next of siblings) {
      const last = merged.at(-1);
      // Pages that leave out different boxes stay apart, so a left-out box is read on its own only where it was left out.
      if (last && next.from <= last.to + 1n && missingKey(last) === missingKey(next)) {
        last.to = last.to > next.to ? last.to : next.to;
        last.rows = [...new Map([...last.rows, ...next.rows].map(r => [`${r.transactionHash}:${r.logIndex}`, r])).values()];
      } else merged.push({ ...next, rows: [...new Map(next.rows.map(r => [`${r.transactionHash}:${r.logIndex}`, r])).values()] });
    }
    this.pages = [...this.pages.filter(p => p.key !== page.key), ...merged];
    while (this.pages.length > INCOME_CACHE_PAGES || this.pages.reduce((sum, p) => sum + p.rows.length, 0) > INCOME_CACHE_LOGS) this.pages.shift();
  }

  private trimHeaders() {
    while (this.headers.size > INCOME_CACHE_HEADERS) {
      const oldest = this.headers.keys().next().value;
      if (oldest === undefined) break;
      this.headers.delete(oldest);
    }
  }

  async header(pub: PublicClient, number: bigint): Promise<Header> {
    let value = this.headers.get(number);
    if (!value) {
      if (this.queries) this.checkTime();
      const block = await pub.getBlock({ blockNumber: number });
      if (block.number !== number || !block.hash) throw new Error('income block unavailable');
      value = { number, hash: block.hash, timestamp: block.timestamp };
      this.headers.set(number, value);
      this.trimHeaders();
    }
    return value;
  }

  async canonicalHeader(pub: PublicClient, row: Pick<ReceiptLog, 'blockNumber' | 'blockHash'>): Promise<Header | null> {
    const block = await this.header(pub, row.blockNumber);
    if (block.hash === row.blockHash) return block;
    // Either RPC answer may be stale. Keep the header within this read for query
    // deduplication, but discard it and every covering interval at commit.
    this.rejectedHeaders.add(row.blockNumber);
    return null;
  }

  private takeQuery() {
    if (!this.queries) return;
    this.checkTime();
    if (this.queryCount >= INCOME_CACHE_PAGES) throw new Error('income tick query capacity');
    this.queryCount++;
  }

  async logs(pub: PublicClient, address: Address, event: AbiEvent, from: bigint, to: bigint, family?: readonly AbiEvent[],
    addresses: readonly Address[] = [address], args?: LogTopics): Promise<readonly ReceiptLog[]> {
    const owner = this.ownerOf(address);
    this.stopped(owner);
    // viem encodes `args` only for one event; a filtered read is never part of a grouped query.
    if (args && (family || addresses.length !== 1)) throw new Error('income log filter needs one event and one address');
    const key = pageKey(addresses, event, family, args);
    const matches = (l: ReceiptLog) => l.address.toLowerCase() === address.toLowerCase() && (!family || l.eventName === event.name);
    const found = this.pages.find(p => p.key === key && p.from <= from && p.to >= to);
    if (found && !found.missing?.has(owner)) return this.served(pub, found, from, to, matches);
    // A kept page that left this box out: this address alone, where its own kept pieces leave a gap; the others keep the page.
    if (found && addresses.length > 1) {
      const rows: ReceiptLog[] = [];
      for (let start = from; start <= to;) {
        const end = this.endOfPage(address, event, start, to, args, family, [address]);
        rows.push(...await this.logs(pub, address, event, start, end, family, [address], args));
        start = end + 1n;
      }
      return rows;
    }
    const queryKey = `${key}:${from}:${to}`;
    let query = this.queries?.get(queryKey) as Promise<readonly ReceiptLog[]> | undefined;
    if (!query) {
      query = this.page(pub, key, address, addresses, event, from, to, family, args, topicKey(event, args));
      this.queries?.set(queryKey, query);
    }
    const rows = await query;
    this.stopped(owner);
    return rows.filter(matches);
  }

  /** A box left out this tick (past its rows, or refused alone) fails on every later read of the tick, alone. */
  private stopped(owner: string) {
    if (this.discoveryFailed.has(owner)) throw new Error('income tick log capacity');
    if (this.discoveryRefused.has(owner)) throw refusedError();
    if (this.waiting.has(owner)) throw pendingError();
  }

  /** A kept page's rows in a range (those `wanted`), each on a canonical block. */
  private async served(pub: PublicClient, page: Page, from: bigint, to: bigint, wanted: (l: ReceiptLog) => boolean = () => true) {
    const valid: ReceiptLog[] = [];
    for (const row of page.rows) if (wanted(row) && row.blockNumber >= from && row.blockNumber <= to
      && await this.canonicalHeader(pub, row)) valid.push(row);
    return valid;
  }

  private ownerOf(a: string) { return this.discoveryOwners.get(a.toLowerCase()) ?? a.toLowerCase(); }

  /**
   * Max-min share of the tick's discovery rows over the boxes with rows in this answer, smallest first: a box whose rows
   * exceed what is left divided by the boxes still to serve is left out this tick (largest first), whatever number of
   * boxes is registered. Returns the rows kept and the boxes left out of this answer.
   */
  private charge(valid: readonly ReceiptLog[]): { rows: ReceiptLog[]; missing: Set<string> } {
    const counts = new Map<string, number>();
    for (const row of valid) {
      const owner = this.ownerOf(row.address);
      if (!this.discoveryFailed.has(owner)) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    }
    const order = [...counts].sort((a, b) => a[1] - b[1]);
    for (const [i, [owner, count]] of order.entries()) {
      if (count > Math.floor((INCOME_DISCOVERY_LOGS - this.discoveryTotal) / (order.length - i))) {
        for (const [later] of order.slice(i)) this.discoveryFailed.add(later);
        break;
      }
      this.discoveryTotal += count;
      if (this.discoveryOwners.size > 0) this.stats(owner).rows += count;
    }
    const missing = new Set(valid.map(row => this.ownerOf(row.address)).filter(o => this.discoveryFailed.has(o)));
    return { rows: valid.filter(row => !this.discoveryFailed.has(this.ownerOf(row.address))), missing };
  }

  /**
   * One grouped (or single) page of the walk. A refusal of a range is about size when its first or last block alone is
   * answered (rule 2); then each address is asked alone over the range, and only an address still refused has its range
   * halved (rule 3). A range neither probe explains stops log discovery for the tick (rule 1).
   */
  private async page(pub: PublicClient, key: string, address: Address, addresses: readonly Address[], event: AbiEvent,
    from: bigint, to: bigint, family: readonly AbiEvent[] | undefined, args: LogTopics | undefined, topics: string): Promise<ReceiptLog[]> {
    try {
      return await this.ask(pub, key, address, addresses, event, from, to, family, args, topics);
    } catch (error) {
      if (ownLimit(error)) throw error;
      if (from < to && !await this.probe(pub, address, addresses, event, from, family, args, topics)
        && !await this.probe(pub, address, addresses, event, to, family, args, topics)) {
        this.unexplained++;
        this.halted = true;
        throw stoppedError();
      }
      if (addresses.length > 1) return this.alone(pub, key, addresses, event, from, to, family, args, topics);
      // A single block refused alone is left out at once (no query); a range waits for halving.
      if (this.deferring && from < to) {
        this.deferred.push({ grouped: false, key, address, addresses, event, from, to, family, args, topics });
        this.waiting.add(this.ownerOf(address));
        throw pendingError();
      }
      return this.halve(pub, address, event, from, to, family, args, topics);
    }
  }

  /**
   * The cheap reads of one page (re-check N1): its grouped query, the probes and the single-address queries, for every
   * page of every family before anything is halved. What must be halved waits for halveDeferred(). Throws only when no
   * query can be sent this tick (rule 1, the time budget or the tick's queries).
   */
  async discover(pub: PublicClient, address: Address, event: AbiEvent, from: bigint, to: bigint, family: readonly AbiEvent[],
    addresses: readonly Address[]): Promise<void> {
    const key = pageKey(addresses, event, family);
    const queryKey = `${key}:${from}:${to}`;
    if (this.pages.some(p => p.key === key && p.from <= from && p.to >= to) || this.queries?.has(queryKey)) return;
    const query = this.page(pub, key, address, addresses, event, from, to, family, undefined, '');
    this.queries?.set(queryKey, query);
    try {
      await query;
    } catch (error) {
      if (ownLimit(error) && !(error instanceof Error && error.message === 'income log halving pending')) throw error;
    }
  }

  /** Halving last (re-check of 5cc707d9f): from here until halveDeferred(), refused ranges wait and are asked twice. */
  deferHalving() { this.deferring = true; }

  /** After every box's own reads of the tick: halve what was refused, in order, with what is left of the tick. */
  async halveDeferred(pub: PublicClient): Promise<void> {
    this.deferring = false;
    for (const d of this.deferred.splice(0)) {
      try {
        if (d.grouped) await this.halveGrouped(pub, d.key, d.addresses, d.event, d.from, d.to, d.family, d.args, d.topics);
        else await this.halve(pub, d.address, d.event, d.from, d.to, d.family, d.args, d.topics);
      } catch (error) {
        // Out of queries, time or answers: these boxes are not fully read this tick. A box left out is marked already.
        if (ownLimit(error)) for (const a of d.grouped ? d.addresses : [d.address]) this.discoveryFailed.add(this.ownerOf(a));
      }
    }
  }

  /**
   * One getLogs request, paced: at least INCOME_LOG_GAP_MS after the previous one, inside the tick's 512 queries and its
   * time budget. No answer (rule 1) stops log discovery for the rest of the tick.
   */
  private async query(pub: PublicClient, address: Address, addresses: readonly Address[], event: AbiEvent, from: bigint, to: bigint,
    family: readonly AbiEvent[] | undefined, args: LogTopics | undefined, topics: string): Promise<unknown> {
    if (this.halted) throw stoppedError();
    const once = async () => {
      this.takeQuery();
      if (this.queries) {
        this.discoveryQueries++;
        const since = this.lastLog === null ? null : this.now() - this.lastLog;
        if (since !== null && since < INCOME_LOG_GAP_MS) await (this.options.sleep ?? sleep)(INCOME_LOG_GAP_MS - since);
        this.lastLog = this.now();
      }
      try {
        return await pub.getLogs({ address: addresses.length === 1 ? address : [...addresses],
          ...(family ? { events: family } : { event, ...(topics ? { args } : {}) }), fromBlock: from, toBlock: to, strict: true });
      } catch (error) {
        if (noAnswer(error)) {
          this.halted = true;
          throw stoppedError();
        }
        throw error;
      }
    };
    try {
      return await once();
    } catch (error) {
      // Outside halving a refusal is believed only when given twice (an erratic node answers the second time).
      if (ownLimit(error) || !this.deferring) throw error;
      return once();
    }
  }

  /** Rule 2's probe: one block alone, same addresses and topics. Its rows only answer whether the block is served. */
  private async probe(pub: PublicClient, address: Address, addresses: readonly Address[], event: AbiEvent, block: bigint,
    family: readonly AbiEvent[] | undefined, args: LogTopics | undefined, topics: string): Promise<boolean> {
    try {
      await this.query(pub, address, addresses, event, block, block, family, args, topics);
      return true;
    } catch (error) {
      if (ownLimit(error)) throw error;
      return false;
    }
  }

  /** One answered query: its rows validated, zero rows dropped, charged, and kept as a page when complete. */
  private async ask(pub: PublicClient, key: string, address: Address, addresses: readonly Address[], event: AbiEvent,
    from: bigint, to: bigint, family: readonly AbiEvent[] | undefined, args: LogTopics | undefined, topics: string): Promise<ReceiptLog[]> {
    let result: unknown;
    try {
      result = await this.query(pub, address, addresses, event, from, to, family, args, topics);
    } catch (error) {
      // Rule 4: one block refused for one address alone is not explained as size.
      if (!ownLimit(error) && addresses.length === 1 && from === to && ++this.unexplained > INCOME_UNEXPLAINED_REFUSALS) {
        this.halted = true;
        throw stoppedError();
      }
      throw error;
    }
    let valid: ReceiptLog[] = [];
    let complete = true;
    for (const row of result as ReceiptLog[]) {
      if (row.removed || typeof row.blockNumber !== 'bigint' || row.blockNumber < from || row.blockNumber > to
        || !row.transactionHash || !Number.isSafeInteger(row.logIndex) || row.logIndex < 0
        || !addresses.some(a => row.address?.toLowerCase() === a.toLowerCase())
        || (family && !family.some(e => e.name === row.eventName))) {
        complete = false;
        continue;
      }
      if (!await this.canonicalHeader(pub, row)) {
        complete = false;
        continue;
      }
      // Even a zero row can expose an orphaned page: validate first, then drop it without charging any budget.
      // A zero row carries no income; token collection boundaries come from the paying transaction's receipt.
      if (family && row.args?.[incomeAmounts[row.eventName ?? ''] ?? ''] === 0n) continue;
      valid.push(row);
    }
    let missing = new Set<string>();
    if (this.queries) {
      if (this.discoveryOwners.size > 0) ({ rows: valid, missing } = this.charge(valid));
      if (this.queryRows + valid.length > INCOME_CACHE_LOGS) throw new Error('income tick log capacity');
      this.queryRows += valid.length;
    }
    // A rejected row can conceal a corrected event: keep valid credits for this tick, but never mark any part of that
    // query covered. A box left out of this answer is marked on the kept page; the other boxes keep it (SH-247).
    if (!complete) this.incompleteAnswers++;
    else if (valid.length <= INCOME_CACHE_LOGS && !(addresses.length === 1 && missing.size > 0)) {
      this.add({ key, from, to, rows: valid, ...(missing.size ? { missing } : {}) });
    }
    return valid;
  }

  /**
   * Rule 3: each address alone over the range, served from its own kept pieces where it has them, before any range is
   * halved, so every box that fits is read in this tick. An address still refused is halved; a box left out, or stopped,
   * is marked on the kept page and the other boxes keep it.
   */
  private async alone(pub: PublicClient, key: string, addresses: readonly Address[], event: AbiEvent, from: bigint, to: bigint,
    family: readonly AbiEvent[] | undefined, args: LogTopics | undefined, topics: string): Promise<ReceiptLog[]> {
    const before = this.incompleteAnswers;
    const rows: ReceiptLog[] = [];
    const refused: { address: Address; from: bigint; to: bigint }[] = [];
    let read = 0;
    const out = (a: Address, error: unknown) => {
      if (ownLimit(error)) this.discoveryFailed.add(this.ownerOf(a));
      else this.discoveryRefused.add(this.ownerOf(a));
    };
    for (const a of addresses) {
      if (this.discoveryFailed.has(this.ownerOf(a)) || this.discoveryRefused.has(this.ownerOf(a))) continue;
      const own = pageKey([a], event, family, args);
      for (let start = from; start <= to;) {
        const end = this.endOfPage(a, event, start, to, args, family, [a]);
        const found = this.pages.find(p => p.key === own && p.from <= start && p.to >= end);
        try {
          rows.push(...found ? await this.served(pub, found, start, end) : await this.ask(pub, own, a, [a], event, start, end, family, args, topics));
          read++;
        } catch (error) {
          if (ownLimit(error)) { out(a, error); break; }
          refused.push({ address: a, from: start, to: end });
        }
        start = end + 1n;
      }
    }
    // Every address refused alone: the range is the cause, not one box's rows. The grouped range is halved instead.
    if (read === 0 && refused.length > 0 && from < to) {
      if (!this.deferring) return this.halveGrouped(pub, key, addresses, event, from, to, family, args, topics);
      this.deferred.push({ grouped: true, key, address: refused[0]?.address ?? addresses[0] ?? ('0x' as Address), addresses, event, from, to,
        family, args, topics });
      for (const a of addresses) this.waiting.add(this.ownerOf(a));
      throw pendingError();
    }
    for (const r of refused) {
      if (this.discoveryFailed.has(this.ownerOf(r.address))) continue;
      if (this.deferring && r.from < r.to) {
        this.deferred.push({ grouped: false, key: pageKey([r.address], event, family, args), address: r.address, addresses: [r.address],
          event, from: r.from, to: r.to, family, args, topics });
        this.waiting.add(this.ownerOf(r.address));
        continue;
      }
      try { rows.push(...await this.halve(pub, r.address, event, r.from, r.to, family, args, topics)); }
      catch (error) { out(r.address, error); }
    }
    // An address waiting to be halved is left out of the kept page like a refused one; its own pieces serve it once halved.
    const missing = new Set(addresses.map(a => this.ownerOf(a))
      .filter(o => this.discoveryRefused.has(o) || this.discoveryFailed.has(o) || this.waiting.has(o)));
    const kept = rows.filter(row => !missing.has(this.ownerOf(row.address)));
    // A page that serves no address is not kept: the next tick asks the grouped range again, not every address alone.
    if (this.incompleteAnswers === before && read > 0) this.add({ key, from, to, rows: kept, ...(missing.size ? { missing } : {}) });
    return kept;
  }

  /**
   * Rule 3 for one address whose range was refused: halves, each its own query and kept piece, down to a single block.
   * A single block refused for the address alone is left out; that box alone misses it (the refusal counted toward
   * INCOME_UNEXPLAINED_REFUSALS in ask()). The other half is still read, so the next tick asks only what is left.
   */
  private async halve(pub: PublicClient, address: Address, event: AbiEvent, from: bigint, to: bigint,
    family: readonly AbiEvent[] | undefined, args: LogTopics | undefined, topics: string): Promise<ReceiptLog[]> {
    if (from === to) {
      this.discoveryRefused.add(this.ownerOf(address));
      throw refusedError();
    }
    const key = pageKey([address], event, family, args);
    const mid = from + (to - from) / 2n;
    const rows: ReceiptLog[] = [];
    // Both halves are asked before either is halved again, so a stop deeper down never leaves a sibling unread.
    const halves: (readonly [bigint, bigint])[] = [];
    for (const [lo, hi] of [[from, mid], [mid + 1n, to]] as const) {
      try { rows.push(...await this.ask(pub, key, address, [address], event, lo, hi, family, args, topics)); }
      catch (error) {
        if (ownLimit(error)) throw error;
        halves.push([lo, hi]);
      }
    }
    let refused: unknown = null;
    for (const [lo, hi] of halves) {
      try { rows.push(...await this.halve(pub, address, event, lo, hi, family, args, topics)); }
      catch (error) {
        if (ownLimit(error)) throw error;
        refused ??= error;
      }
    }
    if (refused) throw refused;
    return rows;
  }

  /**
   * A range every address was refused for alone (re-check N3): the grouped range is halved, each half one grouped query
   * and kept piece; the addresses are asked alone again only at a single block, where rule 3 leaves out each refused box.
   */
  private async halveGrouped(pub: PublicClient, key: string, addresses: readonly Address[], event: AbiEvent, from: bigint, to: bigint,
    family: readonly AbiEvent[] | undefined, args: LogTopics | undefined, topics: string): Promise<ReceiptLog[]> {
    if (from === to) return this.alone(pub, key, addresses, event, from, to, family, args, topics);
    const first = addresses[0];
    if (!first) return [];
    const mid = from + (to - from) / 2n;
    const rows: ReceiptLog[] = [];
    // Both halves are asked before either is halved again, so a stop deeper down never leaves a sibling unread.
    const halves: (readonly [bigint, bigint])[] = [];
    for (const [lo, hi] of [[from, mid], [mid + 1n, to]] as const) {
      try { rows.push(...await this.ask(pub, key, first, addresses, event, lo, hi, family, args, topics)); }
      catch (error) {
        if (ownLimit(error)) throw error;
        halves.push([lo, hi]);
      }
    }
    for (const [lo, hi] of halves) rows.push(...await this.halveGrouped(pub, key, addresses, event, lo, hi, family, args, topics));
    return rows;
  }

  /** Reuse even the last partial page; only newly finalized blocks are queried next time. */
  endOfPage(address: Address, event: AbiEvent, from: bigint, final: bigint, args?: LogTopics,
    family?: readonly AbiEvent[], addresses: readonly Address[] = [address]) {
    const key = pageKey(addresses, event, family, args);
    const found = this.pages.find(p => p.key === key && p.from <= from && p.to >= from);
    let end = found?.to ?? from + 1999n;
    for (const p of this.pages) if (p.key === key && p.from > from && p.from <= end) end = p.from - 1n;
    return end < final ? end : final;
  }

  /** A new receipt or transaction read, paid from the current box's allowance and the tick's query bound. */
  private takeRead() {
    if (this.readsLeft <= 0) throw new IncomeProofPending();
    this.takeQuery();
    this.readsLeft--;
    if (this.owner !== null) this.stats(this.owner).reads++;
  }

  /** Only box-anchored transactions enter this memo. Retain the authenticated projection, never third-party rows. */
  async receipt(pub: PublicClient, anchor: ReceiptLog, scope: (rows: readonly ReceiptLog[]) => string,
    usable: (rows: readonly ReceiptLog[]) => boolean,
    project: (receipt: TransactionReceipt) => { rows: readonly ReceiptLog[]; complete: boolean }): Promise<readonly ReceiptLog[]> {
    const key = `receipt:${anchor.transactionHash}`;
    // This tick's own read of the transaction comes first: every box of the tick sees the same rows.
    let query = this.queries?.get(key) as Promise<readonly ReceiptLog[]> | undefined;
    if (query) return query;
    const found = this.receipts.get(key);
    if (found && found.blockNumber === anchor.blockNumber && found.blockHash === anchor.blockHash
      && found.scope === scope(found.rows) && usable(found.rows) && await this.canonicalHeader(pub, found)) {
      this.receipts.delete(key);
      this.receipts.set(key, found); // Refresh on use; retained capacity follows rows in the window.
      return found.rows;
    }
    this.takeRead();
    // A kept projection that cannot serve this box is dropped once the transaction is read again (review F5).
    if (found) this.receipts.delete(key);
    const owner = this.owner;
    query = (async () => {
      const receipt = await pub.getTransactionReceipt({ hash: anchor.transactionHash });
      if (receipt.status !== 'success' || receipt.transactionHash !== anchor.transactionHash
        || receipt.blockNumber !== anchor.blockNumber || receipt.blockHash !== anchor.blockHash || !Array.isArray(receipt.logs)) {
        throw new Error('income receipt unavailable or inconsistent');
      }
      const { rows, complete } = project(receipt);
      if (this.queries) {
        if (rows.length > this.receiptRowsLeft || this.queryRows + rows.length > INCOME_CACHE_LOGS) throw new Error('income tick log capacity');
        this.queryRows += rows.length;
        this.receiptRowsLeft -= rows.length;
        if (owner !== null) this.stats(owner).receiptRows += rows.length;
      }
      if (complete) {
        this.receipts.set(key, { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, scope: scope(rows), rows });
        while ([...this.receipts.values()].reduce((n, r) => n + r.rows.length, 0) > INCOME_CACHE_LOGS) {
          const oldest = this.receipts.keys().next().value;
          if (oldest === undefined) break;
          this.receipts.delete(oldest);
        }
      }
      return rows;
    })();
    // A failed read is retried next tick, never this tick: the memo keeps its refusal.
    this.queries?.set(key, query);
    return query;
  }

  /** The direct call behind a tipped event: `to` and the decoded first argument, read once per transaction. */
  async call(pub: PublicClient, l: ReceiptLog, kind: string, decode: (input: Hex) => { fn: string; arg0: unknown } | null): Promise<IncomeCall> {
    const key = `call:${l.transactionHash}:${kind}`;
    const found = this.calls.get(key);
    if (found) {
      this.calls.delete(key);
      this.calls.set(key, found);
      return found;
    }
    let query = this.queries?.get(key) as Promise<IncomeCall> | undefined;
    if (!query) {
      this.takeRead();
      query = (async () => {
        const tx = await pub.getTransaction({ hash: l.transactionHash });
        let decoded: { fn: string; arg0: unknown } | null = null;
        try { decoded = decode(tx.input); } catch { /* No authenticated beneficiary. */ }
        const call: IncomeCall = { blockNumber: l.blockNumber, to: typeof tx.to === 'string' ? tx.to.toLowerCase() : null,
          fn: decoded?.fn ?? null, arg0: typeof decoded?.arg0 === 'string' ? decoded.arg0.toLowerCase() : null };
        // Kept across ticks only when the answer names the transaction asked for, in the event's block (review F6);
        // otherwise it serves this tick alone, as on the line.
        const answer = tx as { hash?: unknown; blockHash?: unknown; blockNumber?: unknown };
        if (typeof answer.hash === 'string' && answer.hash.toLowerCase() === l.transactionHash.toLowerCase()
          && (answer.blockHash === null || answer.blockHash === undefined || answer.blockHash === l.blockHash)
          && (answer.blockNumber === null || answer.blockNumber === undefined || answer.blockNumber === l.blockNumber)) this.calls.set(key, call);
        while (this.calls.size > INCOME_CACHE_LOGS) {
          const oldest = this.calls.keys().next().value;
          if (oldest === undefined) break;
          this.calls.delete(oldest);
        }
        return call;
      })();
      this.queries?.set(key, query);
    }
    return query;
  }

  commit(work: IncomeCache, final: Header, from: bigint) {
    this.anchor = final;
    this.turn = work.turn + 1;
    this.headers = work.headers;
    for (const number of this.headers.keys()) if (number < from || number > final.number || work.rejectedHeaders.has(number)) this.headers.delete(number);
    const disputed = [...work.rejectedHeaders];
    this.receipts = new Map([...work.receipts].filter(([, r]) => r.blockNumber >= from && r.blockNumber <= final.number
      && !work.rejectedHeaders.has(r.blockNumber)));
    this.calls = new Map([...work.calls].filter(([, c]) => c.blockNumber >= from && c.blockNumber <= final.number));
    this.pages = work.pages.filter(p => p.to >= from && p.to <= final.number
      && !disputed.some(number => number >= p.from && number <= p.to))
      .map(p => ({ ...p, from: p.from < from ? from : p.from, rows: p.rows.filter(r => r.blockNumber >= from) }));
    this.reads = { discoveryQueries: work.discoveryQueries, queries: work.queryCount, rows: work.queryRows,
      boxes: Object.fromEntries(work.boxReads) };
  }
}
