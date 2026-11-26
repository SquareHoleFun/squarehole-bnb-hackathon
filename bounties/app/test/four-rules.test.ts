import { describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { checkCreateArgs, expectedCreateArgs, FOUR_DEFAULTS, readFourForm, forgetSignerOffer, SIGNER_ASK_MS, signerOffersRules, signerOffersRulesOnce, signerRefusal, type ExpectedTerms, type FourForm, type FourRequest, type Schemas } from '../src/lib/four-create';
import { RULES_DEFAULT, rulesRefusals } from '../src/lib/rules';
import { fourPicture, fourRefusals } from '../src/picture/launch-picture';

// SH-287 on the Four.meme rail (SH-281 step 4b): the tax-rules request (bounties/openfour/sign/README.md), its signed
// bytes checked against the form (sign-create.js buildCreateArgs: the rules inside the clone's parameters), and the
// probe that tells whether the signer offers the kind.
const me = ('0x' + '1'.repeat(40)) as Address;
const quote = ('0x' + '2'.repeat(40)) as Address;
const taxTemplate = ('0x' + '3'.repeat(40)) as Address;
const rulesTemplate = ('0x' + '4'.repeat(40)) as Address;
const parts = { creator: 2000, pile: 5000, burn: 3000 };

describe('the request', () => {
  const tax = { ...FOUR_DEFAULTS, kind: 'tax' as const, quote, sell: '1' };
  it('a tax launch with parts asks for tax-rules with them; without, today\'s tax kind; the curve-fee kind never', () => {
    expect(readFourForm(tax, me, [quote], () => 18, parts)).toMatchObject({ ok: true, body: { kind: 'tax-rules', creatorBps: 2000, pileBps: 5000, burnBps: 3000, taxBuyBps: 100, taxSellBps: 100 } });
    const plain = readFourForm(tax, me, [quote], () => 18);
    expect(plain.ok && plain.body.kind).toBe('tax');
    expect(plain.ok && 'creatorBps' in plain.body).toBe(false);
    const preset = readFourForm({ ...tax, kind: 'preset' }, me, [quote], () => 18, parts);
    expect(preset.ok && preset.body.kind).toBe('preset');
    // the body has exactly the README's fields
    const r = readFourForm(tax, me, [quote], () => 18, parts);
    expect(r.ok && Object.keys(r.body).sort()).toEqual(['burnBps', 'creator', 'creatorBps', 'kind', 'name', 'pileBps', 'quote', 'raiseAmount', 'symbol', 'taxBuyBps', 'taxSellBps', 'tokenUri']);
  });
  it('BAD_RULES has its own text', () => {
    expect(signerRefusal(400, { error: 'BAD_RULES' })).toBe('The signer refused the parts: whole numbers that add up to 100.');
  });
});

describe('whether the signer offers the kind: its refusal of a request with only the kind', () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it('offered only when it refuses the missing wallet, not the kind', async () => {
    let sent: unknown;
    const spy = (async (_u: string, init: RequestInit) => {
      if (init.method === 'GET') return new Response(JSON.stringify({ state: 'ready', signer: '0x1' }), { status: 200 }); // today's health: no kinds
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ error: 'BAD_CREATOR' }), { status: 400 });
    }) as unknown as typeof fetch;
    expect(await signerOffersRules('/api/four/sign-create', spy)).toBe(true);
    expect(sent).toEqual({ kind: 'tax-rules' });
    expect(await signerOffersRules('/x', answer(400, { error: 'BAD_KIND' }))).toBe(false);
    expect(await signerOffersRules('/x', answer(404, {}))).toBe(false);
    expect(await signerOffersRules('/x', answer(500, { error: 'INTERNAL' }))).toBe(false);
    expect(await signerOffersRules('/x', answer(200, { createArgs: '0x' }))).toBe(false);
    expect(await signerOffersRules('/x', (async () => { throw new Error('down'); }) as unknown as typeof fetch)).toBe(false);
  });

  // SH-303: a signer whose health names its kinds is asked nothing else; one whose health names none is probed, once a visit
  const counting = (health: unknown) => {
    const calls: string[] = [];
    const f = (async (u: string, init: RequestInit) => {
      calls.push(`${init.method} ${u}`);
      if (init.method === 'GET') return new Response(JSON.stringify(health), { status: 200 });
      return new Response(JSON.stringify({ error: 'BAD_CREATOR' }), { status: 400 });
    }) as unknown as typeof fetch;
    return { calls, f };
  };
  it('the health answer names the kinds: used, and no probe is sent', async () => {
    const on = counting({ state: 'ready', kinds: ['preset', 'tax', 'tax-rules'] });
    expect(await signerOffersRules('/launches/api/four/sign-create', on.f)).toBe(true);
    expect(on.calls).toEqual(['GET /launches/api/four/health']);
    const off = counting({ state: 'ready', kinds: ['preset', 'tax'] });
    expect(await signerOffersRules('/launches/api/four/sign-create', off.f)).toBe(false);
    expect(off.calls).toEqual(['GET /launches/api/four/health']);
  });
  it('a stalled health answer is given up after SIGNER_ASK_MS, then the probe decides', async () => {
    const calls: string[] = [];
    let aborted = false;
    // the health answer never comes: only its own time limit ends the ask (an ask without one stays open, as a browser's would)
    const f = ((u: string, init: RequestInit) => {
      calls.push(`${init.method} ${u}`);
      if (init.method === 'GET') {
        return new Promise((_, reject) =>
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(init.signal!.reason);
          }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'BAD_CREATOR' }), { status: 400 }));
    }) as unknown as typeof fetch;
    const t0 = Date.now();
    expect(await signerOffersRules('/launches/api/four/sign-create', f)).toBe(true);
    expect(aborted).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(SIGNER_ASK_MS - 100);
    expect(Date.now() - t0).toBeLessThan(SIGNER_ASK_MS + 2_000);
    expect(calls).toEqual(['GET /launches/api/four/health', 'POST /launches/api/four/sign-create']);
  }, SIGNER_ASK_MS + 4_000);
  it('gives health and the probe ten seconds each and accepts their five-second answers', async () => {
    forgetSignerOffer();
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      const f: typeof fetch = async (_url, init) => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return init?.method === 'GET'
          ? new Response(JSON.stringify({ state: 'ready' }))
          : new Response(JSON.stringify({ error: 'BAD_CREATOR' }), { status: 400 });
      };
      const answer = signerOffersRulesOnce('/api/four/sign-create', f);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await answer).toBe(true);
      expect(timeout.mock.calls).toEqual([[10_000], [10_000]]);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
      forgetSignerOffer();
    }
  });
  it('a failed health answer (HTTP 503) that names kinds is no answer: the probe decides, and its answer is the visit\'s', async () => {
    forgetSignerOffer();
    const calls: string[] = [];
    const f = (async (u: string, init: RequestInit) => {
      calls.push(`${init.method} ${u}`);
      if (init.method === 'GET') return new Response(JSON.stringify({ kinds: [] }), { status: 503 });
      return new Response(JSON.stringify({ error: 'BAD_CREATOR' }), { status: 400 });
    }) as unknown as typeof fetch;
    expect(await signerOffersRulesOnce('/launches/api/four/sign-create', f)).toBe(true);
    expect(calls).toEqual(['GET /launches/api/four/health', 'POST /launches/api/four/sign-create']);
    forgetSignerOffer();
  });
  it('no answer from the signer is not kept: the next visit asks again; an answer is kept', async () => {
    forgetSignerOffer();
    let n = 0;
    let up = false;
    const f = (async (_u: string, init: RequestInit) => {
      n += 1;
      if (!up) throw new Error('unreachable');
      if (init.method === 'GET') return new Response(JSON.stringify({ state: 'ready', kinds: ['preset', 'tax', 'tax-rules'] }), { status: 200 });
      throw new Error('no probe expected');
    }) as unknown as typeof fetch;
    expect(await signerOffersRulesOnce('/launches/api/four/sign-create', f)).toBeUndefined();
    expect(n).toBe(2); // the health and the probe, both unanswered
    up = true;
    expect(await signerOffersRulesOnce('/launches/api/four/sign-create', f)).toBe(true);
    expect(await signerOffersRulesOnce('/launches/api/four/sign-create', f)).toBe(true);
    expect(n).toBe(3); // asked again once, then kept
    forgetSignerOffer();
  });
  it('the health answer names none: one probe, kept for the visit', async () => {
    forgetSignerOffer();
    const old = counting({ state: 'ready', signer: '0x1', coreSignerIsKey: true });
    expect(await signerOffersRulesOnce('/launches/api/four/sign-create', old.f)).toBe(true);
    expect(await signerOffersRulesOnce('/launches/api/four/sign-create', old.f)).toBe(true);
    expect(await signerOffersRulesOnce('/launches/api/four/sign-create', old.f)).toBe(true);
    expect(old.calls).toEqual(['GET /launches/api/four/health', 'POST /launches/api/four/sign-create']);
    forgetSignerOffer();
  });
});

