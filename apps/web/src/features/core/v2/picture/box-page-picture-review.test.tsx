/**
 * SH-255, second review (job288): what the box page around the picture answers for, each first run red against the
 * branch's head 45f7a25e6: the entries offer only what the page offers (R-11), an entry puts focus on its action (R-12),
 * the creator's quote is read once per snapshot and the pile's coin as the pile's card reads it (R-13), a long amount
 * stays inside the drawing (R-19).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAWING_CHARS } from '../../../box-picture/live-figures';
import type { V2Snapshot } from '../indexer-v2';
import { boxPictureFixture } from '../test-support/box-picture-v2';
import { required } from '../test-support/required';
import { doEntriesV2, pileAssetOfV2 } from '../V2BoxPage';
import { pileRedeemOpenV2 } from '../CoinPileV2';
import { vaultMovesOpenV2 } from '../VaultItemsV2';
import { numberSize } from '../../../create/picture/BoxPictureSvg';
import { goTo } from './BoxPagePicture';
import { liveModelOf } from './live-picture';
import { sheetOf } from './LiveSheets';

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../claim-all-actions', async (original) => ({
  ...(await original<typeof import('../claim-all-actions')>()),
  creatorReaderV2: async () => ({}),
  // Fork B (its hash all b) quotes zero; every other snapshot quotes 5.
  readCreatorFeesV2: async (view: { blockHash: string; block: bigint }) => { reads.count += 1; return { amount: /^0xb+$/.test(view.blockHash) ? 0n : 5n, block: view.block }; },
}));
const { useCreatorQuoteV2 } = await import('../claim-reads');

afterEach(() => { cleanup(); document.body.innerHTML = ''; });

const NO_ALCHEMIST = { buyers: false, sellers: false } as const;
const entriesOf = (view: V2Snapshot, extra: Partial<Parameters<typeof doEntriesV2>[1]> = {}) =>
  doEntriesV2(view, { ticker: 'T', ...extra }).map((entry) => entry.key);

describe('R-11, round 3 D10: one predicate per entry, the card’s own', () => {
  it('none in the creator’s Reveal items view, which replaces every control an entry leads to', () => {
    const { view } = boxPictureFixture('rent-free');
    expect(entriesOf(view).length).toBeGreaterThan(0);
    expect(entriesOf(view, { revealing: true })).toEqual([]);
  });
  it('Hand in exactly where the pile card renders its Redeem form (pileRedeemOpenV2), whatever the pile holds', () => {
    const { view } = boxPictureFixture('one-dollar');
    const pile = required(view.m3?.pileMoney ?? null);
    const at = (redemptionOpen: boolean, balance: bigint) => ({ ...view, m3: { ...required(view.m3), pileMoney: { ...pile, redemptionOpen, balance } } } as V2Snapshot);
    // The review's case: a donated balance with redemption shut (no Redeem form) offers no Hand in.
    expect(pileRedeemOpenV2(at(false, 7n))).toBe(false);
    expect(entriesOf(at(false, 7n))).not.toContain('pile');
    expect(pileRedeemOpenV2(at(true, 0n))).toBe(true);
    expect(entriesOf(at(true, 0n))).toContain('pile');
    expect(entriesOf({ ...at(true, 7n), m3: { ...required(view.m3), pile: null } } as V2Snapshot)).not.toContain('pile');
  });
  it('Put it back where the vault card’s moves are open (vaultMovesOpenV2); no Pay in, no Take one out', () => {
    const { view } = boxPictureFixture('rent-free');
    expect(vaultMovesOpenV2(view)).toBe(true);
    expect(entriesOf(view)).toEqual(['claim', 'in']);
    expect(entriesOf({ ...view, gate: { ...view.gate, open: false } })).toEqual(['claim']);
    expect(entriesOf(boxPictureFixture('sam').view)).not.toContain('pay');
  });
});

describe('R-12, round 3 D11: focus lands on the control marked for the entry, else on its shown card', () => {
  const place = (html: string) => { document.body.innerHTML = `<div id="place">${html}</div>`; Element.prototype.scrollIntoView = vi.fn(); return required(document.getElementById('place')); };
  it('past a 3D button and a disclosure to the marked control; the card when it is disabled, also by its fieldset', () => {
    place('<button type="button">3D</button><details><summary>Claim all details</summary></details><button type="button" data-entry-target="claim">Claim all</button>');
    expect(goTo('place', 'claim')).toBe(true);
    expect(document.activeElement?.textContent).toBe('Claim all');
    const wrapper = place('<button type="button">3D</button><fieldset disabled><input data-entry-target="pile" /></fieldset>');
    expect(goTo('place', 'pile')).toBe(true);
    expect(document.activeElement).toBe(wrapper);
  });
  it('review fix 7: Put it back without its marked control lands on the card’s first control, the card only without any', () => {
    place('<h2>Items in the vault</h2><button type="button" disabled>Take out</button><button type="button">More items</button>');
    expect(goTo('place', 'in', true)).toBe(true);
    expect(document.activeElement?.textContent).toBe('More items');
    const wrapper = place('<h2>Items in the vault</h2><p>No items to take out on this page.</p>');
    expect(goTo('place', 'in', true)).toBe(true);
    expect(document.activeElement).toBe(wrapper);
    expect(doEntriesV2(boxPictureFixture('rent-free').view, { ticker: 'T' }).find((entry) => entry.key === 'in')?.firstControl).toBe(true);
  });
  it('a card hidden while its chunk loads is no target: focus stays', () => {
    const before = document.activeElement;
    place('<button type="button" data-entry-target="claim">Claim all</button>');
    required(document.getElementById('place')).style.display = 'none';
    expect(goTo('place', 'claim')).toBe(false);
    expect(document.activeElement).toBe(before);
  });
});

describe('R-13: no read the page did not make before', () => {
  it('the creator’s quote: one read per snapshot, however often the sheet opens', async () => {
    const { view, source } = boxPictureFixture('gpu-poor');
    const payee = { ...view, money: { ...required(view.money), creatorPayee: '0x00000000000000000000000000000000000000c1' } } as V2Snapshot;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    reads.count = 0;
    renderHook(() => useCreatorQuoteV2(source, payee), { wrapper });
    await waitFor(() => expect(reads.count).toBe(1));
    for (let open = 0; open < 3; open += 1) {
      const sheet = renderHook(() => useCreatorQuoteV2(source, payee), { wrapper });
      await act(async () => { await new Promise((done) => setTimeout(done, 20)); });
      sheet.unmount();
    }
    expect(reads.count).toBe(1);
  });
  it('round 3 D12: at one height, fork A, fork B, then A again: the quote shown is always the shown fork’s own', async () => {
    const { view, source } = boxPictureFixture('gpu-poor');
    const base = { ...view, money: { ...required(view.money), creatorPayee: '0x00000000000000000000000000000000000000c1' } } as V2Snapshot;
    const a = { ...base, blockHash: `0x${'a'.repeat(64)}` } as V2Snapshot;
    const b = { ...base, blockHash: `0x${'b'.repeat(64)}` } as V2Snapshot;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const hook = renderHook(({ shown }: { shown: V2Snapshot }) => useCreatorQuoteV2(source, shown), { wrapper, initialProps: { shown: a } });
    await waitFor(() => expect(hook.result.current.state).toMatchObject({ kind: 'ready', read: { amount: 5n } }));
    hook.rerender({ shown: b });
    await waitFor(() => expect(hook.result.current.state.kind).toBe('none'));
    hook.rerender({ shown: a });
    await waitFor(() => expect(hook.result.current.state).toMatchObject({ kind: 'ready', read: { amount: 5n } }));
  });
  it('the pile’s coin from the asset the pile’s card reads, none without its history or money', () => {
    const { view } = boxPictureFixture('one-dollar');
    expect(pileAssetOfV2(view)).toBe(required(view.m3?.pileMoney ?? null).asset);
    expect(pileAssetOfV2({ ...view, m3: undefined } as V2Snapshot)).toBeNull();
    expect(pileAssetOfV2(boxPictureFixture('gpu-poor').view)).toBeNull();
  });
});

describe('R-19: a long amount stays inside the drawing', () => {
  it('a 30-digit fee in a six-decimal coin prints short in the drawing, its exact digits in the sheet', () => {
    const f = boxPictureFixture('rent-free');
    const huge = 123_456_789_012_345_678_901_234_567_890n;
    const view = { ...f.view, feesP: { buyers: huge, sellers: huge / 7n } } as V2Snapshot;
    const model = liveModelOf(f.record, view, { nowSec: view.timestamp, alchemist: NO_ALCHEMIST, pileCoin: null });
    // Short, the site's way (formatTokenShort's largest unit is B), with all four of a side in that one unit.
    expect(model.visitor.buyers).toBe('123,456,789,012,345.67B');
    expect(model.numbers.stations.buyers).toMatch(/B$/);
    // Every figure the drawing prints fits its room: its size shrinks only as far as that needs (BoxPictureSvg numberSize).
    for (const [figure, size, room] of [[model.visitor.buyers, 15, 88], [model.numbers.stations.buyers, 16, 96], [model.numbers.pool, 16, 150], [model.numbers.mark, 12, 72]] as const) {
      expect(numberSize(figure, size, room) * figure.length * 0.6, figure).toBeLessThanOrEqual(room + 1);
    }
    // A short figure keeps the drawing's own size (Launch's numbers never change).
    expect(numberSize('0.6667', 16, 96)).toBe(16);
    expect('0.6667'.length).toBeLessThanOrEqual(DRAWING_CHARS);
    const { container } = render(<>{sheetOf('buyers', { record: f.record, view, model, nowSec: view.timestamp, pileCoin: null, creatorClaim: null }).body}</>);
    expect(container.querySelector('.sh-bpic-big strong')?.textContent).toBe('123456789012345678901234.56789');
  });
});
