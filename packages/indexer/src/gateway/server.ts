/**
 * The read-only HTTP gateway: a pre-built snapshot (edge-cacheable, ETag per snapshot) and an SSE stream fed by the
 * store's frame stream, written once per event to every open connection. Several gateway processes can share one
 * indexer through Redis. No writes, no keys, no user input beyond a pool id from an allowlist of one.
 *
 * SSE (research § 5.3): `retry: 3000`; a comment on connect and a heartbeat comment every 15 s (Cloudflare closes idle
 * proxied connections after about 100–125 s); ids `<seq>-<block>:<hash8>` (frame.ts). `Last-Event-ID` resumes by
 * sequence number from a 64-event buffer that is seeded from the store's stream at start (so a gateway restart does
 * not force every client to resync); an id outside the buffer gets `resync` plus the current snapshot. A gap in the
 * sequence (frames this gateway never received) is answered the same way, to every client. Each broadcast carries a
 * `: gw <ms>` comment (the gateway's write time) that EventSource ignores and the latency probe reads.
 *
 * Status: `live`, `stale` (no indexer heartbeat; the indexer catching up; no block frame for 3 slots; or the
 * heartbeat's published head not advancing for 3 slots) or `unverified` (the indexer's state differs from the
 * chain). Sent as a `status` event on change and on connect, as `X-SH-Indexer` on the snapshot, and `/healthz`
 * answers 503 unless live.
 *
 * Limits: streams per client address (CF-Connecting-IP / X-Real-IP / X-Forwarded-For are believed only from a trusted
 * proxy), streams per process, a client that stops reading (over the buffer limit, or not drained for a minute) is
 * dropped, and a request must arrive within the request timeout. `/metrics` and the debug page answer only a direct
 * local request (not one relayed by a proxy on the same machine) unless `exposeDebug` is set.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { PoolTarget } from '../config';
import { curveDrawPoints } from '../curve';
import { decodeFrame, seqOf, type DecodedFrame } from '../frame';
import { firstScoreOf, toJson, tradeFromJson } from '../model';
import type { HeartbeatInfo } from '../pipeline';
import type { FinalityRecord, HotStore, SnapshotRecord } from '../store/types';
import { curveView, tradeView, type IndexerStatus } from '../views';
import { DEBUG_PAGE_HTML } from './debug-page';

export type GatewayStatus = 'live' | 'stale' | 'unverified';

export interface GatewayOptions {
  readonly store: HotStore;
  readonly target: PoolTarget;
  readonly port: number;
  readonly host: string;
  readonly heartbeatMs?: number;
  readonly replayEvents?: number;
  readonly aliveCheckMs?: number;
  /** Stale after this long without a block frame, or without the heartbeat's published head moving (3 slots). */
  readonly staleAfterMs?: number;
  /** Streams per process; about 20,000 fits a 4 GB droplet with room for the proxy and Redis (design § 8). */
  readonly maxClients?: number;
  readonly maxStreamsPerIp?: number;
  /** Peers whose forwarding headers are believed (the local proxy or tunnel). */
  readonly trustedProxies?: readonly string[];
  /** Unsent bytes a client may hold before it is dropped. */
  readonly maxBufferedBytes?: number;
  /** How long a client may go without draining its buffer before it is dropped. */
  readonly stallMs?: number;
  /** Serve /metrics and the debug page to proxied and remote requests too. */
  readonly exposeDebug?: boolean;
  /** Time allowed to receive a request (headers included); a stream's response is not bounded by it. */
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
}

export interface GatewayMetrics {
  clients: number;
  peakClients: number;
  connectionsTotal: number;
  eventsBroadcast: number;
  lastFanoutMs: number;
  maxFanoutMs: number;
  lastFanoutClients: number;
  bytesSent: number;
  droppedSlowClients: number;
  droppedStalledClients: number;
  refusedFull: number;
  refusedPerIp: number;
  snapshotRequests: number;
  snapshot304: number;
  lastEventId: string | null;
  lastSeq: number | null;
  gapsDetected: number;
  duplicateFrames: number;
  status: GatewayStatus | null;
  statusReason: string | null;
}

