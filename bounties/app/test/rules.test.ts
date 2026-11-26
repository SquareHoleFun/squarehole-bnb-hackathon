import { describe, expect, it } from 'vitest';
import { CREATE_DEFAULTS, type CreateForm } from '../src/lib/flap';
import { dispatchWaitingText, FOUR_SET_UP_SAYS, fourRulesState, isPileOnly, payeesOf, readRules, ruleName, RULES_DEFAULT, rulesArg, rulesRefusals, type RulesForm } from '../src/lib/rules';
import { cellsOf, flapPicture, flapRefusals } from '../src/picture/launch-picture';

// SH-287 on the launch page (SH-281 step 4): the creator's three parts, as the form holds them and the contracts take
// them (bounties/flap/src/RulesVaultFactory.sol _check: 1 to 4 rules, each above 0, summing to 10,000; a creator rule
// needs its payee; pile and buy back have no target before the launch).
const ME = '0x00000000000000000000000000000000000bEEF1' as const;
const ZERO = '0x0000000000000000000000000000000000000000';
const f = (creator: string, pile: string, burn: string): RulesForm => ({ creator, pile, burn });

describe('the rules form', () => {
  it('the default is Pile 100, today\'s behaviour: no rules to send', () => {
    expect(RULES_DEFAULT).toEqual({ creator: '0', pile: '100', burn: '0' });
    const r = readRules(RULES_DEFAULT);
    expect(r.ok && isPileOnly(r.parts)).toBe(true);
  });
  it('each part at and past its edges: 0 and 100 read, 101, -1, 1.5, empty, letters do not', () => {
    for (const v of ['0', '100', '007']) expect(rulesRefusals(f(v, '0', '0')).creator).toBe(undefined);
    for (const v of ['101', '-1', '1.5', '', ' ', 'x', '1e2', '1000']) {
      expect(rulesRefusals(f(v, '50', '50')).creator).toBe('A whole number from 0 to 100.');
      expect(rulesRefusals(f('50', v, '50')).pile).toBe('A whole number from 0 to 100.');
      expect(rulesRefusals(f('50', '50', v)).burn).toBe('A whole number from 0 to 100.');
    }
    expect(rulesRefusals(f(' 20 ', '50', '30'))).toEqual({});
  });
  it('the sum: exactly 100, else one refusal on the pile', () => {
    expect(rulesRefusals(f('20', '50', '30'))).toEqual({});
    expect(rulesRefusals(f('100', '0', '0'))).toEqual({});
    expect(rulesRefusals(f('0', '0', '100'))).toEqual({});
    expect(rulesRefusals(f('20', '50', '29'))).toEqual({ pile: 'The three parts add up to 100.' });
    expect(rulesRefusals(f('20', '50', '31'))).toEqual({ pile: 'The three parts add up to 100.' });
    expect(rulesRefusals(f('0', '0', '0'))).toEqual({ pile: 'The three parts add up to 100.' });
    expect(rulesRefusals(f('100', '100', '100'))).toEqual({ pile: 'The three parts add up to 100.' });
    // a field that does not read is named first; the sum waits for it
    expect(rulesRefusals(f('x', '50', '30'))).toEqual({ creator: 'A whole number from 0 to 100.' });
  });
  it('whole percent to basis points; a part at 0 is not there; the creator is paid to the account that presses', () => {
    const r = readRules(f('20', '50', '30'));
    expect(r).toEqual({ ok: true, parts: { creator: 2000, pile: 5000, burn: 3000 } });
    if (!r.ok) throw new Error('not read');
    expect(isPileOnly(r.parts)).toBe(false);
    expect(rulesArg(r.parts, ME)).toEqual([
      { kind: 1, bps: 2000, target: ME },
      { kind: 2, bps: 5000, target: ZERO },
      { kind: 3, bps: 3000, target: ZERO },
    ]);
    const noPile = readRules(f('40', '0', '60'));
    expect(noPile.ok && rulesArg(noPile.parts, ME)).toEqual([
      { kind: 1, bps: 4000, target: ME },
      { kind: 3, bps: 6000, target: ZERO },
    ]);
    const one = readRules(f('0', '0', '100'));
    expect(one.ok && rulesArg(one.parts, ME)).toEqual([{ kind: 3, bps: 10_000, target: ZERO }]);
    const sum = (x: { bps: number }[]) => x.reduce((a, b) => a + b.bps, 0);
    for (const [c, p, b] of [['1', '1', '98'], ['33', '33', '34'], ['99', '1', '0']]) {
      const k = readRules(f(c!, p!, b!));
      expect(k.ok && sum(rulesArg(k.parts, ME))).toBe(10_000);
    }
  });
});