describe('the signed bytes of a tax-rules launch', () => {
  const p = (name: string, abiType: string) => ({ name, abiType, decimals: 0, optional: false, defaultValue: '' });
  const schemas: Schemas = {
    token: [p('founder', 'address'), p('buyFeeRate', 'uint256'), p('sellFeeRate', 'uint256'), p('rateFounder', 'uint256'), p('rateHolder', 'uint256'), p('rateBurn', 'uint256'), p('rateLiquidity', 'uint256'), p('minShare', 'uint256'), p('taxVaultTypeId', 'bytes32'), p('taxVaultInitParams', 'bytes')],
    vault: [],
    curve: [],
    trade: [],
    migrate: [],
    customData: [],
  };
  const body: FourRequest = { kind: 'tax-rules', creator: me, name: 'Rules', symbol: 'RT', tokenUri: '', quote, raiseAmount: '0.3', taxBuyBps: 100, taxSellBps: 100, creatorBps: 2000, pileBps: 5000, burnBps: 3000 };
  const terms = (b: FourRequest, over: Partial<ExpectedTerms> = {}): ExpectedTerms => ({ body: b, presetId: 7n, template: rulesTemplate, schemas, quoteDecimals: 18, ...over });
  const now = 1_000_000n;
  const differs = 'The signed launch differs from this form, so nothing was sent.';
  it('passes the honest bytes', () => {
    expect(checkCreateArgs(expectedCreateArgs(terms(body), 5n, now + 600n), terms(body), now)).toBeNull();
  });
  it('refuses other parts, another payee, today\'s tax kind, or the tax template in place of the rules template', () => {
    expect(checkCreateArgs(expectedCreateArgs(terms({ ...body, creatorBps: 3000, burnBps: 2000 }), 5n, now + 600n), terms(body), now)).toBe(differs);
    expect(checkCreateArgs(expectedCreateArgs(terms({ ...body, pileBps: 5001, burnBps: 2999 }), 5n, now + 600n), terms(body), now)).toBe(differs);
    const plain: FourRequest = { kind: 'tax', creator: me, name: 'Rules', symbol: 'RT', tokenUri: '', quote, raiseAmount: '0.3', taxBuyBps: 100, taxSellBps: 100 };
    expect(checkCreateArgs(expectedCreateArgs(terms(plain), 5n, now + 600n), terms(body), now)).toBe(differs);
    expect(checkCreateArgs(expectedCreateArgs(terms(body, { template: taxTemplate }), 5n, now + 600n), terms(body), now)).toBe(differs);
  });
  it('with no template on the page nothing is sent', () => {
    expect(checkCreateArgs(expectedCreateArgs(terms(body), 5n, now + 600n), terms(body, { template: undefined }), now)).toBe('This page has no tax template, so nothing was sent.');
  });
});

