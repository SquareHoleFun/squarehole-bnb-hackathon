/**
 * The core v1/v2 gateway (S10a § 3.5; chain-data-platform § 2.6): JSON over HTTP, CORS open, no keys.
 *
 *   GET /v1/feed?chain=<id>                          one card per shown box (BC-085: one request feeds every card)
 *   GET /v1/boxes/<chain>/<token>                    the row and the snapshot
 *   GET /v1/boxes/<chain>/<token>/stream             SSE: `snapshot` now and after every block; at most `maxStreams`
 *                                                    open (503) and `maxStreamsPerClient` per client (429), so one
 *                                                    address cannot hold every slot (client-key.ts)
 *   GET /v1/boxes/<chain>/<token>/activity?kind&before&limit   newest first, paged by (block, log index)
 *   GET /v1/boxes/<chain>/<token>/candles?interval=12s|1m|10m|1h|10h|1d&limit=1-1000
 *   GET /v1/boxes/<chain>/<token>/items?after&limit   revealed records, ordered by id
 *   GET /v1/boxes/<chain>/<token>/items/<id>          one record (unrevealed: no hashes or traits)
 *   GET /v1/boxes/<chain>/<token>/items/<id>/art/<image|avatar|model>  verified bytes, no-store
 *   GET /v1/wallets/<chain>/<address>                every shown box the address holds, grouped by box address
 *   GET /v2/sets/<chain>/<token>/activity?before&limit  set activity, mixed page
 *   GET /v2/feed, /v2/boxes/<chain>/<token>[/stream|/activity|/candles]  v2 projections
 *   GET /v2/boxes/<chain>/<token>/holders?limit&after  positive T balances, snapshot-bound pages (1-200)
 *   GET /v2/boxes/<chain>/<token>/links              the creator's public signed links (including art-wait rows)
 *   POST /v2/boxes/<chain>/<token>/links             newer creator-signed links
 *   POST /v2/pictures/hint                          untrusted Arweave ID; committed bytes are the proof
 *   GET /v2/listings/<chain>/<release-registry>        canonical v2 listings
 *   GET/HEAD /v2/create-options/<chain>/<factory>.json  exact validated per-release bytes, no-store; file errors 503
 *   GET /v2/withheld                                 sorted picture-ID hashes, max-age=60 (no chain dependency)
 *   GET /v2/stats?chain=<id>                          lifetime protocol totals for this chain's v2 releases
 *   GET /healthz                                     200 while the indexer follows the chain and the history
 *                                                    writer keeps up, 503 otherwise (the body says which)
 *
 * Chain-data answers carry `asOf {block, hash, tier}` and decimal strings. Unknown chains, tokens and malformed parameters
 * are 404/400, never guessed.
 *
 * Candles: interval defaults to 1h; limit defaults to 1000; newest nonempty buckets, ascending. Stored 1m/1h/1d;
 * 12s folds trades on read, 10m/10h aggregate stored 1m/1h in bigint at epoch-aligned boundaries. No new writes.
 * Box candles/activity (v1/v2) cache serialized data per normalized route/chain/token/query until
 * the history store commits a write (applied head hash without history). Concurrent requests share a build; a read
 * spanning a commit retries. response-cache.ts bounds the LRU to 2000 entries including builds and 64 MiB of bodies.
 * Each 200 attaches current asOf and Cache-Control: public, max-age=1. Candle-only weak ETag hashes the data without
 * asOf; matching If-None-Match (strong/weak list or *) returns bodyless 304 with the same ETag/CORS/Cache-Control.
 * Candle CORS exposes ETag and allows If-None-Match. Activity and feeds have no ETag: clients need fresh asOf.
 * V1/v2 feeds share this cache, keyed by route/chain and feedVersion: history generation AND applied head,
 * liveness, immutable projection inputs, audit/repair flags, visible links and picture copies. Phases/statistics
 * use the applied head timestamp. Each answer attaches current asOf; nested card asOf changes with the head.
 * Legacy sources lacking feedVersion/asOf retain uncached feeds. Other routes and errors are unchanged.
 * Sources without dataVersion are read on every request; no feed read is needed for a fallback version. Set
 * activity stays uncached and passes through unchanged: history commits do not version every in-memory set change.
 *
 * V2 box snapshots (including SSE) and feed cards add `statistics`; schema names stay unchanged. All its numeric
 * fields are decimal strings, derived from authenticated logs through `asOf`, with integer division rounded down:
 * - pricePPerTX18: raw price coin P per whole 18-decimal box token T, scaled by 10^18. Divide by 10^(pDecimals+18)
 *   for whole P/T. From Initialize/Swap sqrtPriceX96: 2^192 * 10^36 / sqrtPriceX96^2 (v2 fixes P as currency0).
 * - marketCapP: raw P value of totalSupplyT at the same exact spot ratio (2^192 * supply / sqrtPriceX96^2).
 *   Price/cap are null before initialization or after failure; neither is USD or an executable quote.
 * - raiseProgress: {raisedP, raiseP, progressBps}, or null outside the curve. raisedP is the curve principal in raw
 *   P from PoolLaunched's range/liquidity and current sqrt price, net of sells, excluding fees; clamped to the frozen
 *   spec raise. progressBps = raisedP * 10000 / raiseP. A filled curve awaiting graduation reports 10000.
 * - totalSupplyT / burnedT: raw T (18 decimals), from token.Transfer mints minus burns / cumulative burns to zero.
 *   No extra burn is counted from summaries such as MigratedV2 or BoughtBack.
 * - holderCount: nonzero-address T balances strictly above zero, including pool and protocol contracts.
 * - volume24hP: sum of trade qRaw in raw P for (asOf.timestamp - 86400, asOf.timestamp]; ages on empty heads too.
 * - tradeCount: lifetime count of nonzero swaps, excluding hook/executor/buy-back/converter/module routes just as
 *   existing volumeQ does. Launch-router trades, including the burned bootstrap buy, count. Buy volume includes the
 *   pool fee but excludes launch tax; sales use P received, less a paired legacy SaleFee if present.
 * - hourlyCandles: ascending nonempty UTC hour buckets, current hour plus 167 previous hours. start is Unix seconds;
 *   open/high/low/close use pricePPerTX18 units at successive nonzero swaps; volumeP and tradeCount use the above
 *   trade policy. Protocol swaps can move OHLC but add no volume/count. Initialize and zero-delta walks add no candle.
 *   Empty hours are omitted; the current hour is partial. The older /candles route retains its sqrt-price encoding.
 * `statistics: null` identifies an old/manual snapshot without a statistics replay; normal discovery replays creation.
 * Full definitions, recorded vectors and limitations: docs/evidence/SH-TA-28.md.
 *
 * /v2/stats uses sh.core-stats.v2; sh.core-feed.v2 is unchanged. Counts, amounts and times are decimal strings.
 * boxesMade counts discovered registry rows; boxesGraduated/boxesFailed count indexed lifecycle states once.
 * priceCoins groups volumeP and collectedFeesP by lowercase P address (zero = native), with decimal precision.
 * feesByChoiceP partitions gross Collected buyersP/sellersP by each side's frozen choice. Holders/Items include
 * both P and T payouts; module remains module. Keep/grow/unclassified preserve other choices without dropping fees.
 * These are collected fees, not net choice payouts or uncollected estimates; reserve, tips and downstream events
 * are not added a second time. volumeP follows the per-box lifetime user-volume policy described above.
 * tokensBurned sums actual raw T burns (all T have 18 decimals), without implying a shared token value.
 * itemsTakenOut/Returned count physical user conversions, including delivered tickets and shop picks/gives;
 * reservations, cancellations, creator recoveries and ordinary NFT transfers are excluded. drawsRequested/Settled
 * count ticket requests/randomness settlements, independently of delivery. All totals survive recent-list eviction.
 * asOf supplies the indexed block/hash/timestamp/tier; null before indexing. coverage reports indexed and missing
 * boxes, and complete=false when any discovered row lacks a lifetime projection or no head is applied. Except
 * boxesMade, incomplete totals cover only indexed boxes. stale includes repair/liveness; verified combines audits.
 * Field definitions and evidence: docs/evidence/SH-TA-60.md.
 *
 * V2 participation API: packages/indexer/API.md. Trades carry the lowercase largest net T mover in the transaction
 * (buy: positive, sell: negative), excluding zero, PoolManager and the box's contracts; TaxedBuy.buyer wins. Null
 * when none. Old persisted null traders use stored T transfers from the same database snapshot; no replay needed.
 * Activity's trade/event/legacy-transfer reads share one read-only REPEATABLE READ transaction.
 * Holders use sh.core-holders.v2: chainId, token, the box snapshot's asOf, decimal totalSupplyT/holderCount,
 * holders [{address, balanceT, role}], next. Balance descending, address ascending; PoolManager role is pool,
 * otherwise the record's contract role or null. limit defaults to 50; after is opaque, scoped to chain/token/hash.
 * A changed hash (new head or reorg) returns 409: restart without after. Malformed pages are 400, missing boxes 404.
 * Holders retain CORS and no-store. The optional activity/removed SSE events are not implemented; snapshot stays.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BlockList } from 'node:net';
import { toJson } from '../model';
import { ResponseCache, matchesEtag, serializeResponseData } from './response-cache';
import { clientOf, trustedProxyList } from './client-key';
import type { CoreChainIndexer } from './chain-indexer';
import type { CoreItemView, ItemArtRole, AsOf, CoreBoxView, FeedView, WalletView } from './core-views';
import type { CoreActivity, CoreTrade } from './derive-core';
import type { Address } from 'viem';
import type { LinksV2, LinksReply } from './v2/links-v2';
import type { VisibleLinks } from '../links/types';
import { createWithheldPictures, type WithheldPictures } from '../withheld/list.mjs';
import { HINT_PATH, type PictureHints } from '../pictures/hints';
import type { PictureCopies } from '../pictures/types';
import { HoldersPageError, type HoldersOptionsV2 } from './v2/holders-v2';
import { CreateOptions } from './create-options';

export type StoredCandleInterval = '1m' | '1h' | '1d';
export type CandleInterval = '12s' | '10m' | '10h' | StoredCandleInterval;
/** Write intervals: adding a served step must not change history persistence. */
export const CANDLE_INTERVALS: readonly StoredCandleInterval[] = Object.freeze(['1m', '1h', '1d']);
export const SERVED_CANDLE_INTERVALS: readonly CandleInterval[] = Object.freeze(['12s', '1m', '10m', '1h', '10h', '1d']);
export const CANDLE_LIMIT = 1000;

