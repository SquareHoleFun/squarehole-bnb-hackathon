/**
 * SH-CREATE-RPC-BATCHING (XR-CREATE-RPC-COUNT F1 and F2): what one fresh, disconnected Create page asks the keyless
 * Sepolia RPC, replayed through the production loaders, readers and viem's own HTTP transport against the committed
 * Sepolia state (test-support/sepolia-create-chain.ts, a fetch double installed as the page's `fetch`).
 *
 * Before: one HTTP request per read, 424 in all (55 for the coins' symbols and issuer powers, 8 for the factory's Eat
 * answers, 361 for The Alchemist's discovery, which read the same directory and modules once for each of six pile
 * coins). Now, on the public Sepolia RPC: view calls folded into Multicall3 `aggregate3` calls, requests into JSON-RPC
 * batches (view-client.ts), and one read set for each discovery (`discoveryReads`): 25 operations in 9 HTTP requests
 * (10 when each source runs on its own).
 * The answers are the same as one request per read: the coin labels, raises and issuer lines, the Eat answers and the
 * Alchemist offer, a revert inside an aggregate still absent, a failed request still a failure.
 */
import { SEPOLIA_MULTICALL3 } from '@squarehole/chain';
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alchemistRowsV21 } from '../../../../../../packages/chain/src/core/v2';
import { alchemistOfferRowsV21, alchemistReleaseV21, discoveryReads, offerOf, rpcAlchemistReads } from './alchemist';
import { eatAnswerV21 } from './eat-check';
import { eatReaderV2, loadListingsV2, resetListingSymbolsForTests, rpcTokenReader } from './indexer-listings';
import { FREEZE_LINE, type SiteListing } from './listings';
import { PAUSE_LINE, UNREAD_LINE, resetIssuerPowersForTests } from './issuer-powers';
import { ALCHEMIST, COINS, DIRECT_RPC, READY_AT, RELEASE, ROUTE_HELPER, SEPOLIA_RPC, TRIGGER, coin, repeats, sepoliaChain, sepoliaSource, type ChainOptions, type FakeChain } from './test-support/sepolia-create-chain';
import { batchedRpc } from './view-client';

const SEPOLIA = 11_155_111;
const ETH = zeroAddress as Address;
const PILES_FOR = (priceCoin: Address) => COINS.map((c) => c.address as Address).filter((address) => address.toLowerCase() !== priceCoin.toLowerCase());

let chain: FakeChain;
const install = (options: ChainOptions = {}) => { chain = sepoliaChain(options); vi.stubGlobal('fetch', chain.fetch); return chain; };
const fresh = () => { resetListingSymbolsForTests(); resetIssuerPowersForTests(); };
beforeEach(fresh);
afterEach(() => { vi.unstubAllGlobals(); fresh(); });

/** What a page shows of one listing: label, raise, decimals, class and issuer lines (identity stays the address). */
const shown = (listings: readonly SiteListing[]) => listings.map((l) => ({ token: l.token.toLowerCase(), symbol: l.symbol, raise: l.raise, decimals: l.decimals, class: l.class, powers: l.powers }));
type Settled<T> = { readonly ok: T } | { readonly failed: true };
const settle = <T,>(promise: Promise<T>): Promise<Settled<T>> => promise.then((ok) => ({ ok }), () => ({ failed: true as const }));

/** The coins' metadata: the book's one load (its default reader on the source's RPC, the page's fetch). */
const metadata = (rpc: string) => loadListingsV2(sepoliaSource(rpc));
/** The factory's Eat answers, one reader for all listings, as `useListingsV2` asks them. */
const eats = (rpc: string, listings: readonly SiteListing[], reader = eatReaderV2(sepoliaSource(rpc))) =>
  Promise.all(listings.map((listing) => settle(eatAnswerV21(reader, RELEASE.factory, listing))));
/** The offer's discovery as the page runs it now (`useAlchemistOffer`): one read set for every pile coin. */
const discovery = (rpc: string, priceCoin: Address) => settle(alchemistOfferRowsV21(rpcAlchemistReads(rpc, SEPOLIA), sepoliaSource(rpc), priceCoin, PILES_FOR(priceCoin)));
/** The offer as the page ran it before SH-CREATE-RPC-BATCHING: one query per pile coin, each reading on its own. */
const perPair = (rpc: string, priceCoin: Address) => {
  const source = sepoliaSource(rpc);
  const reads = rpcAlchemistReads(rpc, SEPOLIA);
  return settle(Promise.all(PILES_FOR(priceCoin).map(async (pileCoin) => alchemistRowsV21(reads, await alchemistReleaseV21(reads, source), { priceCoin, pileCoin }).catch((): null => null))));
};

