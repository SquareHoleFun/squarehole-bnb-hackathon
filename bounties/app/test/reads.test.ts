import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractFunctionRevertedError, type Abi, type Address, type PublicClient } from 'viem';
import { afterFailedRead, AppProvider } from '../src/lib/app-context';
import { bodyRefusesRate, limitedFetch, makeLimiter, pageLimiter, PAUSE_FIRST_MS, PAUSE_MAX_MS, READ_TIMEOUT_MS, saysRateRefusal } from '../src/lib/limiter';
import { forgetScans, RATE_TRIES, readEvents, WINDOW } from '../src/lib/logs';
import { curveFactoryAbi, curveLauncherAbi } from '../src/abi/flap';
import { flapOriginOf, forgetOrigins } from '../src/lib/flap-origin';
import { publicClientFor } from '../src/lib/chain';
import { findPile, keptForVisit } from '../src/screens/FourToken';
import { Home } from '../src/screens/Home';
import { checkConfig, type AppConfig } from '../src/lib/config';
import { flapSalesIn, fourCreationOf, fourPictureLink, fourTokensIn, launchEventSources, launchLists, rulesLauncherIn } from '../src/lib/launch-events';
import addresses from '../public/addresses.json';

// SH-303: the launch pages read less. A refused read pauses every read of the page, growing; it ends when a read is
// answered; a refused log window is read again at the same size after the pause (never halved for a refusal); the
// screen keeps its last numbers with their age while reads fail, and fresh numbers clear the age.
afterEach(() => forgetScans());

describe('the limiter', () => {
  it('a refusal pauses all reads for 1 s, then 2 s, 4 s, at most 8 s; an answered read ends the streak', async () => {
    let t = 0;
    const slept: number[] = [];
    const l = makeLimiter(() => t, async (ms) => {
      slept.push(ms);
      t += ms;
    });
    await l.ready();
    expect(slept).toEqual([]);
    l.refused();
    expect(l.pauseLeft()).toBe(PAUSE_FIRST_MS);
    await l.ready();
    expect(slept).toEqual([1000]);
    l.refused();
    expect(l.pauseLeft()).toBe(2000);
    l.refused(); // a second refusal while paused extends the pause
    expect(l.pauseLeft()).toBe(4000);
    for (let i = 0; i < 10; i++) l.refused();
    expect(l.pauseLeft()).toBe(PAUSE_MAX_MS);
    await l.ready();
    l.answered();
    l.refused();
    expect(l.pauseLeft()).toBe(PAUSE_FIRST_MS); // the streak started again
  });
  it('the fetch waits out the pause, reports a 429 and a JSON-RPC rate refusal, and an answer', async () => {
    let t = 0;
    const l = makeLimiter(() => t, async (ms) => {
      t += ms;
    });
    const answers = [
      new Response('rate', { status: 429 }),
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too many requests' } }), { status: 200 }),
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), { status: 200 }),
    ];
    const sentAt: number[] = [];
    const f = limitedFetch(l, (async () => {
      sentAt.push(t);
      return answers.shift()!;
    }) as typeof fetch);
    expect((await f('https://x')).status).toBe(429);
    await f('https://x'); // waits 1 s, then is refused again in its body
    await f('https://x'); // waits 2 s, then answered
    expect(sentAt).toEqual([0, 1000, 3000]);
    expect(l.pauseLeft()).toBe(0);
    expect(bodyRefusesRate('{"jsonrpc":"2.0","id":1,"result":"0x0"}')).toBe(false);
    expect(bodyRefusesRate('[{"id":1,"error":{"code":429,"message":"Too many requests"}}]')).toBe(true);
  });
  it('the reads of one burst refused together count once: the pause stays short, and a failing read fails soon', async () => {
    let t = 0;
    // reads waiting together wake together: the clock moves to the end of the pause, once
    const l = makeLimiter(() => t, (ms) => {
      const at = t + ms;
      return Promise.resolve().then(() => {
        t = Math.max(t, at);
      });
    });
    const f = limitedFetch(l, (async () => new Response('rate', { status: 429 })) as typeof fetch);
    // five reads sent at once, all refused: one step of the pause, not five
    await Promise.all([f('https://x'), f('https://x'), f('https://x'), f('https://x'), f('https://x')]);
    expect(l.pauseLeft()).toBe(PAUSE_FIRST_MS);
    // each sent again after the pause, refused again: the next step (2 s)
    await Promise.all([f('https://x'), f('https://x'), f('https://x'), f('https://x'), f('https://x')]);
    expect(l.pauseLeft()).toBe(2000);
    // a read with three retries that keeps being refused has failed after 1 + 2 + 4 s of pauses
    const before = t;
    for (let i = 0; i < 2; i++) await f('https://x');
    expect(t - before).toBe(2000 + 4000);
  });
});