describe('the Four.meme picture with rules', () => {
  const form: FourForm = { ...FOUR_DEFAULTS, kind: 'tax', quote, sell: '1' };
  const pic = (rules?: typeof RULES_DEFAULT, f = form) =>
    fourPicture({ form: f, symbol: 'tETH', refusals: fourRefusals(f, [quote], () => 18), ...(rules ? { rules: { form: rules, refusals: rulesRefusals(rules) } } : {}) });
  it('without rules: as before', () => {
    const p = pic();
    expect(p.burn).toBe(null);
    expect(p.creatorTag).toBe(null);
    expect(p.pile).toEqual(['Pile', 'all the tax']);
    expect(p.cells).toEqual(Array(10).fill('pile'));
  });
  it('20 / 50 / 30: the star, the flame and the pile get their numbers; the tax part its name', () => {
    const p = pic({ creator: '20', pile: '50', burn: '30' });
    expect(p.creatorTag).toBe('20%');
    expect(p.burn).toEqual(['Buy back', 'and burn 30%']);
    expect(p.pile).toEqual(['Pile', '50% of the tax']);
    expect(p.cells.filter((c) => c === 'creator')).toHaveLength(2);
    expect(p.cells.filter((c) => c === 'buyburn')).toHaveLength(3);
    expect(p.parts.find((x) => x.id === 'tax')?.name).toBe('Tax: creator 20%, pile 50%, buy back and burn 30%');
    expect(p.warn).toEqual([]);
  });
  it('a sum other than 100 marks Tax; the curve-fee kind ignores rules', () => {
    expect(pic({ creator: '20', pile: '50', burn: '31' }).warn).toEqual(['tax']);
    const fee = pic({ creator: '20', pile: '50', burn: '31' }, { ...form, kind: 'preset' });
    expect(fee.warn).toEqual([]);
    expect(fee.burn).toBe(null);
  });
});
