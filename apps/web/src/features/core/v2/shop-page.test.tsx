/**
 * SH-V21-FE13 the shop panel: the week's give allowance left for the shop and per collection, the fixed prices, and
 * give, pick and the curator's addition, each behind an in-page confirmation. The chain reads (shop-reads.ts) and the
 * sends (shop-actions.ts, whose own tests run them through the real shared sender) are doubles here; the panel, the
 * book's arithmetic (shop-book.ts) and the wallet boundary are real. Navigation asks no wallet.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, type Address, type Hex } from 'viem';
import { shopConfigV2, shopConfigV2Parameters } from '../../../../../../packages/chain/src/core/v2/m2-spec-v2';
import { encodeBoxSpecV2 } from '../../../../../../packages/chain/src/core/v2';
import { jsonV2 } from '../../../../../../packages/indexer/src/core/core-row';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotSendableError } from '@squarehole/chain/write';
import { AppProviders } from '../../../app-providers';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { COLLECTION } from '../../../../../../packages/indexer/src/core/v2/m2-fixture.test-support';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { shopBookV2, type ShopBookV2, type ShopEventV2 } from './shop-book';
import { ShopV2 } from './ShopV2';
import { V2BoxPage } from './V2BoxPage';
import { recordV2 } from './record-v2';
import { A, B, publishedM2 } from './test-support/m2-published';
import { required } from './test-support/required';
import { shopAmountV2, shortNamesV2 } from './ShopCardsV2';
import { dayOf, limitLine, startMark, unfoundLine, utcDate } from './ShopActionsV2';

const wallet = vi.hoisted(() => ({ account: null as string | null, status: 'disconnected', chainId: 0, kind: 'injected', defaultDialog: 'browser', signer: { request: vi.fn() } }));
vi.mock('../../wallet', async (original) => ({ ...await original<object>(), useWallet: () => wallet }));
const reads = vi.hoisted(() => ({ book: null as unknown, own: null as readonly bigint[] | null, item: null as unknown, coins: null as unknown, cards: null as unknown }));
vi.mock('./shop-reads', () => ({
  useShopBookV2: () => ({ book: reads.book, failed: false }),
  useCollectionNamesV2: () => () => 'Test Collection',
  useOwnItemsV2: () => reads.own,
  useShopItemV2: () => ({ item: reads.item, reading: false }),
  useShopCoinsV2: () => reads.coins,
}));
// SH-297: the wallet's own cards of the shop's collections (card-reads.ts; its own tests cover the reading).
vi.mock('./card-reads', async (original) => ({ ...await original<object>(), useOwnCardsV2: () => reads.cards }));
vi.mock('../../create/v2/shop-checks', async (original) => ({ ...await original<object>(), collectionCheckV2: async () => 'erc721' }));
// SH-283: the items' pictures (set-pictures.ts reads them; its own tests cover the reading). Here: item 2's picture is
// read, the rest have none.
const pictures = vi.hoisted(() => ({ calls: [] as { reads: unknown; id: bigint }[] }));
vi.mock('../../set/set-pictures', () => ({
  useItemPicture: (reads: unknown, _chainId: number, _collection: string, id: bigint) => {
    pictures.calls.push({ reads, id });
    return reads && id === 2n ? { url: 'blob:item-2', withheld: false } : { url: null, withheld: false };
  },
}));
const sends = vi.hoisted(() => ({ give: vi.fn(), pick: vi.fn(), add: vi.fn() }));
// SH-300: the whole box page is rendered once (the settings that do not decode); its chain-only panels are not this test's.
vi.mock('./SafesV2', () => ({ SafesV2: () => null }));
vi.mock('./BurnLogV2', () => ({ BurnLogV2: () => null }));
vi.mock('./candle-canvas', () => import('./test-support/candle-canvas-fake'));
vi.mock('./shop-actions', async (original) => ({ ...await original<object>(),
  pressGiveV2: sends.give, pressPickV2: sends.pick, sendAddCollectionV2: sends.add }));

const E18 = 10n ** 18n;
const NOW = 2_000_000n;
const OPEN = NOW - 1_000n;
const OTHER = getAddress('0x00000000000000000000000000000000000000c3') as Address;
const receipt = { transactionHash: `0x${'77'.repeat(32)}`, blockNumber: 200n, blockHash: `0x${'b'.repeat(64)}`, status: 'success' };

async function rig({ items = 3, graduated = true, given = 0n, account = A as string | null, inside, activeAt = OPEN - 1n, cards = [7n], later, unfound = 0n, listDelay, contents, starter, loaded }: { listDelay?: number; contents?: Hex; starter?: Hex; loaded?: number; items?: number; graduated?: boolean; given?: bigint; account?: string | null; inside?: bigint; activeAt?: bigint; cards?: readonly bigint[] | null; later?: bigint; unfound?: bigint } = {}) {
  const m2 = await publishedM2(false);
  // SH-300: other shop settings bytes, or other starter add-on (8) bytes, in the published spec (its hash with them),
  // read by the real snapshot parser.
  const spec0 = contents === undefined && starter === undefined ? null : { ...m2.row.spec, ...(contents === undefined ? {} : { contentsParams: contents }),
    ...(starter === undefined ? {} : { addOns: m2.row.spec.addOns.map((addOn) => (addOn.id === 8 ? { ...addOn, params: starter } : addOn)) }) };
  const encodedSpec = spec0 === null ? null : encodeBoxSpecV2(spec0);
  const body = spec0 === null || encodedSpec === null ? m2.body : { ...m2.body, row: jsonV2({ ...m2.row, spec: spec0, encodedSpec, record: { ...m2.row.record, specHash: keccak256(encodedSpec) } }) };
  const parsed = parseSnapshotV2(body, m2.source);
  // The snapshot's own count of items inside (the publication's 3), when a test needs another; likewise the starter
  // items loaded (the publication's 3).
  const money = required(parsed.m2?.money);
  const counted = inside === undefined && loaded === undefined ? {} : { m2: { ...required(parsed.m2), money: { ...money,
    ...(inside === undefined ? {} : { shop: { ...required(money.shop), inside } }), ...(loaded === undefined ? {} : { starter: { ...required(money.starter), loaded } }) } } };
  // SH-300: the second release's shop takes a wait of ten minutes (600 s); the spec says so in its shop config.
  const spec = listDelay === undefined ? parsed.spec : { ...parsed.spec, contentsParams: encodeAbiParameters(shopConfigV2Parameters, [{ ...shopConfigV2(parsed.spec.contentsParams), listDelay }]) };
  const view: V2Snapshot = { ...parsed, spec, shopConfig: listDelay === undefined ? parsed.shopConfig : shopConfigV2(spec.contentsParams), graduated, timestamp: NOW, ...counted };
  wallet.account = account; wallet.status = account ? 'connected' : 'disconnected'; wallet.chainId = m2.source.manifest.chainId;
  const budget = required(view.m2?.money?.shop).budgetT;
  const events: ShopEventV2[] = [
    { kind: 'seed', amountT: budget + given, block: 101n }, { kind: 'added', collection: COLLECTION, tier: 0, activeAt, block: 101n },
    // SH-297 notes: a second collection that takes gives only from `later`, its card 5 first in the wallet's list.
    ...(later !== undefined ? [{ kind: 'added' as const, collection: OTHER, tier: 0, activeAt: later, block: 101n }] : []),
    ...Array.from({ length: items }, (_, i) => ({ kind: 'loaded' as const, collection: COLLECTION, id: BigInt(i + 1), block: 101n })),
    ...(graduated ? [{ kind: 'opened' as const, timestamp: OPEN, block: 102n }] : []),
    ...(given > 0n ? [{ kind: 'given' as const, collection: COLLECTION, id: 99n, amountT: given, block: 103n }] : []),
  ];
  const book: ShopBookV2 = shopBookV2(events, new Map([[103n, OPEN + 5n]]), NOW, view.block);
  reads.book = book; reads.own = null; reads.item = { owner: A, approved: true }; reads.coins = { balance: 10n * E18, allowance: 10n * E18 };
  const otherCards = later !== undefined ? [{ collection: OTHER, id: 5n }] : [];
  reads.cards = account === null || cards === null ? null : { status: 'ready', cards: [...otherCards, ...cards.map((id) => ({ collection: COLLECTION, id }))], more: false, unfound };
  for (const send of Object.values(sends)) { send.mockReset(); send.mockResolvedValue(receipt); }
  const result = render(<AppProviders><MemoryRouter><ShopV2 view={view} source={m2.source} ticker="B52" disabled={false} /></MemoryRouter></AppProviders>);
  return { ...m2, view, book, budget, rerender: () => result.rerender(<AppProviders><MemoryRouter><ShopV2 view={view} source={m2.source} ticker="B52" disabled={false} /></MemoryRouter></AppProviders>) };
}
const panel = () => screen.getByRole('region', { name: 'Shop' });
const week = () => required(panel().querySelector<HTMLElement>('.sh-v2-shop-week'));
/** The actions' own status line (the starter set has another). */
const said = () => within(required(panel().querySelector<HTMLElement>('.sh-v2-shop-actions'))).getByRole('status').textContent;
const figure = (scope: HTMLElement, label: string) => within(scope).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;
const section = (name: string) => required(screen.getByRole('heading', { name, level: 3 }).closest('section'));
const confirmGroup = () => screen.getByRole('group', { name: 'Confirm transaction' });
const press = async (name: string | RegExp, scope: HTMLElement = panel()) => act(async () => { fireEvent.click(within(scope).getByRole('button', { name })); });
/** The shop's amounts as the site prints token amounts (SH-283: thousands grouped, every digit). */
const b52 = (raw: bigint) => shopAmountV2(raw, 'B52');
/** A collection's label: its name, and its address beside it (a copy can take any name). */
const LABEL = `Test Collection · ${COLLECTION.slice(0, 6)}…${COLLECTION.slice(-4)}`;

