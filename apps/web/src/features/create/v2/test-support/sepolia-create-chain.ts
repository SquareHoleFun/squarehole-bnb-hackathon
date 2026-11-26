/**
 * The committed Sepolia state a fresh Create page reads (XR-CREATE-RPC-COUNT's replay, kept by SH-CREATE-RPC-BATCHING),
 * as one fetch double for the indexer and the keyless RPC. The book holds the seven listings of
 * docs/evidence/SH-SEPOLIA-EXAMPLES-INFRA.md:146 (ETH, tLINK, tUSDC, tNVDA, tGOLD, tPEPE, tFROG at their Sepolia
 * addresses); the fee module directory holds five rows (:270): the four built-in modules of
 * packages/contracts/script/sepolia-v2/CoreV2Deployment.sol:88, which answer `feeActionVersion()` and `poolManager()`
 * but no other Alchemist getter, and row 4, The Alchemist for a tPEPE box with a tGOLD pile over two v4 hops, whose
 * `resolve(4)` reverts until it matures (2026-10-27 12:23:12 UTC). Every listed coin and module holds code; tGOLD answers
 * `paused()` and `isFrozen(address)` (its two issuer lines); the factory allows every Eat probe; any other call reverts.
 * The release's addresses are the recorded twin's (e2e/fixtures/core-local, with Sepolia's chain id); the directory, its
 * modules and the route helper are stand-ins.
 *
 * It answers single JSON-RPC requests, JSON-RPC batches and Multicall3 `aggregate3` calls at Sepolia's canonical
 * Multicall3, and counts what reaches it: HTTP requests by host, JSON-RPC operations by method, every view call inside
 * them (an aggregate's calls included) and every code read. Nothing leaves the test.
 */
