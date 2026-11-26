/**
 * SH-V21-FE14 (step 7 requests 2 and 3): a shop whose sellers chose Into the shop, on its box page. The site parses the
 * receiver and shop reads (`money.shopFees`) and the indexer's projection (`shopFees`) from decimal strings into bigint,
 * refuses them when they disagree with each other or with the spec's ceiling, keeps M2's optional `feesT`, and shows
 * the fixed ceiling, the live budget, what fees put in, the sellers' P waiting and what went to holders instead, the
 * founder's line and the accepted warning word for word. The sellers' share the shop does not take is claimable under
 * Holder fee share even when the buyers pay no holders. Navigation asks no wallet.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { createDemoWalletAdapter } from '../../wallet';
import { SHOP_FEES_LINE, SHOP_FEES_WARNING } from '../../create/v2/fee-words';
import { parseSnapshotV2, shopCeilingPresetV2 } from './indexer-v2';
import { recordV2 } from './record-v2';
import { sellersToHoldersP } from './ShopV2';
import { feeText, V2BoxPage } from './V2BoxPage';
import { publishedM2 } from './test-support/m2-published';
import { E18, SEED_T, publishedShopFees, word, type ShopFeesOptions } from './test-support/shop-fees-published';
import { required } from './test-support/required';
import { feePlace } from './test-support/picture-loaded';

vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
// SH-BOX-CANDLES: the chart's drawing (jsdom has no canvas).
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
afterEach(cleanup);

async function page(options: ShopFeesOptions = {}) {
  const { body, source } = await publishedShopFees(options);
  const adapter = createDemoWalletAdapter({ latencyMs: 0 }); const connect = vi.spyOn(adapter, 'connect');
  const view = parseSnapshotV2(body, source);
  const record = recordV2(view, source);
  render(<AppProviders walletAdapter={adapter}><MemoryRouter><V2BoxPage record={record} /></MemoryRouter></AppProviders>);
  // SH-297: the fee part is behind the shop's (?), closed until opened.
  expect(screen.getByRole('button', { name: 'About the shop' }).getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'About the shop' }));
  const fees = feesPart();
  return { view, record, connect, fees };
}
/** The Shop panel's fee part, under its own heading. */
const feesPart = () => required(screen.getByRole('heading', { name: 'Fees into the shop', level: 3 }).closest('section'));
const figure = (scope: HTMLElement, label: string) => within(scope).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;

