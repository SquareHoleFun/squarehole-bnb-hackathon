import { describe, expect, it } from 'vitest';
import { ATLAS_BNB_USD_MAINNET, ATLAS_MAINNET_REGISTRY, AtlasBook, nativeWeiOf, rpcEthCall, type AtlasFeed, type AtlasPrice } from './atlas-price';
import { atlasFeeds97 } from './atlas-feeds';

/**
 * SH-266: the reader against a FORK OF BNB MAINNET (reads only), e.g.
 * `anvil --fork-url <public BNB mainnet RPC> --port 8584 --no-storage-caching`, then SH_ATLAS_FORK_URL=http://127.0.0.1:8584.
 * Skipped without it. The fork serves chain id 56, so the reader's chain check passes; "now" is the fork block's time.
 */
const url = process.env.SH_ATLAS_FORK_URL ?? '';

describe.skipIf(!url)('Atlas reader on a fork of BNB mainnet (SH-266)', () => {
  it('reads NVDAB/USD from the registry and three single feeds, fresh at the fork block, and values a tNVDA in BNB', async () => {
    const call = rpcEthCall([url], { timeoutMs: 20_000 });
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }) });
    const block = (await res.json() as { result: { number: string; timestamp: string } }).result;
    const now = BigInt(block.timestamp);
    const bnbMain: AtlasFeed = { name: 'BNB/USD', atlasId: 633, source: { kind: 'single', chainId: 56n, address: ATLAS_BNB_USD_MAINNET }, maxAgeSeconds: 180n };
    const nvdabMain: AtlasFeed = { name: 'NVDAB/USD', atlasId: 934, source: { kind: 'multi', chainId: 56n, registry: ATLAS_MAINNET_REGISTRY, feedId: 934 }, maxAgeSeconds: 180n };
    const feeds = [bnbMain, nvdabMain, ...atlasFeeds97.filter(f => f.source.chainId === 56n)];
    // The same fork twice: the agreement rule needs two endpoints (a fork cannot disagree with itself).
    const book = new AtlasBook(feeds, c => (c === 56n ? [call, Object.assign(async (t: `0x${string}`, d: `0x${string}`) => call(t, d), { provider: 'the same fork, a second vote' })] : undefined));
    const answers = await book.refresh(now);
    process.stdout.write(JSON.stringify({ block: BigInt(block.number).toString(), now: now.toString(), answers }, (_, v) => typeof v === 'bigint' ? v.toString() : v) + '\n');
    for (const a of answers) expect(a).toMatchObject({ ok: true, source: 'Atlas' });
    const nvdab = answers.find(a => a.feed === 'NVDAB/USD') as AtlasPrice;
    const bnb = answers.find(a => a.feed === 'BNB/USD') as AtlasPrice;
    // Sanity, not a market claim: a stock between 1 and 100,000 USD, BNB between 10 and 100,000 USD.
    expect(nvdab.price > 10n ** 18n && nvdab.price < 10n ** 23n).toBe(true);
    expect(bnb.price > 10n ** 19n && bnb.price < 10n ** 23n).toBe(true);
    // The exact ratio of the two returned prices: a factor error cannot pass.
    expect(nativeWeiOf(10n ** 18n, 18, nvdab, bnb)).toBe(nvdab.price * 10n ** 18n / bnb.price);
    expect(nativeWeiOf(10n ** 18n, 18, nvdab, bnb) < 10n ** 18n).toBe(true);
  }, 60_000);
});
