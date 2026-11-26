/**
 * SH-255, second review (job288, 24 November 2026): one test per finding the picture's model and sheets answer for,
 * each first run red against the branch's head 45f7a25e6 (docs/evidence/SH-255.md, "Second review"). The six live
 * boxes (block 12,195,510) and GPU Poor's earlier moments; a state no live box is in is the fixture with that field set.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { getAmount0Delta, getAmount1Delta, getSqrtPriceAtTick } from '@squarehole/indexer/client';
import { parseUnits } from 'viem';
import { bookedReturningRemainders, bookedWithCarry, overstatementBound, partsOfFee, poolCoinsOf, WEIGHTS } from '../../../box-picture/live-figures';
import { pAmountV2 } from '../stats-v2';
import type { V2Snapshot } from '../indexer-v2';
import { parseSnapshotV2 } from '../indexer-v2';
import { recordV2 } from '../record-v2';
import { boxPictureFixture, coinDecimalsOf, coinSymbolOf } from '../test-support/box-picture-v2';
import { gpuPoorLifeV2, sepoliaLifeSourceV2 } from '../test-support/life-v2';
import { required } from '../test-support/required';
import { canStillGraduateV2, liveModelOf, livePictureOf, type LiveContext } from './live-picture';
import { sheetOf, type LivePartId } from './LiveSheets';
import { holderBadgeText, liveLayers, stateLines } from './LiveLayers';

type Json = Record<string, unknown>;
const NO_ALCHEMIST = { buyers: false, sellers: false } as const;
const Q96 = 2n ** 96n;

function contextOf(view: V2Snapshot, extra: Partial<LiveContext> = {}): LiveContext {
  const pile = view.m3?.pile ?? null;
  const asset = pile ? pile.asset : null;
  const pileCoin = asset ? { symbol: /^0x0{40}$/i.test(asset) ? 'ETH' : coinSymbolOf(asset) ?? '', decimals: coinDecimalsOf(asset) ?? 18 } : null;
  return { nowSec: view.timestamp, alchemist: NO_ALCHEMIST, pileCoin, ...extra };
}
/** A box as the page reads it, its snapshot changed where a test needs a state no live box is in. */
function boxOf(name: string, change: (view: V2Snapshot) => V2Snapshot = (v) => v, extra: Partial<LiveContext> = {}) {
  const f = boxPictureFixture(name);
  const view = change(f.view);
  const context = contextOf(view, extra);
  const model = liveModelOf(f.record, view, context);
  const sheet = (id: LivePartId) => {
    const s = sheetOf(id, { record: f.record, view, model, nowSec: context.nowSec ?? view.timestamp, pileCoin: context.pileCoin, creatorClaim: null });
    return { ...s, html: renderToStaticMarkup(<>{s.body}</>) };
  };
  return { ...f, view, model, sheet };
}
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const resultsOf = (html: string): string[] => [...html.matchAll(/<section class="sh-bpic-results"[\s\S]*?<\/section>/g)].map((m) => m[0]);

describe('R-2: box totals stay box totals in a side’s sheet', () => {
  it('GPU Poor: both sheets show the buy-back’s totals under "Buy-back progress", identical, none as the side’s own', () => {
    const box = boxOf('gpu-poor');
    const buyers = box.sheet('buyers').html;
    const sellers = box.sheet('sellers').html;
    expect(resultsOf(buyers)).toHaveLength(1);
    expect(resultsOf(sellers)).toEqual(resultsOf(buyers));
    expect(text(required(resultsOf(sellers)[0]))).toMatch(/^Buy-back progress Spent 0\.47971800001157151 tNVDA Burned 984,?378\.355669778200792201 VRAM/);
    // Outside that card's title the sellers' sheet holds only the sellers' own figures (no fees yet: zero).
    const own = text(sellers.replace(required(resultsOf(sellers)[0]), ''));
    expect(own).not.toMatch(/Spent|Burned|Budget/);
  });
  it('a pile’s and an eating box’s totals sit under the Coin pile’s and the Eaten card’s titles', () => {
    const hoard = boxOf('dragons-hoard');
    expect(text(required(resultsOf(hoard.sheet('buyers').html)[0]))).toMatch(/^Coin pile Fees waiting .* Fees moved in /);
    const eat = boxOf('gpu-poor', (v) => ({ ...v, choices: { buyers: 'eat', sellers: 'eat' }, eat: { pendingP: 2n, eatenP: 5n, burned: true } }));
    const results = resultsOf(eat.sheet('buyers').html);
    expect(results.map(text)).toEqual(['Eaten Eaten 0.000000000000000005 tNVDA Waiting 0.000000000000000002 tNVDA']);
    expect(resultsOf(eat.sheet('sellers').html)).toEqual(results);
  });
});