describe('SH-V21-FE14 parsing money.shopFees and the shop fee history', () => {
  it('reads the receiver and shop at the snapshot hash and the projection as bigint, from decimal strings only', async () => {
    const { body, source, money } = await publishedShopFees();
    const view = parseSnapshotV2(body, source);
    expect(view.choices.sellers).toBe('shop');
    expect(shopCeilingPresetV2(view.spec)).toBe(2);
    expect(view.shopFees).toEqual({ preset: 2, money, history: { queuedP: 4_500_000n, resolvedP: 4_000_000n, spentP: 3_000_000n, boughtT: 12n * E18 } });
    // M2's optional history keeps the shop's FeesFunded total (absent in older publications).
    expect(view.m2?.history?.shop?.feesT).toBe(12n * E18);
    const older = await publishedM2(false);
    const before = Object.fromEntries(Object.entries(older.body.m2.shop as Record<string, unknown>).filter(([key]) => key !== 'feesT'));
    expect(parseSnapshotV2({ ...older.body, m2: { ...older.body.m2, shop: before } }, older.source).m2?.history?.shop).not.toHaveProperty('feesT');
    expect(parseSnapshotV2(older.body, older.source).m2?.history?.shop?.feesT).toBe(0n);
    for (const bad of [{ pendingP: 500000 }, { budgetT: '1e21' }, { ceilingT: '-1' }, { feesT: '0x10' }]) {
      expect(() => parseSnapshotV2({ ...body, money: { ...body.money, shopFees: { ...body.money.shopFees, ...bad } } }, source), JSON.stringify(bad)).toThrow(/decimal/i);
    }
    expect(() => parseSnapshotV2({ ...body, money: { ...body.money, shopFees: { ...body.money.shopFees, feesWanted: 'true' } } }, source)).toThrow(/boolean/i);
    // The projection's own conservation: what is resolved never exceeds what was queued, nor is more spent than resolved.
    expect(() => parseSnapshotV2({ ...body, shopFees: { ...(body.shopFees as Record<string, unknown>), consumedP: '4500001' } }, source)).toThrow(/shop fee history/i);
    expect(() => parseSnapshotV2({ ...body, shopFees: { ...(body.shopFees as Record<string, unknown>), spentP: '4000001' } }, source)).toThrow(/shop fee history/i);
  });

  it('refuses figures that disagree with each other or with the spec’s ceiling, and keeps the page', async () => {
    for (const options of [
      { money: { pendingP: 500_001n } },
      { money: { feesT: 13n * E18 } },
      { money: { ceilingT: SEED_T * 4n } },
      { preset: 8 as const, money: { ceilingT: SEED_T * 2n } },
    ]) {
      const { body, source } = await publishedShopFees(options);
      expect(parseSnapshotV2(body, source).shopFees, JSON.stringify(options, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toMatchObject({ money: null, history: null });
    }
    // Unpublished parts are unavailable, never zero.
    const { body, source } = await publishedShopFees({ money: null, history: null });
    expect(parseSnapshotV2(body, source).shopFees).toEqual({ preset: 2, money: null, history: null });
  });

  it('reads the ceiling multiple from the spec’s canonical word only', async () => {
    const { row } = await publishedShopFees({ preset: 8 });
    expect(shopCeilingPresetV2(row.spec)).toBe(8);
    expect(shopCeilingPresetV2({ sellers: { ...row.spec.sellers, a: { ...row.spec.sellers.a, destParams: word(3) } } })).toBeNull();
    expect(shopCeilingPresetV2({ sellers: { ...row.spec.sellers, a: { ...row.spec.sellers.a, leg: 1 } } })).toBeNull();
  });
});

describe('SH-V21-FE14 the box page of a shop with Into the shop', () => {
  it('the ceiling, the live budget, what fees put in, the P waiting and what went to holders; the line and the warning', async () => {
    const { fees, record, connect, view } = await page();
    const p = (raw: string) => `${raw} ${record.pairAsset}`;
    expect(within(fees).getByText('Filling')).toBeTruthy();
    // SH-283: thousands grouped, as the site prints token amounts (was '2000 B52').
    expect(figure(fees, 'Ceiling')).toBe('2,000 B52 · 2x the seed');
    expect(figure(fees, 'Budget')).toBe('1,000 B52');
    expect(figure(fees, 'From fees')).toBe('12 B52');
    expect(figure(fees, 'Waiting')).toBe(p('0.5'));
    // Every funded sellers' batch (even ids) went to holders: 0.7 + 0.3; the buyers' batch 1 and a waiting batch 6 do not count.
    expect(sellersToHoldersP(view)).toBe(1_000_000n);
    expect(figure(fees, 'To holders')).toBe(p('1'));
    expect(within(fees).getByText(SHOP_FEES_LINE)).toBeTruthy();
    // SH-297: the warning is the first line of the shop's (?) panel, ahead of the fee part (moved from inside it).
    const info = required(screen.getByRole('button', { name: 'About the shop' }).closest('section')?.querySelector<HTMLElement>('.sh-info-panel'));
    expect(info.firstElementChild?.textContent).toBe(SHOP_FEES_WARNING);
    expect(within(fees).queryByText(SHOP_FEES_WARNING)).toBeNull();
    const details = within(fees).getByText('How fees fill the shop').closest('details');
    expect(details?.textContent).toContain(`So far ${p('3')} bought 12 B52.`);
    expect(details?.textContent).toContain('The collection time decides, not the trade time');
    expect(details?.textContent).toContain('worth less than one step');
    // SH-245: no "batch by batch"; a batch is claimable once fully calculated, and unrecorded trades' part goes to the pool.
    expect(details?.textContent).not.toContain('batch by batch');
    expect(details?.textContent).toContain(`the share goes to holders in ${record.pairAsset}, claimable under Holder fee share once each batch is fully calculated. The part from the box’s own trades, and from trades sent with too little gas to be counted, goes to the pool.`);
    // G1 B1: a short queue waits for later collections while the shop wants fees; only unusable room pays holders.
    expect(details?.textContent).toContain(`While the shop is filling, waiting ${record.pairAsset} too small for one step stays until later collections add to it.`);
    // "Fees do not fund the shop" is gone from this shop: its sellers' fees do.
    const shop = screen.getByRole('region', { name: 'Shop' });
    expect(screen.getAllByRole('region', { name: /shop/i })).toHaveLength(1);
    expect(shop.textContent).not.toContain('Fees do not fund');
    expect(shop.textContent).toContain('Seed, picks and the sellers’ fees, up to the ceiling, fund gives.');
    // SH-255: the sellers' choice in Where the fees go (the Fees card's row before it).
    expect(await feePlace('sellers')).toBe('Into the shop · ceiling 2x the seed');
    expect(appCopyFraming(renderedCopy(shop))).toEqual([]);
    expect(shop.textContent).not.toMatch(/profit|earn|yield|returns?\b/i);
    expect(connect).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /^(buy|sell|swap)$/i })).toBeNull();
  });

  it('Full once the live budget reaches the ceiling or the week takes no fees; Unavailable without the reads', async () => {
    await page({ money: { budgetT: SEED_T * 2n } });
    expect(within(feesPart()).getByText('Full')).toBeTruthy();
    cleanup();
    await page({ money: { feesWanted: false } });
    expect(within(feesPart()).getByText('Full')).toBeTruthy();
    cleanup();
    const { fees } = await page({ money: null, history: null });
    expect(within(fees).getByText('Unavailable', { selector: '.sh-chip' })).toBeTruthy();
    for (const label of ['Budget', 'From fees', 'Waiting', 'To holders']) expect(figure(fees, label), label).toBe('Unavailable');
    expect(figure(fees, 'Ceiling')).toBe('2x the seed');
  });

  it('the sellers’ share the shop does not take is claimed under Holder fee share, also when the buyers pay no holders', async () => {
    // Buyers Grow the pool (AsPaid / Depth): only the shop's holder share uses the holder ledger.
    await page({ buyers: { leg: 1, dest: 4, destParams: '0x' } });
    const holders = screen.getByRole('region', { name: 'Holder fee share' });
    expect(holders.textContent).toContain('Into the shop: the part of a sellers’ batch the shop does not take is paid to holders');
    expect(await feePlace('buyers')).toBe('Grow the pool');
  });

  it('a shop without Into the shop keeps its own words and shows no fee section', async () => {
    const { body, source } = await publishedM2(false);
    const view = parseSnapshotV2(body, source);
    expect(view.shopFees).toBeUndefined();
    render(<AppProviders><MemoryRouter><V2BoxPage record={recordV2(view, source)} /></MemoryRouter></AppProviders>);
    expect(screen.queryByRole('heading', { name: 'Fees into the shop' })).toBeNull();
    // One Shop region either way: the fee part is no region of its own.
    expect(screen.getAllByRole('region', { name: /shop/i }).map((r) => r.getAttribute('aria-label'))).toEqual(['Shop']);
    expect(screen.getByRole('region', { name: 'Shop' }).textContent).toContain('Fees do not fund this shop.');
    expect(screen.queryByText(SHOP_FEES_WARNING)).toBeNull();
    expect(feeText(view, 'sellers', 'P', 'B52')).not.toMatch(/shop/);
  });

  it('names the ceiling in the fee words', async () => {
    const { body, source } = await publishedShopFees({ preset: 4, money: { ceilingT: SEED_T * 4n } });
    const view = parseSnapshotV2(body, source);
    expect(feeText(view, 'sellers', 'P', 'B52')).toBe('Into the shop · ceiling 4x the seed');
    expect(required(view.shopFees).money?.ceilingT).toBe(4000n * E18);
  });
});

