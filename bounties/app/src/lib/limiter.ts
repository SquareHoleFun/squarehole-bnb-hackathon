/**
 * SH-303: one limiter for every read the page sends (the page's client and the log client share it). A read refused
 * for its rate (HTTP 429, or a JSON-RPC answer with code 429 or a rate-limit message; not a range or method refusal)
 * pauses the page's background reads for a while that grows with each refusal in a row (1 s, 2 s, 4 s, 8 s at most);
 * an answered read ends the streak. A read waits once, at most 8 s, and is then sent (the read transports give a
 * request READ_TIMEOUT_MS, the wait included, so an answer has 10 s after the longest wait). While a press runs (useTx), no read waits: the press's own reads go out at once. So a burst that the endpoint refuses does not cause the next burst: every request waits out
 * the pause before it is sent. The requests of one burst that are refused together count as ONE refusal (a request
 * refused after a pause was set since it was sent does not grow it), so a page that sends five reads at once pauses
 * 1 s, not 16 s, and a read that keeps failing fails within seconds (its screen then shows the numbers' age).
 */
export const PAUSE_FIRST_MS = 1_000;
export const PAUSE_MAX_MS = 8_000;
/** A read's time limit in the limited transports: the longest wait, then viem's own 10 s for the answer. */
export const READ_TIMEOUT_MS = PAUSE_MAX_MS + 10_000;

export interface Limiter {
  /** Advances once per counted refusal. */
  roundNow(): number;
  /** Resolves when a request may be sent (at once unless a pause runs; at most PAUSE_MAX_MS), with its round. */
  ready(): Promise<number>;
  /** A press runs: no read waits until the returned function is called (when the press ends, in whatever way). */
  openForPress(): () => void;
  /** A request was refused for its rate: the page's pause grows, unless a pause was set after it was sent (`round`). */
  refused(round?: number): void;
  /** A request was answered: the streak ends. */
  answered(): void;
  /** The pause still to wait, in ms (0 when none). */
  pauseLeft(): number;
}

export function makeLimiter(now: () => number = () => Date.now(), sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Limiter {
  let streak = 0;
  let until = 0;
  let round = 0;
  let presses = 0;
  return {
    roundNow: () => round,
    async ready() {
      // once, never past the cap: a pause other reads push on later does not hold this one
      const left = Math.min(until - now(), PAUSE_MAX_MS);
      if (left > 0 && presses === 0) await sleep(left);
      return round;
    },
    openForPress() {
      presses += 1;
      let open = true;
      return () => {
        if (open) presses -= 1;
        open = false;
      };
    },
    refused(sentIn?: number) {
      if (sentIn !== undefined && sentIn !== round) return;
      round += 1;
      streak += 1;
      const pause = Math.min(PAUSE_FIRST_MS * 2 ** (streak - 1), PAUSE_MAX_MS);
      until = Math.max(until, now() + pause);
    },
    answered() {
      streak = 0;
    },
    pauseLeft: () => Math.max(0, until - now()),
  };
}

/** The page's one limiter. */
export const pageLimiter = makeLimiter();

/** Recognizes HTTP status 429, JSON-RPC code 429, or error text that reports a rate refusal. */
export function saysRateRefusal(x: { status?: unknown; code?: unknown; shortMessage?: unknown; message?: unknown; details?: unknown }): boolean {
  if (x.status === 429 || x.code === 429) return true;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return /rate.?limit|too many requests|\b429\b/i.test(`${text(x.shortMessage) || text(x.message)} ${text(x.details)}`);
}

/**
 * Whether a response body refuses for the rate: a JSON-RPC error object in it (alone or in a batch) that says so, with
 * whatever HTTP status it came (some endpoints answer HTTP 200 with an error object); a body that is not JSON by its
 * text. The limiter checks the decoded error code, message and data (a string, or the strings directly inside it).
 * For a failed HTTP response it also checks the serialized error.
 */
export function bodyRefusesRate(text: string, failed = false): boolean {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return saysRateRefusal({ details: text });
  }
  const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).filter((x): x is string => typeof x === 'string') : []);
  return [body].flat().some((item) => {
    const error = (item as { error?: unknown } | null)?.error;
    if (error === undefined || error === null) return false;
    const e = (typeof error === 'object' ? error : { message: String(error) }) as { code?: unknown; message?: unknown; data?: unknown };
    return saysRateRefusal({ code: e.code, message: e.message, details: [...strings(e.data), ...(failed ? [JSON.stringify(error)] : [])].join('\n') });
  });
}

/**
 * A fetch for the read transports: waits for the limiter, sends, and tells it the outcome. The response itself is
 * passed on unchanged (viem decides what to retry; its retries wait here again).
 */
export function limitedFetch(limiter: Limiter = pageLimiter, base: typeof fetch = (...a) => fetch(...a)): typeof fetch {
  return async (input, init) => {
    const round = await limiter.ready();
    const res = await base(input, init);
    let refused = res.status === 429;
    if (!refused) {
      const text = await res.clone().text().catch(() => '');
      refused = res.ok ? text.includes('"error"') && bodyRefusesRate(text) : bodyRefusesRate(text, true) || saysRateRefusal({ details: res.statusText });
    }
    if (refused) limiter.refused(round);
    else if (res.ok) limiter.answered();
    return res;
  };
}
