import { setTimeout as delay } from 'node:timers/promises';

// A cycle stops at the first unconfirmed transaction. A full day's queue can
// need forty such waits; poll within a time budget instead of counting cycles.
// `until`: since SH-196 and SH-198 a claim that waits (low float, the day's limit) stays queued, so such a queue
// never drains; a test names the resting state it expects and gets false when the sender's monitor shows it.
export async function cycle(sender, { mine = async () => {}, timeoutMs = 55000, until = null } = {}) {
  const deadline = performance.now() + timeoutMs;
  do {
    if (await sender.cycle()) return true;
    if (until?.(sender.monitor())) return false;
    await mine();
    await delay(25);
  } while (performance.now() < deadline);
  throw new Error(`sender did not finish: ${JSON.stringify(sender.monitor())}`);
}
