/**
 * SH-V21-05 (v2.1 step 5) on the v2 box page: an items side whose in-vault rule is Grow the pool (Depth, policy 3). The
 * published history keeps the policy and its depth total exactly (decimal strings to bigint), the Fees row and the item
 * panel name the rule, the panel's details explain it (in P, and for a side paid in T), and navigation asks no wallet.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { encodeAbiParameters } from 'viem';
import type { SideV2 } from '../../../../../../packages/chain/src/core/v2';
import { AppProviders } from '../../../app-providers';
import { createDemoWalletAdapter } from '../../wallet';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { inVaultText } from './ItemPayoutsV2';
import { parseSnapshotV2 } from './indexer-v2';
import { parseM3 } from './m3-data';
import { recordV2 } from './record-v2';
import { ETH, publishedItems } from './test-support/m3-published';
import { required } from './test-support/required';
import { V2BoxPage, feeText } from './V2BoxPage';
import { feePlace } from './test-support/picture-loaded';
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
// SH-BOX-CANDLES: the chart's drawing (jsdom has no canvas).
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const uint8 = (n: number) => encodeAbiParameters([{ type: 'uint8' }], [n]);
const items = (leg: 1 | 2, inside: 1 | 2 | 3): SideV2 => ({ a: { leg, dest: 8, legParams: '0x', destParams: uint8(inside) }, b: { leg: 0, dest: 0, legParams: '0x', destParams: '0x' }, split: 1, splitParams: '0x' });
/** Above 2^53: a JS number would lose it. */
const DEPTH = 2n ** 53n + 1n;
/** Buyers Grow the pool (all held P to the pool at graduation, one live receipt with one of four items inside), sellers Burn. */
const depthHistory = {
  policies: { buyers: 3, sellers: 2 },
  funding: {
    '1': { batchId: 0n, side: 1, source: 3, choiceP: 4n * ETH, ledgerP: 0n },
    '2': { batchId: 0n, side: 2, source: 3, choiceP: 0n, ledgerP: 0n },
    '3': { batchId: 1n, side: 1, source: 1, choiceP: ETH, ledgerP: (3n * ETH) / 4n },
  },
  depthP: DEPTH,
};
const depthBox = (leg: 1 | 2 = 1) => publishedItems({ sides: { buyers: items(leg, 3), sellers: items(1, 2) }, history: depthHistory });

async function page(published: Awaited<ReturnType<typeof publishedItems>>) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  const adapter = createDemoWalletAdapter({ latencyMs: 0 }); const connect = vi.spyOn(adapter, 'connect');
  const view = parseSnapshotV2(published.body, published.source);
  render(<AppProviders walletAdapter={adapter}><MemoryRouter><V2BoxPage record={recordV2(view, published.source)} /></MemoryRouter></AppProviders>);
  return { connect, view };
}
const panel = () => screen.getByRole('region', { name: 'Item payouts' });
const neutral = (texts: readonly string[]) => texts.map((text) => text.replace(/\bGrow the pool\b/g, 'Add to the pool'));

describe('the published history', () => {
  it('keeps policy 3 and the depth total exactly, as bigint from its decimal string', async () => {
    const { body, source } = await depthBox();
    const view = parseSnapshotV2(body, source);
    const history = required(view.m3?.items);
    expect(history.policies).toEqual({ buyers: 3, sellers: 2 });
    expect(history.depthP).toBe(DEPTH);
    // No base stash on a Depth side: what it held before graduation went to the pool.
    expect(history.paidPerItem).toBe(history.outsideIndex);
    expect(view.choices).toEqual({ buyers: 'items', sellers: 'items' });
  });

  it('a history without a Depth total has none; an unknown policy or a number for the total is refused', async () => {
    const { body, source } = await publishedItems();
    expect(required(parseSnapshotV2(body, source).m3?.items).depthP).toBeUndefined();
    const m3 = body.m3 as { items: Record<string, unknown> };
    const spec = { boxType: 1, n: 4 };
    const money = (body.money as { m3: unknown }).m3; const hash = (body.asOf as { hash: string }).hash;
    expect(parseM3({ ...m3, items: { ...m3.items, depthP: '9007199254740993' } }, money, hash, spec).items?.depthP).toBe(DEPTH);
    expect(() => parseM3({ ...m3, items: { ...m3.items, policies: { buyers: 4, sellers: 2 } } }, money, hash, spec)).toThrow('Invalid M3 number');
    expect(() => parseM3({ ...m3, items: { ...m3.items, depthP: Number(DEPTH) } }, money, hash, spec)).toThrow('Expected a raw decimal string');
  });
});

