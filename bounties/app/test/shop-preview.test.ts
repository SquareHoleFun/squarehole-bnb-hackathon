import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { zeroAddress, type Address, type PublicClient } from 'viem';
import { expect, it, vi } from 'vitest';
import { ShopLinks } from '../src/components/ShopLinks';
import { ShopCards } from '../src/components/ShopCard';
import { flapRulesPayees, type ShopInfo } from '../src/lib/shop';

const shop = '0x0000000000000000000000000000000000001234' as Address;
const info: ShopInfo = {
  shop, token: zeroAddress, asset: zeroAddress, router: zeroAddress, creator: zeroAddress,
  tokenLive: true, tokenSymbol: 'SDECK', tokenDecimals: 18, assetSymbol: 'BNB', assetDecimals: 18,
  pickBps: 1000, weeklyCap: 0n, collections: [{ nft: zeroAddress, name: 'Deck', pickPrice: 2000000000000000001n, givePrice: 1n }],
};
const cards = [{ nft: zeroAddress, id: 42n }];
vi.mock('../src/lib/app-context', () => ({
  useApp: () => ({ config: { shops: { factory: shop } } }),
  useChainRead: () => ({ state: 'ok', value: [shop] }),
}));
vi.mock('../src/lib/use-shop-stock', () => ({
  useShopStock: () => ({ ours: info, now: { state: 'ok', value: { cards } } }),
}));

it('each preview tile links to its shop and shows the same picture, name and full pick price', () => {
  const preview = renderToStaticMarkup(createElement(ShopLinks, { token: info.token, symbol: info.tokenSymbol }));
  const pick = renderToStaticMarkup(createElement(ShopCards, { info, cards, selection: { chosen: null, disabled: false, toggle: vi.fn() } }));
  const face = pick.match(/<button[^>]*>(.*?)<\/button>/)?.[1];
  expect(face).toContain('shop-card-art');
  expect(face).toContain('Deck #42');
  expect(face).toContain('2.000000000000000001 SDECK');
  expect(preview).toContain(`>${face}</a>`);
  expect(preview.match(/href="#\/shop\/[^"]+"/g)).toEqual(Array(2).fill(`href="#/shop/${shop}"`));
  expect(preview).toContain('SDECK cards</a>');
  expect(preview).not.toContain('<button');
});

it.each(['failed', 'empty'])('keeps the creator’s shop link when the rules read is %s', async (state) => {
  const client = { readContract: async () => {
    if (state === 'failed') throw new Error('rules unavailable');
    return [];
  } } as unknown as PublicClient;
  const payees = await flapRulesPayees(client, zeroAddress, zeroAddress);
  const page = renderToStaticMarkup(createElement(ShopLinks, { token: info.token, symbol: info.tokenSymbol, creator: info.creator, payees }));
  expect(page).toContain(`href="#/shop/${shop}">SDECK cards</a>`);
  expect(page.includes('Deck #42')).toBe(state === 'empty');
});