describe('R-3: the pool’s coins are the position’s own amounts, from its two ends', () => {
  it('in range: floor(L·Q96·(B−S)/(S·B)) and floor(L·(S−A)/Q96), on every graduated box', () => {
    for (const name of ['gpu-poor', 'dragons-hoard', 'one-dollar', 'the-alchemist', 'rent-free']) {
      const { view } = boxPictureFixture(name);
      const position = required(view.position);
      const s = required(view.pool).sqrtPriceX96;
      const a = getSqrtPriceAtTick(position.tickLower);
      const b = getSqrtPriceAtTick(position.tickUpper);
      const amount0 = (position.liquidity * Q96 * (b - s)) / (s * b);
      const amount1 = (position.liquidity * (s - a)) / Q96;
      const coins = required(poolCoinsOf(position, s, view.record.q, view.token));
      const priceFirst = /^0x0{40}$/i.test(view.record.q) || BigInt(view.record.q) < BigInt(view.token);
      expect(coins, name).toEqual(priceFirst ? { price: amount0, token: amount1 } : { price: amount1, token: amount0 });
    }
  });
  it('at or beyond an end one coin is used up: never both printed', () => {
    const position = { liquidity: 10n ** 21n, tickLower: -887220, tickUpper: 887220 };
    const low = getSqrtPriceAtTick(-887220);
    const high = getSqrtPriceAtTick(887220);
    const zero = '0x0000000000000000000000000000000000000000';
    const token = '0x00000000000000000000000000000000000000ff';
    expect(poolCoinsOf(position, high, zero, token)).toEqual({ price: 0n, token: getAmount1Delta(low, high, position.liquidity, false) });
    expect(poolCoinsOf(position, low, zero, token)).toEqual({ price: getAmount0Delta(low, high, position.liquidity, false), token: 0n });
    expect(poolCoinsOf(position, high + 1n, zero, token)?.price).toBe(0n);
    expect(poolCoinsOf({ ...position, liquidity: 0n }, high, zero, token)).toBeNull();
  });
});