/** One fresh page: the book and its coins, then the Eat answers and the offer's discovery together (as CreateV2Ready mounts). */
async function freshPage(rpc: string, { priceCoin = ETH, offer = discovery }: { priceCoin?: Address; offer?: typeof discovery } = {}) {
  const listings = await metadata(rpc);
  const [eat, found] = await Promise.all([eats(rpc, listings), offer(rpc, priceCoin)]);
  const piles = PILES_FOR(priceCoin);
  return { listings: shown(listings), eat, found, offer: 'ok' in found ? offerOf(piles, found.ok) : null };
}

/** The per-source counts: each phase on its own (the page overlaps the Eat answers and the discovery). */
async function phases(rpc: string, priceCoin = ETH) {
  const counts: Record<string, { http: number; ops: number; aggregates: number; calls: number; codes: number; methods: Record<string, number> }> = {};
  const take = (name: string) => { const s = chain.stats; counts[name] = { http: s.http.rpc, ops: s.ops, aggregates: s.aggregates, calls: s.calls.length, codes: s.codes.length, methods: { ...s.methods } }; const r = repeats(s); chain.reset(); return r; };
  chain.reset();
  const listings = await metadata(rpc);
  const metadataRepeats = take('metadata');
  await eats(rpc, listings);
  const eatRepeats = take('eat');
  await discovery(rpc, priceCoin);
  const alchemistRepeats = take('alchemist');
  return { counts, repeats: { metadata: metadataRepeats, eat: eatRepeats, alchemist: alchemistRepeats } };
}

