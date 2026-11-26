import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';

/**
 * SH-266: Atlas push-mode prices, read with a plain eth_call and no key: the MultiFeed registry on BNB MAINNET (chain
 * 56) and the SingleFeeds Atlas publishes on BNB mainnet or on BNB Chain testnet (97). Server side only (keeper,
 * indexer). The browser never imports this module and never talks to a price source.
 *
 * Two shapes, both from Atlas's own interfaces (github.com/oracle-atlas/push-oracle-interfaces):
 * - the MultiFeed registry: fetchBatch(bytes4[]) -> (uint80 price, uint48 aggregatedTs, uint48 onchainTs)[],
 *   an unknown id answers all zero;
 * - a SingleFeed: latestRoundData() -> (roundId, int256 answer, startedAt = aggregation time, updatedAt = write time,
 *   answeredInRound).
 * Every price has 18 decimals (checked on every read, on the same endpoint as the price). Answers are decoded by hand
 * word by word and refused when a word is wider than its type (a price wider than uint80, as the registry's own type).
 * Amounts and prices are bigint only.
 *
 * Endpoints: every feed is read on every endpoint of its chain (decimals and price from the same endpoint), and a price
 * is taken only when two endpoints give the same answer; otherwise it is withheld. Each endpoint's chain id is checked
 * once; an endpoint that fails, rate-limits or times out waits (1 s doubling to 60 s); a reverting call makes nobody
 * wait. The band against the last accepted price stays as a second guard.
 */

export const ATLAS_CHAIN_ID = 56n;
export const ATLAS_DECIMALS = 18;
/** The MultiFeed registry of the 105 tokenized stocks (bStocks) and LISTA on BNB mainnet. */
export const ATLAS_MAINNET_REGISTRY: Address = '0xeace519ebb14fb8404fa6ddd23c3b34abade44aa';
/** Feed 633, BNB/USD: the SingleFeed on BNB mainnet, and Atlas's open BNB/USD feed on BNB Chain testnet (97), which
 * answers any caller (SH-272; the first testnet feed, 0xb3d1614b..., refused contracts and stopped updating on 25
 * November 2026). */
