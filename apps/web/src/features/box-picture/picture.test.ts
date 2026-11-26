/** SH-251: the picture of any box from its settings (pure): its parts, what each shows, and the ledger of a run. */
import { describe, expect, it } from 'vitest';
import { percentText, raiseText, roundedText, shortText } from './amounts';
import { HUNDRED_TRADES, NO_TRADES, addTrade, type SimTotals } from './fee-split';
import { LAYOUT, PART_ORDER, iconOf, ledgerOf, pictureOf, trayOf, whyOf, wrap, type PictureInput, type SideInput } from './picture';
import { HOLDERS_SHARE, PART_WHY, PICTURE_WORDS, WALK_WORDS, aboutOf, walkWords } from './picture-words';

const E18 = 10n ** 18n;
const side = (choice: SideInput['choice'], label: string, extra: Partial<SideInput> = {}): SideInput => ({ choice, label, tag: null, insideBurns: false, warn: false, issue: null, ledgerLabel: null, ...extra });
const base: PictureInput = {
  ticker: 'KITE', price: { symbol: 'ETH', decimals: 18, raise: 4_206_980_085_000_000_000n }, deadlineDays: 30, contents: 'token', pile: false, items: null,
  buyers: side('burn', 'Buy back and burn KITE'), sellers: side('burn', 'Buy back and burn KITE'), eatBurns: false, holderWindow: null, totals: null,
};
const run = (sides: readonly ('buyers' | 'sellers')[]): SimTotals => sides.reduce((totals, s) => addTrade(totals, s, E18), NO_TRADES);
const refused = /\b(buy|sell|swap)\b/i;

describe('SH-251 amounts', () => {
  it('prints raw amounts rounded half up, grouped, and shares of what was traded', () => {
    expect(roundedText(6_666_666_666_666_660n, 18, 6)).toBe('0.006667');
    expect(roundedText(1_234_500_000n, 6, 2)).toBe('1,234.5');
    expect(roundedText(-5n, 0, 0)).toBe('-5');
    expect(shortText(6_666_666_666_666_660n, 18)).toBe('0.00667');
    expect(shortText(0n, 18)).toBe('0');
    expect(raiseText(4_206_980_085_000_000_000n, 18)).toBe('4.207');
    expect(raiseText(15_986_524_323n, 6)).toBe('15,987');
    expect(raiseText(1_234_567n * 10n ** 18n, 18)).toBe('1,234,567');
    expect(percentText(10n, 1500n)).toBe('0.667%');
    expect(percentText(2n, 1500n)).toBe('0.133%');
    expect(percentText(3n, 1500n)).toBe('0.2%');
    expect(percentText(1n, 0n)).toBe('0%');
  });
});