describe('F1 and F2: a fresh Create page on the committed Sepolia state (row 4 not yet mature, priced in ETH)', () => {
  it('before: 424 HTTP requests, one per read: 55 coin metadata, 8 Eat answers, 361 Alchemist reads of which 61 are distinct', async () => {
    install();
    chain.reset();
    const listings = await metadata(DIRECT_RPC);
    expect([chain.stats.http.rpc, chain.stats.ops, chain.stats.aggregates]).toEqual([55, 55, 0]);
    chain.reset();
    await eats(DIRECT_RPC, listings, rpcTokenReader(DIRECT_RPC, SEPOLIA));
    expect([chain.stats.http.rpc, chain.stats.ops]).toEqual([8, 8]);
    chain.reset();
    await perPair(DIRECT_RPC, ETH);
    const before = chain.stats;
    expect([before.http.rpc, before.ops, before.aggregates]).toEqual([361, 361, 0]);
    expect(before.methods).toEqual({ eth_chainId: 1, eth_call: 336, eth_getCode: 24 });
    expect(new Set(before.calls).size + new Set(before.codes).size + 1).toBe(61);
    expect(batchedRpc(DIRECT_RPC, SEPOLIA)).toBe(false);
  });

  it('now: 25 JSON-RPC operations (8 + 8 + 9 by source, in 2 + 2 + 6 HTTP requests; 9 requests as the page runs them), the indexer asked once', async () => {
    install();
    const { counts } = await phases(SEPOLIA_RPC);
    expect(counts).toEqual({
      // 1 eth_chainId; 6 eth_getCode; 6 symbol() and 42 issuer getters in one aggregate3.
      metadata: { http: 2, ops: 8, aggregates: 1, calls: 48, codes: 6, methods: { eth_chainId: 1, eth_getCode: 6, eth_call: 1 } },
      // 1 eth_chainId; the 7 refusal() probes, each its own eth_call, in one JSON-RPC batch.
      eat: { http: 2, ops: 8, aggregates: 0, calls: 7, codes: 0, methods: { eth_chainId: 1, eth_call: 7 } },
      // 1 eth_chainId; receiverCode(); count(); 5 resolve() and 5 record(); 4 module codes; 4 x 11 getters.
      alchemist: { http: 6, ops: 9, aggregates: 4, calls: 56, codes: 4, methods: { eth_chainId: 1, eth_call: 4, eth_getCode: 4 } },
    });
    const total = (key: 'http' | 'ops') => Object.values(counts).reduce((sum, count) => sum + count[key], 0);
    expect([total('ops'), total('http')]).toEqual([25, 10]);
    expect(batchedRpc(SEPOLIA_RPC, SEPOLIA)).toBe(true);
    // As the page runs it (the Eat answers and the discovery together): the same 25 operations in 9 requests, as the
    // two readers' first requests share one batch.
    fresh();
    install();
    await freshPage(SEPOLIA_RPC);
    expect(chain.stats.ops).toBe(25);
    expect(chain.stats.http.rpc).toBe(9);
    expect(chain.stats.http.indexer).toBe(1);
    expect(chain.stats.http.other).toEqual([]);
  });

  it('no discovery asks the same call or code twice; neither do the coins nor the Eat answers', async () => {
    install();
    const { repeats: found } = await phases(SEPOLIA_RPC);
    for (const [phase, twice] of Object.entries(found)) expect(twice, phase).toEqual({ calls: [], codes: [] });
    // Within one aggregate too: every member is a different call.
    fresh();
    install();
    await freshPage(SEPOLIA_RPC);
    expect(repeats(chain.stats)).toEqual({ calls: [], codes: [] });
  });

  it('the same answers as one request per read: labels, raises, decimals, classes, issuer lines, Eat answers, no offer', async () => {
    install();
    const before = await freshPage(DIRECT_RPC, { offer: perPair });
    fresh();
    install();
    const now = await freshPage(SEPOLIA_RPC);
    expect(now).toEqual(before);
    expect(now.listings.map((l) => l.symbol)).toEqual(COINS.map((c) => c.symbol));
    expect(now.listings.map((l) => l.raise.toString())).toEqual(COINS.map((c) => c.raise));
    // tGOLD's own pause and freeze; no other coin names a power (the reverting getters are absent, as before).
    expect(Object.fromEntries(now.listings.map((l) => [l.symbol, l.powers]))).toEqual({ ETH: [], tLINK: [], tUSDC: [], tNVDA: [], tGOLD: [PAUSE_LINE, FREEZE_LINE], tPEPE: [], tFROG: [] });
    expect(now.eat).toEqual(Array(7).fill({ ok: 'allowed' }));
    // Row 4 is not mature: no pile coin has a row for ETH, so no Alchemist template is offered.
    expect(now.found).toEqual({ ok: Array(6).fill([]) });
    expect(now.offer).toBeNull();
  });

  it('only view calls and code reads reach the RPC: no wallet method, no transaction, no log or block query', async () => {
    install();
    await freshPage(SEPOLIA_RPC);
    expect(Object.keys(chain.stats.methods).sort()).toEqual(['eth_call', 'eth_chainId', 'eth_getCode']);
  });
});

