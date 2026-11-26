/**
 * F73 launch skill: the BoxSpec checker (`pnpm box-spec:check`, scripts/check-spec.mjs). It must read drafts, the
 * launch flow's download and bare specs into the same wire spec the generated library validates, give the same hash
 * as the generated fixtures, and turn every refusal into a plain sentence with a fix.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CheckResult } from '../scripts/lib/check-spec.mjs';
import {
  DRAFT_FORMAT,
  FILE_FORMAT,
  MARKER,
  checkField,
  checkSpec,
  createModel,
  durationText,
  loadSources,
  utcText,
  missingPlainWords,
  modelFor,
  numbersOf,
  plannedItems,
  renderField,
  renderMenu,
  renderNumbers,
  renderText,
  buildWire,
  explainVerdict,
} from '../scripts/lib/check-spec.mjs';
import * as lib from './index';
import { checkSpecV2, modelForV2, type Twin } from '../scripts/lib/check-spec-v2.mjs';
import * as twinV2 from './generated/box-spec.v2';

const model = modelFor(lib);
const pkgDir = join(__dirname, '..');
const cli = join(pkgDir, 'scripts/check-spec.mjs');
const fixture = (name: string) => JSON.parse(readFileSync(join(pkgDir, 'fixtures', `${name}.json`), 'utf8'));

describe('M211 holder and shop authoring', () => {
  const m2 = () => modelForV2({ network: 'demo', twin: twinV2 as unknown as Twin });
  const draft2 = () => JSON.parse(readFileSync(join(pkgDir, '../../skills/square-hole-launch/references/v2/examples/gm-coin.json'), 'utf8'));
  const holders = { split: 'NoSplit', a: { leg: 'AsPaid', dest: 'Holders', destParams: { currency: 'P' } } };
  const shop = () => ({ seedT: '123456789012345678901', givePricesT: ['1', '2', '3', '4'], pickBps: 15000, weeklyBps: 1000, collectionBps: 250, listDelay: 604800, curator: '0x0000000000000000000000000000000000000000', collections: ['0x0000000000000000000000000000000000000721'], tiers: [0] });
  const shopDraft = () => {
    const d = draft2();
    Object.assign(d.spec, { boxType: 'SHOP', contentsParams: shop(), addOns: [{ addOn: 'collection-list' }, { addOn: 'starter-set', params: { setHash: '0x0', count: 0 } }] });
    return d;
  };
  it.each(['ETH', 'USDC', 'WBTC', 'NVDAon'])('accepts holders on both sides in %s without conversion', (pricing) => {
    const d = draft2();
    Object.assign(d.spec, { pricing, buyers: holders, sellers: holders });
    const r = checkSpecV2(m2(), d);
    expect(r.ok, JSON.stringify(r.problems ?? r.explanation)).toBe(true);
    const wire = r.wire as unknown as twinV2.BoxSpecV2;
    expect(wire.buyers.a.destParams).toBe(`0x${'0'.repeat(63)}1`);
    expect(wire.buyers).toEqual(wire.sellers);
    expect(wire.buyers.b).toEqual({ leg: 0, dest: 0, legParams: '0x', destParams: '0x' });
  });
  it('encodes the frozen shop tuple with exact raw T amounts', () => {
    const r = checkSpecV2(m2(), shopDraft());
    expect(r.ok, JSON.stringify(r.problems ?? r.explanation)).toBe(true);
    expect(r.wire.contentsParams).toContain(BigInt(shop().seedT).toString(16).padStart(64, '0'));
  });
  it('hands opaque shop content to the generated validator and preserves its refusal', () => {
    let called = false;
    const model = modelForV2({ network: 'demo', twin: { ...twinV2, validateBoxSpecV2(wire: unknown, ctx: unknown) {
      called = true;
      expect(wire).toHaveProperty('contentsParams');
      expect(ctx).toHaveProperty('listing');
      return { reason: twinV2.Reason.RECIPE_RULE, field: 30 };
    } } as unknown as Twin });
    const r = checkSpecV2(model, shopDraft());
    expect(called).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.explanation?.field).toBe('contentsParams');
    expect(r.explanation?.fix).toMatch(/shop/i);
  });
  it.each(['T', 'ETH', 'USDC'])('refuses holder conversion to %s in plain words', (currency) => {
    const d = draft2();
    d.spec.buyers = structuredClone(holders); d.spec.buyers.a.destParams.currency = currency;
    const r = checkSpecV2(m2(), d);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.problems)).toMatch(/price coin|pricing coin/i);
  });
  it.each([
    ['split', (d: ReturnType<typeof draft2>) => { d.spec.buyers.split = 2; d.spec.buyers.b = { leg: 'BuyT', dest: 'Eat' }; }, /splits and caps/],
    ['items without a collection', (d: ReturnType<typeof draft2>) => { d.spec.buyers.a = { leg: 'AsPaid', dest: 'Items', destParams: { insidePolicy: 'Keep' } }; }, /not offered/i],
    ['fee-funded shop', (d: ReturnType<typeof draft2>) => { d.spec.buyers.a = { leg: 'AsPaid', dest: 5 }; }, /not offered/i],
    ['other-coin earnings', (d: ReturnType<typeof draft2>) => { d.spec.addOns = [{ id: 9, params: '0x' }]; }, /not available/i],
    ['creator cap', (d: ReturnType<typeof draft2>) => { d.spec.addOns = [{ id: 10, params: '0x' }]; }, /not available/i],
    ['second branch', (d: ReturnType<typeof draft2>) => { d.spec.buyers.b = { leg: 'BuyT', dest: 'Eat' }; }, /zero|empty/i],
  ] as const)('refuses %s without changing the recipe', (_name, change, words) => {
    const d = draft2(); change(d); const before = structuredClone(d);
    const r = checkSpecV2(m2(), d);
    expect(r.ok).toBe(false); expect(r.stage).toBe('check');
    expect(r.explanation?.sentence).toMatch(words); expect(r.explanation?.fix).toBeTruthy();
    expect(d).toEqual(before);
  });
  it('refuses numeric raw money and unknown shop fields instead of rounding or dropping them', () => {
    const d = shopDraft(); d.spec.contentsParams.seedT = 123;
    expect(checkSpecV2(m2(), d).ok).toBe(false);
    d.spec.contentsParams = { ...shop(), feeFunding: true };
    expect(checkSpecV2(m2(), d).problems).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'contentsParams.feeFunding' })]));
  });
  it.each([false, true])('refreshes real prior hashes and salts with a stale raise (latest menu: %s)', async (latestMenu) => {
    // Runtime import: the owned JS seam has no generated declaration file.
    const launch = await import('../scripts/lib/' + 'spec-launch-v2.mjs');
    const answer = JSON.parse(readFileSync(join(pkgDir, 'listings.demo.json'), 'utf8'));
    const d = draft2(); d.spec.buyers = holders; d.spec.sellers = holders;
    const before = checkSpecV2(m2(), d);
    const oldRaise = (before.wire as unknown as twinV2.BoxSpecV2).raise;
    d.spec.raise = oldRaise.toString();
    answer.listings[0].raise = (oldRaise + 123456789n).toString();
    const fresh = modelForV2({ network: 'demo', twin: twinV2 as unknown as Twin, indexer: answer });
    expect(checkSpecV2(fresh, d).verdict?.reasonName).toBe('RAISE_NOT_A_PRESET');
    Object.assign(d, { specHash: before.specHash, quote: { raise: oldRaise.toString() }, coordinatorSalt: `0x${'a1'.repeat(32)}`, hookSalt: `0x${'b2'.repeat(32)}` });
    const original = structuredClone(d);
    const calls: string[] = [];
    const r = await launch.refreshLaunchV2(latestMenu ? fresh : m2(), d, {
      readListings: async (request: { listingId: number; network: string; token: string }) => {
        calls.push('read'); expect(request).toMatchObject({ listingId: 0, network: 'demo', token: answer.listings[0].address }); return answer;
      },
      prepareLaunch: async ({ wire, specHash }: { wire: { raise: bigint }; specHash: string }) => {
        calls.push('prepare'); expect(wire.raise).toBe(BigInt(answer.listings[0].raise));
        expect(specHash).not.toBe(before.specHash);
        return { specHash, quote: { raise: wire.raise.toString() }, coordinatorSalt: `0x${'1'.repeat(64)}`, hookSalt: `0x${'2'.repeat(64)}` };
      },
    });
    expect(calls).toEqual(['read', 'prepare']);
    expect(r.result.ok).toBe(true);
    expect(r.preparation).toEqual({ specHash: r.result.specHash, quote: { raise: answer.listings[0].raise }, coordinatorSalt: `0x${'1'.repeat(64)}`, hookSalt: `0x${'2'.repeat(64)}` });
    for (const key of ['quote', 'specHash', 'coordinatorSalt', 'hookSalt']) expect(r.draft).not.toHaveProperty(key);
    expect(r.draft.spec.raise).toBe(answer.listings[0].raise);
    expect(d).toEqual(original);
    expect(r.draft.spec.pricing).toEqual({ listingId: 0, token: answer.listings[0].address });
    expect(r.draft.spec.buyers).toEqual(holders);
  });
  it.each([false, true])('refuses conflicting pricing identity before reading or preparing (stale raise: %s)', async (staleRaise) => {
    const launch = await import('../scripts/lib/' + 'spec-launch-v2.mjs');
    const answer = JSON.parse(readFileSync(join(pkgDir, 'listings.demo.json'), 'utf8'));
    const d = draft2();
    d.spec.pricing = { listingId: 0, token: '0x0000000000000000000000000000000000000123' };
    if (staleRaise) d.spec.raise = (BigInt(answer.listings[0].raise) - 1n).toString();
    expect(checkSpecV2(m2(), d).verdict?.reasonName).toBe('LISTING_MISMATCH');
    const original = structuredClone(d);
    const readListings = vi.fn(async () => answer);
    const prepareLaunch = vi.fn(async ({ specHash }: { specHash: string }) => ({ specHash, quote: {}, coordinatorSalt: `0x${'1'.repeat(64)}`, hookSalt: `0x${'2'.repeat(64)}` }));
    await expect(launch.refreshLaunchV2(m2(), d, { readListings, prepareLaunch })).rejects.toThrow(/pricing token.*permanent listing/i);
    expect(readListings).not.toHaveBeenCalled(); expect(prepareLaunch).not.toHaveBeenCalled();
    expect(d).toEqual(original);
  });
  it.each([
    ['brief', (d: ReturnType<typeof draft2>, value: string) => { d.brief = value; }],
    ['spec text', (d: ReturnType<typeof draft2>, value: string) => { d.spec.description = value; }],
    ['unknown field', (d: ReturnType<typeof draft2>, value: string) => { d.privateKey = value; }],
    ['nested fingerprint', (d: ReturnType<typeof draft2>, value: string) => { d.site = { specHash: value }; }],
    ['quote', (d: ReturnType<typeof draft2>, value: string) => { d.quote = { specHash: value }; }],
    ...['specHash', 'coordinatorSalt', 'hookSalt'].map((key) => [key, (d: ReturnType<typeof draft2>, value: string) => { d[key] = `unexpected ${value}`; }] as const),
  ] as const)('keeps secret checks in %s before any refresh callback', async (_name, change) => {
    const launch = await import('../scripts/lib/' + 'spec-launch-v2.mjs');
    const d = draft2();
    change(d, `0x${'c3'.repeat(32)}`);
    expect(checkSpecV2(m2(), d).stage).toBe('secret');
    const original = structuredClone(d);
    const readListings = vi.fn(); const prepareLaunch = vi.fn();
    await expect(launch.refreshLaunchV2(m2(), d, { readListings, prepareLaunch })).rejects.toThrow(/fix the draft/i);
    expect(readListings).not.toHaveBeenCalled(); expect(prepareLaunch).not.toHaveBeenCalled();
    expect(d).toEqual(original);
  });
  it('preserves an invalid recipe refusal when refreshing its stale raise', async () => {
    const launch = await import('../scripts/lib/' + 'spec-launch-v2.mjs');
    const answer = JSON.parse(readFileSync(join(pkgDir, 'listings.demo.json'), 'utf8'));
    const d = draft2();
    d.spec.raise = (BigInt(answer.listings[0].raise) - 1n).toString();
    d.spec.buyers.b = { leg: 'BuyT', dest: 'Eat' };
    const original = structuredClone(d);
    const prepareLaunch = vi.fn();
    const r = await launch.refreshLaunchV2(m2(), d, { readListings: async () => answer, prepareLaunch });
    expect(r.result.ok).toBe(false);
    expect(r.result.explanation.field).toBe('buyers.b.leg');
    expect(r.preparation).toBeNull(); expect(prepareLaunch).not.toHaveBeenCalled();
    expect(r.draft.spec.buyers).toEqual(d.spec.buyers); expect(d).toEqual(original);
  });
  it('never prepares from missing, failed, retired or mismatched fresh reads', async () => {
    const launch = await import('../scripts/lib/' + 'spec-launch-v2.mjs');
    const answer = JSON.parse(readFileSync(join(pkgDir, 'listings.demo.json'), 'utf8'));
    let preparations = 0;
    const prepareLaunch = async () => { preparations++; throw new Error('must not prepare'); };
    await expect(launch.refreshLaunchV2(m2(), draft2(), { readListings: async () => { throw new Error('offline'); }, prepareLaunch })).rejects.toThrow('offline');
    await expect(launch.refreshLaunchV2(m2(), draft2(), { readListings: async () => ({ ...answer, listings: [] }), prepareLaunch })).rejects.toThrow(/omitted/);
    await expect(launch.refreshLaunchV2(m2(), draft2(), { readListings: async () => ({ ...answer, network: 'sepolia' }), prepareLaunch })).rejects.toThrow(/network/);
    answer.listings[0].retired = true;
    const r = await launch.refreshLaunchV2(m2(), draft2(), { readListings: async () => answer, prepareLaunch });
    expect(r.result.ok).toBe(false); expect(r.preparation).toBeNull(); expect(preparations).toBe(0);
  });
  it('rejects preparation for another hash or without both salts', async () => {
    const launch = await import('../scripts/lib/' + 'spec-launch-v2.mjs');
    const answer = JSON.parse(readFileSync(join(pkgDir, 'listings.demo.json'), 'utf8'));
    for (const wrong of [{ specHash: `0x${'0'.repeat(64)}` }, { hookSalt: undefined }]) {
      await expect(launch.refreshLaunchV2(m2(), draft2(), {
        readListings: async () => answer,
        prepareLaunch: async ({ specHash }: { specHash: string }) => ({ specHash, quote: {}, coordinatorSalt: `0x${'1'.repeat(64)}`, hookSalt: `0x${'2'.repeat(64)}`, ...wrong }),
      })).rejects.toThrow(/both salts.*refreshed spec hash/);
    }
  });
});

describe('M311 every-item and seeded-pile authoring', () => {
  const model3 = () => modelForV2({ network: 'demo', twin: twinV2 as unknown as Twin });
  const draft3 = (name = 'gm-coin') => JSON.parse(readFileSync(join(pkgDir, '../../skills/square-hole-launch/references/v2/examples', `${name}.json`), 'utf8'));
  const launch3 = () => import('../scripts/lib/' + 'spec-launch-v2.mjs');
  const itemSide = (insidePolicy = 'Keep') => ({ split: 'NoSplit', a: { leg: 'AsPaid', dest: 'Items', destParams: { insidePolicy } } });
  const items = () => {
    const d = draft3('ultrasound-owls');
    d.spec.buyers = itemSide(); d.spec.sellers = itemSide('BuyBackBurn');
    return d;
  };
  const snapshot = () => JSON.parse(readFileSync(join(pkgDir, 'listings.demo.json'), 'utf8'));
  const asset = () => snapshot().listings.find((l: { symbol: string }) => l.symbol === 'USDC').address;
  const pile = (seedAmount = '123456789012345678901', seedAsset = asset()) => {
    const d = draft3();
    Object.assign(d.spec, { boxType: 'PILE', contentsParams: { asset: seedAsset, seedAmount } });
    return d;
  };
  const prepared = ({ specHash }: { specHash: string }) => ({ specHash, quote: { payment: '0' }, coordinatorSalt: `0x${'1'.repeat(64)}`, hookSalt: `0x${'2'.repeat(64)}`, predictedT: '0x0000000000000000000000000000000000000123' });

  it.each(['AsPaid', 'BuyT'])('IP15 checks explicit Depth authoring in %s on both sides', async (leg) => {
    const d = items();
    for (const side of ['buyers', 'sellers']) d.spec[side].a = { leg, dest: 'Items', destParams: { insidePolicy: 'Depth' } };
    const r = (await launch3()).checkSpecV2(model3(), d);
    expect(r.ok, JSON.stringify(r.problems ?? r.explanation)).toBe(true);
    for (const side of ['buyers', 'sellers'] as const) {
      expect(twinV2.decodeItemsDestParams(r.wire[side].a.destParams)).toEqual({ insidePolicy: 3 });
    }
  });
  it.each(['AsPaid', 'BuyT'])('IP15 describes Depth in %s as the box’s own pool, never as a burn', async (leg) => {
    const d = items();
    d.spec.buyers.a = { leg, dest: 'Items', destParams: { insidePolicy: 'Depth' } };
    const r = (await launch3()).checkSpecV2(model3(), d);
    expect(r.ok, JSON.stringify(r.problems ?? r.explanation)).toBe(true);
    const buyers = Object.fromEntries(r.overview)["Buyers' fees"];
    expect(buyers).toBe(leg === 'AsPaid'
      ? "to every item in ETH; inside shares grow this box's own pool in ETH"
      : "to every item in HOOT; inside shares grow this box's own pool in ETH; only outside shares buy HOOT");
    expect(buyers).not.toMatch(/burn|stash/i);
    // The sellers' BuyBackBurn side keeps its own words.
    expect(Object.fromEntries(r.overview)["Sellers' fees"]).toMatch(/buy back and burn HOOT/);
    const notes = r.notes.join(' ');
    if (leg === 'AsPaid') {
      expect(notes).toMatch(/BuyBackBurn uses all that side's held money to buy and burn HOOT, and Depth sends all of it to this box's own pool/);
      expect(notes).toMatch(/Depth adds inside shares to this box's own pool, as Grow does/);
    } else {
      expect(notes).toMatch(/Depth buys no inside-item HOOT: all held ETH goes to this box's own pool at graduation, then the inside share in ETH of each collection, and an unspent queue once every item is back inside, so only outside ETH buys HOOT/);
    }
  });
  it('IP15 the menu names all three inside policies', async () => {
    const menu = (await launch3()).renderMenuV2(model3());
    expect(menu).toContain("Inside policy: Keep (explicit default), BuyBackBurn or Depth (inside P goes to this box’s own pool), independently per side.");
  });
  it('IP15 the canonical source and its plain words admit and name Depth (wire value 3)', () => {
    const source = JSON.parse(readFileSync(join(pkgDir, 'box-spec.v2.json'), 'utf8'));
    const words = JSON.parse(readFileSync(join(pkgDir, 'plain-words.v2.json'), 'utf8'));
    const policy = source.enums.find((e: { name: string }) => e.name === 'ItemsInsidePolicy');
    expect(policy.members).toEqual([{ name: 'Keep', value: 1 }, { name: 'BuyBackBurn', value: 2 }, { name: 'Depth', value: 3 }]);
    expect(source.recipe.dests.Items.checks).toEqual([{ require: { destParam: 'insidePolicy', of: 'Items', in: ['ItemsInsidePolicy.Keep', 'ItemsInsidePolicy.BuyBackBurn', 'ItemsInsidePolicy.Depth'] }, reason: 'NOT_OFFERED' }]);
    expect(Object.keys(words.enums.ItemsInsidePolicy)).toEqual(['Keep', 'BuyBackBurn', 'Depth']);
    expect(words.enums.ItemsInsidePolicy.Depth.label).toBe('Grow the pool');
    expect(words.enums.ItemsInsidePolicy.Depth.plain).toMatch(/\{P\} and go to this box’s own liquidity pool/);
    for (const entry of [words.enums.Dest.Items, words.menu.items]) {
      expect(entry.plain).toContain('or grow this box’s own pool');
      expect(entry.insidePolicy).toBe('Choose Keep, buy back and burn, or grow the pool; Keep is the default.');
    }
  });
  // This coin exists only in the indexer snapshot, outside the bundled identity checks.
  const newSeed = () => ({ id: 99, address: '0x0000000000000000000000000000000000000abc', symbol: 'NEW', label: 'Demo NEW', decimals: 6, class: 'OTHER', kind: 'LISTED', raise: '10000000000' });

  it.each(['ETH', 'USDC', 'WBTC', 'NVDAon'])('encodes both explicit item policies and explains actual %s payouts', async (pricing) => {
    const d = items(); d.spec.pricing = pricing;
    const before = structuredClone(d);
    const r = (await launch3()).checkSpecV2(model3(), d);
    expect(r.ok, JSON.stringify(r.problems ?? r.explanation)).toBe(true);
    const wire = r.wire as twinV2.BoxSpecV2;
    expect(twinV2.decodeItemsDestParams(wire.buyers.a.destParams)).toEqual({ insidePolicy: 1 });
    expect(twinV2.decodeItemsDestParams(wire.sellers.a.destParams)).toEqual({ insidePolicy: 2 });
    expect(r.specHash).toBe(twinV2.specHashV2(wire));
    const overview = Object.fromEntries(r.overview);
    expect(overview["Buyers' fees"]).toContain(`every item in ${pricing}`);
    expect(overview["Buyers' fees"]).toMatch(/keep.*stash/i);
    expect(overview["Sellers' fees"]).toMatch(/buy.*burn HOOT/i);
    expect(r.notes.join(' ')).toMatch(/held.*graduation.*failure.*pot/i);
    expect(r.notes.join(' ')).toMatch(/current owner.*transfer/i);
    expect(r.notes.join(' ')).toMatch(/pick.*collect.*timing/i);
    const text = (await launch3()).renderTextV2(r);
    expect(text).toMatch(/only the current owner claims.*nonzero recipient.*vault/i);
    expect(text).toMatch(/wallets, contracts and EIP-7702 owners.*same.*claim/i);
    expect(text).toMatch(/owner claims have no minimum or tip/i);
    expect(text).not.toMatch(/claimFor|permissionless push|push(?:ed)?[ -](?:claim|payout)|wallet owner only|creation-time minimum/i);
    expect(d).toEqual(before);
  });
  it.each(['Keep', 'BuyBackBurn'])('explains price-coin royalties and in-kind exits with buyers Items policy %s and fee handling', async (policy) => {
    const launch = await launch3();
    const d = draft3('bag-holders');
    // The worked Bag Holders draft is priced in LINK since SH-EX-L6 (its Sepolia kit); payouts stay in the price coin.
    const coin = d.spec.pricing;
    expect(coin).toBe('LINK');
    d.spec.buyers = itemSide(policy);
    d.spec.addOns.push({ addOn: 'royalties', params: { bps: 250, destination: 'FEE_HANDLING' } });
    d.spec.creatorFeeRecipient = 'FROM_LAUNCH_FLOW';
    const r = launch.checkSpecV2(model3(), d);
    expect(r.ok, JSON.stringify(r.problems ?? r.explanation)).toBe(true);
    const text = launch.renderTextV2(r);
    expect(text).not.toMatch(/no outside conversion funds items/i);
    expect(text).toMatch(new RegExp(`item payouts remain in ${coin}`, 'i'));
    expect(text).toMatch(/ledger performs no swaps or conversions/i);
    // F138: the inbox replaces RC5's option 3 router. The box offers listed coins on CoW (no sale is promised); the payee
    // can take a listed coin unsold for 30 days, and any other coin, in kind (rc6 part 4: no "sell for P through CoW").
    expect(text).toMatch(new RegExp(`royalties and gifts reach this box's inbox: the box offers coins on its creation-time sale list for ${coin} on CoW.*the payee can take a listed coin that does not sell for 30 days, and any other coin at any time, as it is`, 'i'));
    expect(text).not.toMatch(new RegExp(`sell for ${coin} through CoW|go to the payee as they are`, 'i'));
    expect(text).toMatch(/booked like the buyers' fees, including their Items policy.*after failure it joins the claim pot/i);
    expect(text).not.toMatch(/royalty router|option 3|configured royalty destination/i);
  });
  it.each(['0', '1', '123456789012345678901', ((1n << 256n) - 1n).toString()])('encodes raw pile seed %s exactly, independently of the price coin', async (amount) => {
    const d = pile(amount);
    const r = (await launch3()).checkSpecV2(model3(), d);
    expect(r.ok, JSON.stringify(r.problems ?? r.explanation)).toBe(true);
    const wire = r.wire as twinV2.BoxSpecV2;
    expect(twinV2.decodePileParams(wire.contentsParams)).toEqual({ asset: asset(), seedAmount: BigInt(amount) });
    expect(wire.raise).toBe(BigInt(snapshot().listings[0].raise));
    expect(r.specHash).toBe(twinV2.specHashV2(wire));
    expect(Object.fromEntries(r.overview)['Pile seed']).toContain('USDC');
    expect(r.notes.join(' ')).toMatch(/pending fees.*after graduation/i);
    expect(r.notes.join(' ')).toMatch(/after graduation.*pre-burn supply/i);
    expect(r.notes.join(' ')).toMatch(/failure.*recorded seed.*creator/i);
    expect(r.notes.join(' ')).toMatch(/surplus.*stranded/i);
    if (amount === '0') expect(r.notes.join(' ')).toMatch(/zero seed.*no loader/i);
  });
  it('accepts native seed with its caller and exact-value rule', async () => {
    const r = (await launch3()).checkSpecV2(model3(), pile('1000000000000000000', snapshot().listings[0].address));
    expect(r.ok).toBe(true);
    expect(Object.fromEntries(r.overview)['Pile seed']).toContain('1 ETH');
    expect(r.notes.join(' ')).toMatch(/native.*creator.*exact value/i);
  });
  it.each([0, 123, '1e18', '-1', '1.2', { decimal: '1' }, (1n << 256n).toString()])('refuses invalid raw seed %j with a pile fix', async (amount) => {
    const d = pile(); d.spec.contentsParams.seedAmount = amount;
    const r = (await launch3()).checkSpecV2(model3(), d);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'contentsParams.seedAmount' })]));
  });
  it.each(['mode', 'ids', 'collection', 'currency', 'eligibleHolder'])('refuses removed Items setting %s without rewriting', async (key) => {
    const d = items(); d.spec.buyers.a.destParams[key] = key === 'ids' ? ['1'] : 1;
    const before = structuredClone(d);
    const r = (await launch3()).checkSpecV2(model3(), d);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining([expect.objectContaining({ path: `buyers.a.destParams.${key}` })]));
    expect(d).toEqual(before);
  });
  it.each([undefined, {}, { insidePolicy: 0 }, { insidePolicy: 4 }, '0x'])('never defaults missing or invalid item bytes (%j)', async (params) => {
    const d = items(); d.spec.buyers.a.destParams = params;
    expect((await launch3()).checkSpecV2(model3(), d).ok).toBe(false);
  });
  it.each(['feeFunding', 'seeder', 'mode'])('refuses old pile setting %s without silently making it seed-only', async (key) => {
    const d = pile(); d.spec.contentsParams[key] = true;
    const before = structuredClone(d);
    const r = (await launch3()).checkSpecV2(model3(), d);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining([expect.objectContaining({ path: `contentsParams.${key}` })]));
    expect(d).toEqual(before);
  });
  it('refuses old fee-fed destination and preserves generated pile content refusals', async () => {
    const launch = await launch3(); const d = pile();
    d.spec.buyers = { split: 'NoSplit', a: { leg: 'AsPaid', dest: 7 } };
    const r = launch.checkSpecV2(model3(), d);
    expect(r.ok).toBe(false); expect(r.stage).toBe('check'); expect(r.explanation.fix).toBeTruthy();
    const malformed = pile(); malformed.spec.contentsParams = '0x';
    const refused = launch.checkSpecV2(model3(), malformed);
    expect(refused.explanation.field).toBe('contentsParams');
    expect(refused.explanation.fix).toMatch(/pile.*seed/i);
  });
  it('requires a currently offered seed listing even for zero seed and raw ABI input', async () => {
    const launch = await launch3();
    const d = pile('0', '0x0000000000000000000000000000000000000999');
    d.spec.contentsParams = twinV2.encodePileParams(d.spec.contentsParams);
    const r = launch.checkSpecV2(model3(), d);
    expect(r.ok).toBe(false); expect(JSON.stringify(r.problems)).toMatch(/listed.*seed|seed.*listed/i);
  });
  it('refreshes both coin admissions, keeps seed raw units and rejects a predicted own coin', async () => {
    const launch = await launch3(); const d = pile(); const original = structuredClone(d);
    const answer = snapshot(); answer.listings[0].raise = (BigInt(answer.listings[0].raise) + 1n).toString();
    const readListings = vi.fn(async () => answer);
    const prepareLaunch = vi.fn(async (req: { specHash: string }) => prepared(req));
    const r = await launch.refreshLaunchV2(model3(), d, { readListings, prepareLaunch });
    expect(r.result.ok).toBe(true);
    expect(readListings).toHaveBeenCalledWith(expect.objectContaining({ pileAsset: asset() }));
    expect(r.preparation.predictedT).toBe(prepared({ specHash: '' }).predictedT);
    expect(twinV2.decodePileParams(r.result.wire.contentsParams).seedAmount).toBe(BigInt(original.spec.contentsParams.seedAmount));
    expect(d).toEqual(original);
    await expect(launch.refreshLaunchV2(model3(), d, { readListings, prepareLaunch: async (req: { specHash: string }) => ({ ...prepared(req), predictedT: asset() }) })).rejects.toThrow(/own.*coin|predicted/i);
  });
  it.each([
    ['id', { id: 100 }],
    ['address', { address: '0x0000000000000000000000000000000000000def' }],
    ['decimals', { decimals: 18 }],
    ['class', { class: 'STABLE' }],
    // Keep the refreshed row internally valid so only comparison with the prior menu catches it.
    ['kind', { class: 'STANDARD', kind: 'BOX_TOKEN' }],
  ] as const)('refuses a changed %s for a seed learned from an earlier indexer snapshot', async (_field, change) => {
    const launch = await launch3(); const seed = newSeed();
    const initial = snapshot(); initial.listings.push(seed);
    const model = modelForV2({ network: 'demo', twin: twinV2 as unknown as Twin, indexer: initial });
    const d = pile('1000000000', seed.address); const original = structuredClone(d);
    const before = launch.checkSpecV2(model, d);
    expect(before.ok).toBe(true);
    expect(Object.fromEntries(before.overview)['Pile seed']).toContain('1,000 NEW');
    const answer = snapshot(); answer.listings.push({ ...seed, ...change });
    const prepareLaunch = vi.fn(async (req: { specHash: string }) => prepared(req));
    await expect(launch.refreshLaunchV2(model, d, { readListings: async () => answer, prepareLaunch })).rejects.toThrow(/pile seed coin/i);
    expect(prepareLaunch).not.toHaveBeenCalled();
    expect(d).toEqual(original);
  });
  it.each([true, false])('accepts a seed raise update or new admission (previously known: %s)', async (known) => {
    const launch = await launch3(); const seed = newSeed();
    const initial = snapshot(); if (known) initial.listings.push(seed);
    const model = modelForV2({ network: 'demo', twin: twinV2 as unknown as Twin, indexer: initial });
    const d = pile('1000000000', seed.address); const original = structuredClone(d);
    const answer = snapshot();
    answer.listings.push({ ...seed, address: seed.address.toUpperCase().replace('0X', '0x'), raise: (BigInt(seed.raise) + 1n).toString() });
    const prepareLaunch = vi.fn(async (req: { specHash: string }) => prepared(req));
    const r = await launch.refreshLaunchV2(model, d, { readListings: async () => answer, prepareLaunch });
    expect(r.result.ok).toBe(true);
    expect(prepareLaunch).toHaveBeenCalledOnce();
    expect(Object.fromEntries(r.result.overview)['Pile seed']).toContain('1,000 NEW');
    expect(twinV2.decodePileParams(r.result.wire.contentsParams).seedAmount).toBe(1000000000n);
    expect(r.result.wire.raise).toBe(BigInt(initial.listings[0].raise));
    expect(d).toEqual(original);
  });
  it.each(['omitted', 'retired', 'failed', 'prediction missing', 'prediction zero'])('never returns pile preparation with %s admission', async (fault) => {
    const launch = await launch3(); const answer = snapshot();
    if (fault === 'omitted') answer.listings = answer.listings.filter((l: { address: string }) => l.address !== asset());
    if (fault === 'retired') answer.listings.find((l: { address: string }) => l.address === asset()).retired = true;
    const prepareLaunch = vi.fn(async (req: { specHash: string }) => ({ ...prepared(req), ...(fault === 'prediction missing' ? { predictedT: undefined } : fault === 'prediction zero' ? { predictedT: snapshot().listings[0].address } : {}) }));
    await expect(launch.refreshLaunchV2(model3(), pile('0'), { readListings: async () => { if (fault === 'failed') throw new Error('offline'); return answer; }, prepareLaunch })).rejects.toThrow();
    if (['omitted', 'retired', 'failed'].includes(fault)) expect(prepareLaunch).not.toHaveBeenCalled();
  });
});

/** A draft as the skill writes it: names for enums, decimals for amounts, the marker where the launch flow fills in. */
function draft(): { format: string; context: string; site?: unknown; spec: Record<string, unknown> } {
  return {
    format: DRAFT_FORMAT,
    context: 'v2',
    spec: {
      version: 2,
      boxType: 'NEW_COLLECTION',
      tokenName: 'Gas Guzzlers',
      tokenSymbol: 'GUZZ',
      collectionName: 'Gas Guzzlers',
      collectionSymbol: 'GUZZ',
      description: 'Demo: 100 toy fuel cans.',
      n: 100,
      firstId: '1',
      q: 'ETH',
      raise: { decimal: '4.206980085' },
      layout: 'CURVE_V1',
      gradLayout: 'ASK_FULL_BID_SENTINEL',
      launchFormat: 'CURVE',
      openAt: 0,
      deadlineDays: 30,
      qStream: 'TO_CREATOR',
      tStream: 'TO_CREATOR',
      artMode: 'OPEN',
      revealRoot: MARKER,
      metadataTable: { formatV1: { traitTypes: [{ name: 'Fuel', values: ['Regular', 'Jet'] }] } },
      generatorHash: '0x0',
      coverSha256: MARKER,
      revealListId: MARKER,
      marketplaceOwner: MARKER,
      creatorFeeRecipient: MARKER,
      creatorBuy: { decimal: '0.1' },
      collectionCoverSha256: MARKER,
      addOns: [{ addOn: 'royalties', params: { bps: 500, destination: 'CREATOR' } }],
    },
  };
}