export interface Candle {
  /** Bucket start (unix seconds). */
  readonly start: string;
  /** Q per T, raw ratio as √P after each trade: open, high, low, close of √P (the site converts with the row). */
  readonly openSqrtPriceX96: string;
  readonly highSqrtPriceX96: string;
  readonly lowSqrtPriceX96: string;
  readonly closeSqrtPriceX96: string;
  readonly volumeQ: string;
  readonly trades: number;
}

export interface ActivityPage {
  readonly asOf: AsOf | null;
  readonly items: readonly (CoreActivity | (CoreTrade & { readonly kind: 'trade' }))[];
  /** Pass as `before` for the next page; null at the end. */
  readonly next: string | null;
}

/** What the gateway serves from (the in-process service: the indexer and, when configured, the history store). */
export interface CoreGatewaySource {
  setFeed?(): ReturnType<CoreChainIndexer['setFeedView']>;
  setBox?(token:string): ReturnType<CoreChainIndexer['setBoxView']>;
  setMembers?(token:string,offset:bigint,limit:number): ReturnType<CoreChainIndexer['setMembersView']>;
  setMoney?(token:string): ReturnType<CoreChainIndexer['setMoneyView']>;
  readonly chainId: number;
  /** Cheap current envelope/version reads; production source supplies the history generation or applied head hash. */
  asOf?(): AsOf | null;
  dataVersion?(): bigint | string;
  /** Feed data also depends on live projection/enrichment state, beyond history commits. */
  feedVersion?(v2: boolean): string;
  feed(): FeedView;
  v2Feed?(): ReturnType<CoreChainIndexer['v2FeedView']> & { readonly cards: readonly (NonNullable<ReturnType<CoreChainIndexer['v2BoxView']>> & { readonly links?: VisibleLinks; readonly pictureCopies?: PictureCopies })[] };
  v2Box?(token: string): (NonNullable<ReturnType<CoreChainIndexer['v2BoxView']>> & { readonly links?: VisibleLinks; readonly pictureCopies?: PictureCopies }) | null;
  v2Listings?(registry: string): ReturnType<CoreChainIndexer['v2ListingsView']>;
  v2Holders?(token: string, options: HoldersOptionsV2): ReturnType<CoreChainIndexer['v2HoldersView']>;
  v2Stats?(): ReturnType<CoreChainIndexer['v2StatsView']>;
  box(token: string): CoreBoxView | null;
  activity(token: string, options: { readonly kind: string | null; readonly before: string | null; readonly limit: number }): Promise<ActivityPage | null>;
  candles(token: string, interval: CandleInterval, limit?: number): Promise<{ readonly asOf: AsOf | null; readonly candles: readonly Candle[] } | null>;
  wallet(address: string): Promise<WalletView>;
  /** Whether the indexer follows the chain (snapshots are Stale otherwise) and how the history writer does. */
  health(): GatewayHealth;
  item?(token: string, id: bigint): CoreItemView | null;
  items?(token: string, after: bigint, limit: number): readonly CoreItemView[];
  itemArt?(token: string, id: bigint, role: ItemArtRole): Promise<Uint8Array | null>;
  /** Calls `listener` after each block; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export interface GatewayHealth {
  /** The indexer hears from the chain and has applied its newest head (within a few blocks). */
  readonly following: boolean;
  /** Why not, when not. */
  readonly reason: string | null;
  /** The history writer's state (null: no history configured). */
  readonly history: { readonly ok: boolean; readonly pending: number; readonly lastError: string | null; readonly failures: number } | null;
}