describe('after row 4 matures (2026-10-27 19:23:12 +07)', () => {
  it('priced in ETH: 26 operations in 10 requests (row 4’s module code and its getters join the same requests); still no offer', async () => {
    install({ mature: true });
    const { counts } = await phases(SEPOLIA_RPC);
    expect([counts.metadata?.ops, counts.eat?.ops, counts.alchemist?.ops]).toEqual([8, 8, 10]);
    expect([counts.metadata?.http, counts.eat?.http, counts.alchemist?.http]).toEqual([2, 2, 6]);
    fresh();
    install({ mature: true });
    const now = await freshPage(SEPOLIA_RPC);
    fresh();
    install({ mature: true });
    expect(now).toEqual(await freshPage(DIRECT_RPC, { offer: perPair }));
    // Row 4 converts tPEPE into tGOLD, so it answers as another pair's: refused here, not offered.
    expect(now.offer).toBeNull();
    // Before, the same load was 496 requests.
    fresh();
    install({ mature: true });
    await freshPage(DIRECT_RPC, { offer: perPair });
    expect(chain.stats.http.rpc).toBe(496);
  });

  it('priced in tPEPE: the tGOLD pile is offered with row 4 and its two v4 hops, as before, in 30 operations', async () => {
    install({ mature: true });
    const { counts, repeats: found } = await phases(SEPOLIA_RPC, coin('tPEPE'));
    // Row 4's route helper: its code, module() manager() length(), hop(0), hop(1).
    expect(counts.alchemist).toMatchObject({ ops: 14, http: 10, codes: 6 });
    expect((counts.metadata?.ops ?? 0) + (counts.eat?.ops ?? 0) + (counts.alchemist?.ops ?? 0)).toBe(30);
    expect(found.alchemist).toEqual({ calls: [], codes: [] });
    fresh();
    install({ mature: true });
    const now = await freshPage(SEPOLIA_RPC, { priceCoin: coin('tPEPE') });
    fresh();
    install({ mature: true });
    const before = await freshPage(DIRECT_RPC, { priceCoin: coin('tPEPE'), offer: perPair });
    expect(now).toEqual(before);
    expect(now.offer).toEqual({ coin: coin('tGOLD'), row: 4 });
    const rows = 'ok' in now.found ? now.found.ok.flatMap((r) => r ?? []) : [];
    expect(rows).toHaveLength(1);
    const id = (address: string) => getAddress(address);
    expect(rows[0]).toMatchObject({
      id: 4, readyAt: READY_AT, module: id(ALCHEMIST), priceCoin: id(coin('tPEPE')), pileCoin: id(coin('tGOLD')), executor: id(ROUTE_HELPER), conversionTrigger: id(TRIGGER),
      inputCap: 1_000n * 10n ** 18n, dustMax: 1_000_000n,
      route: [{ kind: 4, tokenIn: id(coin('tPEPE')), tokenOut: zeroAddress, pool: id(RELEASE.manager), fee: 3000, tickSpacing: 60 }, { kind: 4, tokenIn: zeroAddress, tokenOut: id(coin('tGOLD')), pool: id(RELEASE.manager), fee: 3000, tickSpacing: 60 }],
    });
  });
});

describe('a pair whose rows cannot be read concludes nothing; the other pairs stand, as with one query per pair', () => {
  it('row 4’s route helper code cannot be read: the tGOLD pair is unread (null), every other pair has no row', async () => {
    const options: ChainOptions = { mature: true, failCode: [ROUTE_HELPER] };
    install(options);
    const now = await freshPage(SEPOLIA_RPC, { priceCoin: coin('tPEPE') });
    fresh();
    install(options);
    expect(now).toEqual(await freshPage(DIRECT_RPC, { priceCoin: coin('tPEPE'), offer: perPair }));
    expect(now.found).toEqual({ ok: [[], [], [], [], null, []] });
    expect(now.offer).toBeNull();
  });
});

