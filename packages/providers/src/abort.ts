/**
 * AbortSignal helpers. Every rejection caused by cancellation is a `DOMException` named "AbortError" (the reason a
 * caller passed to `abort()` is not forwarded), so query caches can recognise cancellations uniformly.
 */

export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Resolves after `ms`; rejects with AbortError (and clears the timer) if the signal aborts first. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Never settles unless the signal aborts, then rejects with AbortError. Without a signal it stays pending. */
export function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}