describe('a press and the pause', () => {
  it("a press's reads are sent at once while a pause runs; after the press, reads wait again", async () => {
    let t = 0;
    const slept: number[] = [];
    const l = makeLimiter(() => t, async (ms) => {
      slept.push(ms);
      t += ms;
    });
    l.refused();
    l.refused();
    l.refused(); // a 4 s pause runs
    const release = l.openForPress();
    const sentAt: number[] = [];
    const f = limitedFetch(l, (async () => {
      sentAt.push(t);
      return new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', { status: 200 });
    }) as typeof fetch);
    await f('https://x'); // the simulation
    await f('https://x'); // the gas
    expect(sentAt).toEqual([0, 0]);
    expect(slept).toEqual([]);
    release();
    release(); // twice is once
    await l.ready();
    expect(slept).toEqual([4000]); // the pause set before the press still runs, and reads wait for it again
  });
  it('a background read waits once, at most 8 s, whatever other reads push on meanwhile', async () => {
    let t = 0;
    const l = makeLimiter(() => t, async (ms) => {
      t += ms;
      l.refused(); // others are refused while this one waits: the page's pause moves on
    });
    for (let i = 0; i < 10; i++) l.refused(); // the pause is at its cap
    await l.ready();
    expect(t).toBe(PAUSE_MAX_MS);
    expect(PAUSE_MAX_MS).toBe(8_000);
    expect(l.pauseLeft()).toBeGreaterThan(0); // the page is still paused, but this read is sent now
  });
});