beforeEach(() => { wallet.signer.request.mockReset(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('SH-V21-FE13 the week’s allowance', () => {
  it('left this week for the shop, the limit per collection and each collection’s own room; fixed prices in the box’s coin', async () => {
    const f = await rig({ given: 3n * E18 });
    // The week's budget is what the book replays before this week's first give: the budget read plus that give.
    const snapshot = f.budget + 3n * E18;
    expect(figure(week(), 'Left this week')).toBe(b52(snapshot * 1_000n / 10_000n - 3n * E18));
    expect(figure(week(), 'Per collection')).toBe(`up to ${b52(snapshot * 250n / 10_000n)}`);
    // SH-297: these sit behind the shop's (?), closed until opened; beside the cards, the two figures short and cut.
    fireEvent.click(within(panel()).getByRole('button', { name: 'About the shop' }));
    expect(within(panel()).getByRole('table', { name: 'Fixed prices in B52' }).textContent).toContain('1.5 B52');
    expect(within(panel()).getByText(`Give budget · ${b52(f.budget)} · 3 items inside`)).toBeTruthy();
    expect(within(panel()).getByRole('list', { name: 'Collections' }).textContent).toContain(`${b52(snapshot * 250n / 10_000n - 3n * E18)} left this week`);
    const figures = required(panel().querySelector<HTMLElement>('.sh-v2-shop-figures'));
    expect(figure(figures, 'Left this week')).toMatch(/^[\d.,]+K B52$/);
    expect(wallet.signer.request).not.toHaveBeenCalled();
    expect(appCopyFraming(renderedCopy(panel()))).toEqual([]);
    expect(within(panel()).queryByRole('button', { name: /^(buy|sell|swap)/i })).toBeNull();
  });

  it('before graduation: no give or pick, the allowance waits for the opening', async () => {
    await rig({ graduated: false });
    expect(within(panel()).getByText('Gives and picks open after graduation.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Give an item' })).toBeNull();
    expect(panel().querySelector('.sh-v2-shop-week')).toBeNull();
  });
});

describe('SH-300 shop settings that do not decode', () => {
  it('through the real snapshot parser, with the wallet, cards, items and curator that show Give, Pick and Add: none of them, one line', async () => {
    // The control: the same rig with the publication's own settings shows all three.
    await rig();
    for (const name of ['Give an item', 'Pick an item', 'Add a collection']) expect(section(name)).toBeTruthy();
    cleanup();
    // Inner settings that are not a ShopConfigV2 (cut short): the spec itself still decodes and hashes.
    const good = (await publishedM2(false)).row.spec.contentsParams;
    for (const contents of ['0x1234', good.slice(0, 2 + 64 * 3)] as Hex[]) {
      const f = await rig({ contents });
      expect(f.view.spec.contentsParams).toBe(contents);
      expect(f.view.shopConfig).toBeNull();
      expect(panel().textContent).toBe('ShopShop settings unavailable');
      expect(screen.queryByRole('button', { name: /^(Give|Pick|Add)/ })).toBeNull();
      expect(screen.queryByRole('heading', { name: /^(Give an item|Pick an item|Add a collection)$/ })).toBeNull();
      cleanup();
    }
  });

  it('on the whole box page: the box\'s heading stays, the shop says "Shop settings unavailable", no Give, Pick or Add', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    try {
      // The control first: the publication's own settings show all three on the page; then the bytes that do not decode.
      for (const contents of [undefined, '0x1234'] as const) {
        const f = await rig({ contents });
        cleanup();
        render(<AppProviders><MemoryRouter><V2BoxPage record={recordV2(f.view, f.source, null, 'B52')} /></MemoryRouter></AppProviders>);
        expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(f.view.spec.tokenName);
        const shop = panel();
        if (contents === undefined) {
          for (const name of ['Give an item', 'Pick an item', 'Add a collection']) expect(within(shop).getByRole('heading', { name, level: 3 })).toBeTruthy();
          expect(shop.textContent).not.toContain('Shop settings unavailable');
        } else {
          expect(f.view.shopConfig).toBeNull();
          expect(shop.textContent).toBe('ShopShop settings unavailable');
          expect(screen.queryByRole('button', { name: /^(Give|Pick|Add)/ })).toBeNull();
          expect(screen.queryByRole('heading', { name: /^(Give an item|Pick an item|Add a collection)$/ })).toBeNull();
        }
        cleanup();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('SH-300 the starter state line', () => {
  it('loaded progress, a ready seed, no notice: a decodable add-on reads "Ready to complete"; the same state with an add-on that does not decode has no starter part', async () => {
    // A commitment of 10 items (the least the decoder takes), all 10 loaded, the seed ready, not notified.
    const ready = encodeAbiParameters(parseAbiParameters('bytes32,uint32'), [`0x${'10'.repeat(32)}`, 10]);
    const f = await rig({ starter: ready, loaded: 10 });
    expect(f.view.m2?.money?.starter).toMatchObject({ loaded: 10, notified: false });
    expect(f.view.m2?.money?.shop?.seedReady).toBe(true);
    const part = screen.getByRole('region', { name: 'Starter loading' });
    expect(within(part).getByRole('status').textContent).toBe('Ready to complete');
    cleanup();
    await rig({ starter: '0x1234', loaded: 10 });
    expect(screen.queryByRole('region', { name: 'Starter loading' })).toBeNull();
    expect(panel().textContent).not.toContain('Ready to complete');
  });
});

describe('SH-V21-FE13 give', () => {
  it('your cards as tiles with what you get; select one, one press of Give (SH-297): nothing to type, no approval button, no confirmation', async () => {
    const f = await rig({ cards: [3n, 7n, 11n] });
    const give = section('Give an item');
    expect(within(give).queryByRole('textbox')).toBeNull();
    expect(within(give).queryByRole('group', { name: 'Collection to give from' })).toBeNull();
    const yours = within(give).getByRole('list', { name: 'Your items' });
    expect(within(yours).getAllByRole('button').map((b) => [b.querySelector('.sh-v2-shop-card__name')?.textContent, b.querySelector('.sh-v2-shop-price')?.textContent]))
      .toEqual([['Test Collection #3', '1 B52'], ['Test Collection #7', '1 B52'], ['Test Collection #11', '1 B52']]);
    expect((within(give).getByRole('button', { name: 'Give' }) as HTMLButtonElement).disabled).toBe(true);
    await press(/#7,/, give);
    expect(within(give).queryByRole('button', { name: /^Approve/ })).toBeNull();
    await press('Give · 1 B52', give);
    expect(screen.queryByRole('group', { name: 'Confirm transaction' })).toBeNull();
    expect(sends.give).toHaveBeenCalledWith(f.source, f.view, f.book, A, COLLECTION, 7n, E18, expect.anything(), expect.anything());
    expect(said()).toBe('Confirmed. Reading the updated shop…');
  });

  it('a give over this week’s limit is held with its reason and the day the limit renews (SH-297 notes); a collection that takes gives later keeps its tiles, the button off, its line', async () => {
    // 2.5% of this week's budget (the read plus the 23095 given) leaves less than one more give of 1 for the collection.
    const f = await rig({ given: 23_095n * E18 });
    let give = section('Give an item');
    // The line speaks of the chosen card only: nothing before a choice.
    expect(within(give).queryByText(/limit/)).toBeNull();
    await press(/#7,/, give);
    const renews = utcDate(required(f.book.week).endsAt);
    expect(within(give).getByText(`Over this week’s limit for this collection; it renews ${renews}.`)).toBeTruthy();
    expect((within(give).getByRole('button', { name: /^Give/ }) as HTMLButtonElement).disabled).toBe(true);
    cleanup(); await rig({ activeAt: NOW + 86_400n });
    give = section('Give an item');
    expect(within(give).getAllByRole('button', { name: /#7,/ })).toHaveLength(1);
    await press(/#7,/, give);
    expect(within(give).getByText(/^Takes gives from \d{1,2} \w{3} \d{4}, \d\d:\d\d UTC\.$/)).toBeTruthy();
    expect((within(give).getByRole('button', { name: /^Give/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('SH-297 notes: before a choice no line speaks of another card; a tile whose collection takes gives later carries its day (harm: a date read for the wrong card)', async () => {
    // The wallet's first card is of a collection that takes gives only tomorrow; its card 7 of the open collection can go now.
    await rig({ later: NOW + 86_400n });
    const give = section('Give an item');
    expect(within(give).queryByText(/^Takes gives from/)).toBeNull();
    const tiles = within(give).getByRole('list', { name: 'Your items' });
    const day = dayOf(NOW + 86_400n);
    expect(within(tiles).getByRole('button', { name: /#5,/ }).querySelector('.sh-v2-shop-card__later')?.textContent).toBe(`from ${day}`);
    expect(within(tiles).getByRole('button', { name: /#5,/ }).getAttribute('aria-label')).toMatch(/, takes gives from \d{1,2} \w{3} \d{4}, \d\d:\d\d UTC$/);
    expect(within(tiles).getByRole('button', { name: /#7,/ }).querySelector('.sh-v2-shop-card__later')).toBeNull();
    // The open collection's card: no line, the button on.
    await press(/#7,/, give);
    expect(within(give).queryByText(/^Takes gives from/)).toBeNull();
    expect((within(give).getByRole('button', { name: 'Give · 1 B52' }) as HTMLButtonElement).disabled).toBe(false);
    // The later one's card: its own line, the button off.
    await press(/#5,/, give);
    expect(within(give).getByText(`Takes gives from ${utcDate(NOW + 86_400n)}.`)).toBeTruthy();
    expect((within(give).getByRole('button', { name: /^Give/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('SH-297 notes: cards counted but not listed are said without a reason, the Give group kept even with none listed (harm: no Give group, no sentence; a reason untrue for a card that left since)', async () => {
    await rig({ cards: [], unfound: 2n });
    const give = section('Give an item');
    expect(within(give).getByText('2 more of your items could not be listed here.')).toBeTruthy();
    expect((within(give).getByRole('button', { name: 'Give' }) as HTMLButtonElement).disabled).toBe(true);
    expect(unfoundLine(1n)).toBe('1 more of your items could not be listed here.');
  });

  it('SH-297 notes: each weekly limit line names the day it renews; other lines unchanged', () => {
    const end = 1_800_000_000n;
    expect(limitLine('weekly', end)).toBe(`Over this week’s limit for the shop; it renews ${utcDate(end)}.`);
    expect(limitLine('collection', end)).toBe(`Over this week’s limit for this collection; it renews ${utcDate(end)}.`);
    expect(limitLine('weekly', null)).toBe('Over this week’s limit for the shop.');
    expect(limitLine('budget', end)).toBe('The budget is short of this give.');
    expect(dayOf(end)).toBe('15 Jan');
    // SH-300 merge: within a day the tile says the time (the second release's shop waits ten minutes).
    expect(startMark(end, end - 86_400n)).toBe('from 15 Jan');
    expect(startMark(end, end - 600n)).toBe('from 08:00 UTC');
  });

  it('no cards of the shop in this wallet: no Give group and no sentence; a read that failed: its line and Retry, never "no cards"', async () => {
    await rig({ cards: [] });
    expect(screen.queryByRole('heading', { name: 'Give an item' })).toBeNull();
    cleanup(); const f = await rig();
    const retry = vi.fn();
    reads.cards = { status: 'failed', retry }; f.rerender();
    const give = section('Give an item');
    expect(within(give).getByText('Items unavailable.')).toBeTruthy();
    await press('Retry', give);
    expect(retry).toHaveBeenCalled();
  });

  it('a refusal before the wallet reads as one plain line', async () => {
    await rig();
    sends.give.mockRejectedValue(new NotSendableError('give must name a listed collection'));
    await press(/#7,/, section('Give an item'));
    await press('Give · 1 B52', section('Give an item'));
    expect(said()).toBe('Not sent. Nothing reached your wallet.');
  });

  it('without a wallet: no cards are read, so no Give group; Pick opens the wallet dialog, nothing else asks it', async () => {
    await rig({ account: null });
    expect(screen.queryByRole('heading', { name: 'Give an item' })).toBeNull();
    await press(/#2,/, section('Pick an item'));
    await press('Pick · 1.5 B52', section('Pick an item'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(sends.pick).not.toHaveBeenCalled();
  });
});

describe('SH-V21-FE13 pick', () => {
  it('choose an item inside, see its pick price, then one press of Pick (SH-297): no approval button, no confirmation', async () => {
    const f = await rig();
    reads.coins = { balance: 10n * E18, allowance: 0n }; f.rerender();
    const pick = section('Pick an item');
    const items = within(pick).getByRole('list', { name: 'Items inside' });
    expect(within(items).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([1, 2, 3].map((id) => `${LABEL} #${id}, 1.5 B52`));
    await press(/#2,/, pick);
    expect(within(pick).queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect((within(pick).getByRole('button', { name: 'Pick · 1.5 B52' }) as HTMLButtonElement).disabled).toBe(false);
    await press('Pick · 1.5 B52', pick);
    expect(screen.queryByRole('group', { name: 'Confirm transaction' })).toBeNull();
    expect(sends.pick).toHaveBeenCalledWith(f.source, f.view, f.book, A, { collection: COLLECTION, id: 2n }, 3n * E18 / 2n, expect.anything(), expect.anything());
    expect(said()).toBe('Confirmed. Reading the updated shop…');
  });

  it('while the press runs: the buy and sell box\'s words on the button, two ticks under it; a refusal after the approval says why, and Pick is pressable again', async () => {
    await rig();
    let release: () => void = () => undefined;
    sends.pick.mockImplementation(async (...args: unknown[]) => {
      const hooks = args[7] as { phase: (p: string) => void; progress: (p: unknown) => void };
      hooks.progress({ approve: 'active', act: 'waiting' }); hooks.phase('confirm');
      await new Promise<void>((resolve) => { release = resolve; });
      hooks.phase('mining');
      hooks.progress({ approve: 'done', act: 'active' }); hooks.phase('approval');
      hooks.progress({ approve: 'done', act: 'stopped' });
      throw new Error('The pick price changed. Refresh and try again.');
    });
    const pick = section('Pick an item');
    await press(/#2,/, pick);
    await act(async () => { fireEvent.click(within(pick).getByRole('button', { name: 'Pick · 1.5 B52' })); });
    expect(within(section('Pick an item')).getByRole('button', { name: 'Confirm in your wallet…' })).toBeTruthy();
    expect(within(section('Pick an item')).getByRole('list', { name: 'Progress' }).textContent).toBe('•Approve, under wayPick, next');
    await act(async () => { release(); });
    expect(said()).toBe('The pick price changed. Refresh and try again.');
    expect(within(section('Pick an item')).getByRole('list', { name: 'Progress' }).textContent).toBe('✓Approve, done✕Pick, stopped');
    expect((within(section('Pick an item')).getByRole('button', { name: 'Pick · 1.5 B52' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('the last item stays', async () => {
    await rig({ items: 1, inside: 1n });
    expect(within(panel()).getByText(/^Give budget · .* · 1 item inside$/)).toBeTruthy();
    const pick = section('Pick an item');
    expect(within(pick).getByText('The last item stays.')).toBeTruthy();
    expect((within(pick).getByRole('button', { name: 'Pick' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('SH-V21-FE13 the curator adds a collection', () => {
  it('only the curator sees it; a typed ERC-721 at a tier, and when it starts taking gives', async () => {
    const f = await rig();
    const add = section('Add a collection');
    fireEvent.change(within(add).getByRole('textbox', { name: 'Collection address' }), { target: { value: OTHER } });
    await press('Tier 2 · 2 B52', add);
    expect(within(add).getByText(/^Takes gives from about \d{1,2} \w{3} \d{4}, \d\d:\d\d UTC, 7 days after it is added\.$/)).toBeTruthy();
    await screen.findByRole('button', { name: 'Add collection' });
    await vi.waitFor(() => expect((within(add).getByRole('button', { name: 'Add collection' }) as HTMLButtonElement).disabled).toBe(false));
    await press('Add collection', add);
    expect(confirmGroup().textContent).toMatch(/^Add 0x0000…00c3 at tier 2\? It takes gives 7 days after it is added\./i);
    await press('Confirm', confirmGroup());
    expect(sends.add).toHaveBeenCalledWith(f.source, f.view, f.book, A, OTHER, 1, expect.anything());
  });

  it('a listed collection is named; another wallet sees no addition', async () => {
    await rig();
    fireEvent.change(within(section('Add a collection')).getByRole('textbox', { name: 'Collection address' }), { target: { value: COLLECTION } });
    expect(within(section('Add a collection')).getByText('This collection is listed already.')).toBeTruthy();
    cleanup(); await rig({ account: B });
    expect(screen.queryByRole('heading', { name: 'Add a collection' })).toBeNull();
  });
});

describe('SH-V21-FE13 without the book', () => {
  it('a graduated shop whose book did not read: no give or pick, its one line, and the curator can still add', async () => {
    const f = await rig();
    reads.book = null; f.rerender();
    expect(within(panel()).queryByText('Gives and picks open after graduation.')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Give an item' })).toBeNull();
    const add = section('Add a collection');
    fireEvent.change(within(add).getByRole('textbox', { name: 'Collection address' }), { target: { value: OTHER } });
    await vi.waitFor(() => expect((within(add).getByRole('button', { name: 'Add collection' }) as HTMLButtonElement).disabled).toBe(false));
    await press('Add collection', add); await press('Confirm', confirmGroup());
    expect(sends.add).toHaveBeenCalledWith(f.source, f.view, null, A, OTHER, 0, expect.anything());
  });
});

describe('SH-283 the items as cards', () => {
  it('the pick list is a grid of cards: picture, short name, price; the label and the pressed state as before', async () => {
    pictures.calls.length = 0;
    await rig();
    const pick = section('Pick an item');
    const items = within(pick).getByRole('list', { name: 'Items inside' });
    expect(items.classList.contains('sh-v2-shop-cards')).toBe(true);
    const cards = within(items).getAllByRole('button');
    // One collection: its whole name; the address stays in the button's name and its title.
    expect(cards.map((b) => [b.querySelector('.sh-v2-shop-card__name')?.textContent, b.querySelector('.sh-v2-shop-price')?.textContent])).toEqual([1, 2, 3].map((id) => [`Test Collection #${id}`, '1.5 B52']));
    expect(cards.map((b) => b.getAttribute('title'))).toEqual([1, 2, 3].map((id) => `${LABEL} #${id}`));
    // Item 2's picture is read and shown; the others keep the empty tile, no broken picture, and still work.
    expect(cards.map((b) => b.querySelector('.sh-v2-shop-card__art')?.getAttribute('data-picture'))).toEqual(['none', 'shown', 'none']);
    expect(required(cards[1]).querySelector('img')?.getAttribute('src')).toBe('blob:item-2');
    expect(required(cards[1]).querySelector('img')?.getAttribute('alt')).toBe('');
    expect(cards[0]?.querySelector('img')).toBeNull();
    expect(pictures.calls.filter((c) => c.reads !== null).map((c) => c.id)).toEqual(expect.arrayContaining([1n, 2n, 3n]));
    await press(/#1,/, pick);
    expect(within(items).getAllByRole('button').map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(within(pick).getByRole('button', { name: 'Pick · 1.5 B52' })).toBeTruthy();
    expect(wallet.signer.request).not.toHaveBeenCalled();
  });

  it('a card asks for its picture only once it comes near the window', async () => {
    const seen: ((entries: { isIntersecting: boolean }[]) => void)[] = [];
    vi.stubGlobal('IntersectionObserver', class { constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { seen.push(callback); } observe() {} disconnect() {} });
    try {
      pictures.calls.length = 0;
      await rig();
      expect(pictures.calls.length).toBeGreaterThan(0);
      expect(pictures.calls.every((c) => c.reads === null)).toBe(true);
      await act(async () => { required(seen[0])([{ isIntersecting: true }]); });
      expect(pictures.calls.some((c) => c.reads !== null)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it('amounts as the site prints token amounts: thousands grouped, every digit', () => {
    expect(shopAmountV2(2_000_000n * E18, 'CARD')).toBe('2,000,000 CARD');
    expect(shopAmountV2(1_234n * E18 + 1n, 'CARD')).toBe('1,234.000000000000000001 CARD');
    expect(shopAmountV2(1_500_000n, 'tUSDC', 6)).toBe('1.5 tUSDC');
    expect(shopAmountV2(0n, 'CARD')).toBe('0 CARD');
  });

  it('short names: the words all listed names share leave; one name or the same names stay whole; no name: the short address', () => {
    const a = '0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174'; const b = '0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577'; const c = '0x26C4f9298F88f203c7BC84e4eE3d9eA45680B143';
    expect([...shortNamesV2([{ address: a, name: 'Test Trading Cards Common' }, { address: b, name: 'Test Trading Cards Uncommon' }, { address: c, name: null }]).values()]).toEqual(['Common', 'Uncommon', '0x26C4…B143']);
    expect([...shortNamesV2([{ address: a, name: 'Test Trading Cards Common' }]).values()]).toEqual(['Test Trading Cards Common']);
    expect([...shortNamesV2([{ address: a, name: 'Cards' }, { address: b, name: 'Cards' }]).values()]).toEqual(['Cards', 'Cards']);
    // A name that is all shared words keeps its last word.
    expect([...shortNamesV2([{ address: a, name: 'Test Cards' }, { address: b, name: 'Test Cards Rare' }]).values()]).toEqual(['Cards', 'Cards Rare']);
  });
});

describe('SH-297 the press words are the buy and sell box\'s', () => {
  it('the same strings as trade-words.ts and TradeBox.tsx, read as text (copied, never imported: that folder stays out of the main site\'s build, no-trade-source.test.ts)', async () => {
    const { PRESS_WORDS } = await import('./ShopActionsV2');
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const read = (name: string) => readFileSync([`src/features/trade-sepolia/${name}`, `apps/web/src/features/trade-sepolia/${name}`].map((path) => resolve(process.cwd(), path)).find((path) => existsSync(path)) as string, 'utf8');
    const words = read('trade-words.ts');
    expect(words).toContain(`(inPage ? '${PRESS_WORDS.confirm(true)}' : '${PRESS_WORDS.confirm(false)}')`);
    expect(words).toContain(`STEP_WORDS = Object.freeze({ approve: '${PRESS_WORDS.approve}'`);
    expect(words).toContain(`STEPS_LABEL = '${PRESS_WORDS.steps}'`);
    const states = PRESS_WORDS.states;
    expect(words).toContain(`STEP_STATES = Object.freeze({ waiting: '${states.waiting}', active: '${states.active}', done: '${states.done}', stopped: '${states.stopped}' })`);
    // Its own phase, its own words: reading the mined approval back (the trade box re-checks a price instead).
    expect(PRESS_WORDS.approval).toBe('Checking the approval…');
    expect(words).not.toContain(`'${PRESS_WORDS.approval}'`);
    expect(read('TradeBox.tsx')).toContain(`label = '${PRESS_WORDS.mining}'`);
  });
});

describe('SH-300 a shop whose new collections wait ten minutes (the second release\'s)', () => {
  it('every line that named days reads right for minutes; the date stays as it is', async () => {
    await rig({ listDelay: 600, activeAt: NOW + 300n });
    expect(panel().textContent).toContain('10 minutes before a new entry accepts gives.');
    // A collection still waiting: its give line names the time (as for days); the list's countdown is timeLeftWords's.
    // SH-297 notes: the give line speaks of the chosen card, so the card is chosen first; before, its tile says the time.
    const give = section('Give an item');
    expect(within(give).getByRole('button', { name: /#7,/ }).querySelector('.sh-v2-shop-card__later')?.textContent).toMatch(/^from \d\d:\d\d UTC$/);
    await press(/#7,/, give);
    expect(panel().textContent).toMatch(/Takes gives from \d{1,2} \w{3} \d{4}, \d\d:\d\d UTC\./);
    expect(panel().textContent).not.toMatch(/0\.00\d+ days|1 days/);
    const add = section('Add a collection');
    fireEvent.change(within(add).getByRole('textbox', { name: 'Collection address' }), { target: { value: OTHER } });
    await press('Tier 2 · 2 B52', add);
    expect(within(add).getByText(/^Takes gives from about \d{1,2} \w{3} \d{4}, \d\d:\d\d UTC, 10 minutes after it is added\.$/)).toBeTruthy();
    await vi.waitFor(() => expect((within(add).getByRole('button', { name: 'Add collection' }) as HTMLButtonElement).disabled).toBe(false));
    await press('Add collection', add);
    expect(confirmGroup().textContent).toMatch(/^Add 0x0000…00c3 at tier 2\? It takes gives 10 minutes after it is added\./i);
  });
  it('the first release\'s shop reads as before: days', async () => {
    await rig({ activeAt: NOW + 3n * 86_400n - 10n });
    expect(panel().textContent).toContain('7 days before a new entry accepts gives.');
  });
});
