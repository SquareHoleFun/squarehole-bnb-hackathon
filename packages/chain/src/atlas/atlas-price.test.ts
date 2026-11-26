import { describe, expect, it } from 'vitest';
import { encodeFunctionResult, type Address, type Hex } from 'viem';
import {
  ATLAS_MAINNET_REGISTRY, AtlasBook, atlasAbi, atlasFeedId, decodeBatch, decodeRound, judgeAtlas, nativeWeiOf, normaliseRpcUrl, providerOf,
  readAtlasRaw, rpcEndpoint, rpcEndpoints, rpcEthCall, usdValueX18, type AtlasFeed, type AtlasPrice, type EthCall,
} from './atlas-price';
import { atlasFeeds97, coinFeedOf } from './atlas-feeds';

const must = <T>(v: T | undefined): T => { if (v === undefined) throw new Error('missing'); return v; };

// Recorded on 25 November 2026: fetchBatch([0x000003a6, 0x00000000]) on BNB mainnet's registry, the raw answer as the
// endpoint returned it (NVDAB/USD, then an id that is not a feed). Read at 1795597179 (15:59:39 +07).
const RECORDED_FETCH_BATCH: Hex = '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000082074394540d22886000000000000000000000000000000000000000000000000000000006b06a34a000000000000000000000000000000000000000000000000000000006b06a34a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
// Recorded the same day: BNB/USD's latestRoundData on chain 97 (the first feed, 0xb3d1614b..., identical on mainnet); it
// stands for any SingleFeed answer here, served at the address of the table's BNB/USD feed.
const BNB = { price: 542623466255465080160n, startedAt: 1795596979n, updatedAt: 1795596980n };

const SEL = { decimals: '0x313ce567', latestRoundData: '0xfeaf968c' } as const;
const dec18 = encodeFunctionResult({ abi: atlasAbi, functionName: 'decimals', result: 18 });
const round = (price: bigint, startedAt: bigint, updatedAt: bigint) =>
  encodeFunctionResult({ abi: atlasAbi, functionName: 'latestRoundData', result: [1n, price, startedAt, updatedAt, 1n] });

/** A chain that answers by (address, selector). */
function fakeChain(answers: Record<string, Hex | (() => Hex)>, calls: string[] = []): EthCall {
  return async (to: Address, data: Hex) => {
    const selector = data.slice(0, 10);
    const key = `${to.toLowerCase()}:${selector === SEL.decimals || selector === SEL.latestRoundData ? selector : 'fetchBatch'}`;
    calls.push(key);
    const a = answers[key];
    if (a === undefined) throw new Error('no answer');
    return typeof a === 'function' ? a() : a;
  };
}

// The stock as BNB mainnet's registry serves it (the test network's own NVDAB feed is a SingleFeed, as BNB/USD).
const nvdab: AtlasFeed = { name: 'NVDAB/USD', atlasId: 934, source: { kind: 'multi', chainId: 56n, registry: ATLAS_MAINNET_REGISTRY, feedId: 934 }, maxAgeSeconds: 180n };
const bnb = must(atlasFeeds97.find(f => f.name === 'BNB/USD'));
const registry = ATLAS_MAINNET_REGISTRY.toLowerCase();
const bnbFeed = (bnb.source as { address: Address }).address.toLowerCase();