describe('the log windows', () => {
  const FACTORY = '0x00000000000000000000000000000000000000f1' as Address;
  const one = { chainId: 97, rpcUrl: 'https://a.test', rpcUrls: ['https://a.test'], explorer: 'https://e.test', fromBlock: '1' } as AppConfig;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const read = () => readEvents(publicClientFor(one), { address: FACTORY, abi: curveFactoryAbi, eventName: 'CurveLauncherCreated', fromBlock: 1n });

  function stubWindowReads(reply: (id: number, attempt: number) => Response) {
    const sent: { from: bigint; to: bigint; at: number }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const call = JSON.parse(String(init?.body)) as { id: number; method: string; params: { fromBlock: string; toBlock: string }[] };
      if (call.method === 'eth_blockNumber') return json({ jsonrpc: '2.0', id: call.id, result: `0x${WINDOW.toString(16)}` });
      expect(call.method).toBe('eth_getLogs');
      const range = call.params[0]!;
      sent.push({ from: BigInt(range.fromBlock), to: BigInt(range.toBlock), at: Date.now() });
      return reply(call.id, sent.length);
    });
    return sent;
  }

  afterEach(() => vi.restoreAllMocks());

  it('HTTP 429 and HTTP 200 rate errors retry the same window after each pause, up to six retries', async () => {
    vi.useFakeTimers({ now: Date.now() - 60_000 });
    const ready = vi.spyOn(pageLimiter, 'ready');
    const sent = stubWindowReads((id, attempt) => {
      const message = attempt === 1 ? 'unavailable' : 'rate limit';
      return json({ jsonrpc: '2.0', id, error: { code: -32000, message } }, attempt === 1 ? 429 : 200);
    });
    try {
      const failed = expect(read()).rejects.toThrow('rate limit');
      await vi.advanceTimersByTimeAsync(60_000);
      await failed;
      expect(sent).toHaveLength(RATE_TRIES + 1);
      expect(sent.map(({ from, to }) => [from, to])).toEqual(Array(RATE_TRIES + 1).fill([1n, WINDOW]));
      expect(sent.slice(1).map(({ at }, i) => at - sent[i]!.at)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
      expect(ready).toHaveBeenCalledTimes(1 + sent.length); // head and windows, once per send
    } finally {
      pageLimiter.answered();
      vi.useRealTimers();
    }
  });

  it.each([
    ['a plain error', { code: -32000, message: 'range too large' }],
    ['429 only in error.details', { code: -32000, message: 'range too large', details: 'upstream HTTP 429' }],
  ] as const)('halves the window immediately for %s', async (_label, error) => {
    const round = pageLimiter.roundNow();
    const sent = stubWindowReads((id, attempt) => json(attempt === 1 ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result: [] }));
    expect(await read()).toEqual([]);
    expect(pageLimiter.roundNow()).toBe(round);
    expect(sent.map(({ from, to }) => [from, to])).toEqual([[1n, WINDOW], [1n, WINDOW / 2n], [WINDOW / 2n + 1n, WINDOW]]);
  });

  it('the limiter\'s fetch counts every dress of a refusal the scan knows, and nothing else', async () => {
    const outcome = async (res: Response) => {
      let t = 0;
      const l = makeLimiter(() => t, async (ms) => {
        t += ms;
      });
      await limitedFetch(l, (async () => res) as typeof fetch)('https://x');
      return l.pauseLeft() > 0 ? 'refused' : 'not refused';
    };
    const error = (e: unknown, status = 200) => json({ jsonrpc: '2.0', id: 1, error: e }, status);
    expect(await outcome(error({ code: -32000, message: 'upstream HTTP 429' }))).toBe('refused');
    // the words decoded: a line break before the number, alone and in a batch; the data, a string or the strings in it
    expect(await outcome(error({ code: -32000, message: 'upstream HTTP\n429' }))).toBe('refused');
    expect(await outcome(json([{ jsonrpc: '2.0', id: 1, result: '0x1' }, { jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'upstream HTTP\n429' } }]))).toBe('refused');
    expect(await outcome(error({ code: -32005, message: 'limit exceeded', data: { reason: 'too many\trequests' } }))).toBe('not refused'); // a tab is no space, for the scan neither
    expect(await outcome(error({ code: -32005, message: 'limit exceeded', data: { reason: 'Too Many Requests' } }))).toBe('refused');
    // a number inside the data: only a failed answer's error is also read serialised (as viem hands it on)
    expect(await outcome(error({ code: -32005, message: 'limit exceeded', data: { retry: 429 } }))).toBe('not refused');
    expect(await outcome(error({ code: -32005, message: 'limit exceeded', data: { retry: 429 } }, 403))).toBe('refused');
    expect(await outcome(error({ code: -32005, message: 'limit exceeded', data: 'rate limited' }))).toBe('refused');
    expect(await outcome(error({ code: -32005, message: 'Rate limit exceeded' }, 403))).toBe('refused'); // a failed answer too
    expect(await outcome(new Response('Too Many Requests', { status: 503 }))).toBe('refused'); // not JSON
    expect(await outcome(new Response('', { status: 503, statusText: 'Too Many Requests' }))).toBe('refused');
    // not refusals: a range refusal, a revert, a failed answer that says nothing, and a request that merely has the number 429
    expect(await outcome(error({ code: -32701, message: 'exceed maximum block range: 50000' }, 403))).toBe('not refused');
    expect(await outcome(json([{ jsonrpc: '2.0', id: 429, error: { code: 3, message: 'execution reverted', data: '0x0429' } }]))).toBe('not refused');
    expect(await outcome(new Response('down', { status: 500 }))).toBe('not refused');
    expect(await outcome(json({ jsonrpc: '2.0', id: 429, result: '0x1' }))).toBe('not refused');
    // the same test on what viem throws for them: its own short line and the server's words, not the request it repeats
    expect(saysRateRefusal({ shortMessage: 'RPC Request failed.', message: 'RPC Request failed.\n\nURL: https://a.test/429\nDetails: no', details: 'no' })).toBe(false);
    expect(saysRateRefusal({ shortMessage: 'RPC Request failed.', details: 'upstream HTTP 429' })).toBe(true);
  });
  it('a log window has the 18 s too: one that does not answer is given up at 18 s, not at 10 s', async () => {
    const real = globalThis.fetch;
    vi.useFakeTimers();
    let asked = 0;
    let givenUpAfter: number | undefined;
    let t0 = 0;
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      const call = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (call.method === 'eth_getLogs' && asked++ === 0) {
        t0 = Date.now();
        return new Promise<Response>((_, reject) =>
          init!.signal!.addEventListener('abort', () => {
            givenUpAfter = Date.now() - t0;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }),
        );
      }
      return Promise.resolve(json({ jsonrpc: '2.0', id: call.id, result: call.method === 'eth_blockNumber' ? '0x64' : [] }));
    }) as typeof fetch;
    try {
      const read = readEvents(publicClientFor(one), { address: FACTORY, abi: curveFactoryAbi, eventName: 'CurveLauncherCreated', fromBlock: 1n });
      await vi.advanceTimersByTimeAsync(10_500);
      expect(asked).toBe(1);
      expect(givenUpAfter).toBe(undefined); // viem's own 10 s have passed
      await vi.advanceTimersByTimeAsync(8_000);
      expect(givenUpAfter).toBe(READ_TIMEOUT_MS);
      expect(await read).toEqual([]); // the window again (a time-out is no rate refusal), answered
    } finally {
      globalThis.fetch = real;
      vi.useRealTimers();
    }
  });
});

