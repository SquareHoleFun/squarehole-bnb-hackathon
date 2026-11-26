/**
 * SH-278: the shared retry rule as a fetch wrapper (refused-fetch.ts): HTTP 429 only, the same request to the same
 * endpoint, three more tries at most (400, 900, 1,800 ms, or a Retry-After of at most two seconds); a caller's abort
 * ends a pause.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refusedRetryFetch, type FetchLike } from './refused-fetch';

const URL_ONE = 'https://rpc.example.org/';
const BODY = '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}';
const refused = (retryAfter?: string) => new Response('later', { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
const ok = () => new Response('{"jsonrpc":"2.0","id":1,"result":"0x61"}', { status: 200 });

/** A fetch answering from `answers` in order; it records each call's URL, body and time. */
function endpoint(answers: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; body: string; at: number }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = input instanceof Request ? await input.text() : String(init?.body ?? '');
    calls.push({ url, body, at: Date.now() });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next();
  };
  return { fetch, calls };
}
const gaps = (calls: readonly { at: number }[]): number[] => calls.slice(1).map((call, i) => call.at - (calls[i]?.at ?? call.at));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('refusedRetryFetch', () => {
  it('429, 429, 200: the 200, after three requests with the same URL and body, 400 then 900 ms apart', async () => {
    const { fetch, calls } = endpoint([refused, refused, ok]);
    const answer = refusedRetryFetch(fetch)(URL_ONE, { method: 'POST', body: BODY });
    await vi.runAllTimersAsync();
    expect((await answer).status).toBe(200);
    expect(calls.map((c) => [c.url, c.body])).toEqual([[URL_ONE, BODY], [URL_ONE, BODY], [URL_ONE, BODY]]);
    expect(gaps(calls)).toEqual([400, 900]);
  });

  it('four 429: the fourth 429 is the answer, after four requests (400, 900, 1,800 ms)', async () => {
    const { fetch, calls } = endpoint([refused, refused, refused, refused]);
    const answer = refusedRetryFetch(fetch)(URL_ONE, { method: 'POST', body: BODY });
    await vi.runAllTimersAsync();
    expect((await answer).status).toBe(429);
    expect(gaps(calls)).toEqual([400, 900, 1_800]);
  });

  it('HTTP 500, a 200 with a JSON-RPC error and a network failure: one request each', async () => {
    const five = endpoint([() => new Response('down', { status: 500 })]);
    const err = endpoint([() => new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"limit"}}', { status: 200 })]);
    const down = endpoint([() => Promise.reject(new TypeError('Failed to fetch'))]);
    const a = refusedRetryFetch(five.fetch)(URL_ONE, { body: BODY });
    const b = refusedRetryFetch(err.fetch)(URL_ONE, { body: BODY });
    const c = refusedRetryFetch(down.fetch)(URL_ONE, { body: BODY }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect([(await a).status, (await b).status, String(await c)]).toEqual([500, 200, 'TypeError: Failed to fetch']);
    expect([five.calls.length, err.calls.length, down.calls.length]).toEqual([1, 1, 1]);
  });

  it('Retry-After: 1 waits 1,000 ms; Retry-After: 30 is the answer at once', async () => {
    const one = endpoint([() => refused('1'), ok]);
    const a = refusedRetryFetch(one.fetch)(URL_ONE, { body: BODY });
    await vi.runAllTimersAsync();
    expect((await a).status).toBe(200);
    expect(gaps(one.calls)).toEqual([1_000]);
    const thirty = endpoint([() => refused('30'), ok]);
    const b = refusedRetryFetch(thirty.fetch)(URL_ONE, { body: BODY });
    await vi.runAllTimersAsync();
    expect((await b).status).toBe(429);
    expect(thirty.calls).toHaveLength(1);
  });

  it('a caller\'s abort ends a pause: no further request', async () => {
    const { fetch, calls } = endpoint([refused, ok]);
    const controller = new AbortController();
    const answer = refusedRetryFetch(fetch)(URL_ONE, { body: BODY, signal: controller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.runAllTimersAsync();
    expect(String(await answer)).toContain('AbortError');
    expect(calls).toHaveLength(1);
  });

  it('a Request input is sent again whole (its body each time); retries: 0 sends once', async () => {
    const { fetch, calls } = endpoint([refused, ok]);
    const answer = refusedRetryFetch(fetch)(new Request(URL_ONE, { method: 'POST', body: BODY }));
    await vi.runAllTimersAsync();
    expect((await answer).status).toBe(200);
    expect(calls.map((c) => c.body)).toEqual([BODY, BODY]);
    const once = endpoint([refused, ok]);
    const b = refusedRetryFetch(once.fetch, { retries: 0 })(URL_ONE, { body: BODY });
    await vi.runAllTimersAsync();
    expect((await b).status).toBe(429);
    expect(once.calls).toHaveLength(1);
  });
});