describe('Atlas price reader (SH-266)', () => {
  it('feed ids are bytes4 of the feed number', () => {
    expect(atlasFeedId(934)).toBe('0x000003a6');
    expect(atlasFeedId(633)).toBe('0x00000279');
    expect(() => atlasFeedId(-1)).toThrow();
  });

  it('decodes the recorded mainnet fetchBatch answer, and an unknown id is NEVER_WRITTEN', async () => {
    const unknown: AtlasFeed = { ...nvdab, name: 'unknown', atlasId: 0, source: { kind: 'multi', chainId: 56n, registry: ATLAS_MAINNET_REGISTRY, feedId: 0 } };
    const main = fakeChain({ [`${registry}:${SEL.decimals}`]: dec18, [`${registry}:fetchBatch`]: RECORDED_FETCH_BATCH });
    const raw = await readAtlasRaw(c => (c === 56n ? main : undefined), [nvdab, unknown]);
    expect(raw.get('NVDAB/USD')).toEqual({ price: 149912509665791584390n, aggregatedAt: 1795597130n, onchainAt: 1795597130n });
    const now = 1795597179n;
    const a = judgeAtlas(nvdab, must(raw.get('NVDAB/USD')), now);
    expect(a).toMatchObject({ ok: true, price: 149912509665791584390n, onchainAt: 1795597130n, source: 'Atlas' });
    expect(judgeAtlas(unknown, must(raw.get('unknown')), now)).toMatchObject({ ok: false, refusal: 'NEVER_WRITTEN' });
  });

  it('reads BNB/USD on chain 97 and NVDAB/USD on chain 56 with one batch per registry', async () => {
    const calls: string[] = [];
    const main = fakeChain({ [`${registry}:${SEL.decimals}`]: dec18, [`${registry}:fetchBatch`]: RECORDED_FETCH_BATCH }, calls);
    const test = fakeChain({ [`${bnbFeed}:${SEL.decimals}`]: dec18, [`${bnbFeed}:${SEL.latestRoundData}`]: round(BNB.price, BNB.startedAt, BNB.updatedAt) }, calls);
    // A one-row request with the recorded two-row answer: the shape is wrong, the row is refused, never guessed.
    const wrongShape = await readAtlasRaw(c => (c === 56n ? main : c === 97n ? test : undefined), [bnb, nvdab]);
    expect(wrongShape.get('NVDAB/USD')).toBe('MALFORMED');
    const oneRow = encodeFunctionResult({ abi: atlasAbi, functionName: 'fetchBatch', result: [{ price: 149912509665791584390n, aggregatedTs: 1795597130, onchainTs: 1795597130 }] });
    calls.length = 0;
    const main1 = fakeChain({ [`${registry}:${SEL.decimals}`]: dec18, [`${registry}:fetchBatch`]: oneRow }, calls);
    const raw = await readAtlasRaw(c => (c === 56n ? main1 : c === 97n ? test : undefined), [bnb, nvdab]);
    expect(raw.get('BNB/USD')).toEqual({ price: BNB.price, aggregatedAt: BNB.startedAt, onchainAt: BNB.updatedAt });
    expect(raw.get('NVDAB/USD')).toEqual({ price: 149912509665791584390n, aggregatedAt: 1795597130n, onchainAt: 1795597130n });
    expect(calls.filter(c => c.endsWith('fetchBatch'))).toHaveLength(1);
    // USDC/USD's chain (mainnet) has no endpoint here: refused, not guessed.
    const usdc = must(atlasFeeds97.find(f => f.name === 'USDC/USD'));
    expect((await readAtlasRaw(c => (c === 97n ? test : undefined), [usdc])).get('USDC/USD')).toBe('RPC_FAILED');
  });

  it('refuses a source whose decimals are not 18', async () => {
    const test = fakeChain({ [`${bnbFeed}:${SEL.decimals}`]: encodeFunctionResult({ abi: atlasAbi, functionName: 'decimals', result: 8 }), [`${bnbFeed}:${SEL.latestRoundData}`]: round(1n, 1n, 1n) });
    expect((await readAtlasRaw(() => test, [bnb])).get('BNB/USD')).toBe('BAD_DECIMALS');
  });

  it('freshness: at most maxAgeSeconds (the limit of BNB/USD in the table) after the on-chain write; never in the future', () => {
    const raw = { price: BNB.price, aggregatedAt: BNB.startedAt, onchainAt: BNB.updatedAt };
    expect(judgeAtlas(bnb, raw, BNB.updatedAt + bnb.maxAgeSeconds).ok).toBe(true);
    expect(judgeAtlas(bnb, raw, BNB.updatedAt + bnb.maxAgeSeconds + 1n)).toMatchObject({ ok: false, refusal: 'STALE' });
    expect(judgeAtlas(bnb, raw, BNB.updatedAt).ok).toBe(true);
    // No allowance on reading: one second before its own time is the future.
    expect(judgeAtlas(bnb, raw, BNB.updatedAt - 1n)).toMatchObject({ ok: false, refusal: 'FUTURE' });
    expect(judgeAtlas(bnb, { ...raw, price: 1n << 80n }, BNB.updatedAt)).toMatchObject({ ok: false, refusal: 'TOO_WIDE' });
    expect(judgeAtlas(bnb, { ...raw, aggregatedAt: raw.onchainAt + 1n }, BNB.updatedAt)).toMatchObject({ ok: false, refusal: 'MALFORMED' });
    expect(judgeAtlas(bnb, { ...raw, price: 0n }, BNB.updatedAt)).toMatchObject({ ok: false, refusal: 'NO_PRICE' });
    expect(judgeAtlas(bnb, { ...raw, price: -5n }, BNB.updatedAt)).toMatchObject({ ok: false, refusal: 'NO_PRICE' });
    expect(judgeAtlas(bnb, { ...raw, onchainAt: 0n }, BNB.updatedAt)).toMatchObject({ ok: false, refusal: 'NEVER_WRITTEN' });
  });

  it('sanity band: a step over 20% against the last accepted price within an hour is refused', () => {
    const last = judgeAtlas(bnb, { price: 500n * 10n ** 18n, aggregatedAt: 1000n, onchainAt: 1000n }, 1000n) as AtlasPrice;
    expect(last.ok).toBe(true);
    expect(judgeAtlas(bnb, { price: 600n * 10n ** 18n, aggregatedAt: 1060n, onchainAt: 1060n }, 1060n, last).ok).toBe(true);
    expect(judgeAtlas(bnb, { price: 601n * 10n ** 18n, aggregatedAt: 1060n, onchainAt: 1060n }, 1060n, last)).toMatchObject({ refusal: 'OUT_OF_BAND' });
    expect(judgeAtlas(bnb, { price: 399n * 10n ** 18n, aggregatedAt: 1060n, onchainAt: 1060n }, 1060n, last)).toMatchObject({ refusal: 'OUT_OF_BAND' });
    // An older but still fresh observation never replaces the reference and never skips the band.
    expect(judgeAtlas(bnb, { price: 750n * 10n ** 18n, aggregatedAt: 998n, onchainAt: 999n }, 1010n, last)).toMatchObject({ refusal: 'OUT_OF_ORDER' });
    // After the window the band no longer binds: a real move is accepted at most an hour late.
    expect(judgeAtlas(bnb, { price: 700n * 10n ** 18n, aggregatedAt: 4601n, onchainAt: 4601n }, 4601n, last).ok).toBe(true);
  });

  it('the book: throttled reads, age judged at use, a refusal never becomes the last accepted price', async () => {
    let price = BNB.price, at = BNB.updatedAt;
    const calls: string[] = [];
    const test = fakeChain({ [`${bnbFeed}:${SEL.decimals}`]: dec18, [`${bnbFeed}:${SEL.latestRoundData}`]: () => round(price, at - 1n, at) }, calls);
    const book = new AtlasBook([bnb], () => [test, async (t, d) => test(t, d)], 15n);
    expect((await book.refresh(at + 5n))[0]).toMatchObject({ ok: true, price });
    const n = calls.length;
    await book.refresh(at + 10n);
    expect(calls.length).toBe(n);
    expect(book.price('BNB/USD', at + bnb.maxAgeSeconds + 1n)).toMatchObject({ ok: false, refusal: 'STALE' });
    // A jump of 50% is refused; the accepted price stays the band's reference.
    price = BNB.price * 3n / 2n; at += 30n;
    expect((await book.refresh(at, true))[0]).toMatchObject({ ok: false, refusal: 'OUT_OF_BAND' });
    expect(book.price('BNB/USD', at)).toMatchObject({ ok: false, refusal: 'OUT_OF_BAND' });
    price = BNB.price + 1n; at += 30n;
    expect((await book.refresh(at, true))[0]).toMatchObject({ ok: true, price: BNB.price + 1n });
    expect(book.price('nope', at)).toMatchObject({ ok: false, refusal: 'NOT_READ' });
  });

  it('a failed read refuses (RPC_FAILED), it never keeps an old price alive', async () => {
    const book = new AtlasBook([bnb], () => [async () => { throw new Error('down'); }, async () => { throw new Error('down'); }]);
    expect((await book.refresh(1n))[0]).toMatchObject({ ok: false, refusal: 'RPC_FAILED' });
  });

  it('values: USD and native wei, bigint, floor', () => {
    const coin = { ok: true, feed: 'NVDAB/USD', atlasId: 934, price: 149912509665791584390n, aggregatedAt: 1n, onchainAt: 1n, source: 'Atlas' } as const;
    const native = { ...coin, feed: 'BNB/USD', atlasId: 633, price: BNB.price };
    expect(usdValueX18(10n ** 18n, 18, coin)).toBe(149912509665791584390n);
    // One tNVDA is worth 0.276... tBNB at these two prices (the reviewed pin says 10).
    expect(nativeWeiOf(10n ** 18n, 18, coin, native)).toBe(149912509665791584390n * 10n ** 18n / BNB.price);
    expect(nativeWeiOf(10n ** 18n, 18, coin, native) / 10n ** 15n).toBe(276n);
    const usdc = { ...coin, price: 999838223910062279n };
    expect(nativeWeiOf(1_000_000n, 6, usdc, native) / 10n ** 12n).toBe(1842n);
  });

  it('the mapping of chain 97 names a feed for BNB, tNVDA, tETH, tUSDC and none for tGOLD', () => {
    expect(coinFeedOf('0x0000000000000000000000000000000000000000')?.feed).toBe('BNB/USD');
    expect(coinFeedOf('0x2F8029A6447663e0881b0E21F5E4aD0f1717627e')?.feed).toBe('NVDAB/USD');
    expect(coinFeedOf('0x4bA04db6044A6F442BDB29B032CB019F663Ab164')?.feed).toBe('XAU/USD');
    expect(coinFeedOf('0xF4F59ECf2221c9c07cA8fCF47A2652008FeA2Ed8')).toBeUndefined();
    for (const c of ['BNB/USD', 'NVDAB/USD', 'XAU/USD', 'ETH/USD', 'USDC/USD']) expect(atlasFeeds97.some(f => f.name === c)).toBe(true);
  });
});

