import { describe, expect, it } from 'vitest';
import { flapLivePicture, fourLivePicture, partsOf, type FlapLiveInput, type FourLiveInput, type LiveRule } from '../src/picture/live-picture';

const E18 = 10n ** 18n;
const RULES: LiveRule[] = [
  { kind: 1, bps: 2000, name: 'Creator' },
  { kind: 2, bps: 5000, name: 'Pile' },
  { kind: 3, bps: 3000, name: 'Buy back and burn' },
];
const SENT: LiveRule[] = [
  { kind: 1, bps: 2000, name: 'Creator', sent: 12n * E18 + 3450n * 10n ** 14n, burned: 0n },
  { kind: 2, bps: 5000, name: 'Pile', sent: 30n * E18, burned: 0n },
  { kind: 3, bps: 3000, name: 'Buy back and burn', sent: 18n * E18, burned: 1_234_567n * E18 },
];

const flap = (over: Partial<FlapLiveInput> = {}): FlapLiveInput => ({
  ticker: 'RUL',
  quote: { symbol: 'USDT (test)', decimals: 18 },
  tradeFeeBps: 100,
  buyTaxBps: 300,
  sellTaxBps: 300,
  burnShareBps: 2000,
  taxSeconds: 30n * 86400n,
  raised: 150n * E18,
  target: 300n * E18,
  soldBps: 4512n,
  raisedLabel: 'Raised',
  timeLeft: '2 h 5 m',
  ruled: false,
  figures: {},
  ...over,
});

