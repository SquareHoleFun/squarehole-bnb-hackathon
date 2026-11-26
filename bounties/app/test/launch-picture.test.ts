import { describe, expect, it } from 'vitest';
import { CREATE_DEFAULTS, type CreateForm } from '../src/lib/flap';
import { FOUR_DEFAULTS, type FourForm } from '../src/lib/four-create';
import { flapPicture, flapRefusals, FLAP_FIELD_PART, fourPicture, fourRefusals, type PartId } from '../src/picture/launch-picture';

const base = { symbol: 'USDT (test)', decimals: 18, fee: '0.005 BNB', raiseProblem: false, checkProblem: false, coinProblem: false };
const pic = (over: Partial<CreateForm> = {}, more: Partial<typeof base> = {}) => {
  const form = { ...CREATE_DEFAULTS, ...over };
  return flapPicture({ ...base, ...more, form, refusals: flapRefusals(form, 18) });
};

describe('Flap: the form state as a picture (SH-281)', () => {
  it('the defaults: every number from the form, no problem', () => {
    const p = pic();
    expect(p.ticker).toBe('PILE');
    expect(p.buyers).toEqual(['fee 1%', 'tax 3%']);
    expect(p.sellers).toEqual(['fee 1%', 'tax 5%']);
    expect(p.front.left).toEqual({ label: 'Target', value: '2.35', unit: 'USDT (test)' });
    expect(p.front.right).toEqual({ label: 'Deadline', value: '48', unit: 'hours' });
    expect(p.coin).toBe('USDT (test)');
    expect(p.creator).toEqual(['Creator', '0.005 BNB']);
    expect(p.burn).toEqual(['Burned', '20%']);
    expect(p.burnCells).toBe(2);
    expect(p.pile).toEqual(['Pile', 'the rest']);
    expect(p.center).toEqual(['tax for 365 days']);
    expect(p.pool).toEqual({ label: 'Pool', number: 'at 2.35' });
    expect(p.warn).toEqual([]);
    expect(p.parts.map((x) => x.id)).toEqual(['buyers', 'token', 'sellers', 'creator', 'raise', 'price', 'deadline', 'tax', 'pool', 'pile']);
  });

  it('every part has a name that holds its words', () => {
    const names = Object.fromEntries(pic().parts.map((x) => [x.id, x.name]));
    expect(names.token).toBe('Token PILE');
    expect(names.raise).toBe('Target 2.35 USDT (test)');
    expect(names.deadline).toBe('Deadline 48 hours');
    expect(names.buyers).toBe('Buys: fee 1%, tax 3%');
    expect(names.tax).toBe('Tax: 20% burned, for 365 days');
  });

  // Each field at and past its edges: the value on the picture, and the part it marks (lib/flap.ts readCreateForm).
  const edges: [keyof CreateForm, string, boolean][] = [
    ['name', '', true],
    ['name', '   ', true],
    ['symbol', '', true],
    ['symbol', 'K', false],
    ['target', '', true],
    ['target', '0', true],
    ['target', '1,5', true],
    ['target', '0.000000000000000001', false],
    ['saleTokens', '0', true],
    ['virtualBnb', '', true],
    ['durationHours', '0', true],
    ['durationHours', '1', false],
    ['durationHours', '720', false],
    ['durationHours', '721', true],
    ['durationHours', '1.5', true],
    ['tradeFee', '0', false],
    ['tradeFee', '5', false],
    ['tradeFee', '5.01', true],
    ['buyTax', '0', false],
    ['buyTax', '0.5', true],
    ['buyTax', '1', false],
    ['buyTax', '10', false],
    ['buyTax', '10.01', true],
    ['sellTax', '0.99', true],
    ['burnShare', '0', false],
    ['burnShare', '99.99', false],
    ['burnShare', '100', true],
    ['taxDays', '0', true],
    ['taxDays', '1', false],
    ['taxDays', '49710', false],
    ['taxDays', '49711', true],
  ];
  for (const [key, value, bad] of edges) {
    it(`${key} = "${value}": ${bad ? 'marks its part' : 'no problem'}`, () => {
      const p = pic({ [key]: value });
      const part: PartId = FLAP_FIELD_PART[key];
      expect(p.warn.includes(part)).toBe(bad);
    });
  }

  it('both taxes 0: the sells part is marked (the rule "not both 0" belongs to the sell tax)', () => {
    const p = pic({ buyTax: '0', sellTax: '0' });
    expect(p.warn).toEqual(['sellers']);
    expect(p.sellers).toEqual(['fee 1%', 'tax ?']);
  });

  it('both taxes empty: each marks its own part', () => {
    expect(pic({ buyTax: '', sellTax: '' }).warn).toEqual(['buyers', 'sellers']);
    expect(pic({ buyTax: '0.5', sellTax: '0' }).warn).toEqual(['buyers']);
  });

  it('a field with a problem shows "?" in place of its number', () => {
    const p = pic({ target: '', durationHours: '0', tradeFee: '9', taxDays: '0', burnShare: '100' });
    expect(p.front.left.value).toBe('?');
    expect(p.front.right?.value).toBe('?');
    expect(p.buyers[0]).toBe('fee ?');
    expect(p.center).toEqual(['tax for ? days']);
    expect(p.burn).toEqual(['Burned', '?']);
    expect(p.pool.number).toBe('at ?');
    expect(p.warn).toEqual(['buyers', 'raise', 'deadline', 'tax']);
  });

  it('the burned cells: none at 0%, at least one above, never all ten below 100%', () => {
    expect(pic({ burnShare: '0' }).burnCells).toBe(0);
    expect(pic({ burnShare: '0.01' }).burnCells).toBe(1);
    expect(pic({ burnShare: '50' }).burnCells).toBe(5);
    expect(pic({ burnShare: '99.99' }).burnCells).toBe(9);
  });

  it("the factory's own problems mark their parts: the floor on the target, checkConfig on the creator, the coin on the price", () => {
    expect(pic({}, { raiseProblem: true }).warn).toEqual(['raise']);
    expect(pic({}, { checkProblem: true }).warn).toEqual(['creator']);
    expect(pic({}, { coinProblem: true }).warn).toEqual(['price']);
  });

  it('no symbol: the token says "Token"; the fee not read yet: the creator alone', () => {
    const p = flapPicture({ ...base, fee: undefined, form: { ...CREATE_DEFAULTS, symbol: '' }, refusals: flapRefusals({ ...CREATE_DEFAULTS, symbol: '' }, 18) });
    expect(p.ticker).toBe('Token');
    expect(p.parts.find((x) => x.id === 'token')?.name).toBe('Token');
    expect(p.creator).toEqual(['Creator']);
    expect(p.warn).toEqual(['token']);
  });

  it('a 6-decimal coin: the target is read in its decimals', () => {
    const form = { ...CREATE_DEFAULTS, target: '1700.5' };
    const p = flapPicture({ ...base, decimals: 6, form, refusals: flapRefusals(form, 6) });
    expect(p.front.left.value).toBe('1,700.5');
    expect(p.warn).toEqual([]);
  });
});

