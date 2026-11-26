import { required } from './test-support/required';
import { describe, expect, it, vi } from 'vitest';
import { publishedV2 } from './test-support/published-v2';
import { claimPriceV2, feedKeyV2, feedReadsStarted, loadFeedV2, parseSnapshotV2, pictureCopiesOf, raw, readFeedV2, sourceV2 } from './indexer-v2';
import { recordV2 } from './record-v2';
import { loadListingsV2 } from '../../create/v2/indexer-listings';
import { loadBurnLogV2 } from './BurnLogV2';
import { gpuPoorLifeV2, recordedLifeV2, sepoliaLifeSourceV2 } from './test-support/life-v2';

describe('CQ11-E4 consumes E3 publication', () => {
  it('accepts an unaudited snapshot as readable and unverified, with exact claim price and creator money', async () => {
    const { body, source, feed } = await publishedV2();
    expect(body.verified).toBeNull();
    const view = parseSnapshotV2(body, source);
    expect(view.verified).toBe(false);
    expect(view.closing).toMatchObject({ pot: 10000001n, tLeft: 3n * 10n ** 18n });
    expect(claimPriceV2(required(view.closing).pot, required(view.closing).tLeft, view.decimals)).toBe('3.333333666666666666666666');
    expect(view.money?.creatorOwed).toBe(900719925474099300000001n);
    expect(await loadFeedV2(source, async () => new Response(JSON.stringify(feed)))).toHaveLength(1);
  });
  it('refuses cross-chain, altered spec, numeric money, and a different money block', async () => {
    const { body, source } = await publishedV2();
    for (const value of [
      { ...body, chainId: 1 }, { ...body, row: { ...body.row, encodedSpec: '0x00' } },
      { ...body, money: { ...body.money, block: '102' } },
      { ...body, buyBack: { ...body.buyBack, tBurned: 1 } },
    ]) expect(() => parseSnapshotV2(value, source)).toThrow();
    for (const value of [1, -1, '1e6', '1.1', '-1', '01']) expect(() => raw(value)).toThrow();
  });
  it('matches exact coin decimals, including dust and exhausted claims', () => {
    for (const decimals of [6, 8, 18]) expect(claimPriceV2(10n ** BigInt(decimals), 10n ** 18n, decimals)).toBe('1');
    expect(claimPriceV2(1n, 10n ** 18n, 18)).toBe('0.000000000000000001');
    expect(claimPriceV2(1n, 0n, 6)).toBeNull();
  });
  it('reads permanent listings from the release book without losing the updated raise', async () => {
    const { listings, source } = await publishedV2();
    const current = { ...listings, listings: listings.listings.map((l) => ({ ...l, raise: '1000001', detail: { ...l.detail, raise: '1000001' } })) };
    const rows = await loadListingsV2(source, async () => new Response(JSON.stringify(current)));
    expect(rows).toHaveLength(1); expect(rows[0]?.raise.toString()).toBe('1000001');
    expect(rows[0]?.decimals).toBe(6); expect(rows[0]?.demo).toBeUndefined();
  });
  it('returns no v2 source for Demo, and does not invent a chain deployment', () => {
    const build = { manifests: [], localRpcUrl: '', indexers: { local: '', sepolia: '' } };
    expect(sourceV2('demo', build)).toBeNull(); expect(sourceV2('local', build)).toBeNull();
  });
  // LINKS-WEB 1 (box-links-v2.md § 5 "Bad data never breaks the page"): a malformed `links` value is null, never an error.
  it('a feed whose cards carry malformed links: every card still parses, each bad links value is null; a single box too', async () => {
    const { body, source, feed } = await publishedV2();
    const good = { website: 'https://junkyard.fun', x: 'Junk_yard', telegram: 'junkyard', issuedAt: '1761300000' };
    const values = [good, 'https://junkyard.fun', 42, [good], { website: 'https://junkyard.fun', x: 'Junk_yard', issuedAt: '1' },
      { ...good, website: 'https://Junkyard.fun/' }, { ...good, x: '@Junk_yard' }, { ...good, telegram: 'https://t.me/junkyard' }, { ...good, issuedAt: 1761300000 },
      { website: '', x: '', telegram: '', issuedAt: '1' }, null, undefined];
    const cards = values.map((links) => ({ ...(feed.cards[0] as object), links }));
    const views = await loadFeedV2(source, async () => new Response(JSON.stringify({ ...feed, cards })));
    expect(views).toHaveLength(values.length);
    expect(views.map((view) => view.links)).toEqual([{ ...good, issuedAt: 1761300000n }, ...values.slice(1).map(() => null)]);
    for (const view of views) expect(view.token).toBe(views[0]?.token);
    for (const links of values) expect(parseSnapshotV2({ ...body, links }, source).record.creator).toBe(views[0]?.record.creator);
    expect(parseSnapshotV2({ ...body, links: { ...good, x: '<b>x</b>' } }, source).links).toBeNull();
    expect(parseSnapshotV2(body, source).links).toBeNull();
  });
  // LINKS-WEB fix round 2 (F4): a save gives way only to a feed read that started after its POST completed.
  it('feed reads are numbered in the order they start, and never come from the HTTP cache', async () => {
    const { source, feed } = await publishedV2();
    const answers: ((value: Response) => void)[] = [];
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => { inits.push(init); return new Promise<Response>((resolve) => answers.push(resolve)); }));
    try {
      const before = feedReadsStarted();
      const first = readFeedV2(source);
      const second = readFeedV2(source);
      expect(feedReadsStarted()).toBe(before + 2);
      // The later read finishing first keeps its later number: the order is the start's, never the answer's.
      answers[1]?.(new Response(JSON.stringify(feed)));
      answers[0]?.(new Response(JSON.stringify(feed)));
      const [a, b] = await Promise.all([first, second]);
      expect([a.read, b.read]).toEqual([before + 1, before + 2]);
      expect(a.snapshots).toHaveLength(1);
      expect(inits.map((init) => init?.cache)).toEqual(['no-cache', 'no-cache']);
      // A test seam's fetcher is used as given.
      const seam = await readFeedV2(source, async () => new Response(JSON.stringify(feed)));
      expect(seam.read).toBe(before + 3);
      expect(feedKeyV2(source)).toEqual(['v2-feed', source.network, source.manifest.chainId, source.origin]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('a Safe payment is not a burn; only this receiver’s T-to-zero transfers count', async () => {
    const { body, source } = await publishedV2(); const view = parseSnapshotV2({ ...body, verified: true }, source);
    const tx = `0x${'1'.repeat(64)}`;
    const transfer = { kind: 'v2_event', txHash: tx, logIndex: 1, data: { source: 'token', event: 'Transfer', from: view.record.contracts[5], to: `0x${'0'.repeat(40)}`, amount: '900719925474099300000001' } };
    const items = [transfer, { ...transfer, data: { ...transfer.data, from: view.record.creator } }, { ...transfer, data: { source: 'receiver', event: 'FitPaid', amount: '100' } }];
    expect(await loadBurnLogV2(source, view, async () => new Response(JSON.stringify({ items })))).toEqual([{ tx, amount: 900719925474099300000001n, index: '1' }]);
  });
});

/**
 * SH-ARWEAVE-PICTURES-WEB: the indexer's optional `pictureCopies` (SH-ARWEAVE-PICTURES-SRV, not published yet): read
 * as a hint when well formed, ignored otherwise (never an error), and carried to the box's pictures only where the source
 * keeps them on Arweave.
 */
// SH-BOX-LIFE-VIEW review round 2: the snapshot's `position` and `pool` only draw the box page's curve; a value that is not
// well formed is null, so one card never blanks the feed (and with it every v2 box and box page).
describe('the life view’s display-only fields (position, pool)', () => {
  it('a feed whose cards carry a malformed position or pool: every card parses, each bad value is null, the rest of each card and the other box untouched', async () => {
    const source = sepoliaLifeSourceV2();
    const raising = gpuPoorLifeV2('raising').body;
    const hoard = recordedLifeV2.dragonsHoard.body;
    const curve = raising.position as Record<string, unknown>;
    const positions: unknown[] = [{ ...curve, kind: 'concentrated' }, { ...curve, kind: undefined }, { ...curve, tickLower: curve.tickUpper }, { ...curve, tickLower: 172_390 },
      { ...curve, tickUpper: 887_273 }, { ...curve, tickLower: 145_500.5 }, { ...curve, tickLower: '145500' }, { ...curve, liquidity: 12 }, { ...curve, liquidity: '-1' }, { ...curve, liquidity: '0x10' },
      'curve', [curve], 7, true];
    const pools: unknown[] = [{ sqrtPriceX96: '0', tick: 0 }, { sqrtPriceX96: 1, tick: 0 }, { sqrtPriceX96: '01', tick: 0 }, { sqrtPriceX96: '1', tick: 900_000 }, { sqrtPriceX96: '1' }, 'pool', [], false];
    const cards = [...positions.map((position) => ({ ...raising, position })), ...pools.map((pool) => ({ ...raising, pool })), hoard];
    const views = await loadFeedV2(source, async () => new Response(JSON.stringify({ schema: 'sh.core-feed.v2', chainId: source.manifest.chainId, cards })));
    expect(views).toHaveLength(cards.length);
    const good = parseSnapshotV2(raising, source);
    expect(good.position).toEqual({ kind: 'curve', tickLower: 145_500, tickUpper: 172_380, liquidity: 195_246_362_726_789_906_940_504n });
    expect(good.pool?.sqrtPriceX96).toBeGreaterThan(0n);
    expect(views.slice(0, positions.length).map((view) => [view.position, view.pool])).toEqual(positions.map(() => [null, good.pool]));
    expect(views.slice(positions.length, -1).map((view) => [view.position, view.pool])).toEqual(pools.map(() => [good.position, null]));
    // Each card keeps the rest of what it says: its identity, its figures, its money.
    for (const view of views.slice(0, -1)) expect({ ...view, position: good.position, pool: good.pool }).toEqual(good);
    expect(views.at(-1)).toEqual(parseSnapshotV2(hoard, source));
    // The box page of such a card: the same.
    expect(parseSnapshotV2({ ...raising, position: { ...curve, kind: 'concentrated' }, pool: { sqrtPriceX96: '0', tick: 0 } }, source)).toEqual({ ...good, position: null, pool: null });
  });
});

describe('pictureCopies (the indexer’s Arweave copies, optional)', () => {
  const logo = `L${'a'.repeat(42)}`;
  const cover = `C${'b'.repeat(42)}`;
  it('reads well-formed ids and ignores anything else; absent today', async () => {
    const { body, source } = await publishedV2();
    expect(parseSnapshotV2(body, source).pictureCopies).toBeUndefined();
    expect(parseSnapshotV2({ ...body, pictureCopies: { logo: { arweaveId: logo }, cover: { arweaveId: cover } } }, source).pictureCopies).toEqual({ logo, cover });
    expect(parseSnapshotV2({ ...body, pictureCopies: { cover: { arweaveId: cover } } }, source).pictureCopies).toEqual({ cover });
    for (const bad of [null, 'x', [], { logo: logo }, { logo: { arweaveId: 'short' } }, { cover: { arweaveId: `${cover}/../x` } }]) {
      expect(parseSnapshotV2({ ...body, pictureCopies: bad }, source).pictureCopies, JSON.stringify(bad)).toBeUndefined();
    }
    expect(pictureCopiesOf({ logo: { arweaveId: logo }, cover: { arweaveId: 7 } })).toEqual({ logo });
  });
  it('the box’s pictures carry them only where the source keeps pictures on Arweave', async () => {
    const { body, source } = await publishedV2();
    const view = parseSnapshotV2({ ...body, pictureCopies: { logo: { arweaveId: logo } } }, source);
    expect(recordV2(view, source).pictures?.arweave).toBeUndefined();
    const on = recordV2(view, { ...source, arweave: true }).pictures;
    expect(on?.arweave?.copies).toEqual(on?.logo ? { [on.logo]: logo } : {});
    expect(sourceV2('sepolia', { manifests: [], localRpcUrl: '', indexers: { local: null, sepolia: null } })).toBeNull();
  });
});