describe('R-1, round 3 D1/D4/D5: one population for every fee amount; the sheet prints the parts exactly', () => {
  it('D1: money that is not a collected fee never moves a fee amount; no note carries a number', () => {
    // A royalty of 15 P split through the receiver books 10 to Burn and 3 to the Safes (job290 finding 1): here the
    // buy-back's budget and the Safes' payouts grow while the collected fees stay as they are.
    const plus = 15_000_000_000_000_000_000n;
    const box = boxOf('gpu-poor', (v) => ({
      ...v,
      money: v.money && { ...v.money, owed: { ...v.money.owed, buyBackP: v.money.owed.buyBackP + plus } },
      safePaid: v.safePaid && { ...v.safePaid, fit: { ...v.safePaid.fit, [v.record.q.toLowerCase()]: (v.safePaid.fit[v.record.q.toLowerCase()] ?? 0n) + plus } },
    }));
    const plain = boxOf('gpu-poor');
    expect(box.model.ledger.map((line) => [line.choice, line.amount, line.note])).toEqual(plain.model.ledger.map((line) => [line.choice, line.amount, line.note]));
    expect(box.model.ledger.map((line) => [line.choice, line.amount, line.note])).toEqual([['burn', '0.5988', null], ['pool', '0.1197', null], ['mark', '0.1796', null]]);
    expect(box.model.numbers).toEqual(plain.model.numbers);
    // The box's totals keep their own place: the Safes' payouts in Square Hole's sheet, the budget under Buy-back progress.
    expect(text(box.sheet('mark').html)).toContain('Safe payouts Paid to FIT Safe 15.');
    expect(text(box.sheet('buyers').html)).toContain('Budget 15.09532264696332113');
  });
  it('D4: carried remainders give exactly the parts of the total; returned remainders at most m·floor(14N/15) fewer', () => {
    const fees = [14n, 29n, 1_000_003n, 7n, 15n, 44n, 999n];
    const sum = fees.reduce((a, b) => a + b, 0n);
    expect(bookedWithCarry(fees)).toEqual(partsOfFee(sum));
    // The review's case: fifteen fees of 14 smallest units each, every remainder returned: nothing booked anywhere.
    const fifteen = Array.from({ length: 15 }, () => 14n);
    expect(bookedReturningRemainders(fifteen)).toEqual({ pick: 0n, pool: 0n, squareHole: 0n });
    expect(partsOfFee(210n)).toEqual({ pick: 140n, pool: 28n, squareHole: 42n });
    for (const [part, weight] of Object.entries(WEIGHTS) as [keyof typeof WEIGHTS, bigint][]) {
      expect(partsOfFee(210n)[part] - bookedReturningRemainders(fifteen)[part]).toBe(overstatementBound(weight, 15n));
      expect(partsOfFee(sum)[part] - bookedReturningRemainders(fees)[part] <= overstatementBound(weight, BigInt(fees.length))).toBe(true);
    }
  });
  it('D5: a fee of 1.000000 in a six-decimal coin reads 1, 0.66666, 0.133332, 0.199998 in its sheet', () => {
    const box = boxOf('rent-free', (v) => ({ ...v, feesP: { buyers: 1_000_000n, sellers: 0n } }));
    expect(box.view.decimals).toBe(6);
    const sheet = box.sheet('buyers').html;
    expect(text(required(sheet.match(/<p class="sh-bpic-big">[\s\S]*?<\/p>/))[0])).toBe('1 tUSDC');
    const parts = [...sheet.matchAll(/<span class="sh-pic-ledger__amount"><b>([^<]*)<\/b>/g)].map((m) => m[1]);
    expect(parts).toEqual(['0.66666', '0.133332', '0.199998']);
  });
  it('D5: on every fixture the three exact parts plus the fee’s remainder of 15 make the fee; drawing and ledger print short', () => {
    for (const name of ['gpu-poor', 'dragons-hoard', 'one-dollar', 'the-alchemist', 'rent-free']) {
      const box = boxOf(name);
      for (const side of ['buyers', 'sellers'] as const) {
        const fee = required(box.view.feesP)[side];
        const html = box.sheet(side).html;
        const shown = [...html.matchAll(/<span class="sh-pic-ledger__amount"><b>([^<]*)<\/b>/g)].map((m) => parseUnits(required(m[1]).replace(/,/g, ''), box.view.decimals));
        expect(shown, `${name} ${side}`).toHaveLength(3);
        expect(shown.reduce((a, b) => a + b, 0n) + (fee % 15n), `${name} ${side}`).toBe(fee);
        // The drawing: each figure in the site's own short form, by itself (pAmountV2).
        expect(box.model.visitor[side]).toBe(pAmountV2(fee, box.view.decimals));
        expect(box.model.numbers.stations[side]).toBe(pAmountV2(partsOfFee(fee).pick, box.view.decimals));
      }
    }
  });
});

describe('R-4: the buy-back’s exact figures stay wherever they are known', () => {
  it('the token’s sheet carries Buy-back progress on every box, before graduation too, Unavailable when unread', () => {
    const sam = boxOf('sam');
    expect(sam.model.stage).toBe('raising');
    expect(text(required(resultsOf(sam.sheet('token').html)[0]))).toBe('Buy-back progress Spent 0 ETH Burned 0 sam Waiting to burn 0 sam Budget 0 ETH');
    const unread = boxOf('sam', (v) => ({ ...v, money: null }));
    expect(text(required(resultsOf(unread.sheet('token').html)[0]))).toBe('Buy-back progress Spent 0 ETH Burned 0 sam Waiting to burn Unavailable Budget Unavailable');
    // A side that burns shows them with or without its fee figures.
    const noFees = boxOf('gpu-poor', (v) => ({ ...v, feesP: null }));
    expect(resultsOf(noFees.sheet('buyers').html)).toHaveLength(1);
  });
});

