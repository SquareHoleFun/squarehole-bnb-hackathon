/**
 * The new-block tap. Every configured websocket URL is subscribed AT THE SAME TIME (`eth_subscribe("newHeads")`,
 * Node's built-in WebSocket; the header comes in the push, no extra call) and the first arrival of each block hash
 * wins: the live run showed publicnode delivering heads about 1 s before tenderly, and either socket can close on its
 * own (docs/design/realtime-chain-data.md § 9), so racing two keyless providers buys both speed and redundancy.
 * Each socket reconnects on its own with a backoff that grows with CONSECUTIVE failures (reset as soon as a socket
 * delivers a head), and is recycled as soon as another source has delivered two heads it did not (a connected but
 * silent socket: publicnode once stayed silent for 30 s after connecting while tenderly delivered), or after
 * `silenceMs` without any head. No keepalive by default: publicnode closed (1006) a newHeads socket right after its
 * third `eth_chainId` keepalive (60.9 s) while a silent socket beside it stayed open (§ 9.2); server pings are
 * answered by the WebSocket itself.
 *
 * Fallback: polling `eth_getBlockByNumber("latest")` over HTTP through the reader's endpoint rotation, fast
 * (`pollMs`) while no socket is healthy and slow (12 s) as a cross-check otherwise.
 * Duplicates across sources are dropped here; the pipeline dedupes by hash as well.
 */
import type { Hex } from 'viem';
import type { ChainReader } from './chain-reader';
import type { BlockHeader, HeadSource } from './model';

export interface HeadFeedOptions {
  readonly wsUrls: readonly string[];
  /** Only the latest header is read (the polling fallback): the PoC's reader and the core reader both fit. */
  readonly reader: Pick<ChainReader, 'latestHeader'>;
  readonly pollMs: number;
  readonly silenceMs: number;
  readonly slowPollMs?: number;
  /** Optional eth_chainId keepalive per socket (off by default; publicnode drops sockets that send it). */
  readonly keepaliveMs?: number;
  /** First reconnect delay after a short-lived connection; doubles per consecutive failure, capped at 30 s. */
  readonly reconnectBaseMs?: number;
  readonly onHead: (header: BlockHeader, source: HeadSource, seenAtMs: number) => void;
  readonly onStatus?: (status: HeadFeedStatus) => void;
  readonly now?: () => number;
}

export interface SocketStatus {
  readonly url: string;
  readonly connected: boolean;
  readonly lastHeadAtMs: number | null;
  readonly heads: number;
  /** Heads this socket delivered before any other source. */
  readonly firsts: number;
  readonly reconnects: number;
  /** Consecutive connections that ended without delivering a head (the backoff exponent). */
  readonly failures: number;
  /** Times this socket was recycled because other sources delivered heads it did not. */
  readonly recycledBehind: number;
}

export interface HeadFeedStatus {
  readonly mode: 'ws' | 'poll';
  readonly sockets: readonly SocketStatus[];
  readonly pollFirsts: number;
}

interface NewHeadsPayload {
  number: Hex;
  hash: Hex;
  parentHash: Hex;
  timestamp: Hex;
  logsBloom?: Hex;
}

export function headerFromNewHeads(payload: NewHeadsPayload): BlockHeader {
  return {
    number: BigInt(payload.number),
    hash: payload.hash,
    parentHash: payload.parentHash,
    timestamp: BigInt(payload.timestamp),
    ...(payload.logsBloom ? { logsBloom: payload.logsBloom } : {}),
  };
}

interface Slot {
  readonly url: string;
  socket: WebSocket | null;
  connected: boolean;
  lastHeadAtMs: number | null;
  /** The highest head number this socket delivered (or the feed's newest when it connected). */
  lastNumber: bigint | null;
  /** Whether the current connection has delivered a head yet. */
  delivered: boolean;
  connectedAtMs: number;
  heads: number;
  firsts: number;
  reconnects: number;
  failures: number;
  recycledBehind: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

const RECENT_HASHES = 256;

export class HeadFeed {
  private readonly options: HeadFeedOptions;
  private readonly now: () => number;
  private readonly slots: Slot[];
  private readonly seen = new Set<Hex>();
  private readonly seenOrder: Hex[] = [];
  private newest: bigint | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = true;
  private polling = false;
  private pollFirsts = 0;
  private rpcId = 10;
  private heardAtMs: number | null = null;