describe('each call still answers for itself on the public Sepolia RPC', () => {
  const PAUSED = encodeFunctionData({ abi: parseAbi(['function paused() view returns (bool)']), functionName: 'paused' });
  const SYMBOL = encodeFunctionData({ abi: erc20Abi, functionName: 'symbol' });
  const DECIMALS = encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' });

  it('in one aggregate: a revert is absent (null), an answer is the answer, a call that returns nothing is no data (null)', async () => {
    install({ empty: [`${coin('tLINK').toLowerCase()}:decimals`] });
    const reader = rpcTokenReader(SEPOLIA_RPC, SEPOLIA);
    const [gold, link, symbol, nothing] = await Promise.all([reader.call(coin('tGOLD'), PAUSED), reader.call(coin('tLINK'), PAUSED), reader.call(coin('tGOLD'), SYMBOL), reader.call(coin('tLINK'), DECIMALS)]);
    expect(gold).toBe(`0x${'0'.repeat(64)}`);
    expect(link).toBeNull();
    expect(symbol).not.toBeNull();
    expect(nothing).toBeNull();
    // One eth_chainId and one aggregate3 for all four.
    expect([chain.stats.ops, chain.stats.aggregates, chain.stats.calls.length]).toEqual([2, 1, 4]);
    // The same four, one request each, answer the same.
    fresh();
    install({ empty: [`${coin('tLINK').toLowerCase()}:decimals`] });
    const direct = rpcTokenReader(DIRECT_RPC, SEPOLIA);
    expect(await Promise.all([direct.call(coin('tGOLD'), PAUSED), direct.call(coin('tLINK'), PAUSED), direct.call(coin('tGOLD'), SYMBOL), direct.call(coin('tLINK'), DECIMALS)])).toEqual([gold, link, symbol, nothing]);
    expect(chain.stats.aggregates).toBe(0);
  });

  it.each([
    ['an HTTP 429 after the chain id', { kind: '429', answered: 1 }],
    ['an HTTP 429 from the start', { kind: '429' }],
    ['a network failure after the chain id', { kind: 'network', answered: 1 }],
  ] as const)('%s fails every read it carried, never "absent": the same labels and lines as one request per read', async (_name, failure) => {
    install({ failure });
    const now = await freshPage(SEPOLIA_RPC);
    fresh();
    install({ failure });
    const before = await freshPage(DIRECT_RPC, { offer: perPair });
    expect(now).toEqual(before);
    // The coins show their addresses and "Issuer powers could not be read."; ETH needs no read.
    expect(now.listings.slice(1).map((l) => [l.symbol.toLowerCase(), l.powers])).toEqual(COINS.slice(1).map((c) => [c.address, [UNREAD_LINE]]));
    expect(now.listings[0]).toMatchObject({ symbol: 'ETH', powers: [] });
    // Eat stays unknown and no offer is shown.
    expect(now.eat).toEqual(Array(7).fill({ failed: true }));
    expect(now.found).toEqual({ failed: true });
    expect(now.offer).toBeNull();
  });

  it('an RPC serving another chain is never read, by either reader', async () => {
    install({ chainId: 1 });
    await expect(rpcTokenReader(SEPOLIA_RPC, SEPOLIA).call(coin('tLINK'), SYMBOL)).rejects.toThrow(/serves chain 1, not 11155111/);
    await expect(rpcTokenReader(SEPOLIA_RPC, SEPOLIA).hasCode(coin('tLINK'))).rejects.toThrow(/serves chain 1, not 11155111/);
    await expect(rpcAlchemistReads(SEPOLIA_RPC, SEPOLIA).call(RELEASE.receiver, SYMBOL)).rejects.toThrow(/serves chain 1, not 11155111/);
    await expect(rpcAlchemistReads(SEPOLIA_RPC, SEPOLIA).code(ALCHEMIST)).rejects.toThrow(/serves chain 1, not 11155111/);
    expect(Object.keys(chain.stats.methods)).toEqual(['eth_chainId']);
    fresh();
    install({ chainId: 1 });
    const now = await freshPage(SEPOLIA_RPC);
    fresh();
    install({ chainId: 1 });
    expect(now).toEqual(await freshPage(DIRECT_RPC, { offer: perPair }));
    expect(now.found).toEqual({ failed: true });
  });

  it('an RPC whose Multicall3 answers nothing fails every folded read (never "absent"); one that is not the public one is never folded', async () => {
    install({ noMulticall: true });
    await expect(rpcTokenReader(SEPOLIA_RPC, SEPOLIA).call(coin('tGOLD'), PAUSED)).rejects.toThrow();
    await expect(rpcAlchemistReads(SEPOLIA_RPC, SEPOLIA).call(RELEASE.receiver, SYMBOL)).rejects.toThrow();
    const listings = await metadata(SEPOLIA_RPC);
    expect(listings.slice(1).every((l) => l.powers.length === 1 && l.powers[0] === UNREAD_LINE)).toBe(true);
    // The local chain, a local twin with Sepolia's chain id, any other RPC: one eth_call per read, never to Multicall3.
    fresh();
    install({ noMulticall: true });
    const direct = await freshPage(DIRECT_RPC, { offer: perPair });
    expect(chain.stats.aggregates).toBe(0);
    expect(chain.stats.calls.some((call) => call.startsWith(SEPOLIA_MULTICALL3.toLowerCase()))).toBe(false);
    expect(direct.listings.find((l) => l.symbol === 'tGOLD')?.powers).toEqual([PAUSE_LINE, FREEZE_LINE]);
    for (const rpc of ['http://127.0.0.1:8545', 'https://sepolia.example.invalid']) expect(batchedRpc(rpc, SEPOLIA), rpc).toBe(false);
    expect(batchedRpc(SEPOLIA_RPC, 31_337)).toBe(false);
  });

  it('the Eat probes are never folded into an aggregate: the factory sees each probe as its own call, as before', async () => {
    install();
    const listings = await metadata(SEPOLIA_RPC);
    chain.reset();
    await eats(SEPOLIA_RPC, listings);
    expect(chain.stats.aggregates).toBe(0);
    expect(chain.stats.calls.every((call) => call.startsWith(RELEASE.factory.toLowerCase()))).toBe(true);
    expect(chain.stats.calls.every((call) => (call.length - RELEASE.factory.length - 3) / 2 > 2_048)).toBe(true);
  });
});