describe('R-5: a module side is The Alchemist only once checked; an unread eat and an in-vault burn are drawn as known', () => {
  it('The Alchemist unchecked: no conversion line, no Alchemist drawing, no conversion rows', () => {
    const box = boxOf('the-alchemist');
    expect(box.model.ledger[0]).toMatchObject({ label: 'Fee module', note: null });
    expect(livePictureOf(box.model).sides.buyers.icon).toBeNull();
    expect(text(box.sheet('buyers').html)).not.toMatch(/converted|Added by conversion|into the pile/);
    const checked = boxOf('the-alchemist', (v) => v, { alchemist: { buyers: true, sellers: false } });
    expect(livePictureOf(checked.model).sides.buyers.icon).toBe('alchemist-pile');
    expect(text(checked.sheet('buyers').html)).toMatch(/tGOLD converted|Added by conversion/);
    // No note with a number on the ledger line, checked or not (round 3 D3): the conversions are in the sheet.
    expect(checked.model.ledger[0]?.note).toBeNull();
  });
  it('round 3 D8: two module sides, one checked: neither sheet shows the conversions (one history over both sides)', () => {
    const both = boxOf('the-alchemist', (v) => ({ ...v, choices: { buyers: 'module', sellers: 'module' }, modules: v.modules && { buyers: v.modules.buyers, sellers: v.modules.buyers } }), { alchemist: { buyers: true, sellers: false } });
    for (const side of ['buyers', 'sellers'] as const) expect(text(both.sheet(side).html), side).not.toMatch(/converted|Added by conversion/);
    const all = boxOf('the-alchemist', (v) => ({ ...v, choices: { buyers: 'module', sellers: 'module' }, modules: v.modules && { buyers: v.modules.buyers, sellers: v.modules.buyers } }), { alchemist: { buyers: true, sellers: true } });
    expect(text(all.sheet('buyers').html)).toMatch(/converted/);
  });
  it('an eat side not read yet draws no lock; an items side that burns in the vault draws the collection that burns', () => {
    const unread = boxOf('gpu-poor', (v) => ({ ...v, choices: { buyers: 'eat', sellers: 'burn' }, eat: null }));
    expect(livePictureOf(unread.model).sides.buyers.icon).toBeNull();
    const burns = boxOf('rent-free', (v) => ({ ...v, choices: { buyers: 'items', sellers: 'items' }, spec: { ...v.spec, buyers: { ...v.spec.buyers, a: { ...v.spec.buyers.a, dest: 8, destParams: `0x${'0'.repeat(63)}2` } } } }));
    expect(livePictureOf(burns.model).sides.buyers.icon).toBe('collection-burn');
  });
});

describe('R-6, round 3 D2: a shop is a shop; its own rows stay under its own title', () => {
  it('the contents sheet names the shop; the sellers’ line is the rule’s part; the shop’s rows as ShopV2 prints them', () => {
    const box = boxOf('gpu-poor', (v) => ({
      ...v,
      spec: { ...v.spec, boxType: 4 },
      choices: { buyers: 'burn', sellers: 'shop' },
      feesP: { buyers: v.feesP?.buyers ?? 0n, sellers: 15_000_000_000_000_000n },
      shopFees: { preset: 2, money: { pendingP: 0n, budgetT: 7n * 10n ** 18n, ceilingT: 9n * 10n ** 18n, feesT: 2n * 10n ** 18n, feesWanted: true }, history: { queuedP: 3_000_000_000_000_000n, resolvedP: 0n, spentP: 0n, boughtT: 0n } },
      m2: { history: { failed: false, shop: null, starter: null, batches: { 2: { fundingP: 1_000_000_000_000_000n, complete: true, holderP: 1_000_000_000_000_000n, residueP: 0n, paidP: 0n, tipsP: 0n, flushedP: 0n, payments: {} } } }, money: null },
    } as V2Snapshot));
    expect(text(box.sheet('contents').html)).toBe('Shop');
    expect(box.model.ledger.map((line) => [line.key, line.amount])).toEqual([['buyers', '0.5988'], ['sellers', '0.01'], ['pool', '0.1217'], ['mark', '0.1826']]);
    expect(text(required(resultsOf(box.sheet('sellers').html)[0]))).toBe('Fees into the shop Budget 7 VRAM From fees 2 VRAM Waiting 0 tNVDA To holders 0.001 tNVDA');
  });
});