describe('strict decoding (SH-266)', () => {
  const word = (n: bigint) => (n & ((1n << 256n) - 1n)).toString(16).padStart(64, '0');
  const hex = (...w: bigint[]) => `0x${w.map(word).join('')}` as Hex;
  it('latestRoundData: five words, positive, within uint80', () => {
    expect(decodeRound(hex(1n, 5n, 1n, 2n, 1n))).toEqual({ price: 5n, aggregatedAt: 1n, onchainAt: 2n });
    // The round words as on chain: each within uint80.
    expect(decodeRound(hex(1n << 80n, 5n, 1n, 2n, 1n))).toBe('MALFORMED');
    expect(decodeRound(hex(1n, 5n, 1n, 2n, 1n << 80n))).toBe('MALFORMED');
    expect(decodeRound(hex((1n << 80n) - 1n, 5n, 1n, 2n, (1n << 80n) - 1n))).toEqual({ price: 5n, aggregatedAt: 1n, onchainAt: 2n });
    expect(decodeRound(hex(1n, 1n << 80n, 1n, 2n, 1n))).toBe('TOO_WIDE');
    expect(decodeRound(hex(1n, -1n, 1n, 2n, 1n))).toBe('NO_PRICE');
    expect(decodeRound(hex(1n, 5n, 1n, 2n))).toBe('MALFORMED');
    expect(decodeRound(hex(1n, 5n, 1n, 2n, 1n, 7n))).toBe('MALFORMED');
    expect(decodeRound('0x1234')).toBe('MALFORMED');
  });
  it('fetchBatch: an over-wide row is refused alone, the others stand', () => {
    expect(decodeBatch(hex(32n, 2n, 1n << 80n, 1n, 2n, 7n, 1n, 2n), 2)).toEqual(['TOO_WIDE', { price: 7n, aggregatedAt: 1n, onchainAt: 2n }]);
    expect(decodeBatch(hex(32n, 2n, 7n, 1n << 48n, 2n, 7n, 1n, 2n), 2)[0]).toBe('MALFORMED');
    expect(decodeBatch(hex(64n, 1n, 7n, 1n, 2n), 1)).toEqual(['MALFORMED']);
  });
});

