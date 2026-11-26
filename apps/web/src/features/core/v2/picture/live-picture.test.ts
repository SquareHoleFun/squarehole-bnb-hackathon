/**
 * SH-255: the box page's picture input against the six boxes live on Sepolia (block 12,195,510) and, for the moments
 * no live box is in, GPU Poor's own earlier moments (test-support/life-v2.ts). Every figure is a field of the box API
 * or one of the two computed figures (box-picture/live-figures.ts), each checked here against the fields it must agree
 * with; where the data has no figure nothing is shown.
 */
import { describe, expect, it } from 'vitest';
import { partsOfFee, poolCoinsOf, squareHolePaidOf } from '../../../box-picture/live-figures';
import { parseSnapshotV2 } from '../indexer-v2';
import { recordV2 } from '../record-v2';
import { gpuPoorLifeV2, sepoliaLifeSourceV2 } from '../test-support/life-v2';
import { BOX_PICTURE_BLOCK, BOX_PICTURE_NAMES, boxPictureFixture, coinDecimalsOf, coinSymbolOf } from '../test-support/box-picture-v2';
import type { LifeStageV2 } from '../life-state';
import { liveModelOf, livePictureOf } from './live-picture';
import { required } from '../test-support/required';

type Json = Record<string, unknown>;
const NO_ALCHEMIST = { buyers: false, sellers: false } as const;
const big = (v: unknown): bigint => BigInt(v as string);

function modelOf(name: string, alchemist: { readonly buyers: boolean; readonly sellers: boolean } = NO_ALCHEMIST) {
  const f = boxPictureFixture(name);
  const pile = f.answer.m3 ? ((f.answer.m3 as Json).pile as Json | null) : null;
  const asset = pile ? (pile.asset as string) : null;
  const pileCoin = asset ? { symbol: /^0x0{40}$/i.test(asset) ? 'ETH' : coinSymbolOf(asset) ?? '', decimals: coinDecimalsOf(asset) ?? 18 } : null;
  return { ...f, model: liveModelOf(f.record, f.view, { nowSec: f.view.timestamp, alchemist, pileCoin }) };
}

describe('SH-255 fixtures: the six live boxes, as the page parses them', () => {
  it('are read at block 12,195,510 (Rent Free one block later) and parse with the site’s own parser', () => {
    for (const name of BOX_PICTURE_NAMES) {
      const { view } = boxPictureFixture(name);
      expect(view.block - BOX_PICTURE_BLOCK).toBeLessThanOrEqual(1n);
      expect(view.feesP).not.toBeNull();
      expect(view.safePaid).not.toBeNull();
    }
  });
  it('a malformed fees or safePaid field leaves the figure unknown, never zero, and the box still shows', () => {
    const source = sepoliaLifeSourceV2();
    const { answer } = boxPictureFixture('gpu-poor');
    const view = parseSnapshotV2({ ...answer, fees: { buyersP: 'twelve' }, safePaid: null }, source);
    expect(view.feesP).toBeNull();
    expect(view.safePaid).toBeNull();
    const model = liveModelOf(recordV2(view, source, null, 'tNVDA'), view, { nowSec: view.timestamp, alchemist: NO_ALCHEMIST, pileCoin: null });
    expect(model.fees).toBeNull();
    expect(model.numbers).toEqual({ stations: { buyers: '', sellers: '' }, pool: '', mark: '' });
    expect(model.visitor).toEqual({ buyers: '1%', sellers: '1%' });
  });
});