describe('the trays with rules', () => {
  it('without rules: the burned cells, then the pile (as before)', () => {
    expect(cellsOf(2, null)).toEqual(['burn', 'burn', ...Array(8).fill('pile')]);
    expect(cellsOf(0, null)).toEqual(Array(10).fill('pile'));
  });
  it('the rest shared by the parts; a part above 0 gets a cell while there are enough; a part at 0 none; always 10', () => {
    const count = (c: string[]) => Object.fromEntries(['burn', 'creator', 'pile', 'buyburn'].map((k) => [k, c.filter((x) => x === k).length]));
    expect(count(cellsOf(2, { creator: 2000, pile: 5000, burn: 3000 }))).toEqual({ burn: 2, creator: 2, pile: 4, buyburn: 2 });
    expect(count(cellsOf(2, { creator: 0, pile: 10_000, burn: 0 }))).toEqual({ burn: 2, creator: 0, pile: 8, buyburn: 0 });
    expect(count(cellsOf(0, { creator: 100, pile: 9800, burn: 100 }))).toEqual({ burn: 0, creator: 1, pile: 8, buyburn: 1 });
    // one cell for three parts: the largest part's
    expect(count(cellsOf(9, { creator: 5000, pile: 100, burn: 4900 }))).toEqual({ burn: 9, creator: 1, pile: 0, buyburn: 0 });
    expect(count(cellsOf(2, { creator: 4000, pile: 0, burn: 6000 }))).toEqual({ burn: 2, creator: 3, pile: 0, buyburn: 5 });
    expect(count(cellsOf(2, { creator: 10_000, pile: 0, burn: 0 }))).toEqual({ burn: 2, creator: 8, pile: 0, buyburn: 0 });
    for (const burn of [0, 1, 5, 9]) {
      for (const parts of [
        { creator: 3300, pile: 3300, burn: 3400 },
        { creator: 100, pile: 100, burn: 9800 },
        { creator: 9800, pile: 100, burn: 100 },
        { creator: 0, pile: 0, burn: 10_000 },
      ]) {
        const c = cellsOf(burn, parts);
        expect(c).toHaveLength(10);
        expect(c.filter((x) => x === 'burn')).toHaveLength(burn);
        const there = [parts.creator, parts.pile, parts.burn].filter((x) => x > 0).length;
        if (parts.pile > 0 && there <= 10 - burn) expect(c.includes('pile')).toBe(true);
        if (parts.pile === 0) expect(c.includes('pile')).toBe(false);
        if (parts.creator === 0) expect(c.includes('creator')).toBe(false);
        if (parts.burn === 0) expect(c.includes('buyburn')).toBe(false);
      }
    }
  });
});