describe('SH-245: the shop card’s holder sentence rests on these contract lines', () => {
  it('claims wait for a settled batch; a skipped notice or the box’s own trade credits nobody; the residue goes to the hook', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
    const sol = (path: string) => readFileSync(join(root, 'packages/contracts/src/box-v2', path), 'utf8');
    const ledger = sol('HolderLedgerV2.sol');
    const hook = sol('BoxHookV2Base.sol');
    expect(ledger).toContain('return _batches[id].complete ? _credit[id][holder] : 0;');
    expect(ledger).toContain('} else if (!_batches[id].complete) revert BatchNotReady(id);');
    expect(ledger).toContain('uint256 denominator = source.tradeUnits + source.protocolUnits;');
    expect(ledger).toContain("address to = IBoxCoordinatorV2(Args.addressAt(0)).failed() ? Args.addressAt(60) : Args.addressAt(40);");
    expect(hook).toContain('if (sender == _argAddress(A.RECEIVER) || bootstrap) { b.protocolUnits += units; return; }');
    expect(hook).toContain('if (gasleft() < cap + cap / 63 + C.POKE_OVERHEAD_GAS + C.HOLDER_NOTICE_RESERVE_GAS) return;');
    // The hook's P claims are the pool's budget.
    expect(hook).toContain('return _pm.balanceOf(address(this), uint256(uint160(_argAddress(A.Q))));');
  });
});
