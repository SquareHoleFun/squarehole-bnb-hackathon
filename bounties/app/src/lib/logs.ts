import { createPublicClient, fallback, http, type Abi, type AbiEvent, type Address, type PublicClient } from 'viem';
import { limitedFetch, pageLimiter, READ_TIMEOUT_MS } from './limiter';

/**
 * When the page has a history endpoint, it asks for all missing events up to that endpoint's head
 * in parallel windows of 5,000 blocks. If any read fails or there is no history endpoint, the page
 * uses its own endpoints. It asks for up to 50,000 blocks at a time. A rate refusal retries the same
 * window after a pause. Other refusals halve the window down to 5,000 blocks. Each poll picks up
 * where the last scan left off.
 */
export const WINDOW = 50_000n;
/** A head read serves every scan for this long (ms). */
export const HEAD_MS = 4_000;
/** How many times a window refused for its rate is tried again before the read fails. */
export const RATE_TRIES = 6;
export const MIN_WINDOW = 5_000n;

// Since 26 November 2026, PublicNode returns an empty list for events before block 145,000,000.
// BNB Chain's endpoint keeps those events and accepts up to 5,000 blocks per request.
const HISTORY_BY_FIRST_RPC = new Map([
  ['https://bsc-testnet-rpc.publicnode.com', { rpc: 'https://bsc-prebsc-dataseed.bnbchain.org', span: 5_000n }],
]);

interface Scanned {
  to: bigint;
  logs: unknown[];
}
const scanned = new Map<string, Scanned>();
/** Only one scan per key at a time: a poll that comes while one runs waits for it. */
const running = new Map<string, Promise<unknown[]>>();

export interface EventQuery {
  /** One contract, or a few in one query (SH-288: a wallet's cards in the shop's collections; at most four). */
  address: Address | readonly Address[];
  abi: Abi;
  eventName: string;
  args?: Record<string, unknown>;
  fromBlock: bigint;
}

function keyOf(q: EventQuery): string {
  return [[q.address].flat().map((a) => a.toLowerCase()).sort().join(','), q.eventName, JSON.stringify(q.args ?? {}, (_k, v) => (typeof v === 'string' ? v.toLowerCase() : v)), q.fromBlock.toString()].join('|');
}

/** The decoded events of `q` from its first block to the head, read in windows. */
export async function readEvents<T = unknown>(c: PublicClient, q: EventQuery): Promise<T[]> {
  return scanOnce<T>(c, keyOf(q), q.fromBlock, (lc, fromBlock, toBlock) =>
    lc.getContractEvents({ address: q.address, abi: q.abi, eventName: q.eventName, args: q.args, fromBlock, toBlock } as never) as Promise<unknown[]>,
  );
}

/**
 * SH-303: several contracts' events of several kinds in ONE query per window (eth_getLogs with the addresses and the
 * events' topics), kept and read on like `readEvents`. Each log comes decoded with its `eventName` and `args`.
 */
export interface ManyQuery {
  address: readonly Address[];
  events: readonly AbiEvent[];
  fromBlock: bigint;
}
export async function readEventsMany<T = unknown>(c: PublicClient, q: ManyQuery): Promise<T[]> {
  const key = ['many', [...q.address].map((a) => a.toLowerCase()).sort().join(','), q.events.map((e) => e.name).sort().join(','), q.fromBlock.toString()].join('|');
  return scanOnce<T>(c, key, q.fromBlock, (lc, fromBlock, toBlock) =>
    lc.getLogs({ address: [...q.address], events: [...q.events], fromBlock, toBlock } as never) as Promise<unknown[]>,
  );
}

type Window = (c: PublicClient, fromBlock: bigint, toBlock: bigint) => Promise<unknown[]>;

async function scanOnce<T>(c: PublicClient, key: string, fromBlock: bigint, window: Window): Promise<T[]> {
  const busy = running.get(key);
  if (busy) return (await busy) as T[];
  const job = scan(c, key, fromBlock, window);
  running.set(key, job);
  try {
    return (await job) as T[];
  } finally {
    running.delete(key);
  }
}

/**
 * The client the windows are read with: the page's own endpoints (those admitted at start, in order), each tried
 * once per window with no transport retries, redirects or off-chain lookups.
 */