describe('the Flap picture with rules', () => {
  const base = { symbol: 'USDT (test)', decimals: 18, fee: '0.005 BNB', raiseProblem: false, checkProblem: false, coinProblem: false };
  const pic = (rules?: RulesForm, over: Partial<CreateForm> = {}) => {
    const form = { ...CREATE_DEFAULTS, ...over };
    return flapPicture({ ...base, form, refusals: flapRefusals(form, 18), ...(rules ? { rules: { form: rules, refusals: rulesRefusals(rules) } } : {}) });
  };
  it('without a rules entry: as before', () => {
    const p = pic();
    expect(p.creatorTag).toBe(null);
    expect(p.pile).toEqual(['Pile', 'the rest']);
    expect(p.burn).toEqual(['Burned', '20%']);
    expect(p.cells).toEqual(cellsOf(2, null));
    expect(p.parts.find((x) => x.id === 'tax')?.name).toBe('Tax: 20% burned, for 365 days');
  });
  it('Pile 100 with the entry: the trays as before, the parts named', () => {
    const p = pic(RULES_DEFAULT);
    expect(p.creatorTag).toBe(null);
    expect(p.pile).toEqual(['Pile', 'the rest']);
    expect(p.cells).toEqual(cellsOf(2, null));
    expect(p.warn).toEqual([]);
    expect(p.parts.find((x) => x.id === 'tax')?.name).toBe('Tax: 20% burned, for 365 days; the rest: creator 0%, pile 100%, buy back and burn 0%');
  });
  it('20 / 50 / 30: the star and the flame get their numbers, the pile its share', () => {
    const p = pic(f('20', '50', '30'));
    expect(p.creatorTag).toBe('20%');
    expect(p.burn).toEqual(['Burned 20%', 'buy back 30%', 'of the rest']);
    expect(p.creatorTagOf).toBe('of the rest');
    expect(p.pile).toEqual(['Pile', '50% of the rest']);
    expect(p.cells.filter((c) => c === 'creator')).toHaveLength(2);
    expect(p.warn).toEqual([]);
  });
  it('a sum other than 100 marks Tax, and only Tax', () => {
    const p = pic(f('20', '50', '29'));
    expect(p.warn).toEqual(['tax']);
    expect(p.pile).toEqual(['Pile', '?']);
    expect(p.creatorTag).toBe(null);
    expect(p.parts.find((x) => x.id === 'tax')?.name).toBe('Tax: 20% burned, for 365 days; the rest: ?');
    expect(pic(f('x', '50', '30')).warn).toEqual(['tax']);
  });
  it('a wrong sum and another field: both marked, in reading order', () => {
    const p = pic(f('20', '50', '29'), { symbol: '' });
    expect(p.warn).toContain('tax');
    expect(p.warn).toContain('token');
  });
});

describe('step 4c: the naming rule and the two state fixes', () => {
  const OTHER = '0x00000000000000000000000000000000000bEEF9' as const;
  const SHOP = '0x00000000000000000000000000000000000bEEF5' as const;
  it('a paying rule is "Creator" only for the launch\'s creator; a named payee gets its name; any other is "Paid to"', () => {
    expect(ruleName(1, ME, ME)).toBe('Creator');
    expect(ruleName(1, ME, ME.toLowerCase() as typeof ME)).toBe('Creator');
    expect(ruleName(1, OTHER, ME)).toBe('Paid to');
    expect(ruleName(1, OTHER, undefined)).toBe('Paid to');
    const named = (a: string) => (a.toLowerCase() === SHOP.toLowerCase() ? 'Shop' : undefined);
    expect(ruleName(1, SHOP, ME, named)).toBe('Shop');
    expect(ruleName(1, ME, ME, named)).toBe('Creator');
    expect(ruleName(2, ZERO as typeof ME, ME)).toBe('Pile');
    expect(ruleName(3, ZERO as typeof ME, ME)).toBe('Buy back and burn');
  });
  it('the payees: the paying rules\' addresses, in order, once each', () => {
    expect(payeesOf([{ kind: 1, target: ME }, { kind: 2, target: ZERO as typeof ME }, { kind: 1, target: OTHER }, { kind: 1, target: ME.toLowerCase() as typeof ME }, { kind: 3, target: ZERO as typeof ME }])).toEqual([ME, OTHER]);
    expect(payeesOf([{ kind: 2, target: ZERO as typeof ME }])).toEqual([]);
  });
  it('Flap\'s tax box: nothing in the processor says only that nothing waits (never "already with the rules")', () => {
    expect(dispatchWaitingText(0n)).toBe('Nothing waiting to send.');
    expect(dispatchWaitingText(1n)).toBe(null);
  });
  it('a Four.meme rules token: set up while the clone has no splitter; then the pile, or none for a pile part of 0', () => {
    expect(fourRulesState(undefined, undefined)).toBe('set-up');
    expect(fourRulesState(undefined, OTHER)).toBe('set-up');
    expect(fourRulesState(OTHER, SHOP)).toBe('pile');
    expect(fourRulesState(OTHER, undefined)).toBe('no-pile');
    // the line before the set-up is true with and without a pile part
    expect(FOUR_SET_UP_SAYS).toBe('The rules are fixed; one press (anyone, once) sets them up.');
  });
});