describe('R-7: holders’ Paid follows each coin they are paid in', () => {
  it('holders in the price coin on one side, in the box’s coin on the other: one Paid row in each coin', () => {
    const box = boxOf('gpu-poor', (v) => ({
      ...v,
      choices: { buyers: 'holders', sellers: 'holders-t' },
      m2: { history: { failed: false, shop: null, starter: null, batches: { 1: { fundingP: 9n, complete: true, holderP: 9n, residueP: 0n, paidP: 7n, tipsP: 0n, flushedP: 0n, payments: {} } } }, money: null },
      payInT: { history: { boughtT: 0n, holdersFundedT: 0n, itemsFundedT: 0n, holdersPaidT: 0n, itemsPaidT: 0n, batches: {} }, money: null },
    } as V2Snapshot));
    expect(text(box.sheet('holders').html)).toContain('Paid 0.000000000000000007 tNVDA Paid 0 VRAM');
  });
});

describe('R-8: the inbox as the Inbox card reads it', () => {
  const withInbox = (inbox: Json | null) => (v: V2Snapshot) => ({ ...v, money: v.money && { ...v.money, inbox: inbox as never } });
  it('the price coin is not an other coin; a partial read says so; royalties stay known without balances', () => {
    const q = boxPictureFixture('gpu-poor').view.record.q.toLowerCase();
    const base = required(boxPictureFixture('gpu-poor').view.money?.inbox ?? null) as unknown as Json;
    const p = boxOf('gpu-poor', withInbox({ ...base, balances: { [q]: 5n }, complete: true }));
    expect(p.model.inbox.coins).toBe(0);
    const partial = boxOf('gpu-poor', withInbox({ ...base, balances: {}, complete: false }));
    expect(text(partial.sheet('inbox').html)).toContain('Some coins could not be read.');
    const missing = boxOf('gpu-poor', withInbox(null));
    expect(text(missing.sheet('inbox').html)).toBe('Royalties in tNVDA in the box 0 tNVDA Inbox balances unavailable.');
    expect(missing.sheet('inbox').whyLabel).toBe('About the inbox');
  });
});

describe('round 3 D14, 3b G5: the inbox on the picture: never a final count from a partial read; royalties light it', () => {
  const base = () => required(boxPictureFixture('gpu-poor').view.money?.inbox ?? null) as unknown as Json;
  const draw = (inbox: Json | null, royaltyHeldP = 0n) => {
    const box = boxOf('gpu-poor', (v) => ({ ...v, money: v.money && { ...v.money, owed: { ...v.money.owed, royaltyHeldP }, inbox: inbox as never } }));
    const layers = liveLayers(box.model, 'x', { open: false, onOpen: () => undefined });
    return renderToStaticMarkup(<svg>{layers.words}{layers.controls}</svg>);
  };
  it('one other coin read, another not: no badge, the muted envelope, and the Inbox card’s own line as its description', () => {
    const whole = draw({ ...base(), balances: { '0x00000000000000000000000000000000000000ee': 3n }, complete: true });
    expect(whole).toContain('data-number="inbox"');
    expect(whole).toMatch(/<desc id="x-desc-inbox">1<\/desc>/);
    const partial = draw({ ...base(), balances: { '0x00000000000000000000000000000000000000ee': 3n }, complete: false });
    expect(partial).not.toContain('data-number="inbox"');
    expect(partial).toMatch(/<desc id="x-desc-inbox">Some coins could not be read.<\/desc>/);
    expect(partial).toContain('sh-bpic-inbox--empty');
  });
  it('a known royalty balance lights the envelope with the other coins’ read missing or partial', () => {
    for (const inbox of [null, { ...base(), balances: {}, complete: false }]) {
      const html = draw(inbox, 5n);
      expect(html).not.toContain('sh-bpic-inbox--empty');
      expect(html).not.toContain('data-number="inbox"');
    }
  });
});