interface BufferedEvent {
  readonly seq: number;
  readonly data: Buffer;
}

interface ClientMeta {
  readonly ip: string;
  stalledSinceMs: number | null;
}

const SNAPSHOT_CACHE = 'public, max-age=1, s-maxage=2, stale-while-revalidate=10, stale-if-error=300';
const HISTORY_SETTLED_CACHE = 'public, max-age=86400, immutable';
const HISTORY_RECENT_CACHE = 'public, max-age=12';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Last-Event-ID, If-None-Match', 'Access-Control-Expose-Headers': 'ETag, X-SH-Indexer' };
const LOOPBACK = ['127.0.0.1', '::1'];
const FORWARDING_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded'];

function normalizeIp(address: string): string {
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** RFC 9110 If-None-Match with weak comparison: a list, `W/` prefixes, `*`. */
export function ifNoneMatch(value: string | undefined, tags: readonly string[]): boolean {
  if (!value) return false;
  if (value.trim() === '*') return tags.length > 0;
  const opaque = (tag: string): string => tag.trim().replace(/^W\//, '');
  const wanted = new Set(tags.map(opaque));
  return value.split(',').some((candidate) => wanted.has(opaque(candidate)));
}

export class Gateway {
  readonly metrics: GatewayMetrics = {
    clients: 0, peakClients: 0, connectionsTotal: 0, eventsBroadcast: 0, lastFanoutMs: 0, maxFanoutMs: 0, lastFanoutClients: 0, bytesSent: 0,
    droppedSlowClients: 0, droppedStalledClients: 0, refusedFull: 0, refusedPerIp: 0, snapshotRequests: 0, snapshot304: 0,
    lastEventId: null, lastSeq: null, gapsDetected: 0, duplicateFrames: 0, status: null, statusReason: null,
  };
  private readonly options: GatewayOptions;
  private readonly now: () => number;
  private readonly clients = new Map<ServerResponse, ClientMeta>();
  private readonly perIp = new Map<string, number>();
  private readonly trusted: ReadonlySet<string>;
  private replay: BufferedEvent[] = [];
  /** A client that has seen every frame up to this sequence can be resumed from the buffer. */
  private floorSeq: number | null = null;
  private readonly basePath: string;
  private readonly curveJson: string;
  private server: Server | null = null;
  private snapshot: (SnapshotRecord & { gzip: Buffer | null }) | null = null;
  private finality: FinalityRecord = { safe: null, finalized: null };
  private unsubscribe: (() => Promise<void>) | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private beat: (HeartbeatInfo & { atMs?: number }) | null = null;
  private beatHead: string | null = null;
  private beatHeadSinceMs = 0;
  private lastBlockFrameAtMs = 0;
  private indexerFlags: { verified: boolean | null; catchingUp: boolean; atMs: number } = { verified: null, catchingUp: false, atMs: 0 };

  constructor(options: GatewayOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.basePath = `/v1/pools/${options.target.chainId}/${options.target.poolId.toLowerCase()}`;
    this.curveJson = toJson({ curve: curveView(options.target.curve), points: curveDrawPoints(32, options.target.curve) });
    this.trusted = new Set((options.trustedProxies ?? LOOPBACK).map(normalizeIp));
  }

  address(): { host: string; port: number } {
    const address = this.server?.address();
    if (!address || typeof address === 'string') throw new Error('gateway not listening');
    return { host: address.address, port: address.port };
  }

  private get staleAfterMs(): number {
    return this.options.staleAfterMs ?? 36_000;
  }

  async start(): Promise<void> {
    const stored = await this.options.store.getSnapshot();
    if (stored) this.setSnapshot(stored);
    this.finality = await this.options.store.getFinality();
    const replayEvents = this.options.replayEvents ?? 64;
    const recent = await this.options.store.recentFrames(replayEvents + 32);
    for (const message of recent.frames) this.onMessage(message, true);
    this.lastBlockFrameAtMs = this.now();
    this.beatHeadSinceMs = this.now();
    this.unsubscribe = await this.options.store.subscribe((message) => this.onMessage(message), recent.cursor);
    this.server = createServer((req, res) => void this.route(req, res));
    const requestTimeout = this.options.requestTimeoutMs ?? 30_000;
    this.server.requestTimeout = requestTimeout;
    this.server.headersTimeout = Math.min(20_000, requestTimeout);
    this.server.keepAliveTimeout = 65_000;
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.options.port, this.options.host, () => resolve());
    });
    this.timers.push(setInterval(() => this.heartbeat(), this.options.heartbeatMs ?? 15_000));
    this.timers.push(setInterval(() => void this.checkIndexer(), this.options.aliveCheckMs ?? 5_000));
    await this.checkIndexer();
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await this.unsubscribe?.();
    for (const client of this.clients.keys()) client.destroy();
    this.clients.clear();
    this.perIp.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private setSnapshot(record: SnapshotRecord): void {
    this.snapshot = { ...record, gzip: record.json.length > 1_024 ? gzipSync(record.json) : null };
  }

  // ------------------------------------------------------------------------------------------------ frames

  /** One frame → at most one SSE event, written to every client (the same Buffer for all). */
  onMessage(message: string, seeding = false): void {
    let frame: DecodedFrame;
    try {
      frame = decodeFrame(message);
    } catch (error) {
      if (!seeding) console.warn(`[gateway] dropped a malformed frame: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const last = this.metrics.lastSeq;
    if (last !== null && frame.seq <= last) {
      this.metrics.duplicateFrames += 1;
      return;
    }
    const gap = last !== null && frame.seq > last + 1;
    this.metrics.lastSeq = frame.seq;
    if (this.floorSeq === null) this.floorSeq = frame.seq - 1;
    if (frame.snapshot) this.setSnapshot({ json: frame.snapshot, etag: frame.etag });
    if (frame.type === 'finality') this.readFinality(frame.event);
    if (frame.type === 'block' && !seeding) this.lastBlockFrameAtMs = this.now();
    if (frame.type === 'status') {
      this.readIndexerStatus(frame.event);
      if (!seeding) this.evaluate();
    }
    if (gap) {
      this.metrics.gapsDetected += 1;
      this.floorSeq = frame.seq - 1;
      void this.resyncEveryone(frame, 'gateway missed frames', seeding);
      return;
    }
    if (frame.type === 'status') return;
    const stamp = `: gw ${this.now()}\n`;
    const data = frame.type === 'resync'
      ? Buffer.from(`${stamp}event: resync\ndata: ${frame.event}\n\nid: ${frame.id}\nevent: snapshot\ndata: ${frame.snapshot ?? this.snapshot?.json ?? '{}'}\n\n`)
      : Buffer.from(`${stamp}id: ${frame.id}\nevent: ${frame.type}\ndata: ${frame.event}\n\n`);
    this.remember(frame, data);
    this.broadcast(data);
  }

  private remember(frame: DecodedFrame, data: Buffer): void {
    this.replay.push({ seq: frame.seq, data });
    const limit = this.options.replayEvents ?? 64;
    while (this.replay.length > limit) {
      const evicted = this.replay.shift();
      if (evicted) this.floorSeq = evicted.seq;
    }
    this.metrics.lastEventId = frame.id;
  }

  /** Frames were lost between the indexer and us: every client gets `resync` and the current snapshot. */
  private async resyncEveryone(frame: DecodedFrame, reason: string, seeding: boolean): Promise<void> {
    if (!frame.snapshot) {
      const stored = await this.options.store.getSnapshot().catch(() => null);
      if (stored) this.setSnapshot(stored);
    }
    const snapshot = this.snapshot?.json;
    if (!snapshot) return;
    const data = Buffer.from(`: gw ${this.now()}\nevent: resync\ndata: ${JSON.stringify({ reason })}\n\nid: ${frame.id}\nevent: snapshot\ndata: ${snapshot}\n\n`);
    this.remember(frame, data);
    if (!seeding) this.broadcast(data);
  }

  private readFinality(event: string): void {
    try {
      const view = JSON.parse(event) as { safeBlock: string | null; finalizedBlock: string | null };
      this.finality = { safe: view.safeBlock ? BigInt(view.safeBlock) : null, finalized: view.finalizedBlock ? BigInt(view.finalizedBlock) : null };
    } catch {
      // keep the previous finality
    }
  }

  private readIndexerStatus(event: string): void {
    try {
      const status = JSON.parse(event) as Partial<IndexerStatus>;
      const atMs = typeof status.atMs === 'number' ? status.atMs : this.now();
      if (atMs >= this.indexerFlags.atMs) this.indexerFlags = { verified: status.verified ?? null, catchingUp: status.catchingUp === true, atMs };
    } catch {
      // keep the previous flags
    }
  }

  // ------------------------------------------------------------------------------------------------ clients

  private broadcast(data: Buffer): void {
    const started = performance.now();
    let sent = 0;
    for (const client of [...this.clients.keys()]) if (this.write(client, data)) sent += 1;
    const elapsed = performance.now() - started;
    this.metrics.eventsBroadcast += 1;
    this.metrics.lastFanoutMs = Math.round(elapsed * 1_000) / 1_000;
    this.metrics.maxFanoutMs = Math.max(this.metrics.maxFanoutMs, this.metrics.lastFanoutMs);
    this.metrics.lastFanoutClients = sent;
    this.metrics.bytesSent += data.length * sent;
  }

  /** Writes unless the client stopped reading: too many unsent bytes, or no drain for `stallMs`. */
  private write(client: ServerResponse, data: Buffer): boolean {
    const meta = this.clients.get(client);
    if (!meta) return false;
    if (client.writableLength > (this.options.maxBufferedBytes ?? 256 * 1024)) {
      this.metrics.droppedSlowClients += 1;
      this.drop(client);
      return false;
    }
    if (meta.stalledSinceMs !== null && this.now() - meta.stalledSinceMs > (this.options.stallMs ?? 60_000)) {
      this.metrics.droppedStalledClients += 1;
      this.drop(client);
      return false;
    }
    if (!client.write(data) && meta.stalledSinceMs === null) meta.stalledSinceMs = this.now();
    return true;
  }

  private drop(client: ServerResponse): void {
    this.forget(client);
    client.destroy();
  }

  private forget(client: ServerResponse): void {
    const meta = this.clients.get(client);
    if (!meta) return;
    this.clients.delete(client);
    const left = (this.perIp.get(meta.ip) ?? 1) - 1;
    if (left > 0) this.perIp.set(meta.ip, left);
    else this.perIp.delete(meta.ip);
    this.metrics.clients = this.clients.size;
  }

  private heartbeat(): void {
    const data = Buffer.from(`: hb ${this.now()}\n\n`);
    for (const client of [...this.clients.keys()]) this.write(client, data);
  }

  // ------------------------------------------------------------------------------------------------ status

  private async checkIndexer(): Promise<void> {
    try {
      const raw = await this.options.store.lastHeartbeat();
      this.beat = raw ? (JSON.parse(raw) as HeartbeatInfo & { atMs?: number }) : null;
    } catch {
      this.beat = null;
    }
    if (this.beat) {
      const head = this.beat.publishedHead ?? null;
      if (head !== this.beatHead) {
        this.beatHead = head;
        this.beatHeadSinceMs = this.now();
      }
      const atMs = this.beat.atMs ?? 0;
      if (atMs >= this.indexerFlags.atMs) this.indexerFlags = { verified: this.beat.verified ?? null, catchingUp: this.beat.catchingUp === true, atMs };
    }
    this.evaluate();
  }

  private evaluate(): void {
    const now = this.now();
    let status: GatewayStatus = 'live';
    let reason: string | null = null;
    if (!this.beat) [status, reason] = ['stale', 'no indexer heartbeat'];
    else if (this.indexerFlags.catchingUp) [status, reason] = ['stale', 'catching up'];
    else if (now - this.lastBlockFrameAtMs > this.staleAfterMs) [status, reason] = ['stale', 'no new block'];
    else if (now - this.beatHeadSinceMs > this.staleAfterMs) [status, reason] = ['stale', 'indexer head not advancing'];
    else if (this.indexerFlags.verified === false) [status, reason] = ['unverified', 'the indexer state differs from the chain'];
    if (status === this.metrics.status && reason === this.metrics.statusReason) return;
    this.metrics.status = status;
    this.metrics.statusReason = reason;
    this.broadcast(this.statusEvent());
  }

  private statusEvent(): Buffer {
    return Buffer.from(`event: status\ndata: ${JSON.stringify({ indexer: this.metrics.status ?? 'stale', reason: this.metrics.statusReason, atMs: this.now() })}\n\n`);
  }

  // ------------------------------------------------------------------------------------------------ HTTP

  /** The viewer's address: the peer, or the forwarded client address when the peer is a trusted proxy. */
  private clientIp(req: IncomingMessage): string {
    const peer = normalizeIp(req.socket.remoteAddress ?? '');
    if (!this.trusted.has(peer)) return peer;
    const forwarded = header(req, 'cf-connecting-ip') ?? header(req, 'x-real-ip') ?? header(req, 'x-forwarded-for')?.split(',').at(-1);
    return forwarded?.trim() ? normalizeIp(forwarded.trim()) : peer;
  }

  private debugAllowed(req: IncomingMessage): boolean {
    if (this.options.exposeDebug) return true;
    const peer = normalizeIp(req.socket.remoteAddress ?? '');
    return LOOPBACK.includes(peer) && !FORWARDING_HEADERS.some((name) => header(req, name) !== undefined);
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://gateway.local');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...CORS, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Max-Age': '86400' }).end();
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        this.json(res, 405, { error: 'read-only service' });
        return;
      }
      const path = url.pathname.toLowerCase().replace(/\/+$/, '') || '/';
      if ((path === '/' || path === '/metrics') && !this.debugAllowed(req)) return this.json(res, 404, { error: 'not found' });
      if (path === '/') return this.page(res);
      if (path === '/metrics') return this.privateJson(res, { ...this.metrics, rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, uptimeS: Math.round(process.uptime()) });
      if (path === '/healthz') return this.health(res);
      if (path === `${this.basePath}/snapshot`) return await this.serveSnapshot(req, res);
      if (path === `${this.basePath}/stream`) {
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', ...CORS }).end();
          return;
        }
        return this.stream(req, res, url);
      }
      if (path === `${this.basePath}/curve`) return this.body(res, 200, this.curveJson, 'public, max-age=86400');
      if (path === `${this.basePath}/trades`) return await this.tradesPage(res, url);
      this.json(res, 404, { error: 'not found' });
    } catch (error) {
      console.error(`[gateway] ${req.url}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) this.json(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  }

  private body(res: ServerResponse, status: number, json: string, cache: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache, ...CORS, ...extra });
    res.end(json);
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    this.body(res, status, toJson(value), 'no-store');
  }

  /** No CORS: operator data, not for pages on other origins. */
  private privateJson(res: ServerResponse, value: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(toJson(value));
  }

  private page(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
    res.end(DEBUG_PAGE_HTML.replaceAll('__BASE__', this.basePath));
  }

  private health(res: ServerResponse): void {
    const ok = this.snapshot !== null && this.metrics.status === 'live';
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(toJson({ ok, status: this.metrics.status ?? 'stale', reason: this.metrics.statusReason, head: this.snapshot?.etag ?? null }));
  }

  private async serveSnapshot(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.metrics.snapshotRequests += 1;
    if (!this.snapshot) {
      const stored = await this.options.store.getSnapshot();
      if (stored) this.setSnapshot(stored);
    }
    const snapshot = this.snapshot;
    if (!snapshot) {
      this.body(res, 503, JSON.stringify({ error: 'warming up' }), 'no-store', { 'Retry-After': '2' });
      return;
    }
    // Each representation has its own tag (Cloudflare weakens a strong ETag when it compresses; clients compare weakly).
    const plain = `"${snapshot.etag}"`;
    const zipped = `"${snapshot.etag}-gz"`;
    const gzip = snapshot.gzip !== null && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    const headers = { ETag: gzip ? zipped : plain, 'X-SH-Indexer': this.metrics.status ?? 'stale', Vary: 'Accept-Encoding' };
    if (ifNoneMatch(header(req, 'if-none-match'), [plain, zipped])) {
      this.metrics.snapshot304 += 1;
      res.writeHead(304, { 'Cache-Control': SNAPSHOT_CACHE, ...CORS, ...headers }).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': SNAPSHOT_CACHE, ...CORS, ...headers, ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
    res.end(gzip && snapshot.gzip ? snapshot.gzip : snapshot.json);
  }

  /**
   * History, newest first, in the snapshot's trade shape (views.ts `tradeView`). A page is cached for a day only when
   * it is full, lies wholly at or below the finalized block, and the indexer is live (not rebuilding): a short or empty
   * page may mean trimmed or not-yet-rebuilt history. Everything else: one slot.
   */
  private async tradesPage(res: ServerResponse, url: URL): Promise<void> {
    const beforeText = url.searchParams.get('before');
    const before = beforeText && /^\d{1,16}$/.test(beforeText) ? Number(beforeText) : null;
    const limitText = url.searchParams.get('limit') ?? '100';
    const limit = /^\d{1,3}$/.test(limitText) ? Math.min(200, Math.max(1, Number(limitText))) : 100;
    const rows = await this.options.store.tradesPage(before, limit);
    const trades = rows.map((row) => toJson(tradeView(tradeFromJson(row))));
    const finalizedScore = this.finality.finalized === null ? null : firstScoreOf(this.finality.finalized + 1n);
    const settled = before !== null && finalizedScore !== null && before <= finalizedScore && rows.length === limit && this.metrics.status === 'live';
    this.body(res, 200, `{"trades":[${trades.join(',')}]}`, settled ? HISTORY_SETTLED_CACHE : HISTORY_RECENT_CACHE);
  }

  private stream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (this.clients.size >= (this.options.maxClients ?? 20_000)) {
      this.metrics.refusedFull += 1;
      this.body(res, 503, JSON.stringify({ error: 'busy' }), 'no-store', { 'Retry-After': String(3 + Math.floor(Math.random() * 27)) });
      return;
    }
    const ip = this.clientIp(req);
    if ((this.perIp.get(ip) ?? 0) >= (this.options.maxStreamsPerIp ?? 32)) {
      this.metrics.refusedPerIp += 1;
      this.body(res, 429, JSON.stringify({ error: 'too many streams from one address' }), 'no-store', { 'Retry-After': '30' });
      return;
    }
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 30_000);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...CORS });
    res.write(`retry: 3000\n: connected ${this.now()}\n\n`);
    const lastId = String(req.headers['last-event-id'] ?? url.searchParams.get('lastEventId') ?? '');
    if (lastId) {
      const seq = seqOf(lastId);
      const newest = this.metrics.lastSeq;
      if (seq !== null && newest !== null && this.floorSeq !== null && seq >= this.floorSeq && seq <= newest) {
        for (const event of this.replay) if (event.seq > seq) res.write(event.data);
      } else {
        res.write(`event: resync\ndata: {"reason":"unknown or expired Last-Event-ID"}\n\n`);
        this.writeSnapshotEvent(res);
      }
    } else if (url.searchParams.get('snapshot') !== '0') {
      this.writeSnapshotEvent(res);
    }
    if (this.metrics.status !== null) res.write(this.statusEvent());
    this.clients.set(res, { ip, stalledSinceMs: null });
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    this.metrics.connectionsTotal += 1;
    this.metrics.clients = this.clients.size;
    this.metrics.peakClients = Math.max(this.metrics.peakClients, this.clients.size);
    res.on('drain', () => {
      const meta = this.clients.get(res);
      if (meta) meta.stalledSinceMs = null;
    });
    req.on('close', () => this.forget(res));
    res.on('error', () => this.forget(res));
  }

  private writeSnapshotEvent(res: ServerResponse): void {
    if (!this.snapshot) return;
    const id = this.metrics.lastEventId;
    res.write(`${id ? `id: ${id}\n` : ''}event: snapshot\ndata: ${this.snapshot.json}\n\n`);
  }
}