describe('the screen while reads fail', () => {
  const error = { name: 'unknown', sentence: 'The endpoint did not answer.' };
  it('keeps its numbers with their age ("Numbers from N s ago") while reads fail, and fresh numbers clear it', () => {
    const ok = { key: 'k', v: { state: 'ok' as const, value: 5, at: 1, stale: false } };
    const failed = afterFailedRead(ok, 'k', undefined, false, error);
    expect(failed.v).toEqual({ state: 'ok', value: 5, at: 1, stale: true }); // the badge shows
    expect(afterFailedRead(failed, 'k', undefined, false, error).v).toEqual({ state: 'ok', value: 5, at: 1, stale: true }); // still
    // an answered read sets fresh numbers (useChainRead: stale false), so the badge goes
    const fresh = { key: 'k', v: { state: 'ok' as const, value: 6, at: 9, stale: false } };
    expect(fresh.v.stale).toBe(false);
    // no numbers yet: the failure itself
    expect(afterFailedRead({ key: 'k', v: { state: 'loading' as const } }, 'k', undefined, false, error).v).toEqual({ state: 'error', error });
  });
});

describe('the one scan of creation events', () => {
  const A = (n: string) => `0x${n.padStart(40, '0')}` as Address;
  const config = {
    chainId: 97,
    rpcUrl: 'https://x',
    rpcUrls: ['https://x'],
    explorer: 'https://y',
    fromBlock: '1',
    flap: {
      portal: A('1'),
      tokenImpl: A('2'),
      pileVaultFactory: A('3'),
      curveLauncherFactory: A('f1'),
      sales: [],
      rules: { token: { launcherFactory: A('f2'), rulesVaultFactory: A('e2') } },
    },
    openfour: { core: A('c0'), tools: A('c1'), tokens: [] },
  } as unknown as Parameters<typeof launchEventSources>[0];
  const logs = [
    { address: A('f1'), eventName: 'CurveLauncherCreated', blockNumber: 5n, args: { launcher: A('d1') } },
    { address: A('f2'), eventName: 'TokenCurveLauncherCreated', blockNumber: 6n, args: { launcher: A('d2') } },
    { address: A('99'), eventName: 'CurveLauncherCreated', blockNumber: 7n, args: { launcher: A('d9') } }, // not our factory
    { address: A('e2'), eventName: 'RulesVaultCreated', blockNumber: 8n, args: { token: A('b2'), launcher: A('d2') } },
    { address: A('c0'), eventName: 'TokenCreated', blockNumber: 9n, args: { token: A('b4'), presetId: 2n, tokenMetaUri: 'u' } },
    { address: A('c0'), eventName: 'TokenCreated', blockNumber: 9n, args: { token: A('b5'), presetId: 7n } }, // another preset
  ];
  it('one query covers every source; each page takes only what is its own', () => {
    expect(launchEventSources(config)).toEqual({ flapFactories: [A('f1'), A('f2')], rulesVaultFactories: [A('e2')], core: A('c0') });
    expect(flapSalesIn(logs, config)).toEqual([A('d1'), A('d2')]);
    expect(fourTokensIn(logs, config, [1n, 2n])).toEqual([A('b4')]);
    expect(fourCreationOf(logs, config, A('b4'))?.args.tokenMetaUri).toBe('u');
    expect(rulesLauncherIn(logs, config, A('b2'))).toBe(A('d2'));
    expect(rulesLauncherIn(logs, config, A('b4'))).toBe(undefined);
  });
});