export const ATLAS_BNB_USD_MAINNET: Address = '0x9c0517f5b4c8657c7f18d68d2d79e2b3b1cd6438';
export const ATLAS_BNB_USD_TESTNET: Address = '0x3957d289ee9c38272377786787ea34f9dd29788d';
/** The sanity band applies against a last accepted price no older than this. */
export const ATLAS_BAND_WINDOW_SECONDS = 3600n;
/** Default band: a step of more than 20% against the last accepted price (within the window) is refused. */
export const ATLAS_DEFAULT_BAND_BPS = 2000n;
export const UINT80_MAX = (1n << 80n) - 1n;
const UINT48_MAX = (1n << 48n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

export const atlasAbi = parseAbi([
  'function fetchBatch(bytes4[] ids) view returns ((uint80 price, uint48 aggregatedTs, uint48 onchainTs)[])',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/** Where a feed lives: the chain (56 BNB mainnet, or 97 where Atlas lists a feed on the test network) and its contract. */
export type AtlasSource =
  | { readonly kind: 'multi'; readonly chainId: bigint; readonly registry: Address; readonly feedId: number }
  | { readonly kind: 'single'; readonly chainId: bigint; readonly address: Address };

export interface AtlasFeed {
  /** Atlas's own feed name, e.g. "NVDAB/USD". */
  readonly name: string;
  /** Atlas's feed number (633 BNB/USD, 934 NVDAB/USD). */
  readonly atlasId: number;
  readonly source: AtlasSource;
  /** Freshness: now - onchainTs must be at most this. Three heartbeats for a 60 s feed. */
  readonly maxAgeSeconds: bigint;
  /** Largest accepted step against the last accepted price, in basis points. */
  readonly bandBps?: bigint;
}

export type AtlasRefusalCode = 'RPC_FAILED' | 'BAD_DECIMALS' | 'MALFORMED' | 'TOO_WIDE' | 'NEVER_WRITTEN' | 'NO_PRICE' | 'FUTURE'
  | 'STALE' | 'OUT_OF_ORDER' | 'OUT_OF_BAND' | 'NOT_READ' | 'DISAGREE' | 'ONE_ENDPOINT';

export interface AtlasPrice {
  readonly ok: true;
  readonly feed: string;
  readonly atlasId: number;
  /** USD per whole coin, 18 decimals, at most uint80. */
  readonly price: bigint;
  /** Off-chain aggregation time and on-chain write time, unix seconds. */
  readonly aggregatedAt: bigint;
  readonly onchainAt: bigint;
  readonly source: 'Atlas';
}
export interface AtlasRefusal { readonly ok: false; readonly feed: string; readonly atlasId: number; readonly refusal: AtlasRefusalCode }
export type AtlasAnswer = AtlasPrice | AtlasRefusal;

/** What a feed answered on chain, before any rule. */
export interface AtlasRaw { readonly price: bigint; readonly aggregatedAt: bigint; readonly onchainAt: bigint }

export type EthCall = ((to: Address, data: Hex) => Promise<Hex>) & { readonly provider?: string };
/** The endpoints of each chain a feed lives on, in order; a chain without one refuses its feeds (RPC_FAILED). */
export type EthCallFor = (chainId: bigint) => EthCall | readonly EthCall[] | undefined;

export const atlasFeedId = (n: number): Hex => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error('atlas feed id out of range');
  return `0x${n.toString(16).padStart(8, '0')}`;
};

const refuse = (feed: AtlasFeed, refusal: AtlasRefusalCode): AtlasRefusal => ({ ok: false, feed: feed.name, atlasId: feed.atlasId, refusal });

/**
 * The rules, in order: the feed was written (onchainTs != 0), has a positive price within uint80 and its aggregation
 * time is not after its write time; it was not written after `now` (no allowance on reading); it is at most
 * maxAgeSeconds old at `now` (Atlas's documented check); it is not older than the last accepted observation of the same
 * feed (a regression never replaces the reference); and, when the reference is within the band window, it moved at
 * most bandBps from it. A refused price never becomes the reference.
 */
export function judgeAtlas(feed: AtlasFeed, raw: AtlasRaw | AtlasRefusalCode, now: bigint, last?: AtlasPrice | AtlasRaw): AtlasAnswer {
  if (typeof raw === 'string') return refuse(feed, raw);
  if (raw.onchainAt === 0n) return refuse(feed, 'NEVER_WRITTEN');
  if (raw.price <= 0n) return refuse(feed, 'NO_PRICE');
  if (raw.price > UINT80_MAX) return refuse(feed, 'TOO_WIDE');
  if (raw.aggregatedAt > raw.onchainAt) return refuse(feed, 'MALFORMED');
  if (raw.onchainAt > now) return refuse(feed, 'FUTURE');
  if (now - raw.onchainAt > feed.maxAgeSeconds) return refuse(feed, 'STALE');
  if (last && last.price > 0n) {
    if (raw.onchainAt < last.onchainAt) return refuse(feed, 'OUT_OF_ORDER');
    if (raw.onchainAt - last.onchainAt <= ATLAS_BAND_WINDOW_SECONDS) {
      const step = raw.price > last.price ? raw.price - last.price : last.price - raw.price;
      if (step * 10_000n > (feed.bandBps ?? ATLAS_DEFAULT_BAND_BPS) * last.price) return refuse(feed, 'OUT_OF_BAND');
    }
  }
  return { ok: true, feed: feed.name, atlasId: feed.atlasId, price: raw.price, aggregatedAt: raw.aggregatedAt, onchainAt: raw.onchainAt, source: 'Atlas' };
}

/** Age check again at the moment of use: an accepted price grows old, and is never used before its own time. */
export function freshAt(feed: AtlasFeed, answer: AtlasAnswer | undefined, now: bigint): AtlasAnswer {
  if (!answer) return refuse(feed, 'NOT_READ');
  if (!answer.ok) return answer;
  if (answer.onchainAt > now) return refuse(feed, 'FUTURE');
  if (now - answer.onchainAt > feed.maxAgeSeconds) return refuse(feed, 'STALE');
  return answer;
}

/** The 32-byte words of an ABI answer, or null when the length is not whole words. */
export function abiWords(data: Hex): bigint[] | null {
  if (!/^0x([0-9a-fA-F]{64})*$/.test(data)) return null;
  const out: bigint[] = [];
  for (let i = 2; i < data.length; i += 64) out.push(BigInt(`0x${data.slice(i, i + 64)}`));
  return out;
}

/** decimals(): exactly one word equal to 18. */
export function decodeDecimals(data: Hex): boolean {
  const w = abiWords(data);
  return w !== null && w.length === 1 && w[0] === BigInt(ATLAS_DECIMALS);
}

/** latestRoundData(): exactly five words, the two round words (first and fifth) within uint80 as on chain; a negative
 * answer is NO_PRICE, a positive one wider than uint80 TOO_WIDE. */
export function decodeRound(data: Hex): AtlasRaw | AtlasRefusalCode {
  const w = abiWords(data);
  if (!w || w.length !== 5) return 'MALFORMED';
  const [round, answer, startedAt, updatedAt, answeredIn] = w as [bigint, bigint, bigint, bigint, bigint];
  if (round > UINT80_MAX || answeredIn > UINT80_MAX) return 'MALFORMED';
  if (answer >= 1n << 255n) return 'NO_PRICE';
  if (answer > UINT80_MAX) return 'TOO_WIDE';
  if (startedAt > UINT64_MAX || updatedAt > UINT64_MAX) return 'MALFORMED';
  return { price: answer, aggregatedAt: startedAt, onchainAt: updatedAt };
}

/** fetchBatch(): one dynamic array of `count` (uint80, uint48, uint48) rows, nothing else; a row with a word wider than
 * its type is refused alone (MALFORMED / TOO_WIDE), the other rows stand. A wrong outer shape refuses every row. */
export function decodeBatch(data: Hex, count: number): (AtlasRaw | AtlasRefusalCode)[] {
  const w = abiWords(data);
  if (!w || w.length !== 2 + 3 * count || w[0] !== 32n || w[1] !== BigInt(count)) return Array.from({ length: count }, () => 'MALFORMED' as const);
  return Array.from({ length: count }, (_, i) => {
    const [price, aggregatedAt, onchainAt] = [w[2 + 3 * i], w[3 + 3 * i], w[4 + 3 * i]] as [bigint, bigint, bigint];
    if (price > UINT80_MAX) return 'TOO_WIDE';
    if (aggregatedAt > UINT48_MAX || onchainAt > UINT48_MAX) return 'MALFORMED';
    return { price, aggregatedAt, onchainAt };
  });
}

const endpointsOf = (callFor: EthCallFor, chainId: bigint): readonly EthCall[] => {
  const c = callFor(chainId);
  return c === undefined ? [] : typeof c === 'function' ? [c] : c;
};

/** One endpoint's read of a group of feeds on one chain (singles alone, a registry's feeds in one batch). */
async function readOn(call: EthCall, group: readonly AtlasFeed[]): Promise<(AtlasRaw | AtlasRefusalCode)[]> {
  const first = group[0];
  if (!first) return [];
  const to = first.source.kind === 'multi' ? first.source.registry : first.source.address;
  try {
    if (!decodeDecimals(await call(to, encodeFunctionData({ abi: atlasAbi, functionName: 'decimals' })))) return group.map(() => 'BAD_DECIMALS');
    if (first.source.kind === 'single') return [decodeRound(await call(to, encodeFunctionData({ abi: atlasAbi, functionName: 'latestRoundData' })))];
    const ids = group.map(f => atlasFeedId((f.source as { feedId: number }).feedId));
    return decodeBatch(await call(to, encodeFunctionData({ abi: atlasAbi, functionName: 'fetchBatch', args: [ids] })), group.length);
  } catch {
    return group.map(() => 'RPC_FAILED');
  }
}

/** Groups: each single feed alone; the feeds of one registry together. */
function groupsOf(feeds: readonly AtlasFeed[]): AtlasFeed[][] {
  const groups = new Map<string, AtlasFeed[]>();
  for (const f of feeds) {
    const key = f.source.kind === 'multi' ? `m:${f.source.chainId}:${f.source.registry.toLowerCase()}` : `s:${f.name}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()];
}

/**
 * Reads every feed on EVERY endpoint of its chain and takes a price only when two different PROVIDERS give the same
 * answer (price and both times, word for word after strict decoding) and that answer passes the rules; otherwise the
 * feed is withheld: DISAGREE when the providers that answered differ, ONE_ENDPOINT when fewer than two providers are
 * configured or answered (one provider's several urls count once), or the agreed answer's own refusal. No first-reading
 * exception.
 */
export async function readAtlas(callFor: EthCallFor, feeds: readonly AtlasFeed[], judge: (feed: AtlasFeed, raw: AtlasRaw | AtlasRefusalCode) => AtlasAnswer): Promise<Map<string, AtlasAnswer>> {
  const out = new Map<string, AtlasAnswer>();
  const same = (a: AtlasRaw, b: AtlasRaw) => a.price === b.price && a.aggregatedAt === b.aggregatedAt && a.onchainAt === b.onchainAt;
  await Promise.all(groupsOf(feeds).map(async group => {
    const calls = endpointsOf(callFor, group[0]?.source.chainId ?? 0n);
    // One vote per provider: an untagged endpoint (tests) is its own provider by identity.
    const providerKey = (call: EthCall) => call.provider ?? call;
    const providers = new Set(calls.map(providerKey));
    if (providers.size < 2) { for (const f of group) out.set(f.name, refuse(f, 'ONE_ENDPOINT')); return; }
    const perEndpoint = await Promise.all(calls.map(call => readOn(call, group)));
    group.forEach((f, k) => {
      // The first decoded answer of each provider is its vote.
      const votes = new Map<unknown, AtlasRaw>();
      const refusals: AtlasRefusalCode[] = [];
      calls.forEach((call, e) => {
        const a = perEndpoint[e]?.[k] ?? 'MALFORMED';
        if (typeof a === 'string') refusals.push(a);
        else if (!votes.has(providerKey(call))) votes.set(providerKey(call), a);
      });
      const decoded = [...votes.values()];
      const agreed = decoded.find((a, i) => decoded.some((b, j) => j !== i && same(a, b)));
      if (agreed) { out.set(f.name, judge(f, agreed)); return; }
      if (decoded.length >= 2) { out.set(f.name, refuse(f, 'DISAGREE')); return; }
      // Fewer than two providers answered: a reason when one was given, else one provider is not enough.
      const refusal = refusals.find(a => a !== 'RPC_FAILED');
      out.set(f.name, refuse(f, decoded.length === 1 || !refusal ? (decoded.length === 1 ? 'ONE_ENDPOINT' : 'RPC_FAILED') : refusal));
    });
  }));
  for (const f of feeds) if (!out.has(f.name)) out.set(f.name, refuse(f, 'RPC_FAILED'));
  return out;
}

/** The raw answers of one endpoint per chain, unjudged (tools and tests). */
export async function readAtlasRaw(callFor: EthCallFor, feeds: readonly AtlasFeed[]): Promise<Map<string, AtlasRaw | AtlasRefusalCode>> {
  const out = new Map<string, AtlasRaw | AtlasRefusalCode>();
  await Promise.all(groupsOf(feeds).map(async group => {
    const call = endpointsOf(callFor, group[0]?.source.chainId ?? 0n)[0];
    const raws = call ? await readOn(call, group) : group.map(() => 'RPC_FAILED' as const);
    group.forEach((f, k) => out.set(f.name, raws[k] ?? 'MALFORMED'));
  }));
  return out;
}

export interface RpcOptions {
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
  /** The chain the endpoints must serve; an endpoint that names another chain is never used. */
  readonly chainId?: bigint;
  /** Clock for the backoff (ms). */
  readonly nowMs?: () => number;
}

/**
 * One endpoint: its chain id checked once; an endpoint-wide failure (HTTP error, a rate limit, an error answer other
 * than a revert, a timeout, another chain) makes it wait before it is asked again, 1 s doubling to 60 s; a call that
 * reverts is that call's answer and makes nobody wait; a success clears the wait.
 */
export function rpcEndpoint(url: string, options: RpcOptions = {}): EthCall {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const want = options.chainId ?? ATLAS_CHAIN_ID;
  const nowMs = options.nowMs ?? Date.now;
  let checked = false, failures = 0, until = 0, id = 0;
  const post = async (method: string, params: unknown[]): Promise<unknown> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: controller.signal });
      if (!res.ok) throw new Error('price endpoint http error');
      const body = await res.json() as { result?: unknown; error?: { code?: unknown; message?: unknown } };
      // A call that reverts is this call's answer, not the endpoint's failure: no wait for the endpoint.
      if (body.error !== undefined && (body.error.code === 3 || /revert/i.test(String(body.error.message ?? '')))) throw Object.assign(new Error('call reverted'), { reverted: true });
      if (body.error !== undefined || body.result === undefined) throw new Error('price endpoint error');
      return body.result;
    } finally { clearTimeout(timer); }
  };
  return async (to, data) => {
    if (nowMs() < until) throw new Error('price endpoint waiting');
    try {
      if (!checked) {
        const chain = await post('eth_chainId', []);
        if (typeof chain !== 'string' || !/^0x[0-9a-fA-F]+$/.test(chain) || BigInt(chain) !== want) throw new Error('price endpoint serves another chain');
        checked = true;
      }
      const result = await post('eth_call', [{ to, data }, 'latest']);
      if (typeof result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(result)) throw new Error('price endpoint answer');
      failures = 0; until = 0;
      return result as Hex;
    } catch (error) {
      if (!(error as { reverted?: boolean }).reverted) {
        failures += 1;
        until = nowMs() + Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6));
      }
      throw error;
    }
  };
}

/** An endpoint url normalised (scheme and host lower case, no trailing slash) for de-duplication. */
export function normaliseRpcUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

/** The provider an endpoint belongs to: its host's registrable domain (the last two labels: bsc-dataseed.bnbchain.org
 * and bsc-testnet-dataseed.bnbchain.org are one provider, bnbchain.org). Two votes need two different providers. */
export function providerOf(url: string): string {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return url; }
  return host.split('.').filter(Boolean).slice(-2).join('.');
}

/** The endpoints of a list, normalised and de-duplicated, in order, each with its own chain check and wait and tagged with
 * its provider. */
export function rpcEndpoints(urls: readonly string[], options: RpcOptions = {}): EthCall[] {
  const unique = [...new Map(urls.map(u => [normaliseRpcUrl(u), u])).values()];
  if (unique.length === 0) throw new Error('no price endpoint');
  return unique.map(u => Object.assign(rpcEndpoint(u, options), { provider: providerOf(u) }));
}

/** A single eth_call over the list, first answer wins (kept for tools; the book judges per endpoint instead). */
export function rpcEthCall(urls: readonly string[], options: RpcOptions = {}): EthCall {
  const list = rpcEndpoints(urls, options);
  return async (to, data) => {
    for (const call of list) { try { return await call(to, data); } catch { /* next endpoint */ } }
    throw new Error('price endpoints unavailable');
  };
}

/** A feed's reference for the band: the last accepted observation. Persisted by the keeper across restarts. */
export type AtlasReferences = Readonly<Record<string, { readonly price: string; readonly aggregatedAt: string; readonly onchainAt: string }>>;

/**
 * The last accepted price per feed and the latest answer. `refresh` reads every feed (at most once per
 * `minRefreshSeconds` unless forced); `price` answers at the moment of use, so an accepted price that grew old (or is
 * not yet due) is refused. `references`/`restore` carry the band's reference across a restart.
 */
export class AtlasBook {
  private readonly answers = new Map<string, AtlasAnswer>();
  private readonly accepted = new Map<string, AtlasPrice>();
  private lastRefresh: bigint | null = null;
  constructor(readonly feeds: readonly AtlasFeed[], private readonly callFor: EthCallFor, readonly minRefreshSeconds = 15n) {
    const names = new Set(feeds.map(f => f.name));
    if (names.size !== feeds.length) throw new Error('atlas feed names must be unique');
  }

  async refresh(now: bigint, force = false): Promise<readonly AtlasAnswer[]> {
    if (!force && this.lastRefresh !== null && now >= this.lastRefresh && now - this.lastRefresh < this.minRefreshSeconds) {
      return this.feeds.map(f => this.price(f.name, now));
    }
    this.lastRefresh = now;
    let answers: Map<string, AtlasAnswer>;
    try { answers = await readAtlas(this.callFor, this.feeds, (f, raw) => judgeAtlas(f, raw, now, this.accepted.get(f.name))); } catch { answers = new Map(); }
    return this.feeds.map(f => {
      const answer = answers.get(f.name) ?? refuse(f, 'RPC_FAILED');
      this.answers.set(f.name, answer);
      if (answer.ok) this.accepted.set(f.name, answer);
      return answer;
    });
  }

  /** The latest answer for a feed, judged for age at `now`. A refusal stays a refusal until a later read accepts. */
  price(name: string, now: bigint): AtlasAnswer {
    const feed = this.feeds.find(f => f.name === name);
    if (!feed) return { ok: false, feed: name, atlasId: 0, refusal: 'NOT_READ' };
    return freshAt(feed, this.answers.get(name), now);
  }

  references(): AtlasReferences {
    return Object.fromEntries([...this.accepted.entries()].map(([k, a]) => [k, { price: a.price.toString(), aggregatedAt: a.aggregatedAt.toString(), onchainAt: a.onchainAt.toString() }]));
  }

  /** Restores the band's references (never the answers: nothing is usable before a fresh read). Malformed rows are ignored. */
  restore(refs: unknown): void {
    if (refs === null || typeof refs !== 'object') return;
    for (const f of this.feeds) {
      const r = (refs as Record<string, unknown>)[f.name] as Record<string, unknown> | undefined;
      const num = (v: unknown) => (typeof v === 'string' && /^[0-9]{1,30}$/.test(v) ? BigInt(v) : null);
      const price = num(r?.price), aggregatedAt = num(r?.aggregatedAt), onchainAt = num(r?.onchainAt);
      if (price === null || aggregatedAt === null || onchainAt === null || price === 0n || price > UINT80_MAX) continue;
      this.accepted.set(f.name, { ok: true, feed: f.name, atlasId: f.atlasId, price, aggregatedAt, onchainAt, source: 'Atlas' });
    }
  }
}

/** USD value of a raw amount, 18 decimals; floor. */
export const usdValueX18 = (amount: bigint, decimals: number, price: AtlasPrice): bigint => amount * price.price / 10n ** BigInt(decimals);

/**
 * Wei of the native coin a raw amount of a coin is worth at two Atlas prices (both 18 decimals): the coin's USD price
 * over the native coin's USD price. One floor division: never more than the prices say.
 */
export const nativeWeiOf = (amount: bigint, decimals: number, coin: AtlasPrice, native: AtlasPrice): bigint =>
  amount * coin.price * 10n ** 18n / (native.price * 10n ** BigInt(decimals));
