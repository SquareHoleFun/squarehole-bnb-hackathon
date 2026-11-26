/**
 * The core v1/v2 service in one process (S10a): the chain pipeline (chain-indexer.ts), the head feed (websocket with a
 * polling fallback, heads.ts), the gateway (core-gateway.ts) and, when configured, the history writer feeding Postgres
 * (history/). Hot state lives in the pipeline's memory (`SH_STORE=memory` in the plan's live e2e); the gateway reads it
 * in process. Creator-signed links are stored separately; no wallet, no key, no transaction.
 */
import { boxItemStreamAbi } from '@squarehole/chain/abi';
import { decodeFunctionResult, encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { HeadFeed } from '../heads';
import { CANDLE_LIMIT } from './core-gateway';
import { CreateOptions } from './create-options';
import { candlesFromTrades } from './candles';
import { CoreChainIndexer, type CoreIndexerOptions, type CorePace, type HistoryMessage } from './chain-indexer';
import type { CoreGateway, ActivityPage, Candle, CandleInterval, CoreGatewaySource, GatewayHealth } from './core-gateway';
import type { CoreReader } from './core-reader';
import { boxRowToJson, isRowV2, isSetRowV2 } from './core-row';
import { CORE_WALLET_SCHEMA, type WalletBox, type WalletView } from './core-views';
import { balanceOf, drawsOf, itemsOf, ticketsOf, type CoreActivity, type CoreTrade } from './derive-core';
import { ClaimsGatewayV2 } from './v2/claims-gateway-v2';
import { WalletClaimsIndexV2 } from './v2/claims-index-v2';
import type { ClaimsReaderV2 } from './v2/claims-reads-v2';
import type { DeployedCoreManifest } from '@squarehole/chain';
import type { HistoryHealth } from '../history/writer';
import type { LinksService } from '../links/links-service';
import { LinksV2, type Erc1271Verifier } from './v2/links-v2';
import { PictureHints } from '../pictures/hints';
import type { PictureCopiesService } from '../pictures/service';
import type { HistoryActivityOptions } from '../history/types';
import type { BoxPrices } from './atlas-prices';

/** What the gateway may ask the history store (Postgres or memory) instead of the pipeline's recent rows. */
export interface HistoryQuery {
  readonly version: bigint;
  activityPage(chainId: number, token: string, options: HistoryActivityOptions): Promise<ActivityPage['items']>;
  candles(chainId: number, token: string, interval: CandleInterval, limit?: number): Promise<readonly Candle[]>;
}

export interface CoreServiceOptions {
  /** SH-266: Atlas prices for the box view's `prices` block (chain 97); absent: no such block. */
  readonly prices?: BoxPrices;
  /** Checked once by core-main from the environment; omitted callers retain packaged Create lists. */
  readonly createOptionsDirectory?: URL;
  readonly setManifest?: CoreIndexerOptions['setManifest'];
  readonly pictures?: PictureCopiesService;
  readonly links?: LinksService;
  readonly linksVerifier?: Erc1271Verifier;
  readonly manifest: DeployedCoreManifest & { readonly releases?: CoreIndexerOptions['manifest']['releases'] };
  readonly reader: CoreReader;
  /** Same-chain canonical claims reads. Supply claimsRpcReaderV2 for sender-aware creator quotes.
   * Without it, reader is used; unsupported creator simulations fail explicitly instead of omitting money. */
  readonly claimsReader?: ClaimsReaderV2;
  readonly port: number;
  readonly host: string;
  readonly wsUrls?: readonly string[];
  readonly pollMs?: number;
  readonly wsSilenceMs?: number;
  readonly auditEvery?: number;
  /** Catch-up pacing for the chain's block time (core-config.ts SH_CORE_BLOCK_MS; default the 12-second pace). */
  readonly pace?: CorePace;
  /** The history writer's intake (step 7) and the store it answers from. */
  readonly onHistory?: (message: HistoryMessage) => void | Promise<void>;
  readonly history?: HistoryQuery | null;
  /** Snapshots are Stale once the chain was not heard from for this long (ms; default 60 s, about five blocks). */
  readonly healthyWithinMs?: number;
  /** The history writer's health, for /healthz. */
  readonly historyHealth?: (() => HistoryHealth) | null;
  /** An item's committed picture, verified bytes only (art.ts `loadArt`); no picture decides a listing. */
  readonly itemArt?: (sha256: Hex) => Promise<Uint8Array | null>;
  /** The gateway's stream cap per client and the proxies whose X-Forwarded-For names the client (core-gateway.ts). */
  readonly maxStreamsPerClient?: number;
  readonly trustedProxies?: readonly string[];
}

export interface RunningCoreService {
  readonly indexer: CoreChainIndexer;
  readonly gateway: CoreGateway;
  readonly claims: WalletClaimsIndexV2;
  readonly feed: HeadFeed | null;
  readonly source: CoreGatewaySource;
  stop(): Promise<void>;
}

const cursorOf = (item: { readonly block: bigint; readonly logIndex: number }): string => `${item.block}-${item.logIndex}`;
const before = (item: { readonly block: bigint; readonly logIndex: number }, cursor: string): boolean => {
  const [b, l] = cursor.split('-');
  const block = BigInt(b ?? '0');
  return item.block < block || (item.block === block && item.logIndex < Number(l ?? '0'));
};

/** Activity and trades of the pipeline's recent window, newest first, one page (when no history store is configured). */
export function recentPage(trades: readonly CoreTrade[], activity: readonly CoreActivity[], options: { readonly kind: string | null; readonly before: string | null; readonly limit: number }): ActivityPage['items'] {
  const all: ActivityPage['items'][number][] = [...activity, ...trades.map((t) => ({ ...t, kind: 'trade' as const }))];
  return all
    .filter((item) => (options.kind === null ? true : item.kind === options.kind))
    .filter((item) => (options.before === null ? true : before(item, options.before)))
    .sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block < b.block ? 1 : -1))
    .slice(0, options.limit);
}