describe('SH-255 computed figure 1: a side’s 15 parts, against the fields they must agree with', () => {
  it('Square Hole’s 3 parts equal what the two Safes were paid, to the smallest unit, on every graduated box', () => {
    for (const name of ['gpu-poor', 'dragons-hoard', 'one-dollar', 'the-alchemist', 'rent-free']) {
      const { view } = boxPictureFixture(name);
      const fees = required(view.feesP);
      const parts = partsOfFee(fees.buyers).squareHole + partsOfFee(fees.sellers).squareHole;
      const paid = required(squareHolePaidOf(view.safePaid, view.record.q));
      // The contract splits fee by fee with a carry: at most one smallest unit per part per fee apart (three parts).
      expect(parts - paid >= -3n * big(view.statistics?.tradeCount ?? 0n) && parts - paid <= 3n * big(view.statistics?.tradeCount ?? 0n), name).toBe(true);
    }
  });
  it('the buy-back’s 10 parts equal what it spent, holds as budget and paid its callers, to the smallest unit (GPU Poor, One Dollar, Rent Free)', () => {
    for (const name of ['gpu-poor', 'one-dollar', 'rent-free']) {
      const { view, answer } = boxPictureFixture(name);
      const back = answer.buyBack as Json;
      const owed = (answer.money as Json).owed as Json;
      const pick = partsOfFee(required(view.feesP).buyers).pick + partsOfFee(required(view.feesP).sellers).pick;
      expect(pick - (big(back.pSpent) + big(owed.buyBackP) + big(back.tipsP)), name).toBe(0n);
    }
  });
  it('Dragon’s Hoard: the buyers’ 10 parts are the fees moved into the pile; The Alchemist: what it converted', () => {
    const hoard = boxPictureFixture('dragons-hoard');
    expect(partsOfFee(required(hoard.view.feesP).buyers).pick).toBe(big(hoard.answer.pileMovedP));
    const alchemist = boxPictureFixture('the-alchemist');
    expect(partsOfFee(required(alchemist.view.feesP).buyers).pick).toBe(big((alchemist.answer.alchemist as Json).inputP));
  });
});

describe('SH-255 computed figure 2: the coins in the pool', () => {
  it('match the published price on every graduated box (the price from the two amounts, within 0.01%)', () => {
    for (const name of ['gpu-poor', 'dragons-hoard', 'one-dollar', 'the-alchemist', 'rent-free']) {
      const { view } = boxPictureFixture(name);
      const coins = required(poolCoinsOf(view.position, view.pool?.sqrtPriceX96, view.record.q, view.token));
      const fromCoins = (coins.price * 10n ** 36n) / coins.token;
      const published = required(required(view.statistics).pricePPerTX18);
      const gap = fromCoins > published ? fromCoins - published : published - fromCoins;
      expect(gap * 10_000n <= published, name).toBe(true);
    }
  });
  it('GPU Poor’s pool holds 106.55 tNVDA and 183.65M VRAM; a box without a pool has none', () => {
    const { model } = modelOf('gpu-poor');
    // The position's own amounts from its two ends (review R-3): 7,603 wei of tNVDA fewer than the infinite range's.
    expect(model.poolCoins?.price).toBe(106552370231012512087n);
    expect(required(model.poolCoins).token / 10n ** 24n).toBe(183n);
    expect(modelOf('sam').model.poolCoins).toBeNull();
  });
});

