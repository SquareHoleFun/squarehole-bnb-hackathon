/**
 * SH-276: a request the endpoint refused with HTTP 429 is sent again to the same endpoint, up to three more times, after
 * 400, 900 and 1,800 ms (or a Retry-After of at most two seconds); nothing else is tried again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpRequest } from './rpc';

const URL_ONE = 'https://rpc.example.org/';
const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200, headers: { 'content-type': 'application/json' } });
const refused = (retryAfter?: string) => new Response('later', { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} });

/** The pauses between consecutive requests, in ms. */
const gaps = (calls: readonly { at: number }[]): number[] => calls.slice(1).map((call, i) => call.at - (calls[i]?.at ?? call.at));

/** A fetch that answers from `answers` in order and records each request's URL and time. */
function endpoint(answers: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; at: number }[] = [];
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    calls.push({ url: String(url), at: Date.now() });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('HTTP 429: the same request, the same endpoint, three more tries at most', () => {
  it('429, 429, 200: the result, after three requests, 400 ms then 900 ms apart', async () => {
    const { fetch, calls } = endpoint([() => refused(), () => refused(), () => ok('0x61')]);
    const request = createHttpRequest(URL_ONE, { fetch });
    const answer = request({ method: 'eth_chainId' });
    await vi.runAllTimersAsync();
    await expect(answer).resolves.toBe('0x61');
    expect(calls.map((c) => c.url)).toEqual([URL_ONE, URL_ONE, URL_ONE]);
    expect(gaps(calls)).toEqual([400, 900]);
  });

  it('four 429: today\'s error, after four requests', async () => {
    const { fetch, calls } = endpoint([() => refused(), () => refused(), () => refused(), () => refused()]);
    const answer = createHttpRequest(URL_ONE, { fetch })({ method: 'eth_getTransactionCount', params: ['0x0000000000000000000000000000000000000001', 'pending'] });
    const settled = answer.catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(String(await settled)).toContain('RPC HTTP 429');
    expect(calls).toHaveLength(4);
    expect(gaps(calls)).toEqual([400, 900, 1_800]);
  });

  it('HTTP 500, a JSON-RPC error and a timeout are sent once', async () => {
    const five = endpoint([() => new Response('down', { status: 500 })]);
    const a = createHttpRequest(URL_ONE, { fetch: five.fetch })({ method: 'eth_blockNumber' }).catch((e: unknown) => e);
    const rpcError = endpoint([() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit exceeded' } }), { status: 200 })]);
    const b = createHttpRequest(URL_ONE, { fetch: rpcError.fetch })({ method: 'eth_blockNumber' }).catch((e: unknown) => e);
    const slow = endpoint([() => new Promise<Response>(() => undefined)]);
    const fetchSlow = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      void (slow.fetch as unknown as (u: RequestInfo | URL) => Promise<Response>)(url);
      return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
    }) as unknown as typeof globalThis.fetch;
    const c = createHttpRequest(URL_ONE, { fetch: fetchSlow, timeoutMs: 1_000 })({ method: 'eth_blockNumber' }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(String(await a)).toContain('RPC HTTP 500');
    expect(String(await b)).toContain('limit exceeded');
    expect(String(await c)).toContain('eth_blockNumber timed out');
    expect([five.calls.length, rpcError.calls.length, slow.calls.length]).toEqual([1, 1, 1]);
  });

  it('Retry-After: 1 is honoured (1,000 ms); Retry-After: 30 is not waited for (the refusal at once)', async () => {
    const one = endpoint([() => refused('1'), () => ok('0x1')]);
    const a = createHttpRequest(URL_ONE, { fetch: one.fetch })({ method: 'eth_blockNumber' });
    await vi.runAllTimersAsync();
    await expect(a).resolves.toBe('0x1');
    expect(gaps(one.calls)).toEqual([1_000]);
    const thirty = endpoint([() => refused('30'), () => ok('0x1')]);
    const started = Date.now();
    const b = createHttpRequest(URL_ONE, { fetch: thirty.fetch })({ method: 'eth_blockNumber' }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(String(await b)).toContain('RPC HTTP 429');
    expect(thirty.calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it('refusedRetries: 0 sends a refused request once', async () => {
    const { fetch, calls } = endpoint([() => refused(), () => ok('0x1')]);
    const answer = createHttpRequest(URL_ONE, { fetch, refusedRetries: 0 })({ method: 'eth_blockNumber' }).catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(String(await answer)).toContain('RPC HTTP 429');
    expect(calls).toHaveLength(1);
  });
});