describe('flapLivePicture', () => {
  it('a sale without rules: the pile takes the whole rest; the front holds the raise and the sold share', () => {
    const p = flapLivePicture(flap());
    expect(p.cells).toEqual(['burn', 'burn', 'pile', 'pile', 'pile', 'pile', 'pile', 'pile', 'pile', 'pile']);
    expect(p.creatorTag).toBeNull();
    expect(p.pile).toEqual(['Pile', 'the rest']);
    expect(p.front.left).toEqual({ label: 'Raised', value: '150', unit: 'of 300' });
    expect(p.front.right).toEqual({ label: 'Sold', value: '45.12%', unit: '2 h 5 m left' });
    expect(p.buyers).toEqual(['fee 1%', 'tax 3%']);
    expect(p.center).toEqual(['tax for 30 days']);
    expect(p.burn).toEqual(['Burned', '20%']);
    expect(p.coin).toBe('USDT (test)');
    expect(p.parts.map((x) => x.id)).toEqual(['buyers', 'token', 'sellers', 'creator', 'raise', 'price', 'deadline', 'tax', 'pool', 'pile']);
    expect(p.warn).toEqual([]);
  });

  it('a rules sale before its rules are read: no share claimed for the pile', () => {
    const p = flapLivePicture(flap({ ruled: true }));
    expect(p.pile).toEqual(['Pile']);
  });

  it('a rules sale with its stored parts: the trays, the creator tag and the buy back as the form drew them', () => {
    const p = flapLivePicture(flap({ ruled: true, figures: { rules: { rows: RULES, decimals: 18, symbol: 'USDT (test)' } } }));
    expect(p.cells).toEqual(['burn', 'burn', 'creator', 'creator', 'pile', 'pile', 'pile', 'pile', 'buyburn', 'buyburn']);
    expect(p.creatorTag).toBe('20%');
    expect(p.creatorTagOf).toBe('of the rest');
    expect(p.burn).toEqual(['Burned 20%', 'buy back 30%', 'of the rest']);
    expect(p.pile).toEqual(['Pile', '50% of the rest']);
    expect(p.creator).toEqual(['Creator']);
  });

  it('launched, shared out: what each part was sent and burned, the pile, the holders and the shop', () => {
    const p = flapLivePicture(
      flap({
        ruled: true,
        raised: 300n * E18,
        soldBps: 10_000n,
        timeLeft: undefined,
        figures: {
          rules: { rows: SENT, decimals: 18, symbol: 'USDT (test)' },
          pile: { value: 30n * E18 + 5n * 10n ** 17n, decimals: 18, symbol: 'USDT (test)' },
          holders: { value: 1000n * E18, decimals: 18, symbol: 'RUL' },
          shops: 1,
        },
      }),
    );
    expect(p.front.left.value).toBe('300');
    expect(p.front.right).toEqual({ label: 'Sold', value: '100%', unit: '' });
    expect(p.creator).toEqual(['Creator', 'sent 12.34']);
    expect(p.burn).toEqual(['Burned 20%', 'buy back 30%', '1,234,567 RUL']);
    expect(p.pile).toEqual(['Pile', '30.5 USDT (test)', '50% of the rest']);
    expect(p.holdersTag).toBe('1,000');
    expect(p.shop).toEqual(['Cards']);
    const names = Object.fromEntries(p.parts.map((x) => [x.id, x.name]));
    expect(names.pile).toBe('Pile: 30.5 USDT (test)');
    expect(names.holders).toBe('Holders: 1,000 RUL staked');
    expect(names.shop).toBe('RUL cards');
    expect(names.creator).toBe('Creator 20%: sent 12.34');
  });

  it('one payee without a proven name: "Paid to" on the creator; several: "Creator"', () => {
    const one: LiveRule[] = [{ kind: 1, bps: 4000, name: 'Paid to' }, { kind: 3, bps: 6000, name: 'Buy back and burn' }];
    expect(flapLivePicture(flap({ ruled: true, figures: { rules: { rows: one, decimals: 18, symbol: 'X' } } })).creator).toEqual(['Paid to']);
    const two: LiveRule[] = [{ kind: 1, bps: 2000, name: 'Creator' }, { kind: 1, bps: 2000, name: 'Paid to' }, { kind: 2, bps: 6000, name: 'Pile' }];
    const p = flapLivePicture(flap({ ruled: true, figures: { rules: { rows: two, decimals: 18, symbol: 'X' } } }));
    expect(p.creator).toEqual(['Creator']);
    expect(p.creatorTag).toBe('40%');
  });

  it('rules on a sale that is not a rules sale are not drawn (a stray figure never changes the picture)', () => {
    const p = flapLivePicture(flap({ ruled: false, figures: { rules: { rows: RULES, decimals: 18, symbol: 'X' } } }));
    expect(p.creatorTag).toBeNull();
    expect(p.pile).toEqual(['Pile', 'the rest']);
  });
});

const four = (over: Partial<FourLiveInput> = {}): FourLiveInput => ({
  ticker: 'PTX',
  quote: { symbol: 'WBNB', decimals: 18 },
  kind: 'tax',
  buyBps: 100,
  sellBps: 100,
  raised: 1n * 10n ** 17n,
  target: 3n * 10n ** 17n,
  soldBps: 3333n,
  figures: {},
  ...over,
});

