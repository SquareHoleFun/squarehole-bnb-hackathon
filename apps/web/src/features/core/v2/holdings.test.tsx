/**
 * SH-291: My Box for v2 boxes (holdings.ts, HoldingsV2.tsx). The reads with a scripted reader: nothing held, tokens only
 * (with their worth at the box's last price), items (a box's own and a shop's cards), a failing read; and what the page
 * says in each state, including a claim waiting that leads to the box page's own claim and never "nothing" for a read
 * that failed.
 */
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ContractFunctionRevertedError, encodeFunctionResult, type Address } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../../app-providers';
import type { BoxRecord } from '../../boxes/box-model';
import type { BoxClaimsV2 } from './claim-reads';
import { holdsNothingV2, readHoldingsV2, valueInPV2, type HoldingsRead, type HoldingsV2 } from './holdings';
import { CARDS_MAX, LOOKBACK, type CardReaderV2 } from './card-reads';
import { CLAIMS_PLACE, HOLDINGS_WORDS, HoldingsViewV2, coinAmountV2, coinWorthV2, holdingsBoxesOf, holdingsCountsV2, useHoldingsV2, waitingOf, type HoldingsStateV2 } from './HoldingsV2';
import { parseSnapshotV2, type V2Snapshot } from './indexer-v2';
import { recordV2 } from './record-v2';
import { ERC721_ABI } from './shop-actions';
import { publishedM2 } from './test-support/m2-published';
import { COLLECTION } from '../../../../../../packages/indexer/src/core/v2/m2-fixture.test-support';
import { publishedItems } from './test-support/m3-published';

const ME = '0x00000000000000000000000000000000000000a1' as Address;
const OTHER = '0x00000000000000000000000000000000000000b2' as Address;
const ITEMS_TOKEN = '0x0000000000000000000000000000000000001001' as Address;
const SHOP_TOKEN = '0x0000000000000000000000000000000000001002' as Address;
const E18 = 10n ** 18n;