describe('round 3b G6: a long holder count stays inside its badge and the drawing', () => {
  it('six digits print the site’s short form, the badge inside the 400-unit drawing, its text no wider than the badge', () => {
    expect(holderBadgeText('4')).toBe('4');
    expect(holderBadgeText('999')).toBe('999');
    expect(holderBadgeText('123,456')).toBe('123.45K');
    const box = boxOf('rent-free', (v) => ({ ...v, statistics: v.statistics && { ...v.statistics, holderCount: 123_456n } }));
    const html = renderToStaticMarkup(<svg>{liveLayers(box.model, 'x', { open: false, onOpen: () => undefined }).words}</svg>);
    const rect = required(html.match(/<rect x="([\d.]+)" y="170" width="([\d.]+)"[^>]*data-badge-shape="holders"/));
    const x = Number(rect[1]); const width = Number(rect[2]);
    expect(x + width).toBeLessThanOrEqual(400);
    const text = required(html.match(/<text x="([\d.]+)"[^>]*data-number="holders">([^<]*)<\/text>/));
    expect(text[2]).toBe('123.45K');
    // 12-unit digits are at most 7 units wide each: the text fits the badge around its centre.
    expect(Number(text[1]) - (text[2]?.length ?? 0) * 3.5).toBeGreaterThanOrEqual(x);
    expect(Number(text[1]) + (text[2]?.length ?? 0) * 3.5).toBeLessThanOrEqual(x + width);
  });
});

describe('round 3 D15 b: a box closed after its graduation timed out', () => {
  it('its Raise (?) withholds "Full, the box graduates."', () => {
    const box = boxOf('gpu-poor', (v) => ({ ...v, graduated: false, failed: { cause: 'GraduationTimedOut', at: v.timestamp } }));
    expect(box.model.stage).toBe('failed');
    expect(box.sheet('raise').why.join(' ')).not.toContain('the box graduates');
    expect(boxOf('sam').sheet('raise').why.join(' ')).toContain('Full, the box graduates.');
  });
});

describe('round 3b G2, G3, G4: the pile’s contents, unread totals, Safe payouts in every phase', () => {
  const twoModules = (v: V2Snapshot) => ({ ...v, choices: { buyers: 'module', sellers: 'module' }, modules: v.modules && { buyers: v.modules.buyers, sellers: v.modules.buyers } }) as V2Snapshot;
  it('G2: the contents sheet shows "Added by conversion" only with every module side checked', () => {
    const one = boxOf('the-alchemist', twoModules, { alchemist: { buyers: true, sellers: false } });
    expect(text(one.sheet('contents').html)).not.toContain('Added by conversion');
    const both = boxOf('the-alchemist', twoModules, { alchemist: { buyers: true, sellers: true } });
    expect(text(both.sheet('contents').html)).toContain('Added by conversion');
  });
  it('G3: an unread pile, eat or conversion keeps its titled block, its rows "Unavailable"', () => {
    const pile = boxOf('dragons-hoard', (v) => ({ ...v, pileFees: null }));
    expect(text(required(resultsOf(pile.sheet('buyers').html)[0]))).toBe('Coin pile Fees waiting Unavailable Fees moved in Unavailable');
    const eat = boxOf('gpu-poor', (v) => ({ ...v, choices: { buyers: 'eat', sellers: 'burn' }, eat: null }));
    expect(text(required(resultsOf(eat.sheet('buyers').html)[0]))).toBe('Eaten Eaten Unavailable Waiting Unavailable');
    const conversion = boxOf('the-alchemist', (v) => ({ ...v, alchemist: null }), { alchemist: { buyers: true, sellers: false } });
    expect(text(required(resultsOf(conversion.sheet('buyers').html)[0]))).toMatch(/^Coin pile \S+ converted Unavailable Added by conversion Unavailable$/);
    const coinUnread = boxOf('the-alchemist', (v) => v, { alchemist: { buyers: true, sellers: false }, pileCoin: null });
    expect(text(required(resultsOf(coinUnread.sheet('buyers').html)[0]))).toMatch(/Added by conversion Unavailable$/);
  });
  it('G4: Safe payouts already published show while the box raises; only the fee amount waits', () => {
    const q = boxPictureFixture('sam').view.record.q.toLowerCase();
    const sam = boxOf('sam', (v) => ({ ...v, safePaid: { fit: { [q]: 20n }, platform: { [q]: 10n } } }));
    expect(sam.model.stage).toBe('raising');
    const html = text(sam.sheet('mark').html);
    expect(html).toMatch(/^3 of 15 Safe payouts Paid to FIT Safe 0\.00000000000000002 ETH Paid to platform Safe 0\.00000000000000001 ETH$/);
  });
});

