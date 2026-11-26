/**
 * How the site reads core v1 boxes (S10a § 5, § 6): from the indexer's gateway when the build names one (one feed answer
 * for every card, BC-085; a box's snapshot; its activity; a wallet across boxes), otherwise straight from the chain at
 * one block (C19: the site works without our service). Every answer is checked by the indexer client's parsers and the
 * chain package's row decoder (the spec against its hash, Q against the version's list) before anything is shown, and
 * rows come only from the manifest's registries. Read-only: nothing here asks a wallet for anything.
 *
 * The indexer is an accelerator, never a single point of failure (C19; S10a review): when the build names one and it
 * does not answer (a network error, a 5xx, an answer that fails its checks), the feed, a box and a wallet are read from
 * the chain instead, and say so (`via: 'direct'`, with why). Only the indexer's own 404 for a box ("no shown box with
 * that token") is taken as its answer.
 *
 * Direct reads cost RPC calls, so: a registry row is read once and kept (a row never changes once its creation block
 * is final: 64 blocks deep here), and on Sepolia the views of one block go out batched through Multicall3 (the local
 * twin has none: one call each).
 */
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { boxRowToJson, readCoreBox, readCoreWallet, readRegistryRows, SEPOLIA_CHAIN_ID, viemChain, type BoxRow } from '@squarehole/chain';
import {
  directBoxView,
  feedCard,
  parseBoxView,
  parseFeedView,
  parseWalletView,
  type AsOf,
  type CoreBoxView,
  type FeedCard,
  type ParseOptions,
  type WalletBox,
} from '@squarehole/indexer/client';
import type { CoreSource } from './core-build';
import { DeadlineError, withDeadline } from './deadline';

export type ReadyCore = Extract<CoreSource, { status: 'ready' }>;

export interface CoreFeed {
  readonly via: 'indexer' | 'direct';
  readonly asOf: AsOf | null;
  readonly cards: readonly { readonly row: BoxRow; readonly card: FeedCard }[];
  /** Cards an answer carried that did not pass the checks (never shown). */
  readonly dropped: number;
  /** Why the build's indexer was not used (it did not answer), when the cards were read from the chain instead. */
  readonly indexerError?: string;
}

export interface CoreBox {
  readonly row: BoxRow;
  readonly view: CoreBoxView;
  readonly indexerError?: string;
}

export interface ActivityItem {
  readonly kind: string;
  readonly block: string;
  readonly logIndex: number;
  readonly txHash: string;
  readonly timestamp: string;
  /** Trades: side, Q and T raw amounts; other kinds: the event's own fields (decimal strings). */
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
}

export interface CoreWallet {
  readonly via: 'indexer' | 'direct';
  readonly asOf: AsOf | null;
  readonly boxes: readonly { readonly row: BoxRow; readonly box: WalletBox; readonly itemCount: bigint | null; readonly ticketCount: bigint | null }[];
  readonly indexerError?: string;
}