/** What the head feed knows about the chain, for "does the indexer follow it" (heads.ts). */
export interface ChainLiveness {
  /** When the chain last answered with a head, the same one included (ms; null: never). */
  lastHeardMs(): number | null;
  /** The newest head number seen. */
  newestSeen(): bigint | null;
}

export interface GatewaySourceExtra {
  readonly prices?: BoxPrices;
  readonly pictures?: PictureCopiesService;
  readonly links?: LinksService;
  readonly itemArt?: (sha256: Hex) => Promise<Uint8Array | null>;
  /** The head feed (without it: a block applied within `staleAfterMs`). */
  readonly liveness?: ChainLiveness | null;
  /** Blocks the pipeline may be behind the newest head seen before its snapshots are Stale (default 3). */
  readonly lagBlocks?: number;
  readonly historyHealth?: (() => HistoryHealth) | null;
}

/**
 * The gateway's source. Every snapshot and feed card is Stale while the indexer does not follow the chain (BC-094):
 * the chain not heard from for `staleAfterMs` (RPC failures, a stalled head feed), or the pipeline more than
 * `lagBlocks` behind the newest head seen (it cannot apply blocks). A quiet chain (a local anvil between transactions)
 * is followed: its head is heard, unchanged.
 */
export function coreGatewaySource(indexer: CoreChainIndexer, reader: CoreReader, history: HistoryQuery | null, staleAfterMs: number, now: () => number = Date.now, extra: GatewaySourceExtra = {}): { source: CoreGatewaySource; updated: () => void } {
  const listeners = new Set<() => void>();
  let lastUpdateMs = 0;
  // Projection inputs are replaced immutably by the pipeline. Identity tokens avoid serializing the large
  // money/state/audit objects on every tab's poll; weak keys do not retain rolled-back or trimmed states.
  const identities = new WeakMap<object, number>();
  let identitySequence = 0;
  const identity = (value: object | null | undefined): number => {
    if (!value) return 0;
    let id = identities.get(value);
    if (id === undefined) { id = ++identitySequence; identities.set(value, id); }
    return id;
  };
  const lagBlocks = BigInt(extra.lagBlocks ?? 3);
  const following = (): { ok: boolean; reason: string | null } => {
    const head = indexer.head();
    if (!head) return { ok: false, reason: 'no block applied yet' };
    const live = extra.liveness;
    if (!live) return now() - lastUpdateMs <= staleAfterMs ? { ok: true, reason: null } : { ok: false, reason: `no block applied for over ${Math.round(staleAfterMs / 1000)} s` };
    const heard = live.lastHeardMs();
    if (heard === null || now() - heard > staleAfterMs) return { ok: false, reason: `the chain was not heard from for over ${Math.round(staleAfterMs / 1000)} s` };
    const newest = live.newestSeen();
    if (newest !== null && newest - head.number > lagBlocks) return { ok: false, reason: `the index is at block ${head.number}, the chain at ${newest}` };
    return { ok: true, reason: null };
  };
  const staleIf = <T extends { readonly stale: boolean }>(value: T, stale: boolean): T => (stale && !value.stale ? { ...value, stale: true } : value);
  const health = (): GatewayHealth => {
    const f = following();
    const h = extra.historyHealth?.() ?? null;
    return { following: f.ok, reason: f.reason, history: h ? { ok: h.ok, pending: h.pending, lastError: h.lastError, failures: h.failures } : null };
  };
  const source: CoreGatewaySource = {
    chainId: indexer.chainId,
    asOf: () => indexer.asOf(),
    dataVersion: () => history ? history.version : (indexer.head()?.hash ?? 'no head'),
    feedVersion: v2 => JSON.stringify([
      history?.version.toString() ?? null, indexer.asOf(), following().ok,
      indexer.allRows().filter(({ row }) => v2 ? isRowV2(row) : !isRowV2(row) && !isSetRowV2(row))
        .map(({ row, verdict }) => [identity(row), identity(verdict)]),
      v2 ? [...indexer.boxesV2].map(([token, entry]) => [token, identity(entry.states.at(-1)), entry.verified,
        entry.repairing, identity(entry.audit), extra.links?.visible(token), extra.pictures?.visible(entry.row.spec)])
        : [...indexer.boxes].map(([token, entry]) => [token, identity(entry.states.at(-1)), entry.verified,
          entry.repairing, identity(entry.audit), identity(entry.display)]),
    ]),
    setFeed: () => indexer.setFeedView(),
    setBox: token => indexer.setBoxView(token),
    setMembers: (token,offset,limit) => indexer.setMembersView(token,offset,limit),
    setMoney: token => indexer.setMoneyView(token),
    feed: () => {
      const view = indexer.feedView();
      const stale = !following().ok;
      return stale ? { ...view, cards: view.cards.map((card) => staleIf(card, true)) } : view;
    },
    box: (token) => {
      const view = indexer.boxView(token);
      return view ? staleIf(view, !following().ok) : null;
    },
    v2Feed: () => {
      const view = indexer.v2FeedView();
      return { ...view, cards: view.cards.map((card) => ({ ...staleIf(card, !following().ok), links: extra.links?.visible(card.token) ?? null, ...extra.pictures?.visible(card.row.spec) })) };
    },
    v2Box: (token) => { const view = indexer.v2BoxView(token); return view ? { ...staleIf(view, !following().ok), links: extra.links?.visible(token) ?? null, ...extra.pictures?.visible(view.row.spec), ...(extra.prices ? { prices: extra.prices.of(view) } : {}) } : null; },
    v2Listings: (registry) => indexer.v2ListingsView(registry),
    v2Holders: (token, options) => indexer.v2HoldersView(token, options),
    v2Stats: () => staleIf(indexer.v2StatsView(), !following().ok),
    item: (token, id) => following().ok ? indexer.itemView(token, id) : null,
    items: (token, after, limit) => {
      if (!following().ok) return [];
      const entry = indexer.boxes.get(token.toLowerCase());
      const head = indexer.head();
      const state = entry && head ? indexer.stateAt(entry, head) : null;
      return [...(state?.reveals.keys() ?? [])].filter((id) => id > after).sort((a, b) => a < b ? -1 : 1).slice(0, limit)
        .flatMap((id) => { const item = indexer.itemView(token, id); return item ? [item] : []; });
    },
    async itemArt(token, id, role) {
      const item = source.item?.(token, id);
      const ref = item?.revealed ? item.art?.[role] : null;
      if (!ref || !extra.itemArt) return null;
      const bytes = await extra.itemArt(ref.sha256);
      const current = source.item?.(token, id);
      return current?.revealed && current.art?.[role]?.sha256 === ref.sha256 ? bytes : null;
    },
    async activity(token, options) {
      const recent = indexer.recent(token);
      if (!recent) return null;
      const record = indexer.boxesV2.get(token.toLowerCase())?.row.record;
      const historyOptions = record ? { ...options, v2Contracts: [...record.contracts, record.poolManager] } : options;
      const items = history ? await history.activityPage(indexer.chainId, token, historyOptions) : recentPage(recent.trades, recent.activity, options);
      const last = items.at(-1);
      return { asOf: indexer.asOf(), items, next: items.length === options.limit && last ? cursorOf(last) : null };
    },
    async candles(token, interval, limit = CANDLE_LIMIT) {
      const recent = indexer.recent(token);
      if (!recent) return null;
      const candles = history ? await history.candles(indexer.chainId, token, interval, limit) : candlesFromTrades(recent.trades, interval).slice(-limit);
      return { asOf: indexer.asOf(), candles };
    },
    async wallet(address) {
      const head = indexer.head();
      const boxes: WalletBox[] = [];
      for (const [token, entry] of indexer.boxes) {
        const state = head ? indexer.stateAt(entry, head) : null;
        if (!state || !head) continue;
        const t = balanceOf(state, address);
        const items = itemsOf(state, address);
        const tickets = ticketsOf(state, address);
        const draws = drawsOf(state, address);
        let streamOwed: string | null = null;
        const stream = entry.row.contracts.itemStream;
        if (stream) {
          try {
            const data = encodeFunctionData({ abi: boxItemStreamAbi as Abi, functionName: 'owedOf', args: [address as Address] } as never);
            const raw = await reader.callAt(stream, data, head.hash);
            streamOwed = String(decodeFunctionResult({ abi: boxItemStreamAbi as Abi, functionName: 'owedOf', data: raw } as never));
          } catch {
            streamOwed = null;
          }
        }
        if (t === 0n && items.length === 0 && tickets.length === 0 && draws.length === 0 && (streamOwed === null || streamOwed === '0')) continue;
        boxes.push({ token: token as `0x${string}`, row: boxRowToJson(entry.row), t: t.toString(), items: items.map(String), tickets: tickets.map(String), streamOwed, draws: draws.map(String) });
      }
      const view: WalletView = { schema: CORE_WALLET_SCHEMA, chainId: indexer.chainId, address: address.toLowerCase() as `0x${string}`, asOf: indexer.asOf(), boxes };
      return view;
    },
    health,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const updated = (): void => {
    lastUpdateMs = now();
    for (const listener of listeners) listener();
  };
  return { source, updated };
}

/** One composition for the CLI and the optional v2 entry point; feed and claims share canonical pipeline state. */
export function createCoreService(options: CoreServiceOptions) {
  let updated: () => void = () => undefined;
  const indexer = new CoreChainIndexer({
    reader: options.reader,
    manifest: options.manifest,
    ...(options.setManifest ? {setManifest: options.setManifest} : {}),
    ...(options.auditEvery !== undefined ? { auditEvery: options.auditEvery } : {}),
    ...(options.pace ? { pace: options.pace } : {}),
    ...(options.onHistory ? { onHistory: options.onHistory } : {}),
    onUpdate: () => updated(),
  });
  const feed = new HeadFeed({
    wsUrls: options.wsUrls ?? [],
    reader: options.reader,
    pollMs: options.pollMs ?? 1_000,
    silenceMs: options.wsSilenceMs ?? 30_000,
    onHead: (header) => indexer.onHead(header),
  });
  const wired = coreGatewaySource(indexer, options.reader, options.history ?? null, options.healthyWithinMs ?? 60_000, Date.now, { liveness: feed, ...(options.pace ? { lagBlocks: Number(options.pace.lagBlocks) } : {}), historyHealth: options.historyHealth ?? null, ...(options.itemArt ? { itemArt: options.itemArt } : {}), ...(options.links ? { links: options.links } : {}), ...(options.pictures ? { pictures: options.pictures } : {}), ...(options.prices ? { prices: options.prices } : {}) });
  updated = wired.updated;
  const claims = new WalletClaimsIndexV2(indexer, options.claimsReader ?? options.reader);
  const gateway = new ClaimsGatewayV2({
    source: wired.source,
    createOptions: new CreateOptions((options.manifest.releases ?? []).map(release => ({
      chainId: options.manifest.chainId, factory: release.factory.address.toLowerCase(),
      registry: release.registry.address.toLowerCase(), versionCodeHash: release.versionCodeHash.toLowerCase(),
    })), options.createOptionsDirectory),
    ...(options.pictures ? { pictureHints: new PictureHints({ chainId: indexer.chainId, pictures: options.pictures,
      following: () => wired.source.health().following,
      specOf: box => {
        const head = indexer.head();
        if (!head) return null;
        for (const { row } of indexer.boxesV2.values()) {
          if (row.contracts.coordinator?.toLowerCase() === box && row.creationBlock <= head.number) return row.spec;
        }
        return null;
      } }) } : {}),
    ...(options.links && options.linksVerifier ? { links: new LinksV2({ chainId: indexer.chainId, store: options.links,
      verifier: options.linksVerifier, following: () => wired.source.health().following,
      head: () => indexer.head(), creatorOf: token => indexer.v2CreatorOf(token) }) } : {}),
    port: options.port,
    host: options.host,
    ...(options.maxStreamsPerClient !== undefined ? { maxStreamsPerClient: options.maxStreamsPerClient } : {}),
    ...(options.trustedProxies ? { trustedProxies: options.trustedProxies } : {}),
  }, claims);
  let started = false;
  const stop = async (): Promise<void> => {
    feed.stop();
    indexer.stop();
    await gateway.stop();
    await options.pictures?.stop();
  };
  return {
    indexer,
    gateway,
    claims,
    feed,
    source: wired.source,
    stop,
    async start() {
      if (started) throw new Error('core service already started');
      started = true;
      try {
        await indexer.start();
        await indexer.idle();
        updated();
        await gateway.start();
        feed.start();
        options.pictures?.watch(() => indexer.v2PictureSpecs());
      } catch (error) {
        await stop();
        throw error;
      }
    },
  };
}

export async function startCoreService(options: CoreServiceOptions): Promise<RunningCoreService> {
  const service = createCoreService(options);
  await service.start();
  return service;
}