describe('endpoints: a price only when two endpoints give the same answer (SH-266)', () => {
  it('two equal answers: taken; one lying or malformed endpoint: withheld; one endpoint alone: never a price', async () => {
    const good = fakeChain({ [`${bnbFeed}:${SEL.decimals}`]: dec18, [`${bnbFeed}:${SEL.latestRoundData}`]: round(BNB.price, BNB.startedAt, BNB.updatedAt) });
    const good2 = fakeChain({ [`${bnbFeed}:${SEL.decimals}`]: dec18, [`${bnbFeed}:${SEL.latestRoundData}`]: round(BNB.price, BNB.startedAt, BNB.updatedAt) });
    const liar = fakeChain({ [`${bnbFeed}:${SEL.decimals}`]: dec18, [`${bnbFeed}:${SEL.latestRoundData}`]: round(BNB.price * 6n / 5n, BNB.startedAt, BNB.updatedAt) });
    const short = fakeChain({ [`${bnbFeed}:${SEL.decimals}`]: dec18, [`${bnbFeed}:${SEL.latestRoundData}`]: '0x1234' });
    const at = BNB.updatedAt + 5n;
    expect((await new AtlasBook([bnb], () => [good, good2]).refresh(at))[0]).toMatchObject({ ok: true, price: BNB.price });
    // A first reading has no exception: a well-formed lie on one endpoint withholds the price.
    expect((await new AtlasBook([bnb], () => [liar, good]).refresh(at))[0]).toMatchObject({ ok: false, refusal: 'DISAGREE' });
    expect((await new AtlasBook([bnb], () => [short, good]).refresh(at))[0]).toMatchObject({ ok: false, refusal: 'ONE_ENDPOINT' });
    expect((await new AtlasBook([bnb], () => good).refresh(at))[0]).toMatchObject({ ok: false, refusal: 'ONE_ENDPOINT' });
    // Two of three agree: taken.
    expect((await new AtlasBook([bnb], () => [liar, good, good2]).refresh(at))[0]).toMatchObject({ ok: true, price: BNB.price });
    // An agreed but stale answer keeps its own refusal.
    const stale = fakeChain({ [`${bnbFeed}:${SEL.decimals}`]: dec18, [`${bnbFeed}:${SEL.latestRoundData}`]: round(BNB.price, BNB.startedAt - 400n, BNB.updatedAt - 400n) });
    expect((await new AtlasBook([bnb], () => [stale, async (t, d) => stale(t, d)]).refresh(at))[0]).toMatchObject({ ok: false, refusal: 'STALE' });
    // One provider counts once, however many of its urls are configured.
    const tag = (call: EthCall, provider: string) => Object.assign(async (t: Address, d: Hex) => call(t, d), { provider });
    expect((await new AtlasBook([bnb], () => [tag(good, 'bnbchain.org'), tag(good2, 'bnbchain.org')]).refresh(at))[0]).toMatchObject({ ok: false, refusal: 'ONE_ENDPOINT' });
    expect((await new AtlasBook([bnb], () => [tag(good, 'bnbchain.org'), tag(good2, 'publicnode.com')]).refresh(at))[0]).toMatchObject({ ok: true });
    // Both times are compared: the same price at another write time is a disagreement.
    const later = fakeChain({ [`${bnbFeed}:${SEL.decimals}`]: dec18, [`${bnbFeed}:${SEL.latestRoundData}`]: round(BNB.price, BNB.startedAt, BNB.updatedAt - 1n) });
    expect((await new AtlasBook([bnb], () => [later, good]).refresh(at))[0]).toMatchObject({ ok: false, refusal: 'DISAGREE' });
  });

  it('urls are normalised and de-duplicated; providers by registrable domain', () => {
    expect(normaliseRpcUrl('https://BSC-RPC.publicnode.com/')).toBe('https://bsc-rpc.publicnode.com');
    expect(providerOf('https://bsc-testnet-dataseed.bnbchain.org')).toBe(providerOf('https://bsc-dataseed.bnbchain.org'));
    expect(providerOf('https://bsc-rpc.publicnode.com')).not.toBe(providerOf('https://bsc-dataseed.bnbchain.org'));
    const calls = rpcEndpoints(['https://bsc-rpc.publicnode.com', 'https://BSC-RPC.publicnode.com/', 'https://bsc-dataseed.bnbchain.org']);
    expect(calls.map(c => c.provider)).toEqual(['publicnode.com', 'bnbchain.org']);
  });

  it('a reverting call makes nobody wait; an endpoint-wide failure does', async () => {
    let calls = 0;
    const fetchFn = (async (_url: string, init: { body: string }) => {
      calls += 1;
      const { method } = JSON.parse(init.body) as { method: string };
      if (method === 'eth_chainId') return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x38' }), { status: 200 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const call = rpcEndpoint('x', { fetchFn, nowMs: () => 0 });
    const to = '0x0000000000000000000000000000000000000001';
    await expect(call(to, '0x')).rejects.toThrow('call reverted');
    await expect(call(to, '0x')).rejects.toThrow('call reverted');
    expect(calls).toBe(3);
  });

  it('a rate-limited endpoint waits, 1 s doubling, and is asked again after its wait', async () => {
    let now = 0, calls = 0, limited = true;
    const fetchFn = (async (_url: string, init: { body: string }) => {
      calls += 1;
      const { method } = JSON.parse(init.body) as { method: string };
      if (limited) return new Response('rate limited', { status: 429 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: method === 'eth_chainId' ? '0x38' : '0x12' }), { status: 200 });
    }) as unknown as typeof fetch;
    const call = rpcEndpoint('x', { fetchFn, nowMs: () => now });
    const to = '0x0000000000000000000000000000000000000001';
    await expect(call(to, '0x')).rejects.toThrow();
    await expect(call(to, '0x')).rejects.toThrow('waiting');
    expect(calls).toBe(1);
    now = 1000;
    await expect(call(to, '0x')).rejects.toThrow('http');
    now = 2500;
    await expect(call(to, '0x')).rejects.toThrow('waiting');
    now = 3000; limited = false;
    expect(await call(to, '0x')).toBe('0x12');
  });

  it('the band reference survives a restart (restored), and a malformed saved one is ignored', async () => {
    const at = BNB.updatedAt;
    const test = fakeChain({ [`${bnbFeed}:${SEL.decimals}`]: dec18, [`${bnbFeed}:${SEL.latestRoundData}`]: round(BNB.price * 3n / 2n, at - 1n, at) });
    const book = new AtlasBook([bnb], () => [test, async (t, d) => test(t, d)]);
    book.restore({ 'BNB/USD': { price: BNB.price.toString(), aggregatedAt: (at - 61n).toString(), onchainAt: (at - 60n).toString() } });
    expect((await book.refresh(at + 1n))[0]).toMatchObject({ ok: false, refusal: 'OUT_OF_BAND' });
    const fresh = new AtlasBook([bnb], () => [test, async (t, d) => test(t, d)]);
    fresh.restore({ 'BNB/USD': { price: '1.5' } });
    expect((await fresh.refresh(at + 1n))[0]).toMatchObject({ ok: true });
    expect(fresh.references()['BNB/USD']?.price).toBe((BNB.price * 3n / 2n).toString());
  });
});

describe('rpcEthCall failover (SH-266)', () => {
  const respond = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  it('skips a failing endpoint and one that serves another chain, then answers from the next', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body) as { method: string };
      seen.push(`${url}:${method}`);
      if (url === 'a') throw new Error('down');
      if (method === 'eth_chainId') return respond({ jsonrpc: '2.0', id: 1, result: url === 'b' ? '0x61' : '0x38' });
      return respond({ jsonrpc: '2.0', id: 1, result: '0x1234' });
    }) as unknown as typeof fetch;
    const call = rpcEthCall(['a', 'b', 'c'], { fetchFn });
    expect(await call('0x0000000000000000000000000000000000000001', '0x')).toBe('0x1234');
    expect(seen).toEqual(['a:eth_chainId', 'b:eth_chainId', 'c:eth_chainId', 'c:eth_call']);
    // The chain id of an endpoint is checked once.
    await call('0x0000000000000000000000000000000000000001', '0x');
    expect(seen.filter(s => s === 'c:eth_chainId')).toHaveLength(1);
  });
  it('an error answer or no endpoint left throws', async () => {
    const fetchFn = (async () => respond({ jsonrpc: '2.0', id: 1, error: { code: 3 } })) as unknown as typeof fetch;
    await expect(rpcEthCall(['x'], { fetchFn })('0x0000000000000000000000000000000000000001', '0x')).rejects.toThrow('price endpoints unavailable');
    expect(() => rpcEthCall([])).toThrow();
  });
});