/** How the site asks the indexer: `init.signal` aborts the request (its deadline). */
export type Fetcher = (url: string, init?: { readonly signal?: AbortSignal | null }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * SH-SITE-FIXES-10: an indexer answer (headers and body) that has not come within this long counts as no answer: the
 * request is aborted and the read falls back to the chain, as when the indexer is down.
 */
export const INDEXER_DEADLINE_MS = 8_000;

/** The chain reads used without the indexer (a test seam: the default reads the source's RPC). */
export interface DirectReader {
  feed(core: ReadyCore): Promise<CoreFeed>;
  box(core: ReadyCore, token: string): Promise<CoreBox | null>;
  wallet(core: ReadyCore, address: Address): Promise<CoreWallet>;
}

export function parseOptionsOf(core: ReadyCore): ParseOptions {
  return {
    chainId: core.chainId,
    box0Registry: (core.version1?.registry.address ?? null) as `0x${string}` | null,
    registries: core.manifest.versions.map((v) => v.registry.address),
  };
}

/** The indexer did not answer usefully (the caller reads the chain instead). */
class IndexerUnavailable extends Error {
  override readonly name = 'IndexerUnavailable';
}

const why = (error: unknown): string => (error instanceof Error && error.message ? error.message : String(error));

/**
 * One indexer answer; anything but a usable 200 (and, where `notFound` is given, a 404) is IndexerUnavailable, and so is
 * no answer within INDEXER_DEADLINE_MS (SH-SITE-FIXES-10): its request is aborted then.
 */
async function fromIndexer<T>(fetcher: Fetcher, url: string, parse: (json: unknown) => T, notFound?: T): Promise<T> {
  try {
    return await withDeadline(INDEXER_DEADLINE_MS, undefined, async (deadline) => {
      let response: Awaited<ReturnType<Fetcher>>;
      try {
        response = await fetcher(url, { signal: deadline });
      } catch (error) {
        throw new IndexerUnavailable(`The indexer did not answer: ${why(error)}`);
      }
      if (response.status === 404 && notFound !== undefined) return notFound;
      if (!response.ok) throw new IndexerUnavailable(`The indexer answered ${response.status}.`);
      try {
        return parse(await response.json());
      } catch (error) {
        throw new IndexerUnavailable(`The indexer's answer failed its checks: ${why(error)}`);
      }
    });
  } catch (error) {
    if (error instanceof DeadlineError) throw new IndexerUnavailable(`The indexer did not answer: ${error.message}`);
    throw error;
  }
}

// ------------------------------------------------------------------------------------------------ direct reads

/** Blocks after which a registry row is final and kept (a reorg deeper than this is not expected on Sepolia). */
const ROW_FINAL_BLOCKS = 64n;
const clients = new Map<string, PublicClient>();
const rowCache = new Map<string, Map<bigint, BoxRow>>();

/** One client per source and RPC (Multicall3 batching on Sepolia, where it is deployed; the local twin has none). */
function clientOf(core: ReadyCore): PublicClient {
  const key = `${core.network}|${core.chainId}|${core.rpcUrl}`;
  const known = clients.get(key);
  if (known) return known;
  const transport = http(core.rpcUrl, { timeout: 10_000, retryCount: 1 });
  const client = (core.network === 'sepolia' && core.chainId === SEPOLIA_CHAIN_ID ? createPublicClient({ chain: viemChain(SEPOLIA_CHAIN_ID, [core.rpcUrl]), transport, batch: { multicall: true } }) : createPublicClient({ transport })) as PublicClient;
  clients.set(key, client);
  return client;
}

/** Every row the manifest's registries hold, at `block` (`recordOf` and each box's `BoxSpec` log; final rows kept). */
async function directRows(core: ReadyCore, client: PublicClient, block: bigint): Promise<readonly BoxRow[]> {
  const rows: BoxRow[] = [];
  for (const version of core.manifest.versions) {
    const key = `${core.network}|${core.chainId}|${version.registry.address.toLowerCase()}`;
    const cache = rowCache.get(key) ?? new Map<bigint, BoxRow>();
    rowCache.set(key, cache);
    const found = await readRegistryRows(client, version.registry.address, {
      chainId: core.chainId,
      box0Registry: core.version1?.registry.address ?? null,
      blockNumber: block,
      known: (id, at) => {
        const row = cache.get(id);
        return row && row.creationBlock + ROW_FINAL_BLOCKS <= at ? row : null;
      },
    });
    for (const row of found.rows) cache.set(row.boxId, row);
    rows.push(...found.rows.filter((row) => version.supportedTemplates.includes(row.templateId)));
  }
  return rows;
}

/** Test seam: forget the kept rows and clients. */
export function resetDirectCache(): void {
  clients.clear();
  rowCache.clear();
}

export const CHAIN_READER: DirectReader = {
  async feed(core) {
    const client = clientOf(core);
    const block = await client.getBlockNumber();
    const rows = await directRows(core, client, block);
    // Every box's views at the same block (batched through Multicall3 on Sepolia).
    const cards = await Promise.all(rows.map(async (row) => ({ row, card: feedCard(directBoxView(row, await readCoreBox(client, row, block))) })));
    return { via: 'direct', asOf: cards[0]?.card.asOf ?? null, cards, dropped: 0 };
  },
  async box(core, token) {
    const client = clientOf(core);
    const block = await client.getBlockNumber();
    const row = (await directRows(core, client, block)).find((r) => (r.contracts.token as string).toLowerCase() === token.toLowerCase());
    if (!row) return null;
    return { row, view: directBoxView(row, await readCoreBox(client, row, block)) };
  },
  async wallet(core, address) {
    const client = clientOf(core);
    const block = await client.getBlockNumber();
    const rows = await directRows(core, client, block);
    const boxes = await Promise.all(
      rows.map(async (row) => {
        const held = await readCoreWallet(client, row, address, block);
        const box: WalletBox = { token: (row.contracts.token as string).toLowerCase() as `0x${string}`, row: boxRowToJson(row), t: held.t.toString(), items: [], tickets: [], streamOwed: held.streamOwed?.toString() ?? null };
        return { row, box, itemCount: held.items, ticketCount: held.tickets };
      }),
    );
    return { via: 'direct', asOf: null, boxes: boxes.filter((b) => b.box.t !== '0' || (b.itemCount ?? 0n) > 0n || (b.ticketCount ?? 0n) > 0n || (b.box.streamOwed ?? '0') !== '0') };
  },
};

// ------------------------------------------------------------------------------------------------ the loaders

/** The feed: the indexer's one answer, or (no indexer, or it did not answer in time) every row read from the chain. */
export async function loadFeed(core: ReadyCore, fetcher: Fetcher = fetch, direct: DirectReader = CHAIN_READER): Promise<CoreFeed> {
  if (core.indexerOrigin) {
    try {
      const parsed = await fromIndexer(fetcher, `${core.indexerOrigin}/v1/feed?chain=${core.chainId}`, (json) => parseFeedView(json, parseOptionsOf(core)));
      return { via: 'indexer', asOf: parsed.asOf, cards: parsed.cards, dropped: parsed.dropped };
    } catch (error) {
      if (!(error instanceof IndexerUnavailable)) throw error;
      return { ...(await direct.feed(core)), indexerError: error.message };
    }
  }
  return direct.feed(core);
}

/** One box: the indexer's snapshot (its 404: not a shown box), or a direct read when there is no indexer or it is down. */
export async function loadBox(core: ReadyCore, token: string, fetcher: Fetcher = fetch, direct: DirectReader = CHAIN_READER): Promise<CoreBox | null> {
  if (core.indexerOrigin) {
    try {
      return await fromIndexer<CoreBox | null>(fetcher, `${core.indexerOrigin}/v1/boxes/${core.chainId}/${token.toLowerCase()}`, (json) => parseBoxView(json, parseOptionsOf(core)), null);
    } catch (error) {
      if (!(error instanceof IndexerUnavailable)) throw error;
      const box = await direct.box(core, token);
      return box ? { ...box, indexerError: error.message } : null;
    }
  }
  return direct.box(core, token);
}

const ITEM = /^[a-z_]{1,32}$/;
const UINT = /^\d{1,78}$/;

/** A box's activity, newest first (the indexer only: a direct read has no history; null then). */
export async function loadActivity(core: ReadyCore, token: string, fetcher: Fetcher = fetch): Promise<readonly ActivityItem[] | null> {
  if (!core.indexerOrigin) return null;
  let json: { items?: unknown };
  try {
    json = await fromIndexer(fetcher, `${core.indexerOrigin}/v1/boxes/${core.chainId}/${token.toLowerCase()}/activity?limit=30`, (value) => value as { items?: unknown });
  } catch (error) {
    // The indexer is down: the page says activity needs it (the box itself comes from the chain then).
    if (error instanceof IndexerUnavailable) return null;
    throw error;
  }
  if (!Array.isArray(json.items)) throw new Error('The activity answer has no items.');
  const out: ActivityItem[] = [];
  for (const raw of json.items as Record<string, unknown>[]) {
    const kind = raw.kind;
    if (typeof kind !== 'string' || !ITEM.test(kind) || typeof raw.block !== 'string' || !UINT.test(raw.block) || typeof raw.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.txHash)) continue;
    const data: Record<string, string | number | boolean | null> = {};
    if (kind === 'trade') {
      for (const key of ['side', 'route', 'qRaw', 'tRaw', 'taxQ']) {
        const v = raw[key];
        if (typeof v === 'string') data[key] = v;
      }
    } else if (typeof raw.data === 'object' && raw.data !== null) {
      for (const [key, v] of Object.entries(raw.data as Record<string, unknown>)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') data[key] = v;
    }
    out.push({ kind, block: raw.block, logIndex: Number(raw.logIndex ?? 0), txHash: raw.txHash, timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : '0', data });
  }
  return out;
}

/** What one address holds across the shown boxes, keyed by box address (BC-089); from the chain when the indexer is down. */
export async function loadWallet(core: ReadyCore, address: Address, fetcher: Fetcher = fetch, direct: DirectReader = CHAIN_READER): Promise<CoreWallet> {
  if (core.indexerOrigin) {
    try {
      const parsed = await fromIndexer(fetcher, `${core.indexerOrigin}/v1/wallets/${core.chainId}/${address.toLowerCase()}`, (json) => parseWalletView(json, parseOptionsOf(core)));
      return { via: 'indexer', asOf: parsed.asOf, boxes: parsed.boxes.map((b) => ({ ...b, itemCount: BigInt(b.box.items.length), ticketCount: BigInt(b.box.tickets.length) })) };
    } catch (error) {
      if (!(error instanceof IndexerUnavailable)) throw error;
      return { ...(await direct.wallet(core, address)), indexerError: error.message };
    }
  }
  return direct.wallet(core, address);
}