// No chain: any read a test does not script fails at once.
beforeEach(() => { vi.stubGlobal('fetch', async () => { throw new Error('offline'); }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** An items box whose index places items 1 and 2 with ME and OTHER, and a shop box listing one card collection. */
async function boxes(): Promise<{ items: BoxRecord; shop: BoxRecord; collection: Address; itemsCollection: Address }> {
  const i = await publishedItems();
  (i.body.m3 as { items: Record<string, unknown> }).items.owners = { '1': ME, '2': OTHER };
  const iv = parseSnapshotV2(i.body, i.source);
  const itemsView: V2Snapshot = { ...iv, token: ITEMS_TOKEN, statistics: { ...(iv.statistics ?? {}), pricePPerTX18: 2n * E18 } as V2Snapshot['statistics'] };
  const s = await publishedM2(false);
  const shopView: V2Snapshot = { ...parseSnapshotV2(s.body, s.source), token: SHOP_TOKEN };
  const roles = (await import('./vault-items')).vaultRolesOf(itemsView);
  return { items: recordV2(itemsView, i.source), shop: recordV2(shopView, s.source), collection: COLLECTION as Address, itemsCollection: roles?.collection as Address };
}

/** A reader that answers from a table `address:function:args`; anything else fails as a request would. */
function scripted(answers: Record<string, unknown | Error>): { read: HoldingsRead; calls: string[] } {
  const calls: string[] = [];
  const read: HoldingsRead = async (address, _abi, fn, args = []) => {
    const key = `${address.toLowerCase()}:${fn}:${args.map(String).join(',').toLowerCase()}`;
    calls.push(key);
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new Error(`no answer for ${key}`);
    return answer;
  };
  return { read, calls };
}
const reverted = () => new ContractFunctionRevertedError({ abi: ERC721_ABI, functionName: 'ownerOf', message: 'nonexistent token' });
const k = (address: string, fn: string, ...args: unknown[]) => `${address.toLowerCase()}:${fn}:${args.map(String).join(',').toLowerCase()}`;
/** The card read (card-reads.ts): the transfers to ME (or a failure), each query recorded; owners through `read`. */
function picks(answer: readonly { collection: Address; id: bigint }[] | Error, read: HoldingsRead, asked: string[] = [], count: bigint | null = null): CardReaderV2 {
  return {
    transfersTo: async (collections, to, from, until) => { asked.push(`${collections.map((c) => c.toLowerCase()).join(',')}:${to.toLowerCase()}:${from}-${until}`); if (answer instanceof Error) throw answer; return answer; },
    ownerOf: async (collection, id) => read(collection, [] as never, 'ownerOf', [id]) as Promise<Address>,
    // No count unless a test gives one (then only the window is read, as before SH-297 notes); no listing by index.
    balanceOf: async () => count,
    ownedByIndex: async () => null,
  };
}

describe('SH-291 holdings reads', () => {
  it('nothing held: every read answers and none finds anything; one round per kind of read, no read per item of another wallet', async () => {
    const b = await boxes();
    const { read, calls } = scripted({
      [k(ITEMS_TOKEN, 'balanceOf', ME)]: 0n, [k(SHOP_TOKEN, 'balanceOf', ME)]: 0n,
      [k(b.itemsCollection, 'ownerOf', 1n)]: OTHER,
    });
    const asked: string[] = [];
    const h = await readHoldingsV2(holdingsBoxesOf([b.items, b.shop]), ME, () => read, () => picks([], read, asked));
    expect(h).toEqual({ tokens: [], items: [], failed: 0, more: false });
    // The shop's listed collections are asked once for transfers to this wallet, from LOOKBACK before the shop's creation.
    const created = b.shop.v2Chain?.snapshot?.record.creationBlock ?? 0n;
    expect(asked).toEqual([`${b.collection.toLowerCase()}:${ME}:${created > LOOKBACK ? created - LOOKBACK : 0n}-${b.shop.v2Chain?.snapshot?.block}`]);
    expect(holdsNothingV2(h)).toBe(true);
    // Item 2 is OTHER's in the index: never read for ME.
    expect(calls).not.toContain(k(b.itemsCollection, 'ownerOf', 2n));
    expect(calls).toHaveLength(3);
  });

  it('tokens only: each balance with its worth at the box\'s last price (balance × price / 10^36), none where no price is shown', async () => {
    const b = await boxes();
    const { read } = scripted({
      [k(ITEMS_TOKEN, 'balanceOf', ME)]: 1_234_567_890_123_456_789_012n, [k(SHOP_TOKEN, 'balanceOf', ME)]: 5n * E18,
      [k(b.itemsCollection, 'ownerOf', 1n)]: OTHER,
    });
    const h = await readHoldingsV2(holdingsBoxesOf([b.items, b.shop]), ME, () => read, () => picks([], read));
    expect(h.tokens.map((t) => [t.record.token, t.balanceT, t.valueP])).toEqual([
      [ITEMS_TOKEN, 1_234_567_890_123_456_789_012n, 2_469_135_780_246_913_578_024n / E18],
      [SHOP_TOKEN, 5n * E18, valueInPV2(b.shop.v2Chain?.snapshot as V2Snapshot, 5n * E18)],
    ]);
    expect(h.items).toEqual([]);
    const view = b.items.v2Chain?.snapshot as V2Snapshot;
    expect(valueInPV2({ ...view, audited: true, verified: false }, E18)).toBeNull();
    expect(valueInPV2({ ...view, statistics: null }, E18)).toBeNull();
  });

  it('items: the box\'s own item the index places here and the cards that reached this wallet (picked, minted or sent), each checked on chain now', async () => {
    const b = await boxes();
    const { read, calls } = scripted({
      [k(ITEMS_TOKEN, 'balanceOf', ME)]: 0n, [k(SHOP_TOKEN, 'balanceOf', ME)]: 0n,
      [k(b.itemsCollection, 'ownerOf', 1n)]: ME, [k(b.collection, 'ownerOf', 5n)]: ME, [k(b.collection, 'ownerOf', 6n)]: OTHER,
    });
    const picked = [{ collection: b.collection, id: 5n }, { collection: b.collection, id: 6n }, { collection: b.collection, id: 5n }];
    const h = await readHoldingsV2(holdingsBoxesOf([b.items, b.shop]), ME, () => read, () => picks(picked, read));
    expect(h.items.map((i) => [i.kind, i.collection, i.id])).toEqual([['item', b.itemsCollection, 1n], ['card', b.collection, 5n]]);
    // Card 5 came to this wallet twice: read once. Card 6 went on to another wallet: not shown.
    expect(calls.filter((c) => c === k(b.collection, 'ownerOf', 5n))).toHaveLength(1);
    expect(h).toMatchObject({ failed: 0, more: false });
    // SH-297 notes: a card held (by balanceOf) that the read did not reach is said as "more than shown", never dropped.
    const older = await readHoldingsV2(holdingsBoxesOf([b.items, b.shop]), ME, () => read, () => picks(picked, read, [], 2n));
    expect(older.items.map((i) => [i.kind, i.id])).toEqual([['item', 1n], ['card', 5n]]);
    expect(older.more).toBe(true);
    const many = Array.from({ length: CARDS_MAX + 2 }, (_, i) => ({ collection: b.collection, id: 1000n + BigInt(i) }));
    const all: Record<string, unknown> = { [k(ITEMS_TOKEN, 'balanceOf', ME)]: 0n, [k(SHOP_TOKEN, 'balanceOf', ME)]: 0n, [k(b.itemsCollection, 'ownerOf', 1n)]: OTHER };
    for (const c of many) all[k(c.collection, 'ownerOf', c.id)] = ME;
    const scriptedAll = scripted(all).read;
    const capped = await readHoldingsV2(holdingsBoxesOf([b.items, b.shop]), ME, () => scriptedAll, () => picks(many, scriptedAll));
    expect(capped.items).toHaveLength(CARDS_MAX);
    expect(capped.more).toBe(true);
  });

  it('a failing read is counted, never taken for "none"; a revert (a burned item, a collection that lists no ids) is an answer', async () => {
    const b = await boxes();
    const { read } = scripted({
      [k(ITEMS_TOKEN, 'balanceOf', ME)]: new Error('HTTP 429'), [k(SHOP_TOKEN, 'balanceOf', ME)]: 0n,
      [k(b.itemsCollection, 'ownerOf', 1n)]: reverted(), [k(b.collection, 'ownerOf', 5n)]: reverted(),
    });
    const h = await readHoldingsV2(holdingsBoxesOf([b.items, b.shop]), ME, () => read, () => picks([{ collection: b.collection, id: 5n }], read));
    expect(h.failed).toBe(1);
    expect(h.tokens).toEqual([]);
    expect(h.items).toEqual([]);
    expect(holdsNothingV2(h)).toBe(false);
    // The cards' transfers not read: the cards are unknown.
    const { read: zero } = scripted({ [k(ITEMS_TOKEN, 'balanceOf', ME)]: 0n, [k(SHOP_TOKEN, 'balanceOf', ME)]: 0n, [k(b.itemsCollection, 'ownerOf', 1n)]: OTHER });
    const noPicks = await readHoldingsV2(holdingsBoxesOf([b.items, b.shop]), ME, () => zero, () => picks(new Error('HTTP 503'), zero));
    expect(noPicks.failed).toBe(1);
    expect(holdsNothingV2(noPicks)).toBe(false);
  });
});

const ready = (value: HoldingsV2): HoldingsStateV2 => ({ status: 'ready', value, retry: () => undefined });
const NONE: HoldingsV2 = { tokens: [], items: [], failed: 0, more: false };
const view = (props: Parameters<typeof HoldingsViewV2>[0]) => render(<AppProviders><MemoryRouter><HoldingsViewV2 {...props} /></MemoryRouter></AppProviders>);

describe('SH-291 My Box words', () => {
  it('nothing held and nothing to claim: one line and the way to the boxes', () => {
    view({ state: ready(NONE), claims: [], claimsKnown: true });
    expect(screen.getByText(HOLDINGS_WORDS.nothing)).toBeTruthy();
    expect(screen.getByRole('link', { name: HOLDINGS_WORDS.boxes }).getAttribute('href')).toBe('/');
    expect(holdingsCountsV2(ready(NONE))).toEqual({ boxes: 0, items: 0 });
  });

  it('a read that failed is never "nothing": the whole read, a part of it, or claims still unknown', () => {
    const retry = vi.fn();
    view({ state: { status: 'failed', retry }, claims: [], claimsKnown: true });
    expect(screen.queryByText(HOLDINGS_WORDS.nothing)).toBeNull();
    expect(screen.getByText(HOLDINGS_WORDS.unread)).toBeTruthy();
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(retry).toHaveBeenCalled();
    cleanup();
    view({ state: ready({ ...NONE, failed: 2 }), claims: [], claimsKnown: true });
    expect(screen.queryByText(HOLDINGS_WORDS.nothing)).toBeNull();
    expect(screen.getByText(HOLDINGS_WORDS.partly)).toBeTruthy();
    expect(holdingsCountsV2(ready({ ...NONE, failed: 2 }))).toBeNull();
    cleanup();
    view({ state: ready(NONE), claims: [], claimsKnown: false });
    expect(screen.queryByText(HOLDINGS_WORDS.nothing)).toBeNull();
    cleanup();
    view({ state: { status: 'reading' }, claims: null, claimsKnown: false });
    expect(screen.getByText(HOLDINGS_WORDS.reading)).toBeTruthy();
  });

  it('tokens: short and cut as the Boxes list prints them ("5.82M VRAM", "≈ 0.00434 tNVDA"), each a link to the box', async () => {
    // SH-297 notes: cut at the boundary, never rounded up (a "22M" beside a 22M card would be untrue at 21.99…M).
    const M = 10n ** 24n; const K = 10n ** 21n;
    expect(coinAmountV2(22n * M - 1n, 'CARD')).toBe('21.99M CARD');
    expect(coinAmountV2(21_960n * K, 'CARD')).toBe('21.96M CARD');
    expect(coinAmountV2(22n * M, 'CARD')).toBe('22M CARD');
    expect(coinAmountV2(1_000n * K - 1n, 'CARD')).toBe('999.99K CARD');
    expect(coinAmountV2(5_823_732_461_181_912_089_638_885n, 'VRAM')).toBe('5.82M VRAM');
    expect(coinAmountV2(1_999_999_999_999_999_999_999n, 'VRAM')).toBe('1.99K VRAM');
    expect(coinWorthV2(4_340_397_015_130_480n, 'tNVDA', 18)).toBe('0.00434 tNVDA');
    expect(coinWorthV2(9_794n, 'tUSDC', 6)).toBe('0.009794 tUSDC');
    expect(coinWorthV2(12_345_678n, 'tUSDC', 6)).toBe('12.34 tUSDC');
    const b = await boxes();
    const v = b.items.v2Chain?.snapshot as V2Snapshot;
    view({ state: ready({ ...NONE, tokens: [{ record: b.items, view: v, balanceT: 5_823_732_461_181_912_089_638_885n, valueP: 4_340_397_015_130_480n }] }), claims: [], claimsKnown: true });
    const link = screen.getByRole('link', { name: new RegExp(b.items.name) });
    expect(link.getAttribute('href')).toBe(`/box/${b.items.chainId}/${ITEMS_TOKEN}`);
    expect(link.textContent).toContain(`5.82M ${b.items.ticker}`);
    expect(link.textContent).toContain(`≈ 0.00434 ${b.items.pairAsset}`);
    expect(link.textContent).not.toContain('5,823,732');
    expect(screen.queryByText(HOLDINGS_WORDS.nothing)).toBeNull();
  });

  it('items: a shop\'s card as the shop\'s pick grid shows it ("Common #3"), a box\'s own item "#<id>" under the box\'s picture', async () => {
    const b = await boxes();
    const RARE = '0x00000000000000000000000000000000000c0002' as Address;
    const names: Record<string, string> = { [b.collection.toLowerCase()]: 'Test Trading Cards Common', [RARE.toLowerCase()]: 'Test Trading Cards Rare' };
    const chainId = b.shop.chainId;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? 'null')) as { id: number; method: string; params: [{ to: string }] } | { id: number; method: string; params: [{ to: string }] }[];
      const one = (r: { id: number; method: string; params: [{ to: string }] }) => ({ jsonrpc: '2.0', id: r.id,
        ...(r.method === 'eth_chainId' ? { result: `0x${chainId.toString(16)}` } : names[r.params[0]?.to?.toLowerCase()]
          ? { result: encodeFunctionResult({ abi: ERC721_ABI, functionName: 'name', result: names[r.params[0].to.toLowerCase()] as string }) }
          : { error: { code: -32000, message: 'no' } }) });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { headers: { 'content-type': 'application/json' } });
    });
    const source = b.shop.v2Chain?.source as NonNullable<NonNullable<BoxRecord['v2Chain']>['source']>;
    const items = [
      { record: b.shop, source, collection: b.collection, id: 3n, kind: 'card' as const },
      { record: b.shop, source, collection: RARE, id: 4n, kind: 'card' as const },
      { record: b.items, source: b.items.v2Chain?.source as typeof source, collection: b.itemsCollection, id: 1n, kind: 'item' as const },
    ];
    view({ state: ready({ ...NONE, items }), claims: [], claimsKnown: true });
    await waitFor(() => expect(screen.getByText('Common #3')).toBeTruthy());
    expect(screen.getByText('Rare #4')).toBeTruthy();
    const card = screen.getByRole('link', { name: /Common · 0x/ });
    expect(card.className).toBe('sh-v2-shop-card');
    expect(card.getAttribute('href')).toBe(`/box/${b.shop.chainId}/${SHOP_TOKEN}`);
    expect(card.querySelector('.sh-v2-shop-card__art')).toBeTruthy();
    const own = screen.getByRole('link', { name: `${b.items.name} #1` });
    expect(own.textContent).toBe('#1');
    expect(own.querySelector('.sh-box-cover')).toBeTruthy();
  });

  it('a claim waiting: its amount, leading to the box page\'s own claim (no second claim path)', async () => {
    const b = await boxes();
    const v = b.shop.v2Chain?.snapshot as V2Snapshot;
    const claim = { box: { key: b.shop.id, view: v, source: b.shop.v2Chain?.source, name: b.shop.name, symbol: 'tUSDC', ticker: b.shop.ticker, disabled: false, via: 'index' },
      steps: [{ kind: 'holder', batch: 1n, amount: 1_500_000n }, { kind: 'holder', batch: 2n, amount: 3n * E18, inT: true }], claimed: [], known: true, reading: false, failed: false, via: 'index' } as unknown as BoxClaimsV2;
    expect(waitingOf(claim)).toEqual({ p: 1_500_000n, t: 3n * E18, count: 2 });
    view({ state: ready(NONE), claims: [claim], claimsKnown: true });
    const link = screen.getByRole('link', { name: /Claim on/ });
    expect(link.getAttribute('href')).toBe(`/box/${b.shop.chainId}/${SHOP_TOKEN}#${CLAIMS_PLACE}`);
    expect(link.textContent).toContain(`1.5 tUSDC + 3 ${b.shop.ticker}`);
    expect(screen.queryByText(HOLDINGS_WORDS.nothing)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('SH-291 the holdings hook', () => {
  it('a new feed block reads nothing again, and the rows show the page\'s records as they are now (a symbol read later)', async () => {
    const b = await boxes();
    const { read, calls } = scripted({ [k(ITEMS_TOKEN, 'balanceOf', ME)]: 7n * E18, [k(SHOP_TOKEN, 'balanceOf', ME)]: 0n, [k(b.itemsCollection, 'ownerOf', 1n)]: OTHER });
    const answered = { loading: false, answered: true, error: null };
    const wrapper = ({ children }: { children: React.ReactNode }) => <AppProviders>{children}</AppProviders>;
    const { result, rerender } = renderHook(({ records }) => useHoldingsV2(records, ME, answered, undefined, () => read, () => picks([], read)), { wrapper, initialProps: { records: [b.items, b.shop] } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const asked = calls.length;
    const later = (r: BoxRecord): BoxRecord => ({ ...r, pairAsset: 'tNVDA', v2Chain: { ...r.v2Chain, source: r.v2Chain?.source ?? null, snapshot: { ...(r.v2Chain?.snapshot as V2Snapshot), block: 999n } } });
    rerender({ records: [later(b.items), later(b.shop)] });
    await waitFor(() => expect(result.current.status === 'ready' && result.current.value.tokens[0]?.record.pairAsset).toBe('tNVDA'));
    expect(calls).toHaveLength(asked);
  });

  it('no v2 box: "nothing" only once the feed answered; a feed that failed is a failure, never nothing', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => <AppProviders>{children}</AppProviders>;
    const never = () => { throw new Error('no read without a box'); };
    const failed = renderHook(() => useHoldingsV2([], ME, { loading: false, answered: false, error: 'down' }, undefined, never, never), { wrapper });
    expect(failed.result.current.status).toBe('failed');
    const loading = renderHook(() => useHoldingsV2([], ME, { loading: true, answered: false, error: null }, undefined, never, never), { wrapper });
    expect(loading.result.current.status).toBe('reading');
    const answered = renderHook(() => useHoldingsV2([], ME, { loading: false, answered: true, error: null }, undefined, never, never), { wrapper });
    expect(answered.result.current.status === 'ready' && holdsNothingV2(answered.result.current.value)).toBe(true);
  });
});