describe('SH-251 pictureOf', () => {
  it('has one control per part, in reading order, each named with the words it shows', () => {
    const picture = pictureOf(base);
    expect(picture.parts.map((part) => part.id)).toEqual(PART_ORDER);
    expect(picture.parts.map((part) => part.name)).toEqual([
      'Buys · Buyers’ fees', 'Token KITE', 'What’s in the box: Token', 'Sells · Sellers’ fees', 'Creator',
      'Raise 4.207 ETH · Deadline 30 days', 'Priced in ETH', 'Holders', 'Square Hole', 'Pool',
    ]);
    // What sits beside a control as plain text is its description: a side's pick and number, the pool's and Square Hole's number.
    expect(picture.parts.map((part) => part.description)).toEqual(['Buy back and burn KITE · 0.667%', null, null, 'Buy back and burn KITE · 0.667%', null, null, null, null, '0.2%', '0.133%']);
    // No control is named with the words the no-trade audit refuses (e2e/trading-controls.ts, unchanged).
    for (const part of picture.parts) expect(part.name).not.toMatch(refused);
    expect(pictureOf({ ...base, buyers: side('holders', 'To holders', { tag: 'ETH' }) }).parts[0]?.description).toBe('To holders · ETH · 0.667%');
    expect(pictureOf({ ...base, ticker: '' }).parts[1]?.name).toBe('Token');
    expect(pictureOf({ ...base, contents: 'collection', items: 1200 }).parts[2]?.description).toBe('1,200');
    for (const part of picture.parts) {
      expect(part.hit.length).toBeGreaterThan(0);
      for (const rect of part.hit) {
        expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.w).toBeLessThanOrEqual(LAYOUT.width); expect(rect.y + rect.h).toBeLessThanOrEqual(LAYOUT.height);
        // Every hit area is a finger's size on a phone: 26 units or more each way (the part's other areas add to it).
        expect(Math.min(rect.w, rect.h)).toBeGreaterThanOrEqual(26);
      }
    }
    for (const id of PART_ORDER) expect(PART_WHY[id].length).toBeGreaterThan(0);
  });

  it('names each (?) from the site where one fits, and with the four names the founder approved (round 125) where none did', () => {
    for (const id of ['picture', 'price', 'raise', 'buyers', 'sellers', 'pool', 'mark', 'happens'] as const) expect(aboutOf(id)).toMatch(/^About /);
    expect(['token', 'contents', 'creator', 'holders'].map((id) => aboutOf(id as 'token'))).toEqual(['About the token', 'About what’s in the box', 'About the creator', 'About holders']);
    // Every sheet has its (?) now, and no two share a name.
    const names = PART_ORDER.map((id) => aboutOf(id));
    expect(new Set(names).size).toBe(names.length);
    // The walk's words are the examples' player's own (apps/web/public/examples/follow.js).
    expect(WALK_WORDS).toEqual({ play: 'Play', pause: 'Pause', replay: 'Play again', steps: 'Steps', next: 'Next step' });
    expect(walkWords.step(1, 8, 'Priced in')).toBe('Step 2 of 8, Priced in');
    expect(walkWords.count(1, 8)).toBe('2/8');
    // The Raise sheet holds the steps' own "About the raise" and "About the deadline": its own (?) is named apart.
    expect(aboutOf('raise')).not.toBe('About the raise');
    // Square Hole's (?): the explainer's line, then the site's Fee details, never the slide line about the box's picks.
    expect(PART_WHY.mark).toEqual(['Square Hole. Gets 3 of 15 parts, 0.200 of every 100, from every box.', '2/15 to the FIT Safe · 1/15 to the platform Safe · 2/15 to the pool.']);
    expect(PICTURE_WORDS.pictureName).toBe('Your box');
  });

  it('says the holders share fees only in a box where a side pays them: To holders in the price coin or the box coin', () => {
    // Review pass 2: with Burn on both sides the holders share nothing, so the line is left out.
    expect(whyOf('holders', base)).toEqual(PART_WHY.holders);
    expect(whyOf('holders', base)).not.toContain(HOLDERS_SHARE);
    // Nor does a shop, a Keep, a pile or a side paying items.
    for (const choice of ['shop', 'keep', 'pile', 'items', 'items-t'] as const) {
      expect(whyOf('holders', { ...base, sellers: side(choice, choice) })).not.toContain(HOLDERS_SHARE);
    }
    // To holders in the price coin on the buyers' side; To holders in the box coin on the sellers' side.
    expect(whyOf('holders', { ...base, buyers: side('holders', 'To holders') })).toEqual([...PART_WHY.holders, HOLDERS_SHARE]);
    expect(whyOf('holders', { ...base, sellers: side('holders-t', 'To holders') })).toEqual([...PART_WHY.holders, HOLDERS_SHARE]);
    // Every other part's lines but the contents' are the same in every box.
    for (const id of PART_ORDER.filter((id) => id !== 'holders' && id !== 'contents')) expect(whyOf(id, { ...base, buyers: side('holders', 'To holders') })).toBe(PART_WHY[id]);
  });

  it('says tokens can be exchanged for an item or a slice of the pile only where the box holds one (SH-254)', () => {
    const exchange = 'After graduation, tokens can be exchanged for an item or a slice of the pile.';
    expect(PART_WHY.contents).toContain(exchange);
    // A token-only box has neither: only the first line.
    expect(whyOf('contents', base)).toEqual([PART_WHY.contents[0]]);
    for (const box of [{ contents: 'collection' as const }, { contents: 'shop' as const }, { contents: 'token' as const, pile: true }]) {
      expect(whyOf('contents', { ...base, ...box }), JSON.stringify(box)).toContain(exchange);
    }
  });

  it('shows the fee map numbers per trade before a run, and the run’s amounts after', () => {
    const before = pictureOf(base);
    expect([before.sides.buyers.number, before.sides.sellers.number, before.pool.number, before.mark.number]).toEqual(['0.667%', '0.667%', '0.133%', '0.2%']);
    const after = pictureOf({ ...base, totals: addTrade(NO_TRADES, 'buyers', E18) });
    expect([after.sides.buyers.number, after.sides.sellers.number, after.pool.number, after.mark.number]).toEqual(['0.00667', '0', '0.00133', '0.002']);
  });

  it('draws each choice at its station, and a choice the box cannot take as a warning: no number, the site’s own line said', () => {
    const icons = (['keep', 'burn', 'grow', 'holders', 'holders-t', 'items', 'items-t', 'eat', 'pile', 'shop', 'alchemist'] as const).map((choice) => iconOf({ choice, insideBurns: false }, false));
    expect(icons).toEqual(['creator', 'burn', 'liquidity', 'holders', 'holders', 'collection', 'collection', 'lock', 'pile', 'shop', 'alchemist-pile']);
    expect(iconOf({ choice: 'eat', insideBurns: false }, true)).toBe('burn');
    expect(iconOf({ choice: 'items', insideBurns: true }, false)).toBe('collection-burn');
    const warned = pictureOf({ ...base, sellers: side('items', 'To items', { warn: true, issue: 'Sellers’ fees: To items needs a new collection.' }) });
    expect(warned.sides.sellers.warn).toBe(true);
    expect(warned.sides.sellers.number).toBe('');
    expect(warned.parts[3]?.description).toBe('To items · Sellers’ fees: To items needs a new collection.');
    const none = pictureOf({ ...base, buyers: side(null, '') });
    expect(none.sides.buyers.warn).toBe(true);
    expect(none.sides.buyers.label.join(' ')).toBe(PICTURE_WORDS.noChoice);
    expect(none.sides.buyers.icon).toBeNull();
  });

  it('lights the creator for Keep and the holders for To holders or the shop', () => {
    expect(pictureOf({ ...base, buyers: side('keep', 'Keep') }).lit).toEqual({ creator: true, holders: false });
    expect(pictureOf({ ...base, sellers: side('holders-t', 'To holders') }).lit).toEqual({ creator: false, holders: true });
    expect(pictureOf({ ...base, sellers: side('shop', 'Into the shop') }).lit).toEqual({ creator: false, holders: true });
  });

  it('shows what is in the box: a token, a coin pile, a collection with its count, a shop, or nothing chosen yet', () => {
    expect(pictureOf(base).contents).toMatchObject({ kind: 'token', pile: false, items: null, name: 'Token' });
    expect(pictureOf({ ...base, pile: true }).contents).toMatchObject({ pile: true, name: 'Token · Coin pile' });
    expect(pictureOf({ ...base, contents: 'collection', items: 1200 }).contents).toMatchObject({ kind: 'collection', items: '1,200', name: 'New collection' });
    expect(pictureOf({ ...base, contents: 'shop', pile: true }).contents).toMatchObject({ kind: 'shop', pile: false, name: 'Shop' });
    expect(pictureOf({ ...base, contents: null }).contents).toMatchObject({ kind: null, name: 'What’s in the box' });
  });

  it('keeps the seam for the payout window: a holder side’s tag carries it, no other', () => {
    const holders = side('holders', 'To holders', { tag: 'ETH' });
    expect(pictureOf({ ...base, buyers: holders }).sides.buyers.tag).toBe('ETH');
    const later = pictureOf({ ...base, buyers: holders, holderWindow: '6 hours' });
    expect(later.sides.buyers.tag).toBe('ETH · 6 hours');
    expect(later.sides.sellers.tag).toBeNull();
  });

  it('lays the trays out as the fee map does: 10, 2 and 3, mirrored on the sells side, inside the picture', () => {
    for (const s of ['buyers', 'sellers'] as const) {
      const tray = trayOf(s);
      expect(tray.cells.map((cell) => cell.role).join(',')).toBe(s === 'buyers' ? `${'pick,'.repeat(10)}pool,pool,mark,mark,mark` : `mark,mark,mark,pool,pool,${'pick,'.repeat(10).slice(0, -1)}`);
      const last = tray.cells[tray.cells.length - 1];
      expect(last && last.x + last.w).toBeLessThanOrEqual(tray.x1);
    }
    expect(wrap('Buy back and burn KITE')).toEqual(['Buy back and burn', 'KITE']);
  });

  it('keeps a long pick and its number inside the picture: an 11-character ticker takes two lines', () => {
    const long = pictureOf({ ...base, ticker: 'ABCDEFGHIJK', buyers: side('burn', 'Buy back and burn ABCDEFGHIJK', { tag: 'ETH' }) });
    expect(long.sides.buyers.label).toEqual(['Buy back and burn', 'ABCDEFGHIJK']);
    // The number's baseline (BoxPictureSvg StationWords): under the tag, the lines, 6 units below them; then 16-unit text.
    const { y, r } = LAYOUT.station;
    expect(y + r + 18 + 12 + long.sides.buyers.label.length * 15 + 6 + 4).toBeLessThanOrEqual(LAYOUT.height);
  });
});