const withSpec = (patch: (spec: Record<string, unknown>) => void) => {
  const doc = draft();
  patch(doc.spec);
  return checkSpec(model, doc);
};

/** The draft's royalties settings (its only add-on), to patch. */
const royalty = (s: Record<string, unknown>) => ((s.addOns as { params: Record<string, unknown> }[])[0] ?? { params: {} }).params;

const hiddenAddOn = (svg = '<svg xmlns="http://www.w3.org/2000/svg"/>') => ({
  addOn: 'placeholders',
  params: { placeholderName: 'Guzz ticket', placeholderSymbol: 'GUZZ-T', placeholderDescription: '', hiddenDescription: '', hiddenSvg: svg },
});

describe('reading BoxSpec JSON', () => {
  it('reads the package fixtures to the same wire spec and hash as the generator', () => {
    for (const [name, hash] of [
      ['demo-open-art', lib.DEMO_OPEN_ART_SPEC_HASH],
      ['demo-placeholders', lib.DEMO_PLACEHOLDERS_SPEC_HASH],
    ] as const) {
      const result = checkSpec(model, fixture(name));
      expect(result.ok, name).toBe(true);
      expect(result.specHash).toBe(hash);
      expect(result.draft).toBe(false);
    }
  });

  it('accepts a draft with the marker, says which fields the launch flow fills in, and shows the overview', () => {
    const result = checkSpec(model, draft());
    expect(result.ok).toBe(true);
    expect(result.draft).toBe(true);
    expect(result.placeholders).toEqual(['revealRoot', 'coverSha256', 'revealListId', 'marketplaceOwner', 'creatorFeeRecipient', 'collectionCoverSha256']);
    const rows = Object.fromEntries(result.overview ?? []);
    expect(rows["Buyers' fees"]).toBe('To the creator, in ETH');
    expect(rows["Sellers' fees"]).toBe('To the creator, in GUZZ');
    // The launch flow's Overview labels, the plain term in brackets; a new collection's own cover (F74 U3) after Contents.
    expect(Object.keys(rows)).toEqual(['Token', 'Paired with', 'Logo', 'About', 'Contents', 'Collection cover', 'One item', 'Owner (collection)', "Buyers' fees", "Sellers' fees", 'Fee payout address', 'Add-ons', 'Target (raise)', 'Deadline', 'Opens', 'Your ETH (creator buy)']);
    expect(rows['Collection cover']).toBe('uploaded in the launch flow');
    // F74 U5: one raise for every box.
    expect(rows['Target (raise)']).toBe('4.206980085 ETH');
    expect(rows['Your ETH (creator buy)']).toBe('0.1 ETH, about 6.7% of all GUZZ');
    // One payout wallet (F72 (3)): royalties to the creator go to the fee payout address.
    expect(rows['Add-ons']).toBe('Royalties: 5%, to the creator (the fee payout address: the wallet connected in the launch flow, or one pasted there)');
    expect(rows['One item']).toBe('1/100 of all GUZZ at launch (about 10,000,000; fewer as burns shrink the supply): about 0.0137 ETH at the first buy, 0.2021 ETH at graduation');
    // openAt 0 is the launch flow's Now (the default since 2026-10-04): the block after Create, one 12-second slot
    // (review of open-at, finding 5: durationText takes seconds; "about 1 second" or "about 2 minutes" is a wrong merge).
    expect(rows.Opens).toBe('Now: the block after Create (about 12 seconds)');
    // A clock time (F80, open-at-clock-time.md): every form a draft may write (UTC text, { "utc": ... }, Unix seconds)
    // reads to the same wire value, hash and row (review of open-at, finding 4: both branches' forms, one reader).
    const forms: unknown[] = [1_791_309_600, '1791309600', '2026-10-06T18:00:00Z', '2026-10-06 18:00 UTC', '2026-10-06T18:00:00+00:00', { utc: '2026-10-06T18:00:00Z' }, { utc: '2026-10-06 18:00 UTC' }];
    const hashes = new Set<string>();
    for (const at of forms) {
      const timed = draft();
      timed.spec.openAt = at;
      const read = checkSpec(model, timed, { nowMs: 1_791_300_000_000 });
      expect(read.ok, JSON.stringify(at)).toBe(true);
      expect(Object.fromEntries(read.overview ?? []).Opens, JSON.stringify(at)).toBe('2026-10-06 18:00 UTC, in the first block from then on (if Create lands later: the block after Create)');
      expect(read.warnings ?? [], JSON.stringify(at)).not.toContainEqual(expect.stringContaining('opening time'));
      hashes.add(String(read.specHash));
    }
    expect(hashes.size).toBe(1);
    for (const at of ['2026-10-06T18:00:07Z', { utc: '2026-10-06T18:00:07Z' }]) {
      const seconds = draft();
      seconds.spec.openAt = at;
      expect(Object.fromEntries(checkSpec(model, seconds).overview ?? []).Opens).toBe('2026-10-06 18:00:07 UTC, in the first block from then on (if Create lands later: the block after Create)');
    }
    const now = draft();
    now.spec.openAt = 'NOW';
    expect(checkSpec(model, now).specHash).toBe(result.specHash);
    expect(result.notes?.some((n) => n.includes('more than the advice of at most about 5% of all GUZZ'))).toBe(true);
    expect(renderText(result)).toMatch(/^Valid draft: .*\nDraft hash: 0x[0-9a-f]{64}\n/);
  });

  it('reads the launch flow download and refuses one whose hash no longer matches its spec', () => {
    const spec = lib.DEMO_OPEN_ART;
    const file = {
      format: FILE_FORMAT,
      context: 'v2',
      specHash: lib.specHash(spec),
      encoded: lib.encodeBoxSpecV1(spec),
      spec: Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
    };
    expect(checkSpec(model, file)).toMatchObject({ ok: true, kind: 'download', specHash: lib.DEMO_OPEN_ART_SPEC_HASH });
    const edited = { ...file, spec: { ...file.spec, tokenName: 'Edited' } };
    const result = checkSpec(model, edited);
    expect(result).toMatchObject({ ok: false, stage: 'file' });
    expect(result.problems.map((p) => p.path)).toEqual(['specHash', 'encoded']);
  });

  it('reads a bare wire spec and picks the context by its version', () => {
    // Every generated fixture (box 0 in v1, the demos in v2; the builder kit ships its own box-0 stand-in), so the
    // test holds for whichever fixtures the package carries.
    const generated = lib as unknown as Record<string, unknown>;
    const entries = Object.entries(lib.FIXTURES);
    expect(entries.map(([, spec]) => spec.version)).toContain(1);
    for (const [name, spec] of entries) {
      const key = name.toUpperCase().replace(/-/g, '_');
      const bare = Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
      expect(checkSpec(model, bare), name).toMatchObject({ ok: true, kind: 'bare', context: generated[`${key}_CONTEXT`], specHash: generated[`${key}_SPEC_HASH`] });
      expect(generated[`${key}_CONTEXT`], name).toBe(spec.version === 1 ? 'v1' : 'v2');
    }
    const box0 = entries.find(([, spec]) => spec.version === 1)?.[1];
    const bare0 = Object.fromEntries(Object.entries(box0 ?? {}).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
    expect(checkSpec(model, bare0)).toMatchObject({ ok: true, kind: 'bare', context: 'v1', warnings: [] });
  });

  it('collects every problem in the JSON at once, each with a fix', () => {
    const result = withSpec((s) => {
      s.ticker = 'GUZZ';
      s.raise = 1;
      s.marketplaceOwner = '0xdCE82e76456434d0f550b492Ff212A862221e6C5';
      s.tStream = 'TELEPORT';
      s.description = MARKER;
      delete s.layout;
      (s.addOns as unknown[]).push({ addOn: 'creator-fee-cap', params: {} });
    });
    expect(result.stage).toBe('input');
    const byPath = Object.fromEntries(result.problems.map((p) => [p.path, p]));
    expect(byPath.ticker?.fix).toBe('Did you mean "tokenSymbol"?');
    expect(byPath.raise?.message).toMatch(/written as text/);
    expect(byPath.raise?.fix).toBe('Write { "decimal": "1" } for 1 ETH, or the raw integer as a string.');
    expect(byPath.marketplaceOwner?.message).toMatch(/not its checksum/);
    expect(byPath.tStream?.message).toBe('"TELEPORT" is not a choice for tStream.');
    expect(byPath.layout?.fix).toBe('Add "layout": "CURVE_V1" (set by the version).');
    expect(byPath.description?.message).toMatch(/only for fingerprints, addresses and the launch flow's ticket texts/);
    expect(byPath['addOns[1].params.capPerEpoch']?.message).toBe('The creator-fee-cap setting "capPerEpoch" is missing.');
    for (const p of result.problems) expect(p.fix.length).toBeGreaterThan(0);
  });

  it('calls a value coming soon while plain words plan it and the spec lacks it', () => {
    const sources = structuredClone(loadSources());
    const plain = sources.plain as { enums: Record<string, Record<string, unknown>>; addOns: Record<string, unknown> };
    plain.enums.TStream = { ...plain.enums.TStream, TELEPORT: { label: 'Teleport {T}', plain: 'Test only.', planned: 'coming soon: a test value' } };
    plain.addOns['teleport-pad'] = { label: 'Teleport pad', what: 'Test only.', tell: 'Test only.', planned: 'coming soon: a test add-on', params: {} };
    const planned = createModel(sources, lib);
    const doc = draft();
    doc.spec.tStream = 'TELEPORT';
    (doc.spec.addOns as unknown[]).push({ addOn: 'teleport-pad', params: {} });
    const byPath = Object.fromEntries(checkSpec(planned, doc).problems.map((p) => [p.path, p]));
    expect(byPath.tStream?.message).toBe('"TELEPORT" (Teleport the token) is coming soon: not in this version of the spec yet (coming soon: a test value).');
    expect(byPath['addOns[1]']?.message).toBe('The add-on "teleport-pad" (Teleport pad) is coming soon: not in this version of the spec yet (coming soon: a test add-on).');
    expect(renderMenu(planned)).toContain('add-on "teleport-pad": Teleport pad (coming soon: a test add-on)');
  });

  it('refuses a context that does not match the version', () => {
    const doc = draft();
    doc.spec.version = 1;
    expect(checkSpec(model, doc).problems).toEqual([
      { path: 'context', message: 'Context "v2" is for version 2 boxes, but the spec says version 1.', fix: 'Every new box is "context": "v2" with "version": 2.' },
    ]);
  });

  it('hints the right decimal for an amount written as a JSON number: whole units, or raw units when it is that large', () => {
    const cap = (capPerEpoch: unknown) =>
      withSpec((s) => (s.addOns as unknown[]).push({ addOn: 'creator-fee-cap', params: { capPerEpoch, excess: 'BURN' } })).problems.find((p) => p.path === 'addOns[1].params.capPerEpoch');
    expect(cap(4)?.fix).toBe('Write { "decimal": "4" } for 4 ETH, or the raw integer as a string.');
    // 4 ETH in raw units as a JSON number: never "{ "decimal": "4000000000000000000" }" (that is 4e18 ETH).
    expect(cap(4000000000000000000)?.fix).toBe('Write { "decimal": "4" } for 4 ETH (this JSON number reads as 4000000000000000000 raw units), or the raw integer as a string: "4000000000000000000".');
    expect(cap(1e21)?.fix).toBe('Write { "decimal": "1000" } for 1000 ETH (this JSON number reads as 1000000000000000000000 raw units), or the raw integer as a string: "1000000000000000000000".');
    expect(withSpec((s) => (s.raise = 4.206980085)).problems.find((p) => p.path === 'raise')?.fix).toBe('Write { "decimal": "4.206980085" } for 4.206980085 ETH, or the raw integer as a string.');
  });

  it('flags an amount that looks like a unit mistake', () => {
    const result = withSpec((s) => {
      s.creatorBuy = '5';
    });
    expect(result.ok).toBe(true);
    expect(result.warnings?.[0]).toBe('creatorBuy is 5 raw units (0.000000000000000005 ETH): did you mean { "decimal": "5" }?');
  });
});

describe('refusals in plain words', () => {
  const cases: [string, (s: Record<string, unknown>) => void, string, RegExp][] = [
    ['an emoji in the name', (s) => (s.tokenName = 'Gas 🔥 Guzzlers'), 'BAD_CHARACTER@tokenName', /contains "🔥" \(U\+1F525\)/],
    ['a long dash in the description', (s) => (s.description = 'Fuel — cans'), 'BAD_CHARACTER@description', /Replace it with -\.$/],
    ['a long ticker', (s) => (s.tokenSymbol = 'GUZZLERSTOKEN'), 'LENGTH_OUT_OF_RANGE@tokenSymbol', /13 characters; at most 11/],
    ['too few items', (s) => (s.n = 5), 'OUT_OF_RANGE@n', /between 10 and 10,000; it is 5/],
    ['a raise that is not the one raise', (s) => (s.raise = { decimal: '2' }), 'RAISE_NOT_A_PRESET@raise', /Every box raises the same: 4\.206980085 ETH .*It is 2 ETH now/],
    ["version 2's former 1 ETH preset", (s) => (s.raise = { decimal: '1' }), 'RAISE_NOT_A_PRESET@raise', /"raise": \{ "decimal": "4\.206980085" \}/],
    ['a 45-day deadline', (s) => (s.deadlineDays = 45), 'NOT_A_MEMBER@deadlineDays', /30, 60, 90 or 180 days/],
    ['no deadline', (s) => (s.deadlineDays = 0), 'DEADLINE_RULE@deadlineDays', /needs a deadline/],
    ['burning ETH', (s) => Object.assign(s, { qStream: 'BURN_Q', tStream: 'BURN_T', creatorFeeRecipient: '0x0' }), 'MENU_RULE@qStream', /ETH cannot/],
    ['selling while buying back', (s) => Object.assign(s, { qStream: 'BUYBACK_BURN_T', tStream: 'SELL_FOR_Q', creatorFeeRecipient: '0x0' }), 'MENU_RULE@tStream', /trade against itself/],
    ['creator fees without an address', (s) => (s.creatorFeeRecipient = '0x0'), 'ZERO_VALUE@creatorFeeRecipient', /need a payout address/],
    ['an address nobody pays', (s) => Object.assign(s, { qStream: 'BUYBACK_BURN_T', tStream: 'BURN_T', addOns: [] }), 'MUST_BE_ZERO@creatorFeeRecipient', /payout address must be zero/],
    ['a creator buy of the whole raise', (s) => (s.creatorBuy = { decimal: '4.206980085' }), 'OUT_OF_RANGE@creatorBuy', /below the raise/],
    ['hidden art without placeholders', (s) => Object.assign(s, { artMode: 'HIDDEN', revealListId: '0x0' }), 'ADD_ON_REQUIRED@artMode', /needs that add-on/],
    ['hidden art with a public list', (s) => (s.artMode = 'HIDDEN'), 'MUST_BE_ZERO@revealListId', /reveal list secret/],
    ['open art without its list', (s) => (s.revealListId = '0x0'), 'ZERO_VALUE@revealListId', /publishes its reveal list/],
    ['existing NFTs', (s) => (s.boxType = 'EXISTING'), 'NOT_OFFERED@boxType', /not offered yet: later/],
    ['holder payouts', (s) => (s.qStream = 'PAY_HOLDERS_Q'), 'NOT_OFFERED@qStream', /Demo only for now, marked pending legal review.*--network demo/],
    ['a 3% royalty', (s) => (royalty(s).bps = 300), 'NOT_A_MEMBER@addOns.royalties.bps', /one of 0, 100, 250, 500/],
    ['a creator royalty without an address', (s) => Object.assign(s, { qStream: 'BUYBACK_BURN_T', tStream: 'BURN_T', creatorFeeRecipient: '0x0' }), 'ZERO_VALUE@creatorFeeRecipient', /Fees or royalties that go to the creator need a payout address/],
    ['a payout address with royalties to the fees', (s) => {
      Object.assign(s, { qStream: 'BUYBACK_BURN_T', tStream: 'BURN_T' });
      royalty(s).destination = 'FEE_HANDLING';
    }, 'MUST_BE_ZERO@creatorFeeRecipient', /neither a fee side nor the royalties go to the creator/],
    ['add-ons out of order', (s) => (s.addOns as unknown[]).push({ addOn: 'edition-specials', params: { label: 'Jet', count: 3 } }), 'ADD_ON_ORDER@addOns', /List them as: edition-specials, royalties/],
    ['a fee cap without a creator side', (s) => {
      Object.assign(s, { qStream: 'BUYBACK_BURN_T', tStream: 'BURN_T', creatorFeeRecipient: '0x0' });
      Object.assign(royalty(s), { destination: 'FEE_HANDLING' });
      (s.addOns as unknown[]).push({ addOn: 'creator-fee-cap', params: { capPerEpoch: { decimal: '4' }, excess: 'BURN' } });
    }, 'ADD_ON_CONFLICT@addOns.creator-fee-cap', /needs a creator option on at least one fee side/],
    ['fees above the cap to holders', (s) => (s.addOns as unknown[]).push({ addOn: 'creator-fee-cap', params: { capPerEpoch: { decimal: '4' }, excess: 'HOLDERS' } }), 'NOT_OFFERED@addOns.creator-fee-cap.excess', /Demo only for now.*--network demo/],
    ['a cap that is not a preset', (s) => (s.addOns as unknown[]).push({ addOn: 'creator-fee-cap', params: { capPerEpoch: { decimal: '5' }, excess: 'BURN' } }), 'NOT_A_MEMBER@addOns.creator-fee-cap.capPerEpoch', /must be one of 1, 4, 8, 16 or 32 ETH; it is 5 ETH/],
    ['five teasers', (s) => (s.addOns as unknown[]).push({ addOn: 'collection-metadata', params: { bannerSha256: '0x0', teaserSha256s: Array(5).fill(MARKER), externalLink: '' } }), 'LENGTH_OUT_OF_RANGE@addOns.collection-metadata.teaserSha256s', /at most 4; it lists 5/],
    ['a teaser of zeros', (s) => (s.addOns as unknown[]).push({ addOn: 'collection-metadata', params: { bannerSha256: '0x0', teaserSha256s: ['0x0'], externalLink: '' } }), 'ZERO_VALUE@addOns.collection-metadata.teaserSha256s', /"FROM_LAUNCH_FLOW" for each picture/],
    ['a collection page link without https', (s) => (s.addOns as unknown[]).push({ addOn: 'collection-metadata', params: { bannerSha256: '0x0', teaserSha256s: [], externalLink: 'http://guzz.example' } }), 'BAD_CHARACTER@addOns.collection-metadata.externalLink', /must start with https:\/\//],
    ['a token-only box with a collection', (s) => (s.boxType = 'TOKEN_ONLY'), 'MUST_BE_ZERO@collectionName', /must be empty for this kind of box \(Just the token\)/],
    ['a token-only box with royalties', (s) => Object.assign(s, { boxType: 'TOKEN_ONLY', collectionName: '', collectionSymbol: '', n: 0, artMode: 0, revealRoot: '0x0', metadataTable: '0x', revealListId: '0x0', marketplaceOwner: '0x0', collectionCoverSha256: '0x0' }), 'ADD_ON_CONFLICT@addOns.royalties', /does not fit this kind of box/],
    ['a token-only box with a collection cover', (s) => Object.assign(s, { boxType: 'TOKEN_ONLY', collectionName: '', collectionSymbol: '', n: 0, artMode: 0, revealRoot: '0x0', metadataTable: '0x', revealListId: '0x0', marketplaceOwner: '0x0', addOns: [] }), 'MUST_BE_ZERO@collectionCoverSha256', /"collectionCoverSha256": "0x0+"/],
    ['a token-only box with an owner', (s) => Object.assign(s, { boxType: 'TOKEN_ONLY', collectionName: '', collectionSymbol: '', n: 0, artMode: 0, revealRoot: '0x0', metadataTable: '0x', revealListId: '0x0', addOns: [] }), 'MUST_BE_ZERO@marketplaceOwner', /"marketplaceOwner": "0x0+"/],
    ['a series larger than the box', (s) => (s.addOns as unknown[]).unshift({ addOn: 'edition-specials', params: { label: 'Jet', count: 300 } }), 'OUT_OF_RANGE@addOns.edition-specials.count', /between 1 and 100 \(items of the box\)/],
    ['the box-0 stream add-on', (s) => (s.addOns as unknown[]).unshift({ addOn: 'per-item-stream', params: {} }), 'ADD_ON_NOT_AVAILABLE@addOns.per-item-stream', /only in version 1/],
    ['placeholders on open art', (s) => (s.addOns as unknown[]).unshift(hiddenAddOn()), 'ADD_ON_CONFLICT@addOns.placeholders', /need hidden art/],
    ['a line break in the hidden picture', (s) => {
      Object.assign(s, { artMode: 'HIDDEN', revealListId: '0x0' });
      (s.addOns as unknown[]).unshift(hiddenAddOn('<svg>\n</svg>'));
    }, 'BAD_CHARACTER@addOns.placeholders.hiddenSvg', /a line break/],
    ['a block count as the opening time', (s) => (s.openAt = 300), 'OUT_OF_RANGE@openAt', /must be 0 \(Now\) or a UTC time from 2026-09-01 00:00 UTC on; it is 300 \(1970-01-01 00:05 UTC: a block count or a delay, not a time\)\. Set "openAt" to 0 for Now, or a UTC time like "2026-10-06T18:00:00Z" \(at most 14 days after Create\)\.$/],
    ['no logo', (s) => (s.coverSha256 = '0x0'), 'ZERO_VALUE@coverSha256', /"coverSha256": "FROM_LAUNCH_FLOW"/],
    ['no collection cover', (s) => (s.collectionCoverSha256 = '0x0'), 'ZERO_VALUE@collectionCoverSha256', /"collectionCoverSha256": "FROM_LAUNCH_FLOW"/],
    ['version 3', (s) => (s.version = 3), 'UNSUPPORTED_VERSION@version', /every new box is version 2/],

  ];

  it.each(cases)('%s', (_name, patch, expected, sentence) => {
    const result: CheckResult = withSpec(patch);
    expect(result.stage).toBe('check');
    const e = result.explanation;
    expect(`${e?.reason}@${e?.field}`).toBe(expected);
    expect(`${e?.sentence} ${e?.fix}`).toMatch(sentence);
    expect(e?.fix).not.toMatch(/references\/fields\.md/);
    const text = renderText(result);
    expect(text).toContain(`Why  ${e?.sentence}`.replace('Why  ', ''));
    expect(text).toContain('The check stops at the first problem');
  });
});

describe('the opening time (field 15 openAt, open-at-clock-time.md)', () => {
  const at = (openAt: unknown, options: { nowMs?: number } = {}) => {
    const doc = draft();
    doc.spec.openAt = openAt;
    return checkSpec(model, doc, options);
  };
  const SIX_PM = Date.UTC(2026, 9, 6, 18, 0, 0);

  it('never guesses a local time, and names the field a block delay was written as', () => {
    for (const text of ['2026-10-06T18:00', '2026-10-06T18:00:00+02:00', 'tomorrow 6 pm', '2026-02-30T18:00:00Z']) {
      const result = at(text);
      expect(result.stage, text).toBe('input');
      expect(result.problems[0]?.path).toBe('openAt');
    }
    expect(at('2026-10-06T18:00').problems[0]?.fix).toContain('"2026-10-06T18:00:00Z"');
    const old = draft();
    delete old.spec.openAt;
    old.spec.openDelayBlocks = 300;
    const problems = checkSpec(model, old).problems.map((p) => `${p.path}: ${p.fix}`);
    expect(problems).toContain('openDelayBlocks: Did you mean "openAt"?');
  });

  it('warns, by the clock it is given, about a time already passed or more than 14 days ahead', () => {
    const passed = at('2026-10-06T18:00:00Z', { nowMs: SIX_PM + 1_000 });
    expect(passed.ok).toBe(true);
    expect(passed.warnings).toContain('The opening time 2026-10-06 18:00 UTC has passed: the box would open in the block after Create, as with Now. Pick a later time, or 0 for Now.');
    expect(at('2026-10-06T18:00:00Z', { nowMs: SIX_PM }).warnings?.some((w) => w.includes('has passed'))).toBe(true);
    const ahead = at('2026-10-06T18:00:00Z', { nowMs: SIX_PM - 1_209_601_000 });
    expect(ahead.warnings).toContain('The opening time 2026-10-06 18:00 UTC is more than 14 days ahead: the box factory refuses it at Create until 2026-09-22 18:00 UTC. Pick a time within 14 days.');
    for (const nowMs of [SIX_PM - 1_000, SIX_PM - 1_209_600_000]) expect(at('2026-10-06T18:00:00Z', { nowMs }).warnings?.filter((w) => w.startsWith('The opening time'))).toEqual([]);
    // Now has no time to miss; without a clock nothing is said.
    expect(at(0, { nowMs: SIX_PM }).warnings?.filter((w) => w.startsWith('The opening time'))).toEqual([]);
    expect(at('2026-10-06T18:00:00Z').warnings?.filter((w) => w.startsWith('The opening time'))).toEqual([]);
  });
});

/** Every line the creator may be told: the notes and warnings of a result. */
const toldOf = (r: CheckResult) => [...(r.warnings ?? []), ...(r.notes ?? [])];
const hiddenDraft = (params: unknown) => {
  const doc = draft();
  Object.assign(doc.spec, { artMode: 'HIDDEN', revealListId: '0x0' });
  (doc.spec.addOns as unknown[]).unshift({ addOn: 'placeholders', params });
  return doc;
};
const plainWords = JSON.parse(readFileSync(join(pkgDir, 'plain-words.v1.json'), 'utf8'));

describe('what the creator is told (F73 persona round)', () => {
  it('explains how a creator is paid, without decision ids, jargon or banned words', () => {
    const result = checkSpec(model, draft());
    const told = toldOf(result).join('\n');
    expect(told).toContain("How the creator is paid: never the raise (it becomes the box's pool), only 10/15 of the 1% fee on the fee sides chosen. Buyers' fees: to the creator in ETH, about 0.0067 ETH per 1 ETH bought. Sellers' fees: to the creator in GUZZ");
    expect(told).toContain('still being reviewed by Square Hole\'s lawyers');
    expect(told).toContain('Demo and testnet only');
    expect(told).toContain('At launch one item is 1/100 of all GUZZ (about 10,000,000 GUZZ); as burns shrink the supply');
    for (const doc of [draft(), hiddenDraft(MARKER)]) {
      const lines = toldOf(checkSpec(model, doc)).join('\n');
      expect(lines).not.toMatch(/\bF\d{2}\b|slice S\d|FLR-|counsel flag|\(Q\)|JSON_TEXT/);
      expect(lines).not.toMatch(/\b(earn|earning|reward|rewards|yield)\b/i);
    }
  });

  it('fills the placeholders add-on with the launch flow\'s own texts and picture for "FROM_LAUNCH_FLOW"', () => {
    const result = checkSpec(model, hiddenDraft(MARKER));
    expect(result.ok).toBe(true);
    const lf = plainWords.addOns.placeholders.launchFlow;
    expect(result.launchFlow).toHaveLength(5);
    const explicit = hiddenDraft({ placeholderName: 'Gas Guzzlers ticket', placeholderSymbol: 'GUZZ-T', placeholderDescription: lf.placeholderDescription, hiddenDescription: lf.hiddenDescription, hiddenSvg: lf.hiddenSvg });
    expect(checkSpec(model, explicit).specHash).toBe(result.specHash);
    expect(checkSpec(model, hiddenDraft({})).specHash).toBe(result.specHash);
    expect(checkSpec(model, hiddenDraft(undefined)).specHash).toBe(result.specHash);
    expect(checkSpec(model, hiddenDraft('defaults')).problems[0]?.path).toBe('addOns[0].params');
    const long = hiddenDraft(MARKER);
    Object.assign(long.spec, { collectionName: 'Parliament of Owls and Friends', collectionSymbol: 'PARLIAMENTS' });
    expect(checkSpec(model, long).overview?.find(([k]) => k === 'Add-ons')?.[1]).toContain('tickets "Parliament of Owls and Fr ticket" (PARLIAMEN-T)');
    const own = hiddenDraft({ placeholderName: MARKER, placeholderSymbol: MARKER, placeholderDescription: 'Opens into one fuel can.', hiddenDescription: 'Not revealed yet.', hiddenSvg: MARKER });
    expect(checkSpec(model, own).ok).toBe(true);
    expect(checkSpec(model, own).warnings).toEqual([]);
    const notes = toldOf(result).join('\n');
    expect(notes).toContain('The trait table (Fuel) is public from creation');
    expect(notes).toContain("Hidden art: during the curve buyers can swap one item's worth of GUZZ for a ticket");
    expect(notes).not.toContain('60 days');
  });

  it('warns about what the launch flow cannot enter: own ticket names, separate addresses, a "$" ticker, a bare link', () => {
    const custom = checkSpec(model, hiddenDraft({ placeholderName: 'Guzz egg', placeholderSymbol: 'GUZZ-EGG', placeholderDescription: '', hiddenDescription: '', hiddenSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
    expect(custom.warnings?.filter((w) => w.startsWith('The launch flow cannot enter this yet: an own ticket'))).toHaveLength(3);
    expect(custom.enterable).toBe(false);
    const doc = draft();
    Object.assign(doc.spec, { tokenSymbol: '$GUZZ', marketplaceOwner: '0xdce82e76456434d0f550b492ff212a862221e6c5' });
    doc.site = { links: ['discord.gg/guzz', 'http://guzz.example', 'https://guzz.example', '@guzz'] };
    const result = checkSpec(model, doc);
    expect(result.ok).toBe(true);
    const warnings = result.warnings ?? [];
    expect(warnings).toContain('The ticker $GUZZ starts with "$": sites add the $ themselves, so it would show as $$GUZZ. Write "GUZZ".');
    expect(warnings.some((w) => w.startsWith('The launch flow cannot enter this yet: different addresses'))).toBe(true);
    expect(warnings).toContain('This link is not used: "discord.gg/guzz" (links must start with https:// and contain no spaces; X also takes an @handle). Did you mean "https://discord.gg/guzz"?');
    expect(warnings.some((w) => w.includes('Did you mean "https://guzz.example"?'))).toBe(true);
    expect(warnings.some((w) => w.includes('"@guzz"') || w.includes('"https://guzz.example" ('))).toBe(false);
    expect(renderText(result)).toContain('Check first');
    expect(checkSpec(model, draft()).warnings).toEqual([]);
  });

  it('suggests only choices that work for this box, and planned pricing assets by name', () => {
    const unknown = withSpec((s) => (s.qStream = 'TELEPORT'));
    const fix = unknown.problems.find((p) => p.path === 'qStream')?.fix ?? '';
    expect(fix).toBe('Pick one of: "BUYBACK_BURN_T", "ALL_TO_FIT", "TO_CREATOR", "CREATOR_IN_T".');
    const holders = withSpec((s) => (s.qStream = 'HOLDERS_IN_T'));
    expect(holders.explanation?.sentence).toMatch(/is not offered yet: Demo only for now, marked pending legal review/);
    expect(holders.explanation?.fix).toContain('"CREATOR_IN_T" (To the creator, in GUZZ)');
    expect(holders.explanation?.fix).not.toContain('BURN_Q');
    const usdc = withSpec((s) => (s.q = 'USDC'));
    expect(usdc.problems.find((p) => p.path === 'q')?.fix).toMatch(/Planned: USDC: a proposal for later/);
  });

  it('lists every character that is not allowed at once, with a suggested text', () => {
    const result = withSpec((s) => (s.description = 'Horses — ink and watercolour, who’s next?'));
    expect(result.explanation?.sentence).toBe('Description contains 2 characters that are not allowed: "—" (U+2014) and "’" (U+2019).');
    expect(result.explanation?.fix).toContain('For example: "Horses - ink and watercolour, who\'s next?"');
  });
});

describe('Sepolia offers only what core v1 builds (SH-F74-polish item 5)', () => {
  it('refuses a conversion on Sepolia with what is missing, and accepts it for the Demo and mainnet', () => {
    const doc = draft();
    doc.spec.qStream = 'CREATOR_IN_T';
    const sepolia = checkSpec(model, doc, { network: 'sepolia' });
    expect(sepolia.explanation).toMatchObject({ reason: 'NOT_OFFERED', field: 'qStream' });
    expect(sepolia.explanation?.sentence).toBe('To the creator, in GUZZ ("CREATOR_IN_T") is not built on Sepolia yet: needs the swap module.');
    expect(sepolia.explanation?.fix).toMatch(/^Pick one of Sepolia's choices: .*"ALL_TO_FIT".*"TO_CREATOR"/);
    expect(sepolia.explanation?.fix).not.toMatch(/"CREATOR_IN_T"|"BURN_Q"/);
    for (const network of ['demo', 'mainnet'] as const) expect(checkSpec(model, doc, { network }).ok, network).toBe(true);
    expect(checkSpec(model, draft(), { network: 'sepolia' }).ok).toBe(true);
  });

  it('the menu says what Sepolia leaves out', () => {
    const menu = renderMenu(model);
    expect(menu).toMatch(/"CREATOR_IN_T" [^|]*\(not on Sepolia yet: needs the swap module\)/);
    expect(menu).toMatch(/"SELL_FOR_Q" [^|]*\(not on Sepolia yet: needs the swap module\)/);
    expect(menu).not.toMatch(/"TO_CREATOR" [^|]*not on Sepolia/);
  });
});

describe('words of the F74 polish (SH-F74-polish item 6)', () => {
  it("names the USDC raise as an open ETH-equivalent rule, not presets", () => {
    const menu = renderMenu(model);
    expect(menu).toContain('USDC: a proposal for later; its ETH-equivalent raise rule is open (S12)');
    expect(menu).not.toMatch(/raise presets/);
  });

  it("explains each of the creator-fee cap's two requirements with its own sentence", () => {
    const context = model.contexts.find((c) => c.name === 'v2');
    if (!context) throw new Error('no context v2');
    const doc = draft();
    (doc.spec.addOns as unknown[]).push({ addOn: 'creator-fee-cap', params: { capPerEpoch: { decimal: '4' }, excess: 'BURN' } });
    const { wire } = buildWire(model, doc.spec, context);
    const conflict = { reason: lib.Reason.ADD_ON_CONFLICT, field: lib.Field['addOns.creator-fee-cap'] };
    // A Q other than native ETH (only the vectors' test context lists one today).
    const erc20 = explainVerdict(model, conflict, { ...wire, q: '0x00000000000000000000000000000000000000E2' }, context);
    expect(erc20.sentence).toBe('The cap is a fixed amount of ETH: it needs native ETH as the pricing asset.');
    expect(erc20.fix).toBe('Pair the box with ETH, or remove the creator-fee cap.');
    const noCreator = explainVerdict(model, conflict, { ...wire, qStream: lib.QStream.BUYBACK_BURN_T, tStream: lib.TStream.BURN_T }, context);
    expect(noCreator.sentence).toBe('A cap on creator fees needs a creator option on at least one fee side.');
  });
});

describe('holder payouts per network (F74 U1)', () => {
  const holderDraft = () => {
    const doc = draft();
    Object.assign(doc.spec, { qStream: 'PAY_HOLDERS_Q', tStream: 'HOLDERS_IN_Q', creatorFeeRecipient: '0x0', addOns: [] });
    return doc;
  };

  it('offers them in Demo with the pending legal review note, never on mainnet, not on Sepolia yet', () => {
    const demo = checkSpec(model, holderDraft(), { network: 'demo' });
    expect(demo).toMatchObject({ ok: true, network: 'demo' });
    expect(demo.notes).toContain('Holder payouts are a Demo preview, pending legal review: not offered on testnet or mainnet yet.');
    expect(renderText(demo)).toContain('(context v2, Demo)');
    for (const network of ['sepolia', 'mainnet'] as const) {
      const refused = checkSpec(model, holderDraft(), { network });
      expect(refused.explanation?.reason, network).toBe('NOT_OFFERED');
      expect(refused.explanation?.field, network).toBe('qStream');
    }
    // The default is the strictest network, the factory's own check.
    expect(checkSpec(model, holderDraft()).network).toBe('mainnet');
    expect(checkSpec(model, holderDraft()).ok).toBe(false);
    // The cap's excess to holders follows the same rule.
    const cap = draft();
    (cap.spec.addOns as unknown[]).push({ addOn: 'creator-fee-cap', params: { capPerEpoch: { decimal: '32' }, excess: 'HOLDERS' } });
    expect(checkSpec(model, cap, { network: 'demo' }).ok).toBe(true);
    expect(checkSpec(model, cap).explanation?.field).toBe('addOns.creator-fee-cap.excess');
  });

  it('the command line takes --network and refuses an unknown one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'box-spec-network-'));
    const path = join(dir, 'holders.json');
    writeFileSync(path, JSON.stringify(holderDraft()));
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    expect(run(path, '--network', 'demo').status).toBe(0);
    expect(run(path, '--network', 'sepolia').status).toBe(1);
    expect(run(path).status).toBe(1);
    expect(run(path, '--network', 'moon').status).toBe(2);
  });

  /** The launch flow's Download BoxSpec file of a Demo box with holder payouts: it names the network it was made for. */
  const holderDownload = () => {
    const spec = { ...lib.DEMO_OPEN_ART, qStream: lib.QStream.PAY_HOLDERS_Q };
    return {
      format: FILE_FORMAT,
      context: 'v2',
      network: 'demo',
      specHash: lib.specHash(spec),
      encoded: lib.encodeBoxSpecV1(spec),
      spec: Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
    };
  };

  it('checks a download for the network its file names, unless --network says otherwise', () => {
    const file = holderDownload();
    const fromFile = checkSpec(model, file);
    expect(fromFile).toMatchObject({ ok: true, kind: 'download', network: 'demo', networkFrom: 'file' });
    expect(renderText(fromFile)).toMatch(/^Valid: the factory's check \(context v2, Demo, as the file says\) accepts this spec\.\n/);
    // --network wins over the file.
    expect(checkSpec(model, file, { network: 'mainnet' })).toMatchObject({ ok: false, network: 'mainnet', networkFrom: 'option' });
    // A download without the key, a draft and a bare spec: the strictest, whatever else they carry.
    const unnamed: Record<string, unknown> = { ...file };
    delete unnamed.network;
    expect(checkSpec(model, unnamed)).toMatchObject({ ok: false, network: 'mainnet', networkFrom: 'default' });
    expect(checkSpec(model, { ...holderDraft(), network: 'demo' })).toMatchObject({ ok: false, network: 'mainnet', networkFrom: 'default' });
    // A network the launch flow never writes: not read, said with a fix.
    const odd = checkSpec(model, { ...file, network: 'moon' });
    expect(odd).toMatchObject({ ok: false, stage: 'input' });
    expect(odd.problems.map((p) => p.path)).toEqual(['network']);
    expect(checkSpec(model, { ...file, network: 'moon' }, { network: 'demo' }).ok).toBe(true);
  });

  it('the command line reads the file\'s network when no --network is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'box-spec-file-network-'));
    const path = join(dir, 'holders-boxspec-v1.json');
    writeFileSync(path, JSON.stringify(holderDownload()));
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    const plain = run(path);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('(context v2, Demo, as the file says)');
    expect(run(path, '--network', 'mainnet').status).toBe(1);
    expect(run(path, '--network', 'demo').status).toBe(0);
  });
});

describe('answers before a draft exists (--field, --numbers)', () => {
  it('checks one text on its own', () => {
    const ticker = checkField(model, 'ticker', '$GM');
    expect(ticker.ok).toBe(true);
    expect(ticker.warnings[0]).toMatch(/would show as \$\$GM/);
    const bio = checkField(model, 'description', '250 hand-drawn horses — ink and watercolour… one a day');
    expect(bio.ok).toBe(false);
    expect(bio.bad?.map((b) => b.char)).toEqual(['—', '…']);
    expect(bio.suggestion).toBe('250 hand-drawn horses - ink and watercolour... one a day');
    expect(renderField(bio)).toContain('Suggested:');
    expect(checkField(model, 'name', 'x'.repeat(33)).problems[0]).toMatch(/too long: 33 characters/);
    expect(checkField(model, 'placeholders.placeholderDescription', 'Opens soon.').ok).toBe(true);
    expect(checkField(model, 'royalties', 'x').unknown).toBe(true);
  });

  it('works out values, shares and dollars with bigint', () => {
    const r = numbersOf(model, { raise: '4.206980085', items: '250', buy: '0.05', share: '5', ethUsd: '2,500', usd: '2000' });
    expect(r.ok).toBe(true);
    const row = r.rows?.[0];
    expect(row?.buy?.bps).toBe(347n);
    expect(row?.item?.tokens).toBe(4_000_000n * 10n ** 18n);
    const amount = row?.forShare?.amount ?? 0n;
    const curve = lib.boxCurve(4_206_980_085n * 10n ** 9n, false);
    expect(lib.issuanceBps(lib.curveBuyOut(curve, amount))).toBeGreaterThanOrEqual(500n);
    expect(lib.issuanceBps(lib.curveBuyOut(curve, amount - 1n))).toBeLessThan(500n);
    expect(r.usd?.wei).toBe(8n * 10n ** 17n);
    const text = renderNumbers(r);
    expect(text).toContain('1.3748 ETH (about $3,437) at the first buy');
    expect(text).toContain('a conversion, not a prediction');
    // F74 U5: one raise, so one row.
    expect(numbersOf(model).rows).toHaveLength(1);
    expect(numbersOf(model, { raise: '2' }).problems?.[0]).toMatch(/the one raise every box has: 4\.206980085 ETH/);
    expect(numbersOf(model, { usd: '20' }).problems?.[0]).toMatch(/needs --eth-usd/);
  });
});

describe('the spec read at run time', () => {
  it('has plain words for every field, member, add-on, parameter, reason and rule', () => {
    expect(missingPlainWords(model)).toEqual([]);
  });

  it('lists planned values as coming soon until the spec has them', () => {
    const planned = plannedItems(model);
    for (const item of planned) {
      if (item.kind === 'addOn') expect(lib.ADD_ON_KEYS).not.toContain(item.key);
    }
    const menu = renderMenu(model);
    expect(menu).toContain('Coming soon (planned, not in this spec yet)');
    for (const name of ['BUYBACK_BURN_T', 'ALL_TO_FIT', 'TO_CREATOR', 'BURN_T', 'OPEN', 'HIDDEN', 'royalties', 'edition-specials']) expect(menu).toContain(`"${name}"`);
    expect(menu).toContain('raise (Raise target): 4.206980085 ETH (every box; set by the version)');
    expect(menu).toContain('capPerEpoch: 1 | 4 | 8 | 16 | 32 ETH');
    expect(menu).toContain('collectionCoverSha256 (Collection cover)');
    expect(menu).toContain('Pricing asset USDC: a proposal for later');
    expect(menu).toContain('params: "FROM_LAUNCH_FLOW" for the launch flow\'s own ticket texts and picture');
    expect(menu).not.toMatch(/slice S\d|\(F\d{2}|FLR-|JSON_TEXT|\(Q\)|in Q\b/);
  });

  it('turns seconds into a duration and Unix seconds into a UTC time', () => {
    expect([12, 300, 3_600, 5_400, 86_400, 1_209_600].map(durationText)).toEqual(['about 12 seconds', 'about 5 minutes', 'about 1 hour', 'about 1 hour 30 minutes', 'about 24 hours', 'about 14 days']);
    expect(utcText(1_791_309_600)).toBe('2026-10-06 18:00 UTC');
    expect(utcText(1_791_309_611n)).toBe('2026-10-06 18:00:11 UTC');
    expect(utcText(0)).toBe('1970-01-01 00:00 UTC');
  });

  it('reads opening times (F80) to the second: warned from the second they pass, and from one second over 14 days away', () => {
    const at = (openAt: unknown, nowSeconds: number) => {
      const d = draft();
      d.spec.openAt = openAt;
      return checkSpec(model, d, { nowMs: nowSeconds * 1000 });
    };
    const six = { utc: '2026-10-06T18:00:00Z' };
    expect(at(six, 1_791_309_599).warnings).not.toContainEqual(expect.stringContaining('opening time'));
    expect(at(six, 1_791_309_600).warnings).toContain('The opening time 2026-10-06 18:00 UTC has passed: the box would open in the block after Create, as with Now. Pick a later time, or 0 for Now.');
    const fourteenDays = 1_209_600;
    expect(at('2026-10-06T18:00:00Z', 1_791_309_600 - fourteenDays).warnings).not.toContainEqual(expect.stringContaining('opening time'));
    expect(at('2026-10-06T18:00:00Z', 1_791_309_599 - fourteenDays).warnings).toContain('The opening time 2026-10-06 18:00 UTC is more than 14 days ahead: the box factory refuses it at Create until 2026-09-22 18:00 UTC. Pick a time within 14 days.');
    expect(at(0, 4_000_000_000).warnings).not.toContainEqual(expect.stringContaining('opening time'));
    // Not a UTC time, as text or inside { "utc": ... }: a day that does not exist, an offset other than UTC, a date alone.
    for (const text of ['2026-02-30T18:00:00Z', '2026-10-06T18:00:00+02:00', '2026-10-06']) {
      for (const form of [text, { utc: text }]) {
        const r = at(form, 0);
        expect(r.stage, JSON.stringify(form)).toBe('input');
        expect(r.problems[0]?.path).toBe('openAt');
        expect(r.problems[0]?.fix).toMatch(/^Write it like "2026-10-06T18:00:00Z" \(UTC, ending in Z\), or 0 for Now\.$/);
      }
    }
    for (const bad of ['soon', { utc: 1_791_309_600 }, { time: '2026-10-06T18:00:00Z' }, true]) {
      expect(at(bad, 0).problems[0], JSON.stringify(bad)).toMatchObject({ path: 'openAt', fix: 'Write 0 for Now, or a UTC time like "2026-10-06T18:00:00Z".' });
    }
  });
});

describe('the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'box-spec-check-'));
  const write = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  it('exits 0 for a valid draft and prints the hash, the overview and the notes', () => {
    const r = run(write('ok.json', draft()));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Draft hash: 0x[0-9a-f]{64}/);
    expect(r.stdout).toContain('Overview');
    expect(r.stdout).toContain('Tell the creator');
  });

  it('exits 1 with the plain sentence and the fix for a refused spec', () => {
    const doc = draft();
    doc.spec.qStream = 'BURN_Q';
    const r = run(write('refused.json', doc));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('Refused');
    expect(r.stdout).toMatch(/Fix +Pick "BUYBACK_BURN_T" \(buy back and burn your token\) or "ALL_TO_FIT"/);
  });

  it('checks one field with --field and works out numbers with --numbers', () => {
    expect(run('--field', 'ticker', '$GM')).toMatchObject({ status: 0 });
    expect(run('--field', 'ticker', '$GM').stdout).toContain('would show as $$GM');
    expect(run('--field', 'name', 'gm ☀').status).toBe(1);
    expect(run('--field', 'nope', 'x').status).toBe(2);
    expect(run('--field', 'ticker').status).toBe(2);
    const numbers = run('--numbers', '--raise', '4.206980085', '--buy', '0.05');
    expect(numbers.status).toBe(0);
    expect(numbers.stdout).toContain('0.05 ETH buys about 3.4% of all tokens');
    expect(JSON.parse(run('--numbers', '--json').stdout).rows).toHaveLength(1);
    expect(run('--numbers', '--raise', '2').status).toBe(2);
  });

  it('prints JSON with --json, the menu with --menu, exits 2 on usage errors and 3 on a file that is not JSON', () => {
    const json = JSON.parse(execFileSync(process.execPath, [cli, write('fixture.json', fixture('demo-placeholders')), '--json'], { encoding: 'utf8' }));
    expect(json).toMatchObject({ ok: true, specHash: lib.DEMO_PLACEHOLDERS_SPEC_HASH });
    expect(run('--menu').stdout).toContain('What a box can be today (context v2');
    expect(run('--menu', '--context', 'v9').status).toBe(2);
    expect(run().status).toBe(2);
    expect(run(join(dir, 'missing.json')).status).toBe(2);
    const broken = run(write('broken.json', '{ "spec": '));
    expect(broken.status).toBe(3);
    expect(broken.stderr).toContain('not valid JSON (it ends before the JSON is complete)');
    const token = run(write('token.json', '{ "spec": x }'));
    expect(token.status).toBe(3);
    expect(token.stderr).toContain('not valid JSON (near line 1, column 11, at "x")');
  });
});