describe('SH-255 the six boxes on the picture', () => {
  it('GPU Poor: graduated, the buyers’ fees burn VRAM, the sellers paid none yet', () => {
    const { model } = modelOf('gpu-poor');
    expect(model.stage).toBe('graduated');
    expect(model.front).toMatchObject({ fill: 1, left: { label: 'Raise', value: '100', sub: 'tNVDA' }, right: { kind: 'state', glyph: 'graduate', word: 'Graduated' } });
    expect(model.visitor).toEqual({ buyers: '0.8982', sellers: '0' });
    expect(model.numbers).toEqual({ stations: { buyers: '0.5988', sellers: '0' }, pool: '0.1197', mark: '0.1796' });
    expect(model.routes).toEqual({ buyers: 'flow', sellers: 'idle' });
    expect(model.burned).toBe('2.06M');
    expect(model.holders).toBe('3');
    expect(model.ledger.map((line) => [line.label, line.amount, line.note])).toEqual([
      ['Buy back and burn VRAM', '0.5988', null], ['Pool', '0.1197', null], ['Square Hole', '0.1796', null],
    ]);
    expect(model.feesLine).toBe('0.8982 tNVDA in fees · 3 trades');
  });
  it('Dragon’s Hoard: the buyers’ fees go to the pile in ETH, the sellers’ burn HOARD', () => {
    const { model } = modelOf('dragons-hoard');
    expect(model.input.contents).toBe('token');
    expect(model.input.pile).toBe(true);
    expect(model.pileCoin).toBe('ETH');
    expect(model.ledger.map((line) => [line.label, line.amount, line.note])).toEqual([
      ['To the pile', '0.0005988', null], ['Buy back and burn HOARD', '0', null], ['Pool', '0.0001197', null], ['Square Hole', '0.0001796', null],
    ]);
  });
  it('One Dollar: both sides burn the token 1, one line for both; its pile in tUSDC', () => {
    const { model } = modelOf('one-dollar');
    expect(model.pileCoin).toBe('tUSDC');
    expect(model.ledger[0]).toMatchObject({ key: 'both', label: 'Buy back and burn 1', amount: '0.5988', note: null });
  });
  it('The Alchemist: its buyers’ fees, checked as The Alchemist, went into the pile as tGOLD', () => {
    const { model } = modelOf('the-alchemist', { buyers: true, sellers: false });
    expect(model.input.buyers.choice).toBe('alchemist');
    expect(model.input.buyers.label).toBe('The Alchemist');
    expect(model.ledger[0]).toEqual({ key: 'buyers', choice: 'alchemist', label: 'The Alchemist', amount: '1,205.87', note: null });
    // Not checked (the read not back yet): the site's own word, never a guess.
    expect(modelOf('the-alchemist').model.input.buyers.label).toBe('Fee module');
  });
  it('sam: raising, 29.7% of 0.1 ETH, 8 days left, no fee figure before graduation, the pool not open', () => {
    const { model } = modelOf('sam');
    expect(model.stage).toBe('raising');
    expect(model.front).toMatchObject({ left: { label: 'Raised', value: '29.7%', sub: 'of 0.1 ETH' }, right: { kind: 'figure', label: 'Ends in', value: '8', sub: 'days' } });
    expect(model.front.fill).toBeCloseTo(0.2973, 4);
    expect(model.fees).toBeNull();
    expect(model.visitor).toEqual({ buyers: '1%', sellers: '1%' });
    expect(model.numbers).toEqual({ stations: { buyers: '', sellers: '' }, pool: '', mark: '' });
    expect(model.poolOpen).toBe(false);
    expect(model.routes).toEqual({ buyers: 'idle', sellers: 'idle' });
    expect(model.ledger.every((line) => line.amount === null)).toBe(true);
    expect(model.ledger.map((line) => line.note)).toEqual(['After graduation', 'Opens at graduation with tokens and price coins.', null]);
    expect(model.feesLine).toBeNull();
  });
  it('Rent Free: 500 items, 14 out, both sides burn RENT on one line', () => {
    const { model } = modelOf('rent-free');
    expect(model.items).toEqual({ count: '500', out: '14 out' });
    expect(model.visitor).toEqual({ buyers: '1', sellers: '0.1575' });
    expect(model.ledger[0]).toMatchObject({ key: 'both', label: 'Buy back and burn RENT', amount: '0.7781', note: null });
    expect(model.inbox).toEqual({ coins: 0, complete: true, royaltyHeld: 0n });
  });
  it('every part of the picture names the words on it and describes the words beside it', () => {
    const picture = livePictureOf(modelOf('rent-free').model);
    const byId = Object.fromEntries(picture.parts.map((part) => [part.id, part]));
    expect(byId.raise?.name).toBe('Raise 100 tUSDC · Graduated');
    expect(byId.token?.description).toBe('Burned 10.56M RENT');
    expect(byId.holders?.description).toBe('4');
    expect(byId.contents?.description).toBe('500 · 14 out');
    expect(byId.buyers?.description).toBe('1 tUSDC · Buy back and burn RENT · 0.6731');
    expect(byId.pool?.description).toBe('0.1556');
    expect(byId.mark?.description).toBe('0.2334');
  });
});