describe('fourLivePicture', () => {
  it('a tax token: all the tax to the pile, nothing burned, the raise and the sold share on the front', () => {
    const p = fourLivePicture(four());
    expect(p.cells).toEqual(Array(10).fill('pile'));
    expect(p.burn).toBeNull();
    expect(p.pile).toEqual(['Pile', 'all the tax']);
    expect(p.buyers).toEqual(['tax 1%']);
    expect(p.front.left).toEqual({ label: 'Raised', value: '0.1', unit: 'of 0.3' });
    expect(p.front.right).toEqual({ label: 'Sold', value: '33.33%', unit: '' });
    expect(p.center).toEqual(['tax on every trade']);
  });

  it('a curve-fee token: fees, all of them to the pile', () => {
    const p = fourLivePicture(four({ kind: 'preset' }));
    expect(p.buyers).toEqual(['fee 1%']);
    expect(p.pile).toEqual(['Pile', 'all the fees']);
    expect(p.center).toEqual(['fee on every curve trade']);
  });

  it('a tax-rules token: the fixed parts from the token read, then what the panel shares', () => {
    const fixed = fourLivePicture(four({ kind: 'tax-rules', fixed: RULES }));
    expect(fixed.cells).toEqual(['creator', 'creator', 'pile', 'pile', 'pile', 'pile', 'pile', 'buyburn', 'buyburn', 'buyburn']);
    expect(fixed.creatorTag).toBe('20%');
    expect(fixed.creatorTagOf).toBeNull();
    expect(fixed.burn).toEqual(['Buy back', 'and burn 30%']);
    expect(fixed.pile).toEqual(['Pile', '50% of the tax']);
    const shared = fourLivePicture(four({ kind: 'tax-rules', fixed: RULES, figures: { rules: { rows: SENT, decimals: 18, symbol: 'WBNB' }, pile: { value: 3n * 10n ** 16n, decimals: 18, symbol: 'WBNB' } } }));
    expect(shared.creator).toEqual(['Creator', 'sent 12.34']);
    expect(shared.burn).toEqual(['Buy back', 'and burn 30%', '1,234,567 PTX']);
    expect(shared.pile).toEqual(['Pile', '0.03 WBNB', '50% of the tax']);
  });

  it('rules are drawn only for a tax-rules token', () => {
    expect(fourLivePicture(four({ kind: 'tax', fixed: RULES })).creatorTag).toBeNull();
  });
});

describe('partsOf', () => {
  it('sums each kind; none without rows', () => {
    expect(partsOf(undefined)).toBeNull();
    expect(partsOf([])).toBeNull();
    expect(partsOf(RULES)).toEqual({ creator: 2000, pile: 5000, burn: 3000, holders: 0, shop: 0 });
  });
});

// SH-321: the two live launches whose pictures named the stake's and the shop's parts as the creator's.
const U = (whole: bigint, frac: bigint, places: number) => whole * E18 + frac * 10n ** BigInt(18 - places);
const PAY_PACKET: LiveRule[] = [
  { kind: 1, bps: 1000, name: 'Creator', sent: U(1n, 7n, 1), burned: 0n },
  { kind: 2, bps: 3000, name: 'Pile', sent: U(5n, 1n, 1), burned: 0n },
  { kind: 1, bps: 4000, name: 'Holders', sent: U(6n, 8n, 1), burned: 0n },
  { kind: 3, bps: 2000, name: 'Buy back and burn', sent: 0n, burned: 0n },
];
const SWAP_DECK: LiveRule[] = [
  { kind: 1, bps: 1000, name: 'Creator', sent: U(3n, 8884n, 4), burned: 0n },
  { kind: 2, bps: 3000, name: 'Pile', sent: U(11n, 6652n, 4), burned: 0n },
  { kind: 1, bps: 4000, name: 'Card shop', sent: U(15n, 5536n, 4), burned: 0n },
  { kind: 3, bps: 2000, name: 'Buy back and burn', sent: 0n, burned: 0n },
];
const usd = (rows: LiveRule[]) => ({ rules: { rows, decimals: 18, symbol: 'USDT (test)' } });