const logClients = new WeakMap<PublicClient, PublicClient>();
function logClientOf(c: PublicClient): PublicClient {
  const had = logClients.get(c);
  if (had) return had;
  const urls = c.chain?.rpcUrls.default.http ?? [];
  const transports = urls.map((u) => http(u, { retryCount: 0, batch: false, timeout: READ_TIMEOUT_MS, fetchOptions: { redirect: 'error' }, fetchFn: limitedFetch() }));
  const made = transports.length
    ? createPublicClient({ chain: c.chain, ccipRead: false, transport: transports.length === 1 ? transports[0]! : fallback(transports, { retryCount: 0 }) })
    : c;
  logClients.set(c, made);
  return made;
}

let historyClients = new WeakMap<PublicClient, { client: PublicClient; chainId?: Promise<number> }>();
async function historyClientOf(app: PublicClient, rpc: string): Promise<PublicClient> {
  let entry = historyClients.get(app);
  if (!entry) {
    const client = createPublicClient({
      chain: app.chain,
      ccipRead: false,
      transport: http(rpc, { batch: true, retryCount: 0, timeout: READ_TIMEOUT_MS, fetchOptions: { redirect: 'error' }, fetchFn: limitedFetch() }),
    });
    entry = { client };
    historyClients.set(app, entry);
  }
  try {
    entry.chainId ??= entry.client.getChainId();
    if (await entry.chainId !== app.chain?.id) throw new Error('History endpoint returned a different chain ID');
  } catch (error) {
    entry.chainId = undefined;
    throw error;
  }
  return entry.client;
}

const heads = new WeakMap<PublicClient, { at: number; epoch: number; head: Promise<bigint> }>();
let headEpoch = 0;
/** A new round of reads (the page's poll or a press) reads the head again. */
export function forgetHead(): void {
  headEpoch += 1;
}
/** The head, read once for all scans of one round (within HEAD_MS). */
function headOf(c: PublicClient): Promise<bigint> {
  const had = heads.get(c);
  if (had && had.epoch === headEpoch && Date.now() - had.at < HEAD_MS) return had.head;
  const head = c.getBlockNumber({ cacheTime: 0 });
  heads.set(c, { at: Date.now(), epoch: headEpoch, head });
  head.catch(() => heads.delete(c));
  return head;
}

async function scan(app: PublicClient, key: string, fromBlock: bigint, window: Window): Promise<unknown[]> {
  const had = scanned.get(key);
  const logs = had ? [...had.logs] : [];
  let from = had ? had.to + 1n : fromBlock;
  const history = HISTORY_BY_FIRST_RPC.get(app.chain?.rpcUrls.default.http[0] ?? '');
  if (history) {
    try {
      const client = await historyClientOf(app, history.rpc);
      const head = await client.getBlockNumber({ cacheTime: 0 });
      if (from > head) return logs;

      const parts: Promise<unknown[]>[] = [];
      for (let start = from; start <= head; start += history.span) {
        const end = start + history.span - 1n;
        parts.push(window(client, start, end < head ? end : head));
      }
      const combined = logs.concat((await Promise.all(parts)).flat());
      scanned.set(key, { to: head, logs: combined });
      return [...combined];
    } catch {
      // Read the whole remaining range from the page's endpoints if any history read failed.
    }
  }

  const c = logClientOf(app);
  const head = await headOf(c);
  let size = WINDOW;
  let rateTries = 0;
  while (from <= head) {
    const to = from + size - 1n < head ? from + size - 1n : head;
    let got: unknown[];
    const round = pageLimiter.roundNow();
    try {
      got = await window(c, from, to);
    } catch (e) {
      if (pageLimiter.roundNow() > round) {
        // Another read can advance the round. The transport gates each retry unless a press holds it open.
        if (++rateTries > RATE_TRIES) throw e;
        continue;
      }
      if (size <= MIN_WINDOW) throw e;
      size = size / 2n > MIN_WINDOW ? size / 2n : MIN_WINDOW;
      continue;
    }
    rateTries = 0;
    logs.push(...got);
    // Kept window by window: a later failure does not lose what was read.
    scanned.set(key, { to, logs: [...logs] });
    from = to + 1n;
    if (size < WINDOW) size = size * 2n < WINDOW ? size * 2n : WINDOW;
  }
  return logs;
}

/** Forgets what was read (tests). */
export function forgetScans(): void {
  scanned.clear();
  historyClients = new WeakMap();
}