describe('SH-251 ledgerOf', () => {
  it('names each side’s place once (one line when both go to the same place), then the pool and Square Hole', () => {
    expect(ledgerOf(base).map((row) => [row.label, row.amount])).toEqual([['Buy back and burn KITE', null], ['Pool', null], ['Square Hole', null]]);
    const totals = run(['buyers', 'sellers']);
    const rows = ledgerOf({ ...base, buyers: side('keep', 'Keep'), totals });
    expect(rows.map((row) => [row.label, row.amount, row.share])).toEqual([
      ['Keep', '0.00667', '0.333%'], ['Buy back and burn KITE', '0.00667', '0.333%'], ['Pool', '0.00267', '0.133%'], ['Square Hole', '0.004', '0.2%'],
    ]);
    const shared = ledgerOf({ ...base, totals });
    expect(shared.map((row) => [row.label, row.amount])).toEqual([['Buy back and burn KITE', '0.0133'], ['Pool', '0.00267'], ['Square Hole', '0.004']]);
  });

  it('keeps a side the box cannot take as a line of its own, marked, so the lines always add up to the fee', () => {
    const warned = { ...base, sellers: side('items', 'To items', { warn: true }) };
    expect(ledgerOf(warned).map((row) => [row.key, row.warn])).toEqual([['buyers', false], ['sellers', true], ['pool', false], ['mark', false]]);
    for (const input of [base, warned, { ...base, buyers: side(null, '') }, { ...base, buyers: side('keep', 'Keep') }]) {
      for (const trades of [['buyers'], ['sellers'], ['buyers', 'sellers', 'sellers'], HUNDRED_TRADES] as const) {
        const totals = run(trades);
        const rows = ledgerOf({ ...input, totals });
        expect(rows.reduce((sum, row) => sum + row.raw, 0n) + totals.carry.buyers + totals.carry.sellers).toBe(totals.fees);
      }
    }
  });

  it('names a payout in the box’s token in the steps’ own words, never as if the price coin were paid', () => {
    const inT = side('holders-t', 'To holders', { tag: 'KITE', ledgerLabel: 'To holders · in ETH · holders claim KITE' });
    const rows = ledgerOf({ ...base, buyers: inT, totals: run(['buyers']) });
    expect(rows[0]?.label).toBe('To holders · in ETH · holders claim KITE');
  });
});