describe('one read set per discovery, never longer', () => {
  it('within one set: a call or code read is asked once, its null or its failure shared; another set asks again', async () => {
    const asked: string[] = [];
    const base = {
      call: async (to: Address, data: Hex) => { asked.push(`call ${to} ${data}`); if (data === '0xdead') throw new Error('429'); return data === '0x00' ? null : data; },
      code: async (address: Address) => { asked.push(`code ${address}`); return '0x60' as Hex; },
    };
    const one = discoveryReads(base);
    // One address in two spellings (lower case and checksummed) is one target.
    const target = coin('tGOLD');
    expect(await Promise.all([one.call(target, '0x00'), one.call(target, '0x00'), one.call(getAddress(target), '0x00')])).toEqual([null, null, null]);
    expect(await Promise.all([one.call(target, '0x01'), one.call(target, '0x01')])).toEqual(['0x01', '0x01']);
    expect(await Promise.all([one.code(target), one.code(target)])).toEqual(['0x60', '0x60']);
    await expect(one.call(target, '0xdead')).rejects.toThrow('429');
    await expect(one.call(target, '0xdead')).rejects.toThrow('429');
    expect(asked).toEqual([`call ${target} 0x00`, `call ${target} 0x01`, `code ${target}`, `call ${target} 0xdead`]);
    const two = discoveryReads(base);
    expect(await two.call(target, '0x00')).toBeNull();
    await expect(two.call(target, '0xdead')).rejects.toThrow('429');
    expect(asked).toHaveLength(6);
  });

  it('a second discovery asks the chain again, and sees a row that matured in between', async () => {
    const shared = { mature: false };
    const first = sepoliaChain({ get mature() { return shared.mature; } } as ChainOptions);
    vi.stubGlobal('fetch', first.fetch);
    chain = first;
    const reads = rpcAlchemistReads(SEPOLIA_RPC, SEPOLIA);
    const source = sepoliaSource();
    const piles = PILES_FOR(coin('tPEPE'));
    expect(offerOf(piles, await alchemistOfferRowsV21(reads, source, coin('tPEPE'), piles))).toBeNull();
    const once = chain.stats.ops;
    shared.mature = true;
    expect(offerOf(piles, await alchemistOfferRowsV21(reads, source, coin('tPEPE'), piles))).toEqual({ coin: coin('tGOLD'), row: 4 });
    // The reader checked the chain once; everything else was asked again.
    expect(chain.stats.ops - once).toBeGreaterThanOrEqual(once - 1);
  });

  it('the offer is still the first listed pile coin with a row, with that pair’s newest row; an unread pair concludes nothing', () => {
    const row = (id: number) => ({ id }) as never;
    const [a, b, c] = [coin('tLINK'), coin('tGOLD'), coin('tFROG')];
    expect(offerOf([a, b, c], [[], [row(6), row(4)], [row(9)]])).toEqual({ coin: b, row: 6 });
    expect(offerOf([a, b, c], [null, [], [row(9)]])).toEqual({ coin: c, row: 9 });
    expect(offerOf([a, b, c], [null, null, null])).toBeNull();
    expect(offerOf([a, b, c], [])).toBeNull();
  });

  it('a failed read is not kept: the next discovery asks again and can succeed', async () => {
    const failing = { on: true };
    const flaky = sepoliaChain({ get failure() { return failing.on ? { kind: '429', answered: 1 } : null; } } as ChainOptions);
    vi.stubGlobal('fetch', flaky.fetch);
    chain = flaky;
    const reads = rpcAlchemistReads(SEPOLIA_RPC, SEPOLIA);
    const piles = PILES_FOR(ETH);
    await expect(alchemistOfferRowsV21(reads, sepoliaSource(), ETH, piles)).rejects.toThrow();
    failing.on = false;
    expect(await alchemistOfferRowsV21(reads, sepoliaSource(), ETH, piles)).toEqual(Array(6).fill([]));
  });
});
