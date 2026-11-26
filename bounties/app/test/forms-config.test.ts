import { describe, expect, it, vi } from 'vitest';
import { addressesUrl, allPiles, checkConfig, type AppConfig } from '../src/lib/config';
import { checkRedeem, redeemMinOut, REFUSALS } from '../src/lib/forms';
import { decodeError, ERROR_SENTENCES } from '../src/lib/errors';
import { feeRulesAbi } from '../src/abi/feeRules';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from 'viem';

const E18 = 10n ** 18n;

describe('the redeem box: every refusal it can show', () => {
  const base = { guardText: '0.5', decimals: 18, balance: 100n * E18, circulating: 1000n * E18 };
  const cases: [string, Partial<typeof base> & { amountText: string }, keyof typeof REFUSALS][] = [
    ['empty', { amountText: '' }, 'empty'],
    ['letters', { amountText: 'ten' }, 'not-a-number'],
    ['too precise', { amountText: '0.0000000000000000001' }, 'too-many-decimals'],
    ['zero', { amountText: '0' }, 'zero'],
    ['over balance', { amountText: '100.000000000000000001' }, 'over-balance'],
    ['over circulating', { amountText: '50', circulating: 10n * E18 }, 'over-circulating'],
    ['bad guard', { amountText: '1', guardText: '101' }, 'bad-guard'],
    ['empty guard', { amountText: '1', guardText: '' }, 'bad-guard'],
  ];
  for (const [name, over, refusal] of cases) {
    it(name, () => {
      expect(checkRedeem({ ...base, ...over })).toEqual({ ok: false, refusal });
      expect(REFUSALS[refusal]).toMatch(/\.$/);
    });
  }
  it('accepts the whole balance exactly', () => {
    expect(checkRedeem({ ...base, amountText: '100' })).toEqual({ ok: true, value: { amount: 100n * E18, guardBps: 50n } });
  });
  it('minimum out from the contract quote', () => {
    expect(redeemMinOut(6_180_160_000_000_000n, 50n)).toBe(6_149_259_200_000_000n);
  });
});