  constructor(options: HeadFeedOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.slots = options.wsUrls.map((url) => ({ url, socket: null, connected: false, lastHeadAtMs: null, lastNumber: null, delivered: false, connectedAtMs: 0, heads: 0, firsts: 0, reconnects: 0, failures: 0, recycledBehind: 0, retryTimer: null }));
  }

  /** When any source last answered with a head, the same one included (ms; null: never). The chain is reachable. */
  lastHeardMs(): number | null {
    return this.heardAtMs;
  }

  /** The newest head number any source delivered (null: none yet). */
  newestSeen(): bigint | null {
    return this.newest;
  }

  status(): HeadFeedStatus {
    return {
      mode: this.anySocketHealthy() ? 'ws' : 'poll',
      sockets: this.slots.map((s) => ({ url: s.url, connected: s.connected, lastHeadAtMs: s.lastHeadAtMs, heads: s.heads, firsts: s.firsts, reconnects: s.reconnects, failures: s.failures, recycledBehind: s.recycledBehind })),
      pollFirsts: this.pollFirsts,
    };
  }

  start(): void {
    this.stopped = false;
    for (const slot of this.slots) this.connect(slot);
    this.schedulePoll(0);
    this.timers.push(setInterval(() => this.checkSilence(), 1_000));
    const keepaliveMs = this.options.keepaliveMs ?? 0;
    if (keepaliveMs > 0) this.timers.push(setInterval(() => this.keepalive(), keepaliveMs));
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.pollTimer = null;
    for (const slot of this.slots) this.closeSocket(slot);
  }

  private healthy(slot: Slot): boolean {
    return slot.connected && slot.lastHeadAtMs !== null && this.now() - slot.lastHeadAtMs < this.options.silenceMs;
  }

  private anySocketHealthy(): boolean {
    return this.slots.some((slot) => this.healthy(slot));
  }

  /** First arrival of a hash from any source goes to the pipeline; later ones only count. */
  private deliver(header: BlockHeader, source: HeadSource, seenAtMs: number, slot: Slot | null): void {
    if (this.seen.has(header.hash)) return;
    this.seen.add(header.hash);
    this.seenOrder.push(header.hash);
    if (this.seenOrder.length > RECENT_HASHES) this.seen.delete(this.seenOrder.shift() as Hex);
    if (slot) slot.firsts += 1;
    else this.pollFirsts += 1;
    if (this.newest === null || header.number > this.newest) {
      this.newest = header.number;
      this.recycleSocketsBehind(header.number, slot);
    }
    this.options.onHead(header, source, seenAtMs);
  }

  /**
   * A connected socket that has not delivered head N − 1 when another source delivers N has missed two heads (N − 1
   * about a slot ago, and N): it is connected but not subscribed in effect. Recycle it now instead of waiting for the
   * silence timeout. A socket that is merely slower (tenderly: about 1 s) delivered N − 1 long ago and is kept.
   */
  private recycleSocketsBehind(number: bigint, source: Slot | null): void {
    for (const slot of this.slots) {
      if (slot === source || !slot.connected) continue;
      if (slot.lastNumber === null) {
        slot.lastNumber = number - 1n; // connected before any head: count from here
        continue;
      }
      if (slot.lastNumber < number - 1n) {
        console.warn(`[heads] ${slot.url} missed heads ${slot.lastNumber + 1n}…${number} that another source delivered; reconnecting`);
        slot.recycledBehind += 1;
        this.recordFailure(slot);
        this.reconnect(slot, this.backoff(slot));
      }
    }
  }

  private backoff(slot: Slot): number {
    return Math.min(30_000, (this.options.reconnectBaseMs ?? 1_000) * 2 ** Math.min(5, Math.max(0, slot.failures - 1)));
  }