import { SEPOLIA_MULTICALL3, SEPOLIA_PUBLIC_RPC_URLS } from '@squarehole/chain';
import { decodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, multicall3Abi, parseAbi, toHex, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import recorded from '../../../../../e2e/fixtures/core-local/manifest-11155111.json' with { type: 'json' };
import { factoryV2Abi, parseCoreManifestV2, receiverModulesV21Abi } from '../../../../../../../packages/chain/src/core/v2';
import { alchemistDirectoryV21Abi, alchemistRouteV21Abi, alchemistV21Abi } from '../../../../../../../packages/chain/src/core/v2/alchemist-v21';
import type { V2Source } from '../../../core/v2/indexer-v2';

/** The keyless public Sepolia RPC the site reads (indexer-v2.ts `sourceV2`). */
export const SEPOLIA_RPC = SEPOLIA_PUBLIC_RPC_URLS[0] ?? '';
/** Any other RPC: read one request per call (view-client.ts), as every RPC was before SH-CREATE-RPC-BATCHING. */
export const DIRECT_RPC = 'https://rpc.invalid/direct';
export const INDEXER = 'https://indexer.invalid';
const SEPOLIA = 11_155_111;

const at = (n: number): Address => toHex(n, { size: 20 }) as Address;
const manifest = parseCoreManifestV2({ ...recorded, network: 'sepolia' });
const release = manifest.releases[0];
if (!release) throw new Error('The recorded twin has no v2 release');
export const RELEASE = Object.freeze({
  registry: release.registry.address, factory: release.factory.address, receiver: release.implementations.receiver.address,
  coordinator: release.implementations.coordinator.address, manager: manifest.chain.poolManager.address as Address,
});
export const DIRECTORY = at(0xd1);
/** Row `id`'s module; row 4's is The Alchemist. */
export const moduleOf = (id: number): Address => at(0x40 + id);
export const ALCHEMIST = moduleOf(4);
export const ROUTE_HELPER = at(0x60);
export const TRIGGER = at(0x99);
const RUNTIME: Hex = '0x608000';
const CODE_HASH = keccak256(RUNTIME);
/** Row 4's readyAt (record(4) on Sepolia). */
export const READY_AT = 1_793_103_792n;

export const COINS = Object.freeze([
  { symbol: 'ETH', address: zeroAddress, decimals: 18, class: 'NATIVE', raise: '100000000000000000' },
  { symbol: 'tLINK', address: '0xb1b5cddb6be298e9188984e53513b0db38eea6d7', decimals: 18, class: 'OTHER', raise: '100000000000000000000' },
  { symbol: 'tUSDC', address: '0x5b397f65571def193ba5dbe8b2a353c3963c65f6', decimals: 6, class: 'STABLE', raise: '100000000' },
  { symbol: 'tNVDA', address: '0x2cbbad2607fccfee778d959d386997862099f33b', decimals: 18, class: 'STOCK', raise: '100000000000000000000' },
  { symbol: 'tGOLD', address: '0x25f276ce776f5c9b0686250e78ea34bf7ab4c17a', decimals: 18, class: 'OTHER', raise: '1000000000000000000' },
  { symbol: 'tPEPE', address: '0x1c5231c8bdde9ed7aa80fe13edb634db9bd3e1c7', decimals: 18, class: 'OTHER', raise: '100000000000000000000000' },
  { symbol: 'tFROG', address: '0x86d5c2533a78077c125630d4d1d1b2321a07eb35', decimals: 18, class: 'OTHER', raise: '100000000000000000000000' },
] as const satisfies readonly { symbol: string; address: string; decimals: number; class: string; raise: string }[]);
export const coin = (symbol: (typeof COINS)[number]['symbol']): Address => (COINS.find((c) => c.symbol === symbol)?.address ?? zeroAddress) as Address;

/** A Sepolia v2 source on `rpc` (the public RPC by default) and this double's indexer. */
export const sepoliaSource = (rpc: string = SEPOLIA_RPC): V2Source => ({ network: 'sepolia', manifest, origin: INDEXER, rpc });

/** The indexer's book for the release, in its wire shape. */
export function listingBook(): unknown {
  return {
    schema: 'sh.core-listings.v2', chainId: SEPOLIA, registry: RELEASE.registry.toLowerCase(),
    listings: COINS.map((c, id) => ({ id, token: c.address, raise: c.raise, detail: { id, token: c.address, raise: c.raise, decimals: c.decimals, class: c.class, kind: 'LISTED', listedAt: '1', q: { bootstrapQ: '35655029729004', batchMinQ: '1', tipMaxQ: '1', swapStepMinQ: '1' } } })),
  };
}

const POWER_ABI = parseAbi([
  'function controls() view returns (address)', 'function paused() view returns (bool)', 'function frozen(address) view returns (bool)', 'function isFrozen(address) view returns (bool)',
  'function isBlacklisted(address) view returns (bool)', 'function isBlackListed(address) view returns (bool)', 'function isBlocked(address) view returns (bool)',
]);
const TOKEN_ABI = [...erc20Abi, ...POWER_ABI] as const;

type Answer = { readonly result: Hex } | { readonly error: { readonly code: number; readonly message: string; readonly data?: Hex } };
const REVERT: Answer = { error: { code: 3, message: 'execution reverted', data: '0x' } };

/** Where a read goes: the coin metadata, the factory's Eat answers, The Alchemist's discovery, or Multicall3 itself. */
export type ReadSource = 'metadata' | 'eat' | 'alchemist' | 'multicall' | 'other';
const tokenSet = new Set<string>(COINS.map((c) => c.address.toLowerCase()));
export function sourceOf(address: string): ReadSource {
  const to = address.toLowerCase();
  if (tokenSet.has(to)) return 'metadata';
  if (to === RELEASE.factory.toLowerCase()) return 'eat';
  if (to === SEPOLIA_MULTICALL3.toLowerCase()) return 'multicall';
  if ([RELEASE.receiver, DIRECTORY, ROUTE_HELPER, ...[0, 1, 2, 3, 4].map(moduleOf)].some((known) => known.toLowerCase() === to)) return 'alchemist';
  return 'other';
}

export interface ChainOptions {
  /** Row 4 has matured: `resolve(4)` answers. */
  readonly mature?: boolean;
  /** Every RPC request (after `answered` of them) is answered with HTTP 429, or fails as a network error. */
  readonly failure?: { readonly kind: '429' | 'network'; readonly answered?: number } | null;
  /** The RPC serves another chain. */
  readonly chainId?: number;
  /** Multicall3 holds no code: an `aggregate3` call answers nothing ('0x'). */
  readonly noMulticall?: boolean;
  /** Calls answered as no data (a successful call returning '0x'), by target and function name. */
  readonly empty?: readonly string[];
  /** Code reads that fail with an RPC error (not a revert), by address. */
  readonly failCode?: readonly string[];
}

export interface ChainStats {
  /**
   * HTTP requests: to the RPC, to the indexer for the book, to the indexer for the release's list of switched-off Create
   * options (SH-218 rail 2, answered empty), and any other URL (none is expected).
   */
  readonly http: { rpc: number; indexer: number; createOptions: number; other: string[] };
  /** JSON-RPC operations (one per request, a batch's members each), by method. */
  ops: number;
  readonly methods: Record<string, number>;
  /** eth_call operations to Multicall3 (`aggregate3`). */
  aggregates: number;
  /** Every view call: a direct eth_call's or an aggregate's member (`to:data`), in order. */
  readonly calls: string[];
  /** Every eth_getCode address, in order. */
  readonly codes: string[];
  /** JSON-RPC operations by where their calls go (an aggregate by its members' source; eth_chainId under 'chain'). */
  readonly bySource: Record<string, number>;
}
const emptyStats = (): ChainStats => ({ http: { rpc: 0, indexer: 0, createOptions: 0, other: [] }, ops: 0, methods: {}, aggregates: 0, calls: [], codes: [], bySource: {} });
const bump = (record: Record<string, number>, key: string) => { record[key] = (record[key] ?? 0) + 1; };

export interface FakeChain {
  fetch: typeof fetch;
  stats: ChainStats;
  /** Starts counting again (the chain's state stays). */
  reset(): void;
}

/** The double: one fetch for the indexer origin and every RPC URL (the public one and DIRECT_RPC alike). */
export function sepoliaChain(options: ChainOptions = {}): FakeChain {
  const empty = new Set(options.empty ?? []);
  let envelopes = 0;
  const chain: FakeChain = { stats: emptyStats(), reset: () => { chain.stats = emptyStats(); }, fetch: undefined as never };

  function view(to: Address, data: Hex): Answer {
    const target = to.toLowerCase();
    const known: Abi | null = target === RELEASE.receiver.toLowerCase() ? receiverModulesV21Abi as Abi
      : target === DIRECTORY.toLowerCase() ? alchemistDirectoryV21Abi as Abi
      : target === RELEASE.factory.toLowerCase() ? factoryV2Abi as Abi
      : tokenSet.has(target) ? TOKEN_ABI as Abi
      : target === ROUTE_HELPER.toLowerCase() ? alchemistRouteV21Abi as Abi
      : sourceOf(target) === 'alchemist' ? alchemistV21Abi as Abi : null;
    if (!known) return REVERT;
    let call: { functionName: string; args?: readonly unknown[] };
    try { call = decodeFunctionData({ abi: known, data }) as typeof call; } catch { return REVERT; }
    const { functionName: name, args = [] } = call;
    if (empty.has(`${target}:${name}`)) return { result: '0x' };
    const ok = (result: unknown): Answer => ({ result: encodeFunctionResult({ abi: known, functionName: name, result } as never) });
    if (target === RELEASE.receiver.toLowerCase()) return name === 'receiverCode' ? ok([at(0x73), at(0x74), DIRECTORY]) : REVERT;
    if (target === RELEASE.factory.toLowerCase()) return name === 'refusal' ? ok('0x') : REVERT;
    if (target === DIRECTORY.toLowerCase()) {
      if (name === 'count') return ok(5n);
      const id = Number(args[0]);
      if (name === 'record') return ok([moduleOf(id), CODE_HASH, id === 4 ? READY_AT : 1n, false]);
      if (name === 'resolve') return id < 4 || options.mature ? ok([moduleOf(id), CODE_HASH]) : REVERT;
      return REVERT;
    }
    if (tokenSet.has(target)) {
      const listed = COINS.find((c) => c.address.toLowerCase() === target);
      if (name === 'symbol' && listed) return ok(listed.symbol);
      if (listed?.symbol === 'tGOLD' && (name === 'paused' || name === 'isFrozen')) return ok(false);
      return REVERT;
    }
    if (target === ROUTE_HELPER.toLowerCase()) {
      if (name === 'module') return ok(ALCHEMIST);
      if (name === 'manager') return ok(RELEASE.manager);
      if (name === 'length') return ok(2n);
      if (name === 'hop') {
        const first = args[0] === 0n;
        return ok({ kind: 4, tokenIn: first ? coin('tPEPE') : zeroAddress, tokenOut: first ? zeroAddress : coin('tGOLD'), pool: RELEASE.manager, fee: 3000, tickSpacing: 60 });
      }
      return REVERT;
    }
    // A built-in fee module answers its version and its manager, and no other Alchemist getter.
    if (name === 'feeActionVersion') return ok(1n);
    if (name === 'poolManager') return ok(RELEASE.manager);
    if (target !== ALCHEMIST.toLowerCase()) return REVERT;
    const alchemist: Readonly<Record<string, unknown>> = {
      receiverImplementation: RELEASE.receiver, coordinatorImplementation: RELEASE.coordinator, priceCoin: coin('tPEPE'), pileCoin: coin('tGOLD'),
      executor: ROUTE_HELPER, executorCodeHash: CODE_HASH, inputCap: 1_000n * 10n ** 18n, dustMax: 1_000_000n, conversionTrigger: TRIGGER,
    };
    return name in alchemist ? ok(alchemist[name]) : REVERT;
  }

  function counted(to: Address, data: Hex): Answer {
    chain.stats.calls.push(`${to.toLowerCase()}:${data.toLowerCase()}`);
    return view(to, data);
  }

  function rpc(request: { readonly id: number; readonly method: string; readonly params?: readonly unknown[] }): object {
    const stats = chain.stats;
    stats.ops++;
    bump(stats.methods, request.method);
    const reply = (answer: Answer) => ({ jsonrpc: '2.0', id: request.id, ...answer });
    if (request.method === 'eth_chainId') { bump(stats.bySource, 'chain'); return reply({ result: toHex(options.chainId ?? SEPOLIA) }); }
    if (request.method === 'eth_getCode') {
      const address = String(request.params?.[0]).toLowerCase();
      stats.codes.push(address);
      bump(stats.bySource, sourceOf(address));
      if (options.failCode?.some((failing) => failing.toLowerCase() === address)) return reply({ error: { code: -32000, message: 'header not found' } });
      return reply({ result: RUNTIME });
    }
    if (request.method === 'eth_call') {
      const { to, data } = request.params?.[0] as { readonly to: Address; readonly data: Hex };
      if (to.toLowerCase() !== SEPOLIA_MULTICALL3.toLowerCase()) { bump(stats.bySource, sourceOf(to)); return reply(counted(to, data)); }
      stats.aggregates++;
      if (options.noMulticall) { bump(stats.bySource, 'multicall'); return reply({ result: '0x' }); }
      const { args } = decodeFunctionData({ abi: multicall3Abi, data });
      if (!args || !Array.isArray(args[0])) return reply(REVERT);
      const members = args[0] as readonly { readonly target: Address; readonly callData: Hex }[];
      const sources = new Set(members.map((member) => sourceOf(member.target)));
      bump(stats.bySource, sources.size === 1 ? [...sources][0] ?? 'other' : 'mixed');
      const result = members.map((member) => {
        const answer = counted(member.target, member.callData);
        return 'result' in answer ? { success: true, returnData: answer.result } : { success: false, returnData: answer.error.data ?? '0x' };
      });
      return reply({ result: encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result }) });
    }
    return reply({ error: { code: -32601, message: `the double does not answer ${request.method}` } });
  }

  chain.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (release && url.origin === INDEXER && url.pathname === `/v2/create-options/${SEPOLIA}/${release.factory.address.toLowerCase()}.json`) {
      chain.stats.http.createOptions++;
      return new Response(JSON.stringify({ schema: 1, chainId: SEPOLIA, factory: release.factory.address.toLowerCase(), registry: release.registry.address.toLowerCase(),
        versionCodeHash: release.versionCodeHash.toLowerCase(), revision: 1, off: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.origin === INDEXER) {
      chain.stats.http.indexer++;
      return url.pathname === `/v2/listings/${SEPOLIA}/${RELEASE.registry.toLowerCase()}` ? json(listingBook()) : json({}, 404);
    }
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
    const batch = Array.isArray(body);
    const requests = (batch ? body : [body]) as { readonly id: number; readonly method: string; readonly params?: readonly unknown[] }[];
    if (!body || requests.some((request) => typeof request?.method !== 'string')) { chain.stats.http.other.push(url.href); return new Response('not found', { status: 404 }); }
    chain.stats.http.rpc++;
    envelopes++;
    const failure = options.failure;
    if (failure && envelopes > (failure.answered ?? 0)) {
      // Counted as sent: the provider saw them.
      for (const request of requests) { chain.stats.ops++; bump(chain.stats.methods, request.method); }
      if (failure.kind === 'network') throw new TypeError('fetch failed');
      return new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } });
    }
    const answers = requests.map(rpc);
    return json(batch ? answers : answers[0]);
  }) as typeof fetch;
  return chain;
}

/** The repeated `to:data` calls and code reads of `stats` (none expected within one discovery). */
export function repeats(stats: Pick<ChainStats, 'calls' | 'codes'>): { readonly calls: string[]; readonly codes: string[] } {
  const twice = (list: readonly string[]) => list.filter((item, i) => list.indexOf(item) !== i);
  return { calls: twice(stats.calls), codes: twice(stats.codes) };
}