describe('the launches named in the shipped addresses file', () => {
  const checked = checkConfig(addresses);
  if (!checked.ok) throw new Error(checked.problem);
  const config = checked.value;
  const flap = config.flap!;
  const quote = flap.tokenQuote!;
  const native = flap.rules!.native!;
  const token = flap.rules!.token!;
  const named = [token.sales![1]!, token.sales![0]!, native.sales![0]!, quote.sales[0]!, flap.sales[0]!];
  const launchers = named.map((s) => s.launcher.toLowerCase());
  const empty = { state: 'ok' as const, value: [], at: 1, stale: false };

  it('lists all five sales newest first when the endpoint returns no events', () => {
    expect(launchLists(config, empty).sales).toEqual({ ...empty, value: launchers });
  });

  it('lists an event-only sale first and keeps one copy of each recorded sale', () => {
    const groups = [
      [flap.curveLauncherFactory, 'CurveLauncherCreated', flap.sales],
      [quote.launcherFactory, 'TokenCurveLauncherCreated', quote.sales],
      [native.launcherFactory, 'CurveLauncherCreated', native.sales!],
      [token.launcherFactory, 'TokenCurveLauncherCreated', token.sales!],
    ] as const;
    const logs = groups.flatMap(([address, eventName, sales]) =>
      sales.map(({ launcher }) => ({ address, eventName, blockNumber: 1n, args: { launcher } })),
    );
    const newer = '0x000000000000000000000000000000000000000a';
    logs.push({ address: flap.curveLauncherFactory, eventName: 'CurveLauncherCreated', blockNumber: 2n, args: { launcher: newer } });
    expect(launchLists(config, { ...empty, value: logs }).sales).toEqual({ ...empty, value: [newer, ...launchers] });
  });

  it('finds both pairs’ launchers by token without events and gives the file precedence', () => {
    for (const sale of [...native.sales!, ...token.sales!]) {
      expect(rulesLauncherIn([], config, sale.token.toLowerCase() as Address)).toBe(sale.launcher);
    }
    const sale = token.sales![0]!;
    const event = { address: token.rulesVaultFactory, eventName: 'RulesVaultCreated', blockNumber: 1n, args: { token: sale.token, launcher: flap.sales[0]!.launcher } };
    expect(rulesLauncherIn([event], config, sale.token)).toBe(sale.launcher);
  });

  it('uses the recorded OpenFour picture link only when the token has no creation event', () => {
    const recorded = addresses.openfour.tokens.find((t) => t.tokenUri)!;
    const token = recorded.token.toLowerCase() as Address;
    expect(fourPictureLink([], config, token)).toBe(recorded.tokenUri);
    expect(fourPictureLink([], config, flap.sales[0]!.token!)).toBeNull();
    const event = { address: config.openfour!.core, eventName: 'TokenCreated', blockNumber: 1n, args: { token, tokenMetaUri: 'event-link' } };
    expect(fourPictureLink([event], config, token)).toBe('event-link');
    expect(fourPictureLink([{ ...event, args: { token, tokenMetaUri: '' } }], config, token)).toBe('');
  });
});

