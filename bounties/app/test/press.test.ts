import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BaseError, ContractFunctionRevertedError, createPublicClient, custom, encodeErrorResult, type Address, type Hash } from 'viem';
import { chainFor } from '../src/lib/chain';
import { feeRulesAbi } from '../src/abi/feeRules';
import { AppProvider, finalLine, guardSends, minimumAtPress, reasonOf, sendWrite, useApp, useTx, waitForApproval, withApproval, type Press, type PressStep, type WalletLike, type WriteLock } from '../src/lib/app-context';
import type { AppConfig } from '../src/lib/config';
import { pageLimiter } from '../src/lib/limiter';
import { SiteSignInProvider } from '../src/lib/site-signin';
import { WalletProvider } from '../src/lib/wallet';

// The effects of a render in these tests are kept instead of dropped (a server render never runs them), so a test can
// run one by hand: the provider's teardown is an effect's cleanup.
const kept = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[] }));
vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>();
  return { ...real, useEffect: (effect: () => void | (() => void)) => void kept.effects.push(effect) };
});
import { decodeError, PageRefusal } from '../src/lib/errors';
import { checkCreateArgs, checkSigned, expectedCreateArgs, FOUR_DEFAULTS, readFourForm, signerRefusal, signUrl, type ExpectedTerms, type FourRequest, type Schemas } from '../src/lib/four-create';
import { isCloneOf } from '../src/screens/FourToken';

const refusalOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof PageRefusal ? e.refusal : 'other';
  }
  return null;
};

describe('the minimum at the press (finding 4)', () => {
  it('is taken from the fresh quote with the guard on screen', () => {
    expect(minimumAtPress(1000n, 100n, 990n)).toBe(990n);
    expect(minimumAtPress(2000n, 100n, 990n)).toBe(1980n); // better than shown: sent
  });
  it('refuses a zero minimum: a 100% guard, a quote that rounds to nothing, an empty pile', () => {
    expect(refusalOf(() => minimumAtPress(1000n, 10_000n, undefined))).toBe('zero-minimum');
    expect(refusalOf(() => minimumAtPress(1n, 1n, undefined))).toBe('zero-minimum');
    expect(refusalOf(() => minimumAtPress(0n, 50n, undefined))).toBe('zero-minimum');
  });
  it('asks again when the fresh minimum is worse than the one the visitor saw', () => {
    expect(refusalOf(() => minimumAtPress(999n, 100n, 990n))).toBe('quote-moved');
  });
});

describe('refusals carry the payout coin’s own decimals (finding 6)', () => {
  it('BelowMinimum on a 6-decimal coin', () => {
    const data = encodeErrorResult({ abi: feeRulesAbi, errorName: 'BelowMinimum', args: [500_000n, 600_000n] });
    const err = new BaseError('x', { cause: new ContractFunctionRevertedError({ abi: feeRulesAbi, data, functionName: 'redeem' }) });
    expect(decodeError(err, 6).sentence).toBe('The payout, 0.5, fell below your minimum, 0.6, so nothing was done.');
  });
  it('a page refusal reads as its own name and sentence', () => {
    expect(decodeError(new PageRefusal('wallet-changed', 'The wallet changed, so nothing was sent.'))).toEqual({
      name: 'wallet-changed',
      sentence: 'The wallet changed, so nothing was sent.',
    });
  });
});