describe('the deployed Atlas contracts and the tracked tables agree (SH-266, SH-272)', () => {
  it('the deploy script names the reader table\'s chain-97 feeds with the same limits; the file, once recorded, too', async () => {
    const { readFileSync } = await import('node:fs');
    const deployed = JSON.parse(readFileSync(new URL('../../../contracts/deployments/bnb-testnet/97-atlas.json', import.meta.url), 'utf8')) as {
      schema: string; source: string; mirror: string; feeds: { id: string; pair: string; feed: string; maxAgeSeconds: number }[];
    };
    const script = readFileSync(new URL('../../../contracts/script/bnb/AtlasRaiseDeploy.s.sol', import.meta.url), 'utf8').toLowerCase();
    expect(script).toContain(`deployed_mirror = ${deployed.mirror.toLowerCase()}`);
    const limitOf = (key: string) => BigInt(script.match(new RegExp(`${key}_max_age = (\\d+);`))?.[1] ?? -1);
    const pins = [['BNB/USD', 'atlas_bnb_usd_open_97', 'bnb'], ['ETH/USD', 'atlas_eth_usd_open_97', 'eth'], ['NVDAB/USD', 'atlas_nvdab_usd_97', 'nvdab'], ['XAU/USD', 'atlas_xau_usd_97', 'xau']] as const;
    for (const [pair, constant, key] of pins) {
      const row = must(atlasFeeds97.find(f => f.name === pair));
      expect(row.source.chainId).toBe(97n);
      expect(script).toContain(`${constant} = ${(row.source as { address: string }).address}`);
      expect(limitOf(key)).toBe(row.maxAgeSeconds);
    }
    // The file: the first deployment until the real run of SH-272 is recorded (schema 1), the open feeds after it.
    if (deployed.schema === 'square-hole-bnb-testnet-atlas/2') {
      for (const f of deployed.feeds) {
        const row = must(atlasFeeds97.find(x => x.name === f.pair));
        expect(row.source.kind === 'single' ? row.source.address : null).toBe(f.feed.toLowerCase());
        expect(row.maxAgeSeconds).toBe(BigInt(f.maxAgeSeconds));
      }
    } else {
      expect(deployed.source.toLowerCase()).toBe('0x44b187f89ad9aa2f0526a553ebd36425490bb01d');
    }
  });
});
