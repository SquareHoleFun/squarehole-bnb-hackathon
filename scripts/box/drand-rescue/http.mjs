/** Bounded time includes body streaming. Abort plus race also bounds an injected fetch ignoring its signal. */
export async function json(io, url, init, { limit = 1048576, timeout = 10000, signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timer;
  let rejectAbort;
  const expired = new Promise((_, reject) => {
    rejectAbort = () => reject(new Error('request failed'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
    timer = setTimeout(abort, timeout);
  });
  let reader;
  try {
    return await Promise.race([expired, (async () => {
      const response = await io.fetch(url, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok || !response.body || response.redirected) throw new Error('request failed');
      reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) throw new Error('response too large');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    })()]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
    controller.abort();
    // A hostile stream must not turn cleanup into an unbounded wait.
    reader?.cancel().catch(() => {});
  }
}