describe('R-9: the countdown and the hatch go by chain time, as the page’s close control does', () => {
  const source = sepoliaLifeSourceV2();
  const at = (stage: 'raising' | 'graduating', edit: (v: V2Snapshot) => V2Snapshot, extra: Partial<LiveContext> = {}) => {
    const view = edit(parseSnapshotV2(gpuPoorLifeV2(stage).body, source));
    const record = recordV2(view, source, null, 'tNVDA');
    const model = liveModelOf(record, view, { nowSec: view.timestamp, alchemist: NO_ALCHEMIST, pileCoin: null, ...extra });
    return { model, html: renderToStaticMarkup(<>{sheetOf('raise', { record, view, model, nowSec: extra.nowSec ?? view.timestamp, pileCoin: null, creatorClaim: null }).body}</>) };
  };
  it('two days before the deadline by chain time the front says 2 days, whatever the reader’s clock says', () => {
    const twoDays = (v: V2Snapshot) => ({ ...v, timestamp: v.gate.deadline - 2n * 86_400n });
    const reader = at('raising', twoDays, { nowSec: parseSnapshotV2(gpuPoorLifeV2('raising').body, source).gate.deadline - 1n });
    expect(reader.model.front.right).toMatchObject({ label: 'Ends in', value: '2', sub: 'days' });
    expect(text(reader.html)).toContain('Ends in 2 d');
  });
  it('the hatch says Anyone may close only when the page’s own decision does', () => {
    const late = (v: V2Snapshot) => v;
    const fast = at('graduating', late, { nowSec: 10n ** 12n, closable: false });
    expect(text(fast.html)).toContain('Anyone may close in');
    const open = at('graduating', late, { closable: true });
    expect(text(open.html)).toContain('Seven days since fill. Anyone may close this box.');
  });
});

describe('R-10: the front and the words follow what is known of the box’s life', () => {
  const source = sepoliaLifeSourceV2();
  const at = (stage: 'scheduled' | 'failed' | 'raising', edit: (v: V2Snapshot) => V2Snapshot = (v) => v) => {
    const view = edit(parseSnapshotV2(gpuPoorLifeV2(stage).body, source));
    const record = recordV2(view, source, null, 'tNVDA');
    const model = liveModelOf(record, view, { nowSec: view.timestamp, alchemist: NO_ALCHEMIST, pileCoin: null });
    return { view, model, sheet: (id: LivePartId) => sheetOf(id, { record, view, model, nowSec: view.timestamp, pileCoin: null, creatorClaim: null }) };
  };
  it('a scheduled box with a start buy shows its share; a timed-out graduation is full; unpublished progress is unknown', () => {
    const scheduled = at('scheduled');
    expect(scheduled.model.front.fill).toBeGreaterThan(0);
    expect(scheduled.model.front.left.label).toBe('Raised');
    expect(at('failed', (v) => ({ ...v, failed: { cause: 'GraduationTimedOut', at: v.timestamp } })).model.front.fill).toBe(1);
    expect(at('raising', (v) => ({ ...v, statistics: null })).model.front.fill).toBeNull();
  });
  it('a closed box’s pool (?) promises no opening; a graduated box without fee figures never says After graduation', () => {
    expect(at('failed').sheet('pool').why.join(' ')).not.toContain('Opens at graduation');
    const graduated = boxOf('gpu-poor', (v) => ({ ...v, feesP: null }));
    expect(text(graduated.sheet('buyers').html)).not.toContain('After graduation');
  });
});