describe('one retry budget per read', () => {
  it('a failing read is sent at most twice to each endpoint (one try each, then the list once more)', async () => {
    const sent: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return new Response('down', { status: 500 });
    }) as typeof fetch;
    try {
      const c = publicClientFor({ chainId: 97, rpcUrl: 'https://a.test', rpcUrls: ['https://a.test', 'https://b.test'], explorer: 'https://e.test', fromBlock: '1' } as AppConfig);
      await expect(c.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
      expect(sent.filter((u) => u.startsWith('https://a.test')).length).toBe(2);
      expect(sent.filter((u) => u.startsWith('https://b.test')).length).toBe(2);
    } finally {
      globalThis.fetch = real;
    }
  });
  it('with one endpoint too: a failing read is sent twice, not more', async () => {
    const sent: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return new Response('down', { status: 500 });
    }) as typeof fetch;
    try {
      const c = publicClientFor({ chainId: 97, rpcUrl: 'https://a.test', rpcUrls: ['https://a.test'], explorer: 'https://e.test', fromBlock: '1' } as AppConfig);
      await expect(c.getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
      expect(sent.length).toBe(2);
    } finally {
      globalThis.fetch = real;
    }
  });
  it('a read has the longest wait and then 10 s for its answer: 18 s in each of the page\'s endpoints', () => {
    expect(READ_TIMEOUT_MS).toBe(PAUSE_MAX_MS + 10_000);
    expect(READ_TIMEOUT_MS).toBe(18_000);
    const c = publicClientFor({ chainId: 97, rpcUrl: 'https://a.test', rpcUrls: ['https://a.test', 'https://b.test'], explorer: 'https://e.test', fromBlock: '1' } as AppConfig);
    const each = (c.transport as unknown as { transports: { config: { timeout?: number } }[] }).transports;
    expect(each.map((t) => t.config.timeout)).toEqual([READ_TIMEOUT_MS, READ_TIMEOUT_MS]);
  });
});

describe('the sale origin kept for the visit', () => {
  const A = (n: string) => `0x${n.padStart(40, '0')}` as Address;
  const config = { flap: { curveLauncherFactory: A('f1') } } as unknown as AppConfig;
  const LAUNCHER = A('d1');
  it('an internal error dressed as a revert is "not ours" for one round only: the next ask proves the sale', async () => {
    forgetOrigins();
    let fail = true;
    const c = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (fail && functionName === 'factory') {
          fail = false;
          throw new ContractFunctionRevertedError({ abi: curveLauncherAbi as Abi, functionName: 'factory', message: 'internal error' });
        }
        if (functionName === 'factory') return A('f1');
        if (functionName === 'creator') return A('c1');
        if (functionName === 'config') return { salt: `0x${'11'.repeat(32)}` };
        if (functionName === 'predictLauncher') return LAUNCHER;
        throw new Error(functionName);
      },
    } as unknown as PublicClient;
    expect(await flapOriginOf(c, config, LAUNCHER)).toBe(null);
    expect(await flapOriginOf(c, config, LAUNCHER)).toEqual({ origin: 'native', creator: A('c1') });
    forgetOrigins();
  });
});