describe('the deployment file (findings 1 and 9): validated as a whole, refused on any problem', () => {
  const A = (c: string) => '0x' + c.repeat(40);
  const good = () => ({
    chainId: 97,
    rpcUrls: ['https://bsc-testnet-rpc.publicnode.com', 'https://bsc-testnet-dataseed.bnbchain.org'],
    explorer: 'https://testnet.bscscan.com',
    fromBlock: '144770777',
    flap: { portal: A('1'), tokenImpl: A('2'), pileVaultFactory: A('3'), curveLauncherFactory: A('4'), sales: [{ launcher: A('5'), token: A('6') }] },
    openfour: { core: A('7'), tools: A('8'), presetId: '1', taxPresetId: '2', taxTemplate: A('9'), quotes: [A('a')], tokens: [{ token: A('b'), kind: 'tax' }] },
    piles: [{ pile: A('c'), rail: 'core' }],
  });
  it('a complete file passes', () => {
    const r = checkConfig(good());
    expect(r.ok).toBe(true);
    if (r.ok) expect(allPiles(r.value)).toHaveLength(1);
  });
  const bad: [string, (f: ReturnType<typeof good>) => unknown, string][] = [
    ['a list at the top', () => [good()], 'file: must be an object'],
    ['chain 56', (f) => ({ ...f, chainId: 56 }), 'chainId: must be 97'],
    ['chain id as a string', (f) => ({ ...f, chainId: '97' }), 'chainId: must be 97'],
    ['no read endpoint', (f) => ({ ...f, rpcUrls: [] }), 'rpcUrls: must be a list with at least one entry'],
    ['a plain http endpoint', (f) => ({ ...f, rpcUrls: ['http://example.com'] }), 'rpcUrls[0]: must be an https URL'],
    ['an endpoint with a user', (f) => ({ ...f, rpcUrls: ['https://a:b@example.com'] }), 'rpcUrls[0]: must be an https URL'],
    ['not a URL', (f) => ({ ...f, explorer: 'testnet.bscscan.com' }), 'explorer: must be a URL'],
    ['a numeric fromBlock', (f) => ({ ...f, fromBlock: 5 }), 'fromBlock: has the wrong form'],
    ['a short address', (f) => ({ ...f, flap: { ...f.flap, portal: '0x1234' } }), 'flap.portal: must be an address (0x and 40 hex digits)'],
    ['a long address', (f) => ({ ...f, flap: { ...f.flap, portal: A('1') + '00' } }), 'flap.portal: must be an address (0x and 40 hex digits)'],
    ['a number as address', (f) => ({ ...f, flap: { ...f.flap, portal: 1 } }), 'flap.portal: must be an address (0x and 40 hex digits)'],
    ['a missing factory', (f) => ({ ...f, flap: { ...f.flap, curveLauncherFactory: undefined } }), 'flap.curveLauncherFactory: must be an address (0x and 40 hex digits)'],
    ['an unknown field', (f) => ({ ...f, extra: 1 }), 'file.extra: unknown field'],
    ['a preset id as a number', (f) => ({ ...f, openfour: { ...f.openfour, presetId: 1 } }), 'openfour.presetId: has the wrong form'],
  ];
  for (const [name, make, problem] of bad) {
    it(`refuses ${name}`, () => {
      expect(checkConfig(make(good()))).toEqual({ ok: false, problem });
    });
  }
  // SH-301: one entry of a list (a sale, a token, a pile) never stops the page: it is left out with a note naming it,
  // and nothing of it is trusted; the rest of the file stands.
  const leftOut: [string, (f: ReturnType<typeof good>) => unknown, string, (c: AppConfig) => unknown[]][] = [
    ['a nested unknown field', (f) => ({ ...f, flap: { ...f.flap, sales: [{ launcher: A('5'), spender: A('6') }] } }), 'flap.sales[0].spender: unknown field', (c) => c.flap!.sales],
    ['a wrong kind', (f) => ({ ...f, openfour: { ...f.openfour, tokens: [{ token: A('b'), kind: 'other' }] } }), 'openfour.tokens[0].kind: must be preset, tax or tax-rules', (c) => c.openfour!.tokens],
    ['a numeric picture link', (f) => ({ ...f, openfour: { ...f.openfour, tokens: [{ token: A('b'), tokenUri: 1 }] } }), 'openfour.tokens[0].tokenUri: has the wrong form', (c) => c.openfour!.tokens],
    ['a wrong rail', (f) => ({ ...f, piles: [{ pile: A('c'), rail: 'x' }] }), 'piles[0].rail: must be flap, openfour or core', (c) => c.piles!],
  ];
  for (const [name, make, problem, listOf] of leftOut) {
    it(`leaves out an entry with ${name}, says so, and keeps the page`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const r = checkConfig(make(good()));
      expect(r.ok).toBe(true);
      if (r.ok) expect(listOf(r.value)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(`addresses file: left out ${problem}`);
      warn.mockRestore();
    });
  }
  it('refuses a mixed-case address with a wrong checksum; takes all lower case and a right checksum', () => {
    const right = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    const wrong = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';
    expect(checkConfig({ ...good(), flap: { ...good().flap, portal: right } }).ok).toBe(true);
    expect(checkConfig({ ...good(), flap: { ...good().flap, portal: right.toLowerCase() } }).ok).toBe(true);
    expect(checkConfig({ ...good(), flap: { ...good().flap, portal: wrong } })).toEqual({ ok: false, problem: 'flap.portal: has a wrong checksum' });
  });
  it('refuses a tax preset without our tax template (no proof, no tax writes)', () => {
    const o = { core: A('a'), tools: A('b'), taxPresetId: '2', tokens: [] };
    expect(checkConfig({ ...good(), openfour: o })).toEqual({ ok: false, problem: 'openfour.taxTemplate: is required with taxPresetId' });
    expect(checkConfig({ ...good(), openfour: { ...o, taxTemplate: A('c') } }).ok).toBe(true);
  });
  it('takes the token-quote pair, with its label checked', () => {
    const t = { quote: A('d'), label: 'USDT (test)', launcherFactory: A('e'), pileVaultFactory: A('f'), sales: [] };
    const ok = checkConfig({ ...good(), flap: { ...good().flap, tokenQuote: t } });
    expect(ok.ok && ok.value.flap?.tokenQuote?.label).toBe('USDT (test)');
    expect(checkConfig({ ...good(), flap: { ...good().flap, tokenQuote: { ...t, label: '<b>x</b>' } } })).toEqual({ ok: false, problem: 'flap.tokenQuote.label: has the wrong form' });
    expect(checkConfig({ ...good(), flap: { ...good().flap, tokenQuote: { ...t, quote: '0x12' } } }).ok).toBe(false);
  });
  it('takes the rules pairs per coin (SH-287); none is today\'s config, an unknown key or a bad address is refused', () => {
    const pair = { launcherFactory: A('e'), rulesVaultFactory: A('f') };
    const one = checkConfig({ ...good(), flap: { ...good().flap, rules: { token: pair } } });
    expect(one.ok && one.value.flap?.rules).toEqual({ token: pair });
    const none = checkConfig(good());
    expect(none.ok && none.value.flap?.rules).toBe(undefined);
    expect(checkConfig({ ...good(), flap: { ...good().flap, rules: { usd: pair } } }).ok).toBe(false);
    expect(checkConfig({ ...good(), flap: { ...good().flap, rules: { native: { ...pair, rulesVaultFactory: '0x12' } } } }).ok).toBe(false);
    expect(checkConfig({ ...good(), flap: { ...good().flap, rules: { native: { launcherFactory: A('e') } } } }).ok).toBe(false);
  });
  it('validates both addresses on each named rules sale and keeps the valid entries', () => {
    const sale = { launcher: A('5'), token: A('6') };
    const pair = { launcherFactory: A('e'), rulesVaultFactory: A('f'), sales: [sale, { ...sale, launcher: '0x12' }, { launcher: sale.launcher }] };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const r = checkConfig({ ...good(), flap: { ...good().flap, rules: { native: pair } } });
      expect(r.ok && r.value.flap?.rules?.native?.sales).toEqual([sale]);
      expect(warn).toHaveBeenCalledWith('addresses file: left out flap.rules.native.sales[1].launcher: must be an address (0x and 40 hex digits)');
      expect(warn).toHaveBeenCalledWith('addresses file: left out flap.rules.native.sales[2].token: missing');
    } finally {
      warn.mockRestore();
    }
  });
  it('takes a plain http endpoint only where allowed (the development server, for a local chain)', () => {
    expect(checkConfig({ ...good(), rpcUrls: ['http://127.0.0.1:8581'] }, { allowHttp: true }).ok).toBe(true);
  });
  it('the production build takes no file name from the page address; development only plain names in the folder', () => {
    expect(addressesUrl('?addresses=local/addresses.json', '/launches/', false)).toBe('/launches/addresses.json');
    expect(addressesUrl('', '/launches', false)).toBe('/launches/addresses.json');
    expect(addressesUrl('?addresses=local/addresses.json', './', true)).toBe('./local/addresses.json');
    for (const hostile of ['/x.json', '//evil.example/x.json', '%2F%2Fevil.example%2Fx.json', '../x.json', 'a/../x.json', 'a\\x.json', 'https://evil.example/a.json', 'x.json?y=1', 'a//x.json']) {
      expect(addressesUrl(`?addresses=${hostile}`, './', true)).toBe('./addresses.json');
    }
  });
});

describe('a contract refusal reads as its name and one sentence, never hex', () => {
  it('InexactMovement', () => {
    const data = encodeErrorResult({ abi: feeRulesAbi, errorName: 'InexactMovement' });
    const err = new BaseError('call failed', {
      cause: new ContractFunctionRevertedError({ abi: feeRulesAbi, data, functionName: 'redeem' }),
    });
    const d = decodeError(err);
    expect(d.name).toBe('InexactMovement');
    expect(d.sentence).toBe(ERROR_SENTENCES.InexactMovement);
    expect(d.sentence).not.toMatch(/0x/);
  });
  it('BelowMinimum with arguments', () => {
    const data = encodeErrorResult({ abi: feeRulesAbi, errorName: 'BelowMinimum', args: [1n, 2n] });
    const err = new BaseError('x', { cause: new ContractFunctionRevertedError({ abi: feeRulesAbi, data, functionName: 'redeem' }) });
    expect(decodeError(err).name).toBe('BelowMinimum');
  });
  it('a wallet refusal', () => {
    expect(decodeError({ code: 4001 }).name).toBe('rejected');
  });
});
