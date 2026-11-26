import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { BoxRecord } from '../../boxes/box-model';
import { parseSnapshotV2 } from './indexer-v2';
import { recordedLifeV2, sepoliaLifeSourceV2 } from './test-support/life-v2';
import { usdNote, usdPriceFor, usdPricesOf, usdText, type UsdPriceV2 } from './usd-v2';
import { UsdLine } from './UsdLineV2';
import { headerStatsV2 } from './V2BoxPage';

// SH-266: the box page's dollar values from the indexer's `prices` block (Atlas, read by the indexer). The recorded GPU
// Poor box (priced in tNVDA) with a prices block as the indexer publishes it; NVDAB/USD as Atlas answered on 25 November.
const body = recordedLifeV2.gpuPoor.body as Record<string, unknown>;
const q = ((body.row as { record: { q: string } }).record.q).toLowerCase();
const AT = 1793083272n; // the recorded snapshot's own block time
const NVDAB = '147737064126976709110';
const block = (onchainAt = AT - 20n) => ({ source: 'Atlas', maxAgeSeconds: '180', coins: [{ role: 'price', token: q, symbol: 'tNVDA', decimals: 18, feed: 'NVDAB/USD', atlasId: 934,
  standsInFor: 'NVDAB, a tokenized NVIDIA stock (a Binance bStock) on BNB mainnet', usdX18: NVDAB, aggregatedAt: (onchainAt - 1n).toString(), onchainAt: onchainAt.toString(), ageSeconds: '20', maxAgeSeconds: '180' }] });
const price: UsdPriceV2 = { role: 'price', token: q, symbol: 'tNVDA', decimals: 18, feed: 'NVDAB/USD', standsInFor: 'NVDAB, a tokenized NVIDIA stock (a Binance bStock) on BNB mainnet', usdX18: BigInt(NVDAB), onchainAt: AT - 20n, maxAgeSeconds: 180n };

describe('SH-266: dollar values on the box page', () => {
  it('reads the prices block; a malformed one is dropped and the box still shows', () => {
    const view = parseSnapshotV2({ ...body, prices: block() }, sepoliaLifeSourceV2());
    expect(view.prices?.coins[0]).toMatchObject({ symbol: 'tNVDA', feed: 'NVDAB/USD', usdX18: BigInt(NVDAB) });
    // A coin with a malformed or missing limit of its own is dropped: never the block's limit instead.
    const { maxAgeSeconds: _drop, ...noLimit } = block().coins[0] as Record<string, unknown>;
    void _drop;
    for (const bad of [{ ...block(), source: 'Other' }, { ...block(), coins: [{ ...block().coins[0], usdX18: '1.5' }] }, { ...block(), coins: [{ ...block().coins[0], maxAgeSeconds: '1.5' }] },
      { ...block(), maxAgeSeconds: '900', coins: [noLimit] }, 'x', null]) {
      expect(parseSnapshotV2({ ...body, prices: bad }, sepoliaLifeSourceV2()).prices).toBeUndefined();
    }
    expect(parseSnapshotV2(body, sepoliaLifeSourceV2()).prices).toBeUndefined();
  });

  it('a price older than the block\'s limit shows nothing', () => {
    const prices = usdPricesOf(block());
    expect(usdPriceFor(prices, q, AT)).not.toBeNull();
    expect(usdPriceFor(prices, q, AT - 20n + 180n)).not.toBeNull();
    expect(usdPriceFor(prices, q, AT - 20n + 181n)).toBeNull();
    expect(usdPriceFor(prices, '0x0000000000000000000000000000000000000001', AT)).toBeNull();
    // A coin's own limit (gold and the stock: 900 s) wins over the block's; a time after the page's clock shows nothing.
    const gold = usdPricesOf({ ...block(), coins: [{ ...block().coins[0], maxAgeSeconds: '900' }] });
    expect(usdPriceFor(gold, q, AT - 20n + 900n)).not.toBeNull();
    expect(usdPriceFor(gold, q, AT - 20n + 901n)).toBeNull();
    expect(usdPriceFor(prices, q, AT - 21n)).toBeNull();
  });

  it('formats: rounded down to the cent, grouped, never a float', () => {
    expect(usdText(10n ** 18n, 18, price)).toBe('about $147.73');
    expect(usdText(10n ** 22n, 18, price)).toBe('about $1,477,370.64');
    expect(usdText(10n ** 13n, 18, price)).toBe('under $0.01');
    expect(usdText(0n, 18, price)).toBe('$0');
    expect(usdNote(price, AT)).toBe('Price from Atlas (NVDAB/USD), 20 s old. tNVDA is a test coin priced as NVDAB, a tokenized NVIDIA stock (a Binance bStock) on BNB mainnet.');
  });

  it('the header: market cap and 24h volume say about $X while fresh, the coin alone otherwise', () => {
    const view = parseSnapshotV2({ ...body, prices: block() }, sepoliaLifeSourceV2());
    const record = { pairAsset: 'tNVDA', ticker: 'VRAM' } as unknown as BoxRecord;
    const stats = headerStatsV2(record, view, AT);
    expect(stats.find(s => s.label === 'Market cap')).toMatchObject({ unit: 'tNVDA, about $71,830.20', info: usdNote(price, AT) });
    expect(stats.find(s => s.label === '24h volume')?.unit).toBe('tNVDA, about $14,922.93');
    const later = headerStatsV2(record, view, AT + 200n);
    expect(later.find(s => s.label === 'Market cap')).toEqual(expect.objectContaining({ unit: 'tNVDA' }));
    expect(later.find(s => s.label === 'Market cap')?.info).toBeUndefined();
    expect(headerStatsV2(record, parseSnapshotV2(body, sepoliaLifeSourceV2()), AT).find(s => s.label === 'Market cap')?.unit).toBe('tNVDA');
  });

  it('the dollar line: the number in view, source and age behind a closed (i)', () => {
    render(<UsdLine raw={2n * 10n ** 18n} decimals={18} price={price} nowSec={AT} />);
    expect(screen.getByText('about $295.47')).toBeTruthy();
    const note = screen.getByText(/Price from Atlas/);
    expect(note.closest('[hidden]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'About the dollar value' }));
    expect(note.closest('[hidden]')).toBeNull();
  });

  it('no fresh price, no line', () => {
    const { container } = render(<UsdLine raw={10n ** 18n} decimals={18} price={null} nowSec={AT} />);
    expect(container.textContent).toBe('');
  });
});