describe('the Four.meme create form and the signer’s answer', () => {
  const me = '0x' + '1'.repeat(40);
  const quote = '0x' + '2'.repeat(40);
  const base = { ...FOUR_DEFAULTS, quote };
  it('builds the signer’s body exactly (preset and tax)', () => {
    expect(readFourForm(base, me as `0x${string}`, [quote as `0x${string}`])).toEqual({
      ok: true,
      body: { kind: 'preset', creator: me, name: 'My Pile', symbol: 'PILE', tokenUri: '', quote, raiseAmount: '1', buyFeeBps: 100, sellFeeBps: 100 },
    });
    const tax = readFourForm({ ...base, kind: 'tax', buy: '3', sell: '3', raise: '0.3' }, me as `0x${string}`, [quote as `0x${string}`]);
    expect(tax.ok && tax.body).toEqual({ kind: 'tax', creator: me, name: 'My Pile', symbol: 'PILE', tokenUri: '', quote, raiseAmount: '0.3', taxBuyBps: 300, taxSellBps: 300 });
  });
  const cases: [Partial<typeof base>, string][] = [
    [{ name: '' }, 'name'],
    [{ name: 'a'.repeat(33) }, 'name'],
    [{ symbol: 'pile' }, 'symbol'],
    [{ quote: '0x' + '3'.repeat(40) }, 'quote'],
    [{ raise: '1,5' }, 'raise'],
    [{ buy: '11' }, 'buy'],
    [{ buy: '0', sell: '0' }, 'sell'],
    [{ kind: 'tax', sell: '0.5' }, 'sell'],
  ];
  for (const [over, field] of cases) {
    it(`refuses ${JSON.stringify(over)}`, () => {
      const r = readFourForm({ ...base, ...over }, me as `0x${string}`, [quote as `0x${string}`]);
      expect(r.ok ? null : r.refusal.field).toBe(field);
    });
  }
  const body = { kind: 'preset', creator: me } as unknown as FourRequest;
  const ok = { createArgs: '0x12', signature: '0x34', requestId: '7', validUntil: 2000, kind: 'preset', creator: me };
  it('accepts a signature for this creator and kind, still valid', () => {
    expect(checkSigned(ok, body, 1000)).toEqual({ createArgs: '0x12', signature: '0x34', requestId: '7', validUntil: 2000 });
  });
  it('refuses another creator, another kind, an expired one, no bytes; a refusal reads as the page’s own text', () => {
    expect(checkSigned({ ...ok, creator: '0x' + '9'.repeat(40) }, body, 1000)).toBe('The signature is for another wallet.');
    expect(checkSigned({ ...ok, kind: 'tax' }, body, 1000)).toBe('The signature is for another kind of launch.');
    expect(checkSigned(ok, body, 2000)).toBe('The signature has expired.');
    expect(checkSigned({ ...ok, signature: 'nope' }, body, 1000)).toBe('The signer gave no signature.');
    // a refusal shows the page's fixed text for its code, never text from the answer (re-read finding 2)
    expect(checkSigned({ error: 'BAD_NAME', message: 'go to evil.example' }, body, 1000)).toBe('The signer refused the name: 1 to 32 letters, digits, spaces, dots or dashes.');
    expect(checkSigned({ error: 'NEW_CODE', message: 'go to evil.example' }, body, 1000)).toBe('The signer refused, so nothing was sent.');
    expect(signerRefusal(500, { error: 'BAD_NAME', message: 'x' })).toBe('The signer refused, so nothing was sent.');
    expect(signerRefusal(400, { error: 'toString', message: 'x' })).toBe('The signer refused, so nothing was sent.');
  });
  it('calls the signer on this page’s own origin, under the build’s base', () => {
    expect(signUrl('/launches/')).toBe('/launches/api/four/sign-create');
    expect(signUrl('./')).toBe('./api/four/sign-create');
  });
});

describe('a tax vault must be a clone of our template (finding 2)', () => {
  const t = '0x' + 'ab'.repeat(20);
  it('matches the EIP-1167 code of the template only', () => {
    expect(isCloneOf(`0x363d3d373d3d3d363d73${'ab'.repeat(20)}5af43d82803e903d91602b57fd5bf3`, t as `0x${string}`)).toBe(true);
    expect(isCloneOf(`0x363d3d373d3d3d363d73${'cd'.repeat(20)}5af43d82803e903d91602b57fd5bf3`, t as `0x${string}`)).toBe(false);
    expect(isCloneOf(undefined, t as `0x${string}`)).toBe(false);
  });
});

describe('the sale’s quote coin is the sale’s, not assumed (lane f’s token-quote variant comes next)', () => {
  it('the native coin is sent as value; a token quote sends none (it is approved and pulled)', async () => {
    const { NATIVE_QUOTE, valueFor } = await import('../src/lib/quote');
    expect(valueFor(NATIVE_QUOTE, 5n)).toBe(5n);
    expect(valueFor({ kind: 'token', address: ('0x' + '1'.repeat(40)) as `0x${string}`, symbol: 'USDT', decimals: 6 }, 5n)).toBeUndefined();
  });
});