export interface CoreGatewayOptions {
  readonly createOptions?: CreateOptions;
  readonly source: CoreGatewaySource;
  readonly links?: LinksV2;
  readonly pictureHints?: PictureHints;
  readonly withheld?: WithheldPictures;
  readonly port: number;
  readonly host: string;
  readonly heartbeatMs?: number;
  /** Open streams for the whole gateway (default 2000); beyond it 503. */
  readonly maxStreams?: number;
  /** Open streams per client (an IPv4 address or an IPv6 /64; default 8); beyond it 429. */
  readonly maxStreamsPerClient?: number;
  /** Peers (addresses or CIDRs) whose last X-Forwarded-For entry names the client (the proxy in front); default none. */
  readonly trustedProxies?: readonly string[];
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'If-None-Match' };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CURSOR = /^\d{1,20}-\d{1,5}$/;
const KINDS = /^[a-z_]{1,32}$/;
const normalizeCursor = (cursor: string | null): string | null => cursor === null ? null : cursor.split('-').map(n => BigInt(n).toString()).join('-');

/** Recognize malformed aliases only to refuse them. Acceptance always matches the unmodified req.url below. */
function isLinksRequest(raw: string): boolean {
  const candidate = (path: string) => /^\/+v2\/+boxes(?:\/|%)/.test(path) && /(?:\/|%2[fF])links(?:[/%?#]|$)/.test(path);
  if (candidate(raw)) return true;
  try { return candidate(decodeURIComponent(raw)); } catch { return false; }
}

export class CoreGateway {
  private server: Server | null = null;
  private readonly historyCache: ResponseCache | null;
  private readonly streams = new Set<ServerResponse>();
  /** Open streams per client key. */
  private readonly perClient = new Map<string, number>();
  private readonly proxies: BlockList | null;
  private readonly withheld: WithheldPictures;
  private readonly createOptions: CreateOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: CoreGatewayOptions) {
    this.createOptions = options.createOptions ?? new CreateOptions([]);
    this.withheld = options.withheld ?? createWithheldPictures();
    const version = options.source.dataVersion;
    this.historyCache = version ? new ResponseCache(() => version.call(options.source)) : null;
    this.proxies = trustedProxyList(options.trustedProxies ?? []);
  }

  address(): { host: string; port: number } {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('gateway not listening');
    return { host: address.address, port: address.port };
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.route(req, res).catch((error: unknown) => {
      console.error('[core-gateway]', error);
      this.fail(res, 500, 'internal error');
    }));
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.options.port, this.options.host, () => resolve());
    });
    this.timer = setInterval(() => {
      for (const res of this.streams) res.write(': heartbeat\n\n');
    }, this.options.heartbeatMs ?? 15_000);
    this.unsubscribe = this.options.source.subscribe(() => this.broadcast());
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    for (const res of this.streams) res.destroy();
    this.streams.clear();
    this.perClient.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private send(res: ServerResponse, status: number, body: unknown, cache = 'no-store', extra: Record<string, string> = {}): void {
    const text = typeof body === 'string' ? body : toJson(body);
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache, ...extra });
    res.end(text);
  }

  private async historyAnswer(req: IncomingMessage, res: ServerResponse, key: readonly unknown[], build: () => Promise<object | null>, asOf: () => AsOf | null, candle: boolean, missing: () => void, version?: () => bigint | string): Promise<void> {
    const cache = this.historyCache;
    for (;;) {
      const body = cache ? null : await build();
      const data = cache ? await cache.read(JSON.stringify(key), build, version) : body === null ? null : serializeResponseData(body, 'uncached');
      if (!data) return missing();
      // No await between this final version check and writing the response.
      if (cache && !cache.isCurrent(data, version)) continue;
      const headers = { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=1',
        ...(candle ? { ETag: data.etag, 'Access-Control-Expose-Headers': 'ETag' } : {}) };
      if (candle && matchesEtag(req.headers?.['if-none-match'], data.etag)) {
        res.writeHead(304, headers); res.end(); return;
      }
      res.writeHead(200, headers);
      const envelope = Buffer.from(`{"asOf":${toJson(asOf())}${data.body.length > 2 ? ',' : ''}`);
      res.end(Buffer.concat([envelope, data.body.subarray(1)])); // Serialize only the live envelope; retain the old single-end transport.
      return;
    }
  }

  private fail(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    this.send(res, status, { error: message });
  }

  async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try { await this.routeRequest(req, res); }
    catch (error) {
      // Library messages, stacks, causes and Postgres details can contain submitted links/signatures.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      const errorClass = error instanceof Error ? error.constructor.name : 'UnknownError';
      console.error('[core-gateway]', {
        class: /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(errorClass) ? errorClass : 'Error',
        code: typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code
          : typeof code === 'number' && Number.isSafeInteger(code) ? code : null,
      });
      this.fail(res, 500, 'internal error');
    }
  }

  private async routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, req.url === HINT_PATH ? { ...CORS, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } : CORS);
      res.end();
      return;
    }
    const raw = req.url ?? '/';
    if (raw === '/v2/create-options' || raw.startsWith('/v2/create-options/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return this.fail(res, 405, 'read-only');
      const reply = await this.createOptions.get(raw);
      res.writeHead(reply.status, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : reply.body instanceof Uint8Array ? reply.body : toJson(reply.body));
      return;
    }
    if (raw === HINT_PATH) {
      if (req.method !== 'POST') return this.fail(res, 405, 'read-only');
      if (!this.options.pictureHints) return this.fail(res, 503, 'pictures unavailable');
      const client = clientOf(req.socket.remoteAddress, req.headers['x-forwarded-for'], this.proxies);
      const reply = await this.options.pictureHints.post(req, client);
      return this.send(res, reply.status, reply.body, 'no-store', { 'Access-Control-Expose-Headers': 'Retry-After', ...reply.headers });
    }
    // Identify links-shaped requests without URL normalization; reject aliases before the shown-box gate.
    const isLinks = isLinksRequest(raw);
    if (isLinks && (req.method === 'POST' || req.method === 'GET')) {
      const match = /^\/v2\/boxes\/(0|[1-9][0-9]{0,9})\/(0x[0-9a-fA-F]{40})\/links$/.exec(raw);
      const links = this.options.links;
      const reply = (r: LinksReply) => this.send(res, r.status, r.body, r.cache, r.headers);
      if (!match) return links ? reply(links.refuse(404, 'not found')) : this.fail(res, 404, 'not found');
      if (match[1] !== String(this.options.source.chainId)) return links ? reply(links.refuse(404, 'no chain')) : this.fail(res, 404, 'no chain');
      if (!links) return this.send(res, 503, { error: 'signature check unavailable' }, 'no-store', { 'Retry-After': '10' });
      const token = (match[2] ?? '').toLowerCase() as Address;
      return reply(req.method === 'POST' ? await links.post(req, token) : links.get(token));
    }
    if (req.method !== 'GET') {
      if (this.options.links && req.method === 'POST') {
        const r = this.options.links.refuse(405, 'read-only');
        return this.send(res, r.status, r.body);
      }
      return this.fail(res, 405, 'read-only');
    }
    if (raw === '/v2/withheld') return this.send(res, 200, this.withheld.snapshot(), 'max-age=60');
    const url = new URL(req.url ?? '/', 'http://gateway');
    const parts = url.pathname.split('/').filter(Boolean);
    const src = this.options.source;
    if (url.pathname === '/healthz') {
      const health = src.health();
      const ok = health.following && (health.history === null || health.history.ok);
      return this.send(res, ok ? 200 : 503, { ok, asOf: src.feed().asOf, following: health.following, reason: health.reason, history: health.history });
    }
    if (parts[0] === 'v2' && parts[1] === 'sets') {
      if (!src.health().following) return this.fail(res,503,'set index is catching up');
      if (parts[2] === 'feed' && parts.length === 3) {
        const chain=url.searchParams.get('chain');
        if(chain!==null && chain!==String(src.chainId)) return this.fail(res,404,'no chain here');
        const feed=src.setFeed?.(); return feed ? this.send(res,200,feed) : this.fail(res,404,'no set feed');
      }
      if(parts[2]!==String(src.chainId)) return this.fail(res,404,'no chain here');
      const token=(parts[3]??'').toLowerCase();
      if(!ADDRESS.test(token)) return this.fail(res,400,'not an address');
      const box=src.setBox?.(token); if(!box) return this.fail(res,404,'unknown set');
      if(parts.length===4) return this.send(res,200,box);
      if(parts.length!==5) return this.fail(res,404,'not found');
      if(parts[4]==='members') {
        const offset=url.searchParams.get('offset')??'0',limit=Number(url.searchParams.get('limit')??'100');
        if(!/^(0|[1-9][0-9]{0,4})$/.test(offset)||BigInt(offset)>10000n||!Number.isInteger(limit)||limit<1||limit>10000) return this.fail(res,400,'bad member page');
        return this.send(res,200,src.setMembers?.(token,BigInt(offset),limit));
      }
      if(parts[4]==='money') return this.send(res,200,src.setMoney?.(token));
      if(parts[4]==='activity') {
        const before=url.searchParams.get('before'),limit=Number(url.searchParams.get('limit')??'50');
        if((before!==null&&!CURSOR.test(before))||!Number.isInteger(limit)||limit<1||limit>200) return this.fail(res,400,'bad activity page');
        return this.send(res,200,await src.activity(token,{kind:null,before,limit}));
      }
      return this.fail(res,404,'not found');
    }
    const v2 = parts[0] === 'v2';
    if (parts[0] !== 'v1' && !v2) return this.fail(res, 404, 'not found');
    if (v2 && parts[1] === 'stats' && parts.length === 2) {
      const chain = url.searchParams.get('chain');
      if (chain !== null && chain !== String(src.chainId)) return this.fail(res, 404, 'no chain here');
      const stats = src.v2Stats?.();
      return stats ? this.send(res, 200, stats, 'public, max-age=1') : this.fail(res, 404, 'no v2 stats');
    }
    if (parts[1] === 'feed' && parts.length === 2) {
      const chain = url.searchParams.get('chain');
      if (chain !== null && chain !== String(src.chainId)) return this.fail(res, 404, 'no chain here');
      const feedVersion = src.feedVersion, asOf = src.asOf;
      if (feedVersion && asOf) return this.historyAnswer(req, res, [parts[0], 'feed', src.chainId], async () => {
        const feed = v2 ? src.v2Feed?.() : src.feed();
        return feed ? { ...feed, asOf: undefined } : null;
      }, () => asOf.call(src), false, () => this.fail(res, 404, 'no v2 feed'), () => feedVersion.call(src, v2));
      const feed = v2 ? src.v2Feed?.() : src.feed();
      return feed ? this.send(res, 200, feed, 'public, max-age=1') : this.fail(res, 404, 'no v2 feed');
    }
    if (v2 && parts[1] === 'listings' && parts.length === 4) {
      if (parts[2] !== String(src.chainId)) return this.fail(res, 404, 'no chain here');
      const registry = parts[3] ?? '';
      if (!ADDRESS.test(registry)) return this.fail(res, 400, 'not a registry address');
      const listings = src.v2Listings?.(registry);
      return listings ? this.send(res, 200, listings, 'public, max-age=1') : this.fail(res, 404, 'unknown release registry');
    }
    if (!v2 && parts[1] === 'wallets' && parts.length === 4) {
      if (parts[2] !== String(src.chainId)) return this.fail(res, 404, 'no chain here');
      const address = parts[3] ?? '';
      if (!ADDRESS.test(address)) return this.fail(res, 400, 'not an address');
      return this.send(res, 200, await src.wallet(address.toLowerCase()));
    }
    if (parts[1] === 'boxes' && parts.length >= 4) {
      if (parts[2] !== String(src.chainId)) return this.fail(res, 404, 'no chain here');
      const token = (parts[3] ?? '').toLowerCase();
      if (!ADDRESS.test(token)) return this.fail(res, 400, 'not an address');
      const view = v2 ? src.v2Box?.(token) : src.box(token);
      if (!view) return this.fail(res, 404, 'no shown box with that token on this chain');
      const sub = parts[4];
      if (sub === undefined && parts.length === 4) return this.send(res, 200, view, 'public, max-age=1');
      if (v2 && sub === 'holders' && parts.length === 5) {
        try {
          const page = src.v2Holders?.(token, { limit: Number(url.searchParams.get('limit') ?? '50'), after: url.searchParams.get('after') });
          return page ? this.send(res, 200, page) : this.fail(res, 404, 'no holders');
        } catch (error) {
          if (error instanceof HoldersPageError) return this.fail(res, error.status, error.message);
          throw error;
        }
      }
      if (!v2 && sub === 'items' && parts.length === 5) {
        const after = url.searchParams.get('after') ?? '0';
        const limit = Number(url.searchParams.get('limit') ?? '24');
        if (!/^(0|[1-9][0-9]{0,77})$/.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 100) return this.fail(res, 400, 'bad item page');
        const items = src.items?.(token, BigInt(after), limit) ?? [];
        return this.send(res, 200, { asOf: view.asOf, items, next: items.length === limit ? items.at(-1)?.id : null });
      }
      if (!v2 && sub === 'items' && (parts.length === 6 || (parts.length === 8 && parts[6] === 'art'))) {
        const id = parts[5] ?? '';
        if (!/^[1-9][0-9]{0,77}$/.test(id)) return this.fail(res, 400, 'bad item id');
        const item = src.item?.(token, BigInt(id));
        if (!item) return this.fail(res, 404, 'no item');
        if (parts.length === 6) return this.send(res, 200, item);
        const role = parts[7];
        if (role !== 'image' && role !== 'avatar' && role !== 'model') return this.fail(res, 404, 'no art role');
        const pictureId = role === 'model' ? null : item.art?.[role]?.cid;
        const listed = () => pictureId !== null && pictureId !== undefined && this.withheld.has(`ipfs:${pictureId}`);
        if (listed()) return this.fail(res, 451, 'picture withheld');
        const bytes = await src.itemArt?.(token, BigInt(id), role);
        if (listed()) return this.fail(res, 451, 'picture withheld');
        if (!bytes) return this.fail(res, 404, 'art unavailable');
        // No browser cache: a reveal at the head may be rolled back.
        res.writeHead(200, { ...CORS, 'Content-Type': role === 'model' ? 'model/gltf-binary' : 'image/webp', 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(bytes);
        return;
      }
      if (sub === 'stream' && parts.length === 5) return this.stream(req, res, token, v2);
      if (sub === 'activity' && parts.length === 5) {
        const kind = url.searchParams.get('kind');
        const before = url.searchParams.get('before');
        const limit = Number(url.searchParams.get('limit') ?? '50');
        if (kind !== null && !KINDS.test(kind)) return this.fail(res, 400, 'bad kind');
        if (before !== null && !CURSOR.test(before)) return this.fail(res, 400, 'bad cursor');
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) return this.fail(res, 400, 'limit is 1-200');
        const cursor = normalizeCursor(before);
        return this.historyAnswer(req, res, [parts[0], 'boxes/activity', src.chainId, token, kind, cursor, limit], async () => {
          const page = await src.activity(token, { kind, before: cursor, limit });
          return page ? { ...page, asOf: undefined } : null;
        }, () => src.asOf ? src.asOf() : view.asOf, false, () => this.fail(res, 404, 'no activity'));
      }
      if (sub === 'candles' && parts.length === 5) {
        const interval = url.searchParams.get('interval') ?? '1h';
        if (!(SERVED_CANDLE_INTERVALS as readonly string[]).includes(interval)) return this.fail(res, 400, 'interval is 12s, 1m, 10m, 1h, 10h or 1d');
        const rawLimit = url.searchParams.get('limit') ?? String(CANDLE_LIMIT);
        const limit = Number(rawLimit);
        if (!/^[0-9]+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > CANDLE_LIMIT) return this.fail(res, 400, 'limit is 1-1000');
        return this.historyAnswer(req, res, [parts[0], 'boxes/candles', src.chainId, token, interval, limit], async () => {
          const answer = await src.candles(token, interval as CandleInterval, limit);
          return answer ? { ...answer, asOf: undefined, interval } : null;
        }, () => src.asOf ? src.asOf() : view.asOf, true, () => this.fail(res, 404, 'no candles'));
      }
    }
    return this.fail(res, 404, 'not found');
  }

  private stream(req: IncomingMessage, res: ServerResponse, token: string, v2 = false): void {
    if (this.streams.size >= (this.options.maxStreams ?? 2_000)) return this.fail(res, 503, 'too many streams');
    const client = clientOf(req.socket.remoteAddress, req.headers['x-forwarded-for'], this.proxies);
    const open = this.perClient.get(client) ?? 0;
    if (open >= (this.options.maxStreamsPerClient ?? 8)) return this.send(res, 429, { error: 'too many streams from one address' }, 'no-store', { 'Retry-After': '30' });
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    (res as ServerResponse & { shToken?: string }).shToken = token;
    (res as ServerResponse & { shV2?: boolean }).shV2 = v2;
    this.streams.add(res);
    this.perClient.set(client, open + 1);
    this.push(res, token);
    // The response's close (the visitor left, or stop()), once per stream.
    res.on('close', () => {
      if (!this.streams.delete(res)) return;
      const left = (this.perClient.get(client) ?? 1) - 1;
      if (left > 0) this.perClient.set(client, left);
      else this.perClient.delete(client);
    });
  }

  private push(res: ServerResponse, token: string): void {
    const v2 = (res as ServerResponse & { shV2?: boolean }).shV2;
    const view = v2 ? this.options.source.v2Box?.(token) : this.options.source.box(token);
    if (!view) return;
    res.write(`id: ${view.asOf.block}\nevent: snapshot\ndata: ${toJson(view)}\n\n`);
  }

  private broadcast(): void {
    for (const res of this.streams) {
      const token = (res as ServerResponse & { shToken?: string }).shToken;
      if (token) this.push(res, token);
    }
  }
}
