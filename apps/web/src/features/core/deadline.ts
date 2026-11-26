/**
 * SH-SITE-FIXES-10: a read with a deadline. A request that is never answered (a lost response, a stalled body) used to
 * hold its read open for the page's life: react-query starts no new fetch while one is in flight (an interval refetch
 * joins it), so one feed request without an answer kept a box link "reading", or "not in this source", until a reload.
 * Here the read's signal aborts at the deadline, which cancels the request itself, and the read rejects then even when
 * its fetcher ignores the signal, so the caller's retry starts a fresh request. An outer signal (react-query's: the page
 * left, the query was reset) aborts it too, with that signal's reason.
 */

/** The read got no answer before its deadline. */
export class DeadlineError extends Error {
  override readonly name = 'DeadlineError';
  constructor(readonly ms: number) {
    super(`no answer within ${ms / 1000} s`);
  }
}

export async function withDeadline<T>(ms: number, outer: AbortSignal | undefined, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  outer?.throwIfAborted();
  const controller = new AbortController();
  const onOuter = () => controller.abort(outer?.reason);
  outer?.addEventListener('abort', onOuter, { once: true });
  const timer = setTimeout(() => controller.abort(new DeadlineError(ms)), ms);
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  try {
    return await Promise.race([read(controller.signal), stopped]);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuter);
  }
}
