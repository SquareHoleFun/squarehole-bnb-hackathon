import { describe, expect, it } from 'vitest';
import { encodeFunctionResult, type Address, type Hex } from 'viem';
import { AtlasBook, atlasAbi } from '../../../chain/src/atlas/atlas-price';
import { atlasFeeds97 } from '../../../chain/src/atlas/atlas-feeds';
import { BoxPrices, boxPricesFrom } from '../../src/core/atlas-prices';

// SH-266: the indexer's `prices` block for a box view: the price coin's and the pile coin's Atlas USD price with its
// two times and age, only for a coin with a feed and only while fresh. Prices as Atlas answered on 25 November 2026.
const T = 1_800_000_000n;
const BNB_USD = 539300459101204565650n, NVDAB_USD = 147737064126976709110n, ETH_USD = 1647479641856144183000n;
const tNVDA = '0x2f8029a6447663e0881b0e21f5e4ad0f1717627e';
const tPEPE = '0xf4f59ecf2221c9c07ca8fcf47a2652008fea2ed8';
const NATIVE = '0x0000000000000000000000000000000000000000';

function book(at = T) {
  const dec = encodeFunctionResult({ abi: atlasAbi, functionName: 'decimals', result: 18 });
  const single = (p: bigint) => encodeFunctionResult({ abi: atlasAbi, functionName: 'latestRoundData', result: [1n, p, at - 1n, at, 1n] });
  const byAddress: Record<string, bigint> = {
    '0x3957d289ee9c38272377786787ea34f9dd29788d': BNB_USD, '0x35369decd8c662954b3d24acc2a862c708a34fd2': ETH_USD, '0x2fd873e39e65b5f7f0e03e5079ecd4da7fc4067b': 10n ** 18n,
    '0x3ef39d6361efa1e8ca066751f438077da81082a6': NVDAB_USD, '0xb3c87f255ce00b2692dc0eaf3e5985fbe2489764': 3520569566335130392800n,
  };
  const answer = (to: Address, data: Hex): Hex => {
    if (data.startsWith('0x313ce567')) return dec;
    const p = byAddress[to.toLowerCase()];
    if (p !== undefined) return single(p);
    return encodeFunctionResult({ abi: atlasAbi, functionName: 'fetchBatch', result: [{ price: NVDAB_USD, aggregatedTs: Number(at), onchainTs: Number(at) }] });
  };
  const call = async (to: Address, data: Hex) => answer(to, data);
  return new AtlasBook(atlasFeeds97, () => [call, async (t: Address, d: Hex) => call(t, d)]);
}
const view = (q: string, pile?: string) => ({ row: { record: { q } }, ...(pile ? { m3: { pile: { asset: pile } } } : {}) });

describe('SH-266: the indexer prices a box view from Atlas', () => {
  it('a tNVDA-priced box: its price coin with the feed, both times and the age', async () => {
    let now = T + 30n;
    const prices = new BoxPrices(book(), () => now);
    await prices.refresh();
    expect(prices.of(view(tNVDA))).toEqual({ source: 'Atlas', maxAgeSeconds: '910', coins: [{
      role: 'price', token: tNVDA, symbol: 'tNVDA', decimals: 18, feed: 'NVDAB/USD', atlasId: 934,
      standsInFor: 'NVDAB, a tokenized NVIDIA stock (a Binance bStock) on BNB mainnet', usdX18: NVDAB_USD.toString(), aggregatedAt: (T - 1n).toString(), onchainAt: T.toString(), ageSeconds: '30', maxAgeSeconds: '910',
    }] });
    // Past its feed's own limit (910 s: at least three times the largest gap between its updates): no dollar figure at all.
    now = T + 911n;
    expect(prices.of(view(tNVDA))).toBeNull();
  });

  it('a BNB-priced box with a tNVDA pile: both coins; a coin without a feed adds nothing', async () => {
    const prices = new BoxPrices(book(), () => T);
    await prices.refresh();
    const block = prices.of(view(NATIVE, tNVDA));
    expect(block?.coins.map(c => [c.role, c.symbol, c.feed, c.usdX18])).toEqual([['price', 'BNB', 'BNB/USD', BNB_USD.toString()], ['pile', 'tNVDA', 'NVDAB/USD', NVDAB_USD.toString()]]);
    expect(prices.of(view(tPEPE))).toBeNull();
    expect(prices.of(view(NATIVE, tPEPE))?.coins.map(c => c.symbol)).toEqual(['BNB']);
  });

  it('nothing read yet: no block', () => {
    expect(new BoxPrices(book(), () => T).of(view(tNVDA))).toBeNull();
  });

  it('settings: on by default for chain 97 only; public https endpoints only', () => {
    // Off unless switched on, on every network.
    expect(boxPricesFrom({}, 97, ['https://bsc-testnet-rpc.publicnode.com'])).toBeNull();
    expect(boxPricesFrom({ SH_CORE_ATLAS: '1' }, 97, ['https://bsc-testnet-rpc.publicnode.com'])).toBeInstanceOf(BoxPrices);
    expect(boxPricesFrom({}, 11155111, [])).toBeNull();
    expect(() => boxPricesFrom({ SH_CORE_ATLAS: '1' }, 1, [])).toThrow(/chain 97 only/);
    expect(() => boxPricesFrom({ SH_CORE_ATLAS: '1', SH_CORE_ATLAS_MAINNET_RPC_URLS: 'https://a.example/?key=1' }, 97, ['https://x.example'])).toThrow(/public https/);
  });
});