describe('the rule’s words', () => {
  it('names Depth "Grow the pool", alone or beside the other side’s rule', () => {
    expect(inVaultText({ buyers: 3, sellers: 0 })).toBe('Grow the pool');
    expect(inVaultText({ buyers: 3, sellers: 3 })).toBe('Grow the pool');
    expect(inVaultText({ buyers: 3, sellers: 1 })).toBe('Buyers Grow the pool · Sellers Keep');
    expect(inVaultText({ buyers: 2, sellers: 3 })).toBe('Buyers Buy back and burn the box coin · Sellers Grow the pool');
    expect(inVaultText({ buyers: 2, sellers: 2 }, 'RENT')).toBe('Buy back and burn RENT');
  });

  it.each([[1, 'To items · Grow the pool'], [2, 'To items · in MARINE · Grow the pool']] as const)('the Fees row of a Depth side (leg %i)', async (leg, text) => {
    const { body, source } = await depthBox(leg);
    const view = parseSnapshotV2(body, source);
    expect(feeText(view, 'buyers', 'ETH', 'MARINE')).toBe(text);
    expect(feeText(view, 'sellers', 'ETH', 'MARINE')).toBe('To items · Buy back and burn MARINE');
  });
});

describe('the box page', () => {
  it('a Depth box names its rule in Fees and the item panel, explains it in the details, and asks no wallet', async () => {
    const { connect } = await page(await depthBox());
    // SH-255: each side's rule in Where the fees go (the Fees card's rows before it).
    expect(await feePlace('buyers')).toBe('To items · Grow the pool');
    expect(await feePlace('sellers')).toBe('To items · Buy back and burn B352');
    expect(within(panel()).getByText('In the vault').nextElementSibling?.textContent).toBe('Buyers Grow the pool · Sellers Buy back and burn B352');
    const details = required(panel().querySelector('details'));
    expect(details.textContent).toContain('Grow the pool: while an item is in the vault, its share goes into this box’s own pool for good, in ETH; shares held before graduation go there too.');
    expect(details.textContent).not.toMatch(/buys \S+ only with the shares of items out of the vault/);
    expect(connect).not.toHaveBeenCalled(); expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /^(buy|sell|swap)$/i })).toBeNull();
    expect(appCopyFraming(neutral(renderedCopy(document.body)))).toEqual([]);
  });

  it('a Depth side paid in the box token says only items out of the vault have their share buy it', async () => {
    const published = await depthBox(2);
    await page(published);
    const ticker = (published.row.spec as { tokenSymbol: string }).tokenSymbol;
    const details = required(panel().querySelector('details'));
    expect(details.textContent).toContain(`A side paid in ${ticker} buys ${ticker} only with the shares of items out of the vault, and each purchase is shared out over those items.`);
    expect(appCopyFraming(neutral(renderedCopy(document.body)))).toEqual([]);
  });

  it('a Keep and Burn box shows no Depth line', async () => {
    await page(await publishedItems());
    expect(within(panel()).getByText('In the vault').nextElementSibling?.textContent).toBe('Buyers Keep · Sellers Buy back and burn B352');
    expect(required(panel().querySelector('details')).textContent).not.toContain('Grow the pool');
  });
});