describe('payees: the stake and the card shop are not the creator (SH-321)', () => {
  it('Pay Packet (Flap, 20% burned): creator 10, pile 30, holders 40, burn 20; the holders carry their part and what was sent', () => {
    const p = flapLivePicture(flap({ ruled: true, figures: { ...usd(PAY_PACKET), holders: { value: 1000n * E18, decimals: 18, symbol: 'PAY' } } }));
    expect(partsOf(PAY_PACKET)).toEqual({ creator: 1000, pile: 3000, burn: 2000, holders: 4000, shop: 0 });
    // 8 cells after the 2 burned: creator 0.8, pile 2.4, holders 3.2, buy back 1.6
    expect(p.cells).toEqual(['burn', 'burn', 'creator', 'pile', 'pile', 'holders', 'holders', 'holders', 'buyburn', 'buyburn']);
    expect(p.creatorTag).toBe('10%');
    expect(p.creator).toEqual(['Creator', 'sent 1.7']);
    expect(p.holdersLines).toEqual(['Holders 40%', 'sent 6.8']);
    expect(p.holdersTag).toBe('1,000');
    expect(p.pile).toEqual(['Pile', '30% of the rest']);
    expect(p.shop).toBeNull();
    const names = Object.fromEntries(p.parts.map((x) => [x.id, x.name]));
    expect(names.creator).toBe('Creator 10%: sent 1.7');
    expect(names.holders).toBe('Holders 40%: sent 6.8, 1,000 PAY staked');
    expect(names.tax).toBe('Tax: 20% burned, for 30 days; the rest: creator 10%, pile 30%, holders 40%, buy back and burn 20%');
  });

  it('Pay Packet without the stake panel: the holders part still shows the rule', () => {
    const p = flapLivePicture(flap({ ruled: true, figures: usd(PAY_PACKET) }));
    expect(p.parts.map((x) => x.id)).toContain('holders');
    expect(p.holdersTag).toBeNull();
    expect(p.holdersLines).toEqual(['Holders 40%', 'sent 6.8']);
  });

  it('Swap Deck (Four, nothing burned at once): creator 10, pile 30, card shop 40, burn 20; the shop carries its part and what was sent', () => {
    const p = fourLivePicture(four({ kind: 'tax-rules', fixed: SWAP_DECK, figures: { ...usd(SWAP_DECK), shops: 1 } }));
    expect(p.cells).toEqual(['creator', 'pile', 'pile', 'pile', 'shop', 'shop', 'shop', 'shop', 'buyburn', 'buyburn']);
    expect(p.creatorTag).toBe('10%');
    expect(p.creator).toEqual(['Creator', 'sent 3.88']);
    expect(p.shop).toEqual(['Cards 40%', 'sent 15.55']);
    expect(p.holdersLines).toBeNull();
    expect(p.pile).toEqual(['Pile', '30% of the tax']);
    const names = Object.fromEntries(p.parts.map((x) => [x.id, x.name]));
    expect(names.shop).toBe('PTX cards 40%: sent 15.55');
    expect(names.creator).toBe('Creator 10%: sent 3.88');
    expect(names.tax).toBe('Tax: creator 10%, pile 30%, card shop 40%, buy back and burn 20%');
  });

  it('Swap Deck as a Flap sale: 2 burned, then creator, pile, shop, buy back', () => {
    const p = flapLivePicture(flap({ ruled: true, figures: usd(SWAP_DECK) }));
    expect(p.cells).toEqual(['burn', 'burn', 'creator', 'pile', 'pile', 'shop', 'shop', 'shop', 'buyburn', 'buyburn']);
    expect(p.shop).toEqual(['Cards 40%', 'sent 15.55']);
  });

  it('a payee without a proven name stays with the creator', () => {
    const rows: LiveRule[] = [{ kind: 1, bps: 1000, name: 'Creator' }, { kind: 1, bps: 4000, name: 'Paid to' }, { kind: 2, bps: 5000, name: 'Pile' }];
    const p = fourLivePicture(four({ kind: 'tax-rules', fixed: rows }));
    expect(p.creatorTag).toBe('50%');
    expect(p.cells.filter((c) => c === 'creator')).toHaveLength(5);
    expect(p.holdersLines).toBeNull();
    expect(p.shop).toBeNull();
  });

  it('a launch with neither: no holders or shop cells, parts or lines', () => {
    const p = flapLivePicture(flap({ ruled: true, figures: usd(SENT) }));
    expect(p.cells.some((c) => c === 'holders' || c === 'shop')).toBe(false);
    expect(p.parts.map((x) => x.id)).not.toContain('holders');
    expect(p.parts.map((x) => x.id)).not.toContain('shop');
    expect(p.holdersLines).toBeNull();
    const q = fourLivePicture(four());
    expect(q.cells).toEqual(Array(10).fill('pile'));
    expect(q.shop).toBeNull();
  });
});