  /** A connection that ends without a head is a failure; one that delivered a head resets the count. */
  private recordFailure(slot: Slot): void {
    if (!slot.delivered) slot.failures += 1;
  }

  private closeSocket(slot: Slot): void {
    if (slot.retryTimer) clearTimeout(slot.retryTimer);
    slot.retryTimer = null;
    const socket = slot.socket;
    slot.socket = null;
    slot.connected = false;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {
      // already closed
    }
  }

  private connect(slot: Slot): void {
    if (this.stopped) return;
    const socket = new WebSocket(slot.url);
    slot.socket = socket;
    slot.connectedAtMs = this.now();
    slot.delivered = false;
    socket.onopen = () => {
      slot.connected = true;
      slot.lastNumber = this.newest;
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
      this.options.onStatus?.(this.status());
    };
    socket.onmessage = (message: MessageEvent) => {
      const seenAtMs = this.now();
      let parsed: { id?: number; method?: string; params?: { result?: NewHeadsPayload }; error?: { message?: string } };
      try {
        parsed = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data)) as typeof parsed;
      } catch {
        return;
      }
      if (parsed.error && parsed.id === 1) {
        console.warn(`[heads] ${slot.url} refused the subscription: ${parsed.error.message ?? 'unknown error'}`);
        this.recordFailure(slot);
        this.reconnect(slot, Math.max(5_000, this.backoff(slot)));
        return;
      }
      const result = parsed.method === 'eth_subscription' ? parsed.params?.result : undefined;
      if (!result?.hash) return;
      let header: BlockHeader;
      try {
        header = headerFromNewHeads(result);
      } catch {
        return;
      }
      slot.lastHeadAtMs = seenAtMs;
      this.heardAtMs = seenAtMs;
      slot.heads += 1;
      slot.delivered = true;
      slot.failures = 0;
      if (slot.lastNumber === null || header.number > slot.lastNumber) slot.lastNumber = header.number;
      this.deliver(header, 'ws', seenAtMs, slot);
    };
    socket.onclose = (event: CloseEvent) => {
      if (slot.socket !== socket) return;
      const lived = this.now() - slot.connectedAtMs;
      console.warn(`[heads] ${slot.url} closed (code ${event.code}${event.reason ? `, ${event.reason}` : ''}) after ${lived} ms`);
      slot.connected = false;
      this.options.onStatus?.(this.status());
      this.recordFailure(slot);
      this.reconnect(slot, slot.failures > 0 ? this.backoff(slot) : 250);
    };
    socket.onerror = () => {
      // onclose follows
    };
  }

  private reconnect(slot: Slot, delayMs: number): void {
    if (this.stopped) return;
    this.closeSocket(slot);
    slot.reconnects += 1;
    slot.retryTimer = setTimeout(() => this.connect(slot), delayMs);
  }

  private keepalive(): void {
    for (const slot of this.slots) {
      if (!slot.connected || !slot.socket) continue;
      try {
        slot.socket.send(JSON.stringify({ jsonrpc: '2.0', id: (this.rpcId += 1), method: 'eth_chainId', params: [] }));
      } catch {
        // the close handler reconnects
      }
    }
  }

  private checkSilence(): void {
    if (this.stopped) return;
    for (const slot of this.slots) {
      const since = slot.lastHeadAtMs ?? slot.connectedAtMs;
      if (slot.connected && this.now() - since > this.options.silenceMs) {
        console.warn(`[heads] ${slot.url} silent for ${this.now() - since} ms; reconnecting`);
        slot.lastHeadAtMs = null;
        this.recordFailure(slot);
        this.reconnect(slot, slot.failures > 0 ? this.backoff(slot) : 250);
      }
    }
  }

  private schedulePoll(delay: number): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    const healthy = this.anySocketHealthy();
    this.polling = true;
    try {
      const header = await this.options.reader.latestHeader();
      this.heardAtMs = this.now();
      this.deliver(header, 'poll', this.now(), null);
    } catch (error) {
      console.warn(`[heads] poll failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.polling = false;
      this.schedulePoll(healthy ? (this.options.slowPollMs ?? 12_000) : this.options.pollMs);
    }
  }
}