describe('Four.meme: the form state as a picture, both kinds (SH-281)', () => {
  const Q = '0x' + '2'.repeat(40);
  const quotes = [Q as `0x${string}`];
  const four = (over: Partial<FourForm> = {}, decimals = 18) => {
    const form: FourForm = { ...FOUR_DEFAULTS, quote: Q, ...over };
    return fourPicture({ form, symbol: 'WBNB', refusals: fourRefusals(form, quotes, () => decimals) });
  };
  it('curve fee: fees on buys and sells, all of them to the pile, no deadline, nothing burned', () => {
    const p = four();
    expect(p.buyers).toEqual(['fee 1%']);
    expect(p.sellers).toEqual(['fee 1%']);
    expect(p.front).toEqual({ left: { label: 'Raise', value: '1', unit: 'WBNB' }, right: null });
    expect(p.burn).toBeNull();
    expect(p.burnCells).toBe(0);
    expect(p.pile).toEqual(['Pile', 'all the fees']);
    expect(p.center).toEqual(['fee on every curve trade']);
    expect(p.creator).toEqual(['Creator']);
    expect(p.pool).toEqual({ label: 'Pool', number: 'at 1' });
    expect(p.parts.map((x) => x.id)).toEqual(['buyers', 'token', 'sellers', 'creator', 'raise', 'price', 'tax', 'pool', 'pile']);
    expect(p.warn).toEqual([]);
  });
  it('tax token: the tax on buys and sells, all of it to the pile', () => {
    const p = four({ kind: 'tax', buy: '3', sell: '3' });
    expect(p.buyers).toEqual(['tax 3%']);
    expect(p.pile).toEqual(['Pile', 'all the tax']);
    expect(p.center).toEqual(['tax on every trade']);
    expect(p.parts.find((x) => x.id === 'tax')?.name).toBe('Tax: all of it to the pile');
  });
  const edges: [Partial<FourForm>, PartId | null][] = [
    [{ name: '' }, 'token'],
    [{ name: 'a'.repeat(32) }, null],
    [{ name: 'a'.repeat(33) }, 'token'],
    [{ symbol: 'pile' }, 'token'],
    [{ symbol: 'A'.repeat(10) }, null],
    [{ symbol: 'A'.repeat(11) }, 'token'],
    [{ quote: '0x' + '3'.repeat(40) }, 'price'],
    [{ raise: '' }, 'raise'],
    [{ raise: '0' }, 'raise'],
    [{ raise: '1,5' }, 'raise'],
    [{ raise: '0.3' }, null],
    [{ buy: '10' }, null],
    [{ buy: '10.01' }, 'buyers'],
    [{ buy: '0', sell: '0' }, 'sellers'],
    [{ buy: '0', sell: '1' }, null],
    [{ kind: 'tax', sell: '0.99' }, 'sellers'],
    [{ kind: 'tax', sell: '1' }, null],
    [{ kind: 'tax', sell: '10.01' }, 'sellers'],
    [{ kind: 'tax', buy: '0', sell: '1' }, null],
  ];
  for (const [over, part] of edges) {
    it(`${JSON.stringify(over)}: ${part ?? 'no problem'}`, () => {
      expect(four(over).warn).toEqual(part ? [part] : []);
    });
  }
  it('a 6-decimal coin is refused on the price part (the signer encodes 18)', () => {
    expect(four({}, 6).warn).toEqual(['price']);
  });
  it('both fees empty: each marks its own part; "?" in place of their numbers', () => {
    const p = four({ buy: '', sell: '' });
    expect(p.warn).toEqual(['buyers', 'sellers']);
    expect(p.buyers).toEqual(['fee ?']);
  });
});