describe('a Four.meme token kept for the visit', () => {
  const P = `0x${'aa'.repeat(20)}` as Address;
  it('a tax token with its pile, and a rules token with its splitter, are kept; a preset token never is', () => {
    expect(keptForVisit({ ours: true, pile: P, kind: 'tax' })).toBe(true);
    expect(keptForVisit({ ours: true, pile: P, kind: 'tax-rules', rules: { splitter: P } })).toBe(true);
    expect(keptForVisit({ ours: true, pile: P, kind: 'tax-rules', rules: {} })).toBe(false);
    expect(keptForVisit({ ours: true, pile: P, kind: 'preset' })).toBe(false);
    expect(keptForVisit({ ours: true, kind: 'tax' })).toBe(false);
    expect(keptForVisit({ ours: false, pile: P, kind: 'tax' })).toBe(false);
  });
  // through the page's own lookup (findPile), which decides what is kept
  const A = (n: string) => `0x${n.padStart(40, '0')}` as Address;
  const o = { core: A('c0'), tools: A('c1'), presetId: '1', taxPresetId: '2', taxTemplate: A('7e'), tokens: [] };
  const config = { openfour: o } as unknown as AppConfig;
  type Info = Parameters<typeof findPile>[3];
  it('a preset token is read again each round: a new pile behind its trade module shows on the next read', async () => {
    const TOKEN = A('b1');
    const MODULE = A('d1');
    let pile = A('e1');
    const c = {
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        if (address === MODULE && functionName === 'pile') return pile;
        if (functionName === 'token') return TOKEN;
        throw new Error(functionName);
      },
    } as unknown as PublicClient;
    const info = { token: TOKEN, presetId: 1n, tradeModule: MODULE, quoteAsset: A('aa'), exists: true } as unknown as Info;
    expect(await findPile(c, config, undefined, info)).toMatchObject({ kind: 'preset', ours: true, pile: A('e1') });
    pile = A('e2'); // the module behind the beacon answers with another pile
    expect((await findPile(c, config, undefined, info)).pile).toBe(A('e2'));
  });
  it('a tax token with its pile is kept: the next round sends no read for it', async () => {
    const TOKEN = A('b2');
    const QUOTE = A('aa');
    const PILE = A('e3');
    let asked = 0;
    const answers: Record<string, Address> = { founder: A('f0'), clonedVault: A('c9'), taxVaultToken: TOKEN, taxVaultQuote: QUOTE, pile: PILE, token: TOKEN };
    const c = {
      readContract: async ({ functionName }: { functionName: string }) => {
        asked += 1;
        if (!(functionName in answers)) throw new Error(functionName);
        return answers[functionName];
      },
      getBytecode: async () => {
        asked += 1;
        return `0x363d3d373d3d3d363d73${o.taxTemplate.slice(2)}5af43d82803e903d91602b57fd5bf3`;
      },
    } as unknown as PublicClient;
    const info = { token: TOKEN, presetId: 2n, tradeModule: A('d2'), quoteAsset: QUOTE, exists: true } as unknown as Info;
    expect(await findPile(c, config, undefined, info)).toMatchObject({ kind: 'tax', ours: true, pile: PILE });
    const first = asked;
    expect(first).toBeGreaterThan(0);
    expect((await findPile(c, config, undefined, info)).pile).toBe(PILE);
    expect(asked).toBe(first);
  });
});

