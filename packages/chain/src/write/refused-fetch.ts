/**
 * SH-276/SH-278: the one retry rule of the site's chain reads, as a fetch wrapper. A request the endpoint refused with
 * HTTP 429 ("later") was not served, so the same request goes again to the same endpoint: up to three more times, after
 * 400, 900 and 1,800 ms, or after the endpoint's own Retry-After when that is at most two seconds (a longer one is not
 * waited for: the 429 is the answer). Then the last answer is returned as it came. Nothing else is tried again: no other
 * status, no network failure or abort, and never another endpoint. A caller's abort (the request's signal) ends a pause
 * at once.
 *
 * `createHttpRequest` (rpc.ts) sends through it, and so do the viem `http` transports of Create's reads (`fetchFn`).
 * viem's own `retryCount` stays 0 there: it would repeat other statuses too.
 */

/** A fetch: what viem's `fetchFn` and `createHttpRequest`'s `fetch` take. */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The pauses before each new try of a refused (HTTP 429) request. */
export const REFUSED_PAUSES_MS: readonly number[] = Object.freeze([400, 900, 1_800]);
/** The longest Retry-After waited for; a longer one ends the request as a refusal at once. */
export const MAX_RETRY_AFTER_MS = 2_000;

/** A Retry-After header as milliseconds from `now` (seconds or an HTTP date), or null when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null || header.trim() === '') return null;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** The pause before try `attempt + 1` of a request answered by `response`, or null when it is not tried again. */
export function refusedPauseMs(response: Pick<Response, 'status' | 'headers'>, attempt: number, retries = REFUSED_PAUSES_MS.length): number | null {
  if (response.status !== 429 || attempt >= Math.min(retries, REFUSED_PAUSES_MS.length)) return null;
  const asked = retryAfterMs(response.headers.get('retry-after'), Date.now());
  if (asked !== null && asked > MAX_RETRY_AFTER_MS) return null;
  return asked ?? REFUSED_PAUSES_MS[attempt] ?? null;
}

function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Waits `ms`; a signal that aborts ends the wait with its reason. */
function pause(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(aborted(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); if (signal) reject(aborted(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RefusedRetryOptions {
  /** How many more tries a refused request gets: 0 to 3 (default 3). */
  readonly retries?: number;
}

/**
 * `inner` (default: the global fetch, looked up per request) with the rule above. A `Request` input is cloned for
 * each try, so its body can be sent again; viem and `createHttpRequest` pass a URL and a string body.
 */
export function refusedRetryFetch(inner?: FetchLike, options: RefusedRetryOptions = {}): FetchLike {
  const send: FetchLike = inner ?? ((input, init) => fetch(input, init));
  const retries = Math.max(0, Math.min(options.retries ?? REFUSED_PAUSES_MS.length, REFUSED_PAUSES_MS.length));
  return async (input, init) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await send(input instanceof Request ? input.clone() : input, init);
      const wait = refusedPauseMs(response, attempt, retries);
      if (wait === null) return response;
      await response.body?.cancel().catch(() => undefined);
      await pause(wait, init?.signal);
    }
  };
}