describe('the last check sits at the wallet call itself (re-read finding 1)', () => {
  const me = ('0x' + '1'.repeat(40)) as Address;
  const approve = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] }] as const;
  const request = { address: ('0x' + '2'.repeat(40)) as Address, abi: approve, functionName: 'approve', args: [me, 5n] };
  function setup(onChainIdCall: (n: number) => void) {
    (globalThis as unknown as { window: unknown }).window = { location: { hash: '#/flap/x' } };
    let epoch = 1;
    let chainIdCalls = 0;
    const sent: unknown[] = [];
    const eth = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_accounts') return [me];
        if (method === 'eth_chainId') {
          onChainIdCall(++chainIdCalls);
          return '0x61';
        }
        if (method === 'eth_sendTransaction' || method === 'wallet_sendTransaction') {
          sent.push(params?.[0]);
          return '0x' + 'ab'.repeat(32);
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const wallet = { account: me, currentEpoch: () => epoch, provider: () => eth };
    // SH-280: the guard reads the chain's fee right before the wallet (fees.ts): the read endpoint answers BNB Chain
    // testnet's numbers (base fee 0, 0.1 gwei).
    const client = createPublicClient({ chain: chainFor({ rpcUrls: ['http://127.0.0.1:1'], explorer: 'https://x' }), transport: custom({ request: async ({ method }: { method: string }) => (
      method === 'eth_gasPrice' ? '0x5f5e100' : method === 'eth_maxPriorityFeePerGas' ? '0x0'
        : method === 'eth_getBlockByNumber' ? { number: '0x1', hash: `0x${'11'.repeat(32)}`, timestamp: '0x1', baseFeePerGas: '0x0', transactions: [] } : null) }) });
    const state = { moved: false, asked: 0, need: null as string | null, needReads: [] as number[] };
    const press: Press = {
      account: me,
      epoch: 1,
      check: () => {
        if (state.moved) throw new PageRefusal('moved', 'The page changed.');
      },
      steps: () => undefined,
      onWallet: () => {
        state.asked += 1;
      },
      sent: () => undefined,
      mined: async () => ({}) as never,
      next: () => undefined,
    };
    const need = async () => {
      state.needReads.push(chainIdCalls);
      return state.need;
    };
    return { sent, wallet, client, press, state, need, bump: () => (epoch += 1) };
  }
  function approveThenAct(latest: () => Promise<bigint>, balance = async () => 5n) {
    const t = setup(() => undefined);
    let mined = false;
    t.press.mined = async () => {
      mined = true;
      return { blockNumber: 30n } as never;
    };
    t.press.next = vi.fn();
    const read = vi.spyOn(t.client, 'readContract').mockImplementation(async (call) => {
      if (call.functionName === 'balanceOf') return balance();
      return call.blockNumber === 30n ? 5n : mined ? latest() : 0n;
    });
    const act = vi.fn(async () => {
      expect(await t.press.alsoNeeds!()).toBeNull();
      return sendWrite(t.client, t.wallet, request, t.press, t.need, 100_000n);
    });
    const result = withApproval(t.client, t.wallet, t.press, {
      token: request.address, spender: me, amount: 5n, approveLabel: 'Approve', mainLabel: 'Act', need: t.need, gas: 100_000n,
    }).then(act);
    return { ...t, read, act, result };
  }
  it('refuses a grant above the pressing owner’s latest balance before asking the wallet', async () => {
    const t = approveThenAct(async () => 5n, async () => 4n);
    const provider = vi.spyOn(t.wallet, 'provider');
    await expect(t.result).rejects.toMatchObject({ refusal: 'over-balance', sentence: 'More than you hold.' });
    const reads = t.read.mock.calls.filter(([call]) => call.functionName === 'balanceOf');
    expect(reads).toEqual([[expect.objectContaining({ address: request.address, args: [t.press.account], blockTag: 'latest' })]]);
    expect(provider).not.toHaveBeenCalled();
    expect(t.act).not.toHaveBeenCalled();
  });
  it.each(['sufficient', 'unreadable'])('continues the grant and call when the balance is %s', async (state) => {
    vi.useFakeTimers();
    try {
      const balance = vi.fn(async () => {
        if (state === 'unreadable') throw new Error('read failed');
        return 5n;
      });
      const t = approveThenAct(async () => 5n, balance);
      await vi.advanceTimersByTimeAsync(1000);
      await t.result;
      expect(balance).toHaveBeenCalledOnce();
      expect(t.sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('removes an approval without a balance read', async () => {
    const t = setup(() => undefined);
    const read = vi.spyOn(t.client, 'readContract').mockResolvedValue(5n);
    await withApproval(t.client, t.wallet, t.press, {
      token: request.address, spender: me, amount: 0n, approveLabel: 'Remove', need: t.need, gas: 100_000n,
    });
    expect(t.sent).toHaveLength(1);
    expect(read.mock.calls.every(([call]) => call.functionName === 'allowance')).toBe(true);
  });
  it.each([
    { scenario: 'latest lags and briefly falls behind again', reads: [0n, 0n, 5n, 0n, 5n, 5n] },
    { scenario: 'latest shows the approval immediately', reads: [5n, 5n] },
  ])('waits for two consecutive reads when $scenario', async ({ reads }) => {
    vi.useFakeTimers();
    try {
      const answers = [...reads];
      const latest = vi.fn(async () => answers.shift() ?? 5n);
      const t = approveThenAct(latest);
      await vi.advanceTimersByTimeAsync((reads.length - 1) * 1000 - 1);
      expect(latest).toHaveBeenCalledTimes(reads.length - 1);
      expect(t.act).not.toHaveBeenCalled();
      expect(t.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await t.result;
      expect(t.act).toHaveBeenCalledOnce();
      expect(t.sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('starts four-second receipt and latest reads together and continues at nine seconds', async () => {
    vi.useFakeTimers();
    try {
      const slowRead = () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 4000));
      const receipt = vi.fn(slowRead);
      const latest = vi.fn(slowRead);
      const continued = vi.fn();
      const done = waitForApproval(setup(() => undefined).press, latest, receipt).then(continued);
      expect(receipt).toHaveBeenCalledOnce();
      expect(latest).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(8999);
      expect(continued).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(continued).toHaveBeenCalledOnce();
      expect(latest).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('refuses a different receipt-block amount even when latest shows the approved amount', async () => {
    vi.useFakeTimers();
    try {
      const latest = vi.fn(() => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 500)));
      const receipt = () => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1800));
      const done = expect(waitForApproval(setup(() => undefined).press, latest, receipt)).rejects.toMatchObject({
        refusal: 'state', sentence: 'the allowance on chain is not the amount approved',
      });
      await vi.advanceTimersByTimeAsync(1800);
      await done;
      expect(latest).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('continues after two latest matches when the receipt-block read never answers', async () => {
    vi.useFakeTimers();
    try {
      const t = setup(() => undefined);
      t.press.next = vi.fn();
      const done = waitForApproval(t.press, async () => true, () => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(t.press.next).toHaveBeenCalledExactlyOnceWith('the allowance');
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['old', 'unanswered'])('ends the press after twenty seconds with an %s latest allowance read', async (state) => {
    vi.useFakeTimers();
    try {
      const t = approveThenAct(() => state === 'old' ? Promise.resolve(0n) : new Promise(() => {}));
      const failure = vi.fn();
      const done = t.result.catch(failure);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(failure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(decodeError(failure.mock.calls[0]![0])).toEqual({
        name: 'approval-not-visible', sentence: 'The approval is confirmed, but the network does not show it yet. Press again in a moment.',
      });
      expect(t.press.next).toHaveBeenCalledOnce();
      expect(t.sent).toHaveLength(1);
      expect(t.act).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('a wallet change while the wallet client asks for the chain stops the send', async () => {
    let bump = () => 0;
    const t = setup((n) => {
      if (n === 2) bump(); // the first eth_chainId is the page's own check; the second is viem's, after it
    });
    bump = t.bump;
    expect(decodeError(await sendWrite(t.client, t.wallet, request, t.press, t.need, 100_000n).catch((e) => e)).name).toBe('wallet-changed');
    expect(t.sent).toEqual([]);
  });
  it('a page change at that moment stops it too; otherwise the transaction carries from and chain 0x61', async () => {
    let t = setup(() => undefined);
    t = setup((n) => {
      if (n === 2) t.state.moved = true; // the navigation counter moved while the wallet client asked for the chain
    });
    expect(decodeError(await sendWrite(t.client, t.wallet, request, t.press, t.need, 100_000n).catch((e) => e)).name).toBe('moved');
    expect(t.sent).toEqual([]);
    expect(t.state.asked).toBe(0);
    const u = setup(() => undefined);
    await sendWrite(u.client, u.wallet, request, u.press, u.need, 100_000n);
    expect(u.sent).toHaveLength(1);
    expect(u.sent[0]).toMatchObject({ from: me, chainId: '0x61', maxFeePerGas: '0x68e7780', maxPriorityFeePerGas: '0x68e7780' });
    expect(u.state.asked).toBe(1);
  });
  it('a step whose chain state is gone is not sent, with its reason', async () => {
    const t = setup(() => undefined);
    t.state.need = 'the sale has launched';
    const e = await sendWrite(t.client, t.wallet, request, t.press, t.need, 100_000n).catch((x) => x);
    expect(decodeError(e)).toEqual({ name: 'state', sentence: 'the sale has launched' });
    expect(t.sent).toEqual([]);
    expect(t.state.asked).toBe(0);
  });
  it('the state is read inside the provider call, after the library\'s own chain request: a change during it is caught', async () => {
    let t = setup(() => undefined);
    t = setup((n) => {
      if (n === 2) t.state.need = 'the sale has launched'; // the sale launches while viem asks the wallet for the chain
    });
    const e = await sendWrite(t.client, t.wallet, request, t.press, t.need, 100_000n).catch((x) => x);
    expect(decodeError(e).sentence).toBe('the sale has launched');
    expect(t.state.needReads).toEqual([2]); // read once, after both chain requests
    expect(t.sent).toEqual([]);
  });
  it('both transaction methods are checked and pinned; raw and batched sends are refused', async () => {
    const seen: unknown[] = [];
    let ok = true;
    const g = guardSends({ request: async (a) => seen.push(a) }, me, () => {
      if (!ok) throw new Error('changed');
    });
    await g.request({ method: 'wallet_sendTransaction', params: [{ from: '0x' + '9'.repeat(40), chainId: '0x1' }] });
    await g.request({ method: 'eth_sendTransaction', params: [{}] });
    expect(seen).toEqual([
      { method: 'wallet_sendTransaction', params: [{ from: me, chainId: '0x61' }] },
      { method: 'eth_sendTransaction', params: [{ from: me, chainId: '0x61' }] },
    ]);
    ok = false;
    await expect(g.request({ method: 'eth_sendTransaction', params: [{}] })).rejects.toThrow('changed');
    for (const method of ['eth_sendRawTransaction', 'wallet_sendCalls', 'eth_signTransaction']) await expect(g.request({ method, params: [] })).rejects.toMatchObject({ refusal: 'wallet-changed' });
    expect(seen).toHaveLength(2);
  });
});

describe('the signed launch is decoded and compared with the form (re-read findings 2 and 8)', () => {
  const me = ('0x' + '1'.repeat(40)) as Address;
  const quote = ('0x' + '2'.repeat(40)) as Address;
  const template = ('0x' + '3'.repeat(40)) as Address;
  const p = (name: string, abiType: string, defaultValue = '', decimals = 0) => ({ name, abiType, decimals, optional: false, defaultValue });
  // schemas in the shape OpenFour's Tools reports; the preset's trade module carries the fees, the tax token module its routing
  const schemas: Schemas = {
    token: [p('founder', 'address', '', 0), p('buyFeeRate', 'uint256'), p('sellFeeRate', 'uint256'), p('rateFounder', 'uint256'), p('rateHolder', 'uint256'), p('rateBurn', 'uint256'), p('rateLiquidity', 'uint256'), p('minShare', 'uint256'), p('taxVaultTypeId', 'bytes32'), p('taxVaultInitParams', 'bytes')],
    vault: [],
    curve: [p('k', 'uint256', '5', 2)],
    trade: [],
    migrate: [],
    customData: [],
  };
  const presetSchemas: Schemas = { ...schemas, token: [], trade: [p('buyFeeBps', 'uint256'), p('sellFeeBps', 'uint256')] };
  const preset: FourRequest = { kind: 'preset', creator: me, name: 'My Pile', symbol: 'PILE', tokenUri: '', quote, raiseAmount: '1', buyFeeBps: 100, sellFeeBps: 100 };
  const tax: FourRequest = { kind: 'tax', creator: me, name: 'My Tax', symbol: 'TPILE', tokenUri: '', quote, raiseAmount: '0.3', taxBuyBps: 300, taxSellBps: 300 };
  const terms = (body: FourRequest, over: Partial<ExpectedTerms> = {}): ExpectedTerms => ({ body, presetId: 7n, template, schemas: body.kind === 'tax' ? schemas : presetSchemas, quoteDecimals: 18, ...over });
  const now = 1_000_000n;
  it('passes the honest bytes', () => {
    expect(checkCreateArgs(expectedCreateArgs(terms(preset), 5n, now + 600n), terms(preset), now)).toBeNull();
    expect(checkCreateArgs(expectedCreateArgs(terms(tax), 5n, now + 600n), terms(tax), now)).toBeNull();
  });
  const differs = 'The signed launch differs from this form, so nothing was sent.';
  const swaps: [string, FourRequest, Partial<ExpectedTerms>, FourRequest][] = [
    ['another name', preset, {}, { ...preset, name: 'Other' }],
    ['another symbol', preset, {}, { ...preset, symbol: 'X' }],
    ['another coin', preset, {}, { ...preset, quote: ('0x' + '4'.repeat(40)) as Address }],
    ['another raise', preset, {}, { ...preset, raiseAmount: '2' }],
    ['other fees', preset, {}, { ...preset, sellFeeBps: 1000 }],
    ['another tax rate', tax, {}, { ...tax, taxSellBps: 1000 }],
    ['another founder', tax, {}, { ...tax, creator: ('0x' + '5'.repeat(40)) as Address }],
  ];
  for (const [what, body, over, signedFor] of swaps) {
    it(`refuses a valid signature for ${what}`, () => {
      expect(checkCreateArgs(expectedCreateArgs(terms(signedFor, over), 5n, now + 600n), terms(body), now)).toBe(differs);
    });
  }
  it('refuses another preset, another tax template, and an 18-decimal raise for a 6-decimal coin', () => {
    expect(checkCreateArgs(expectedCreateArgs(terms(preset, { presetId: 8n }), 5n, now + 600n), terms(preset), now)).toBe(differs);
    expect(checkCreateArgs(expectedCreateArgs(terms(tax, { template: ('0x' + '6'.repeat(40)) as Address }), 5n, now + 600n), terms(tax), now)).toBe(differs);
    expect(checkCreateArgs(expectedCreateArgs(terms(preset), 5n, now + 600n), terms(preset, { quoteDecimals: 6 }), now)).toBe(differs);
  });
  it('refuses a validity in the past or too far ahead of the chain, a zero request id, bytes that do not decode', () => {
    const bad = 'The signature is not valid now, so nothing was sent.';
    expect(checkCreateArgs(expectedCreateArgs(terms(preset), 5n, now), terms(preset), now)).toBe(bad);
    expect(checkCreateArgs(expectedCreateArgs(terms(preset), 5n, now + 3600n), terms(preset), now)).toBe(bad);
    expect(checkCreateArgs(expectedCreateArgs(terms(preset), 0n, now + 600n), terms(preset), now)).toBe('The signed launch could not be read, so nothing was sent.');
    expect(checkCreateArgs('0x12', terms(preset), now)).toBe('The signed launch could not be read, so nothing was sent.');
  });
  it('the form offers only 18-decimal coins (the signer encodes 18)', () => {
    const r = readFourForm({ ...FOUR_DEFAULTS, quote }, me, [quote], () => 6);
    expect(r.ok ? null : r.refusal.field).toBe('quote');
  });
});

describe('the last line of a press says exactly what happened', () => {
  const st = (label: string, state: PressStep['state'], asked: boolean, reason?: string): PressStep => ({ label, state, asked, reason });
  it('"Nothing was sent" only when no step reached the wallet', () => {
    expect(finalLine([st('Buy', 'notSent', false, 'cancelled')])).toBe('Nothing was sent: cancelled.');
    expect(finalLine([st('Approve 300 USDT (test) for this sale', 'notSent', false, 'the sale has launched'), st('Buy', 'notSent', false, 'step 1 did not go through')])).toBe(
      'Nothing was sent: the sale has launched.',
    );
  });
  it('each step of a longer press in order', () => {
    expect(finalLine([st('Approve', 'confirmed', true), st('Buy', 'notSent', false, 'the sale has launched')])).toBe('Step 1 confirmed. Step 2 was not sent: the sale has launched.');
    expect(finalLine([st('Approve', 'confirmed', true), st('Launch', 'confirmed', true)])).toBe('Step 1 confirmed. Step 2 confirmed.');
    expect(finalLine([st('Approve', 'failed', true, 'it was undone on chain'), st('Buy', 'notSent', false, 'step 1 did not go through')])).toBe(
      'Step 1 failed: it was undone on chain. Step 2 was not sent: step 1 did not go through.',
    );
  });
  it('a one-step press by its name; a rejection in the wallet is "not sent", not "nothing was sent"', () => {
    expect(finalLine([st('Redeem', 'confirmed', true)])).toBe('Redeem confirmed.');
    expect(finalLine([st('Redeem', 'notSent', true, 'you rejected it in your wallet')])).toBe('Redeem was not sent: you rejected it in your wallet.');
  });
  it('a refusal sentence becomes a reason', () => {
    expect(reasonOf('The wallet changed, so nothing was sent.')).toBe('the wallet changed');
    expect(reasonOf('The quote moved. Check the new numbers and press again.')).toBe('the quote moved. Check the new numbers and press again');
  });
});

describe('the three outcomes of a step, never a guess', () => {
  const st = (label: string, state: PressStep['state'], asked: boolean, extra: Partial<PressStep> = {}): PressStep => ({ label, state, asked, ...extra });
  it('unknown: the wallet was asked and no hash came back', () => {
    expect(finalLine([st('Approve', 'confirmed', true), st('Buy', 'unknown', true)])).toBe(
      "Step 1 confirmed. Your wallet did not answer for step 2. It may still send it: check your wallet's activity before pressing again.",
    );
  });
  it('pending: sent, no receipt, left by the visitor', () => {
    expect(finalLine([st('Get', 'pending', true, { hash: '0x1' })])).toBe('Step 1 is still pending: check it on the explorer before pressing again.');
  });
  it('a read after a confirmed receipt that fails keeps the step confirmed', () => {
    expect(finalLine([st('Get', 'confirmed', true, { unread: 'the new balance' })])).toBe('Get confirmed; the new balance could not be read.');
  });
});

// SH-303, second review round (G1): a press holds the page's pause off while it runs (its own reads go out at once).
// Every way a press ends gives the pause back, also the ways that never reach the runner's end by themselves: "Stop
// waiting" with a wallet that never answers, and "Leave it pending". Through the page's own provider and runner (useTx),
// rendered once: their refs and callbacks are the page's.
describe('an ended press gives the page its pause back', () => {
  const ME = ('0x' + '1'.repeat(40)) as Address;
  const HASH = ('0x' + 'ab'.repeat(32)) as Hash;
  const CONFIG = { chainId: 97, rpcUrl: 'http://127.0.0.1:1', rpcUrls: ['http://127.0.0.1:1'], explorer: 'https://testnet.bscscan.com', fromBlock: '0' } as AppConfig;
  const wallet: WalletLike = { account: ME, currentEpoch: () => 0, provider: () => undefined };
  type Run = ReturnType<typeof useTx>['run'];
  function mount(): { run: Run; lock: WriteLock } {
    let got: { run: Run; lock: WriteLock } | undefined;
    const Probe = () => {
      const { lock } = useApp();
      got = { run: useTx().run, lock };
      return null;
    };
    const inWallet = createElement(WalletProvider, { rpcUrls: CONFIG.rpcUrls, explorer: CONFIG.explorer, children: createElement(Probe) });
    renderToStaticMarkup(createElement(SiteSignInProvider, { initial: { state: 'off' }, children: createElement(AppProvider, { config: CONFIG, children: inWallet }) }));
    return got!;
  }
  /** A 1 s pause runs from now: whether a background read waits for it (true), or may be sent at once (false). */
  const readWaits = () => {
    pageLimiter.answered();
    pageLimiter.refused();
    return Promise.race([pageLimiter.ready().then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 40))]);
  };
  /** The runner's timers (a development page may shorten them) and the endpoint: no receipt yet, whatever is asked. */
  async function stand<T>(f: (asked: () => number) => Promise<T>): Promise<T> {
    const g = globalThis as unknown as { window?: unknown; fetch: typeof fetch };
    const had = { window: g.window, fetch: g.fetch };
    let asked = 0;
    g.window = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id), __slowAfterMs: 30, __receiptPollMs: 10 };
    g.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      asked += 1;
      const body = JSON.parse(String(init?.body)) as { id: number } | { id: number }[];
      const none = (c: { id: number }) => ({ jsonrpc: '2.0', id: c.id, result: null });
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(none) : none(body)), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      return await f(() => asked);
    } finally {
      g.window = had.window;
      g.fetch = had.fetch;
      pageLimiter.answered();
    }
  }

  it('"Stop waiting" with a wallet that never answers: reads wait again; a wallet that answers later ends the runner', () =>
    stand(async () => {
      const { run, lock } = mount();
      expect(await readWaits()).toBe(true);
      // the wallet is asked and never answers
      void run('Buy', wallet, async (press) => {
        press.onWallet();
        return new Promise<Hash>(() => undefined);
      });
      expect(await readWaits()).toBe(false); // the press runs: its reads go out at once
      lock.stopWaiting();
      expect(await readWaits()).toBe(true);
      lock.close();
      // the wallet answers after "Stop waiting": the receipt wait of an ended press ends, and so does the runner
      let answer!: (h: Hash) => void;
      const done = run('Buy', wallet, async (press) => {
        press.onWallet();
        return new Promise<Hash>((r) => (answer = r));
      });
      expect(await readWaits()).toBe(false);
      lock.stopWaiting();
      expect(await readWaits()).toBe(true);
      answer(HASH);
      expect(await done).toBe(null);
      expect(await readWaits()).toBe(true);
      lock.close();
    }));

  it('"Leave it pending" on a sent step without a receipt: reads wait again, the receipt wait ends and the runner returns', () =>
    stand(async (asked) => {
      const { run, lock } = mount();
      let ended: unknown;
      const done = run('Buy', wallet, async (press) => {
        press.onWallet();
        press.sent(HASH);
        // as a plan with an approval waits for its first step (withApproval)
        await press.mined(HASH).catch((e: unknown) => {
          ended = e;
          throw e;
        });
        return HASH;
      });
      await new Promise((r) => setTimeout(r, 60)); // the receipt is asked for, again and again: none yet
      expect(asked()).toBeGreaterThan(1);
      expect(await readWaits()).toBe(false);
      lock.leavePending();
      expect(await readWaits()).toBe(true);
      expect(await done).toBe(null);
      expect(ended instanceof PageRefusal && ended.refusal).toBe('stopped'); // the ended wait says what ended it
      const n = asked();
      await new Promise((r) => setTimeout(r, 60));
      expect(asked()).toBe(n); // nothing asks for the receipt any more
    }));

  it('the provider letting a press go ("Leave it pending") gives the pause back whatever the press does', () =>
    stand(async () => {
      const { run, lock } = mount();
      // a press whose step is not sent yet: its own "leave" does nothing, the provider's does
      void run('Buy', wallet, async (press) => {
        press.onWallet();
        return new Promise<Hash>(() => undefined);
      });
      expect(await readWaits()).toBe(false);
      lock.leavePending();
      expect(await readWaits()).toBe(true);
    }));

  it('a press that fails by itself gives the pause back at the runner\'s own end', () =>
    stand(async () => {
      const { run, lock } = mount();
      const done = run('Buy', wallet, async () => {
        await new Promise((r) => setTimeout(r, 60));
        throw new PageRefusal('state', 'the sale ended');
      });
      expect(await readWaits()).toBe(false); // the press runs
      expect(await done).toBe(null);
      expect(await readWaits()).toBe(true);
      lock.close();
    }));

  it('the provider going away ends a running press: its plan stops at its next check, before the wallet, and the pause is back', () =>
    stand(async () => {
      kept.effects.length = 0;
      const { run } = mount();
      let approvalMined!: () => void;
      let reached = 'the approval';
      const done = run('Buy', wallet, async (press) => {
        await new Promise<void>((r) => (approvalMined = r));
        press.check(); // every wallet request starts with it (sendWrite)
        reached = 'the wallet';
        press.onWallet();
        return new Promise<Hash>(() => undefined);
      });
      expect(await readWaits()).toBe(false);
      // the provider's own teardown: the cleanup of its effect, run as an unmount runs it
      const teardown = kept.effects.filter((e) => String(e).includes('pauseAgain'));
      expect(teardown).toHaveLength(1);
      (teardown[0]!() as () => void)();
      expect(await readWaits()).toBe(true);
      approvalMined();
      await new Promise((r) => setTimeout(r, 20));
      expect(reached).toBe('the approval');
      expect(await done).toBe(null);
    }));
});