describe('SH-255 the moments no live box is in, from the site’s own rules (GPU Poor’s earlier moments)', () => {
  const at = (stage: LifeStageV2) => {
    const source = sepoliaLifeSourceV2();
    const view = parseSnapshotV2(gpuPoorLifeV2(stage).body, source);
    return liveModelOf(recordV2(view, source, null, 'tNVDA'), view, { nowSec: view.timestamp, alchemist: NO_ALCHEMIST, pileCoin: null });
  };
  it('upcoming: the deadline, and the share its start buy raised (review R-10)', () => {
    const model = at('scheduled');
    expect(model.front).toMatchObject({ fill: 0.0003, left: { label: 'Raised', value: '0.0%', sub: 'of 100 tNVDA' }, right: { kind: 'figure', label: 'Deadline', value: '30', sub: 'days' } });
    expect(model.fees).toBeNull();
    expect(model.poolOpen).toBe(false);
  });
  it('the launch window and raising: the share raised and the days left', () => {
    for (const stage of ['window', 'raising'] as const) {
      const model = at(stage);
      expect(model.front.left).toMatchObject({ label: 'Raised', value: '42.1%', sub: 'of 100 tNVDA' });
      expect(model.front.right).toMatchObject({ kind: 'figure', label: 'Ends in', sub: 'days' });
      expect(model.numbers.stations).toEqual({ buyers: '', sellers: '' });
    }
  });
  it('the raise full, not graduated yet: the box full, Graduating, no fee figure yet', () => {
    const model = at('graduating');
    expect(model.front).toMatchObject({ fill: 1, right: { kind: 'state', word: 'Graduating' } });
    expect(model.fees).toBeNull();
    expect(model.poolOpen).toBe(false);
  });
  it('past its deadline, not full, not closed yet: the site’s "Deadline passed", never "Ends in 0"', () => {
    const source = sepoliaLifeSourceV2();
    const read = parseSnapshotV2(gpuPoorLifeV2('raising').body, source);
    // Chain time decides (the block's), as the site's close state does: a reader's clock past the deadline alone does not.
    const early = liveModelOf(recordV2(read, source, null, 'tNVDA'), read, { nowSec: read.gate.deadline + 1n, alchemist: NO_ALCHEMIST, pileCoin: null });
    expect(early.front.right).toMatchObject({ kind: 'figure', label: 'Ends in' });
    const view = { ...read, timestamp: read.gate.deadline + 1n };
    const model = liveModelOf(recordV2(view, source, null, 'tNVDA'), view, { nowSec: view.timestamp, alchemist: NO_ALCHEMIST, pileCoin: null });
    expect(model.front.right).toEqual({ kind: 'state', glyph: 'closed', word: 'Deadline passed' });
    expect(model.front.left).toMatchObject({ label: 'Raised', value: '42.1%' });
  });
  it('closed: Closed on the front, its raise not known (a dashed edge, review R-10), no fee or pool figure (the closing card keeps its own)', () => {
    const model = at('failed');
    // A closed box never graduates: no "After graduation" and no "Opens at graduation" anywhere.
    expect(model.ledger.map((line) => line.note)).toEqual([null, null, null]);
    expect(model.stage).toBe('failed');
    expect(model.front).toMatchObject({ fill: null, left: { label: 'Raise' }, right: { kind: 'state', glyph: 'closed', word: 'Closed' } });
    expect(model.fees).toBeNull();
    expect(model.numbers).toEqual({ stations: { buyers: '', sellers: '' }, pool: '', mark: '' });
    expect(model.poolOpen).toBe(false);
  });
});