describe('R-18: every explanation sits behind its closed (?)', () => {
  it('Square Hole’s fee split is in its (?), once (review fix 3), not in the sheet', () => {
    const box = boxOf('gpu-poor');
    const mark = box.sheet('mark');
    expect(mark.why.filter((line) => line.includes('2/15 to the FIT Safe'))).toEqual(['2/15 to the FIT Safe · 1/15 to the platform Safe · 2/15 to the pool.']);
    expect(text(mark.html)).not.toContain('2/15 to the FIT Safe');
  });
});

describe('review fixes (Opus browser review of 3a8c127de)', () => {
  // sam, raising, past its deadline by chain time and not closed yet: the state every box sits in between its deadline
  // and the close call (review fixes 1 and 2).
  const pastDeadline = (v: V2Snapshot) => ({ ...v, gate: { ...v.gate, deadline: v.timestamp - 3600n } });
  it('1: "Deadline passed" takes two lines on the front, never a cut letter', () => {
    expect(stateLines('Deadline passed')).toEqual(['Deadline', 'passed']);
    expect(stateLines('Graduated')).toEqual(['Graduated']);
    const box = boxOf('sam', pastDeadline);
    expect(box.model.front.right).toEqual({ kind: 'state', glyph: 'closed', word: 'Deadline passed' });
    const html = renderToStaticMarkup(<svg>{liveLayers(box.model, 'x', { open: false, onOpen: () => undefined }).front}</svg>);
    expect([...html.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])).toEqual(expect.arrayContaining(['Deadline', 'passed']));
  });
  it('2: past its deadline, unfilled, the box can no longer graduate: no graduation promise anywhere', () => {
    const box = boxOf('sam', pastDeadline);
    expect(canStillGraduateV2(box.view)).toBe(false);
    expect(box.model.ledger.map((line) => line.note)).toEqual([null, null, null]);
    expect(livePictureOf(box.model).parts.find((part) => part.id === 'pool')?.description).toBeNull();
    const layers = renderToStaticMarkup(<svg>{liveLayers(box.model, 'x', { open: false, onOpen: () => undefined }).words}</svg>);
    expect(layers).not.toContain('graduation');
    for (const id of ['buyers', 'sellers', 'holders', 'pool'] as const) {
      const sheet = box.sheet(id);
      expect(text(sheet.html), id).not.toMatch(/graduation/i);
      if (id === 'pool') expect(sheet.why.join(' ')).not.toContain('Opens at graduation');
    }
    // Before its deadline it can: the promises show.
    expect(boxOf('sam').model.ledger.map((line) => line.note)).toEqual(['After graduation', 'Opens at graduation with tokens and price coins.', null]);
  });
  it('2: a full raise waiting for its graduation call keeps the promises, past its deadline too', () => {
    const full = boxOf('sam', (v) => ({ ...pastDeadline(v), closedAt: v.timestamp - 7200n }));
    expect(full.model.stage).toBe('graduating');
    expect(canStillGraduateV2(full.view)).toBe(true);
    expect(full.model.ledger.map((line) => line.note)).toEqual(['After graduation', 'Opens at graduation with tokens and price coins.', null]);
    // A failed box and a graduated one never: the rule's other two rows.
    expect(canStillGraduateV2({ ...full.view, failed: { cause: 'GraduationTimedOut', at: full.view.timestamp } })).toBe(false);
    expect(canStillGraduateV2(boxPictureFixture('gpu-poor').view)).toBe(false);
    // A gate still holding (no deadline set) can still open and fill.
    expect(canStillGraduateV2({ ...full.view, closedAt: 0n, gate: { ...full.view.gate, deadline: 0n } })).toBe(true);
  });
  it('4: an upcoming box with published progress shows Raised on its front and in its raise sheet', () => {
    const box = boxOf('sam', (v) => ({ ...v, gate: { ...v.gate, open: false } }));
    expect(box.model.stage).toBe('scheduled');
    expect(box.model.front.left).toMatchObject({ label: 'Raised', value: '29.7%' });
    expect(text(box.sheet('raise').html)).toMatch(/^29\.7% Raised /);
  });
  it('6: unread statistics: the Holders sheet says Unavailable, as the other sheets do', () => {
    const box = boxOf('gpu-poor', (v) => ({ ...v, statistics: null }));
    expect(text(box.sheet('holders').html)).toBe('Unavailable');
  });
});