describe('the launch page lists from the one shared read', () => {
  const A = (n: string) => `0x${n.padStart(40, '0')}` as Address;
  const flap = {
    portal: A('1'),
    curveLauncherFactory: A('f1'),
    sales: [{ launcher: A('a1') }],
    tokenQuote: { launcherFactory: A('f2'), sales: [] },
    rules: { native: { launcherFactory: A('f3'), rulesVaultFactory: A('e3') }, token: { launcherFactory: A('f4'), rulesVaultFactory: A('e4') } },
  };
  const ok = (value: unknown[]) => ({ state: 'ok' as const, value: value as never, at: 1, stale: false });
  const created = (factory: string, launcher: string, block: bigint) => ({
    address: A(factory),
    eventName: factory === 'f2' || factory === 'f4' ? 'TokenCurveLauncherCreated' : 'CurveLauncherCreated',
    blockNumber: block,
    args: { launcher: A(launcher) },
  });
  it('the Flap launches as before SH-303: grouped by factory (rules token, rules native, token, native), each newest first, the file\'s own last', () => {
    const config = { fromBlock: '1', flap } as unknown as AppConfig;
    // chain order interleaves the factories
    const logs = [created('f1', 'b1', 1n), created('f3', 'b3', 2n), created('f2', 'b2', 3n), created('f1', 'c1', 4n), created('f4', 'b4', 5n), created('f3', 'c3', 6n)];
    const { sales } = launchLists(config, ok(logs));
    expect(sales.state === 'ok' && sales.value).toEqual([A('b4'), A('c3'), A('b3'), A('b2'), A('c1'), A('b1'), A('a1')].map((a) => a.toLowerCase()));
  });
  it('a failed shared read fails only the lists that need it', () => {
    const failed = { state: 'error' as const, error: { name: 'unknown', sentence: 'down' } };
    // OpenFour without preset ids lists the file's tokens whatever the read does; Flap needs the events
    const config = { fromBlock: '1', flap, openfour: { core: A('c0'), tools: A('c1'), tokens: [{ token: A('t1') }, { token: A('t2') }] } } as unknown as AppConfig;
    const { sales, tokens } = launchLists(config, failed);
    expect(sales.state).toBe('error');
    expect(tokens.state === 'ok' && tokens.value).toEqual([A('t2'), A('t1')].map((a) => a.toLowerCase()));
    // no Flap in the file: its list is empty, not failed; OpenFour with preset ids needs the events
    const four = { fromBlock: '1', openfour: { core: A('c0'), tools: A('c1'), presetId: '1', tokens: [{ token: A('t1') }] } } as unknown as AppConfig;
    const both = launchLists(four, failed);
    expect(both.sales.state === 'ok' && both.sales.value).toEqual([]);
    expect(both.tokens.state).toBe('error');
  });
  it('a factory address the file names in two slots: each slot takes only its own event, so no launch moves', () => {
    // the rules token factory's address also sits in the plain native slot
    const config = { fromBlock: '1', flap: { ...flap, curveLauncherFactory: A('f4') } } as unknown as AppConfig;
    const logs = [created('f4', 'b4', 1n), created('f3', 'b3', 2n), created('f2', 'b2', 3n)];
    const { sales } = launchLists(config, ok(logs));
    // as the scans before SH-303: the native slot asked that address for the native event (none), so b4 stays in its own group
    expect(sales.state === 'ok' && sales.value).toEqual([A('b4'), A('b3'), A('b2'), A('a1')].map((a) => a.toLowerCase()));
  });
  it('the launch page itself (Home) takes its lists from there: the file\'s tokens show, newest first, while the shared read has not answered', () => {
    // OpenFour without preset ids needs no events; the Flap list does and waits. (A server render: no read has answered.)
    const config = {
      chainId: 97,
      rpcUrl: 'https://x.test',
      rpcUrls: ['https://x.test'],
      explorer: 'https://e.test',
      fromBlock: '1',
      flap: { ...flap, tokenImpl: A('2'), pileVaultFactory: A('3') },
      openfour: { core: A('c0'), tools: A('c1'), tokens: [{ token: A('b1') }, { token: A('b2') }] },
    } as unknown as AppConfig;
    const html = renderToStaticMarkup(createElement(AppProvider, { config, children: createElement(Home) }));
    const fourAt = html.indexOf('data-testid="rail-openfour"');
    expect(fourAt).toBeGreaterThan(-1);
    const four = html.slice(fourAt);
    const row = (t: Address) => four.indexOf(`href="#/four/${t.toLowerCase()}"`);
    expect(row(A('b2'))).toBeGreaterThan(-1);
    expect(row(A('b1'))).toBeGreaterThan(row(A('b2')));
    const flapCard = html.slice(html.indexOf('data-testid="rail-flap"'), fourAt);
    expect(flapCard).toContain('Reading…');
    expect(flapCard).not.toContain('data-testid="sale-line"');
  });
});
