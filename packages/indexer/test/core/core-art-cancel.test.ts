import { deferred } from './core-art-deferred';
import { createHash } from 'node:crypto';
import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { loadArt, MemoryArtStore } from '../../src/core/art';

const LOGO = new TextEncoder().encode('logo');
const sha = (bytes: Uint8Array): Hex => `0x${createHash('sha256').update(bytes).digest('hex')}`;

// The picture loader's cancellation (the item route, art.ts `loadArt`); since SH-NO-PICTURE-GATE no listing check runs.
describe('R4 F2: picture cancellation without a live gateway', () => {
  it('F2: cancellation aborts an active gateway and prevents fallback gateways', async () => {
    const controller = new AbortController();
    const entered = deferred<undefined>();
    const release = deferred<Response>();
    const signals: (AbortSignal | null | undefined)[] = [];
    const store = new MemoryArtStore();
    const load = loadArt(sha(LOGO), {
      gateways: ['https://first.example', 'https://fallback.example'], store,
      fetch: (async (_url, init) => {
        signals.push(init?.signal);
        entered.resolve(undefined);
        return release.promise;
      }) as typeof fetch,
    }, controller.signal);
    // Keep the rejection handled even if the abort arrives before the assertion below.
    const settled = load.catch(() => null);
    await entered.promise;
    controller.abort();
    const aborted = signals[0]?.aborted;
    release.resolve(new Response(null, { status: 503 }));
    await settled;
    expect(aborted).toBe(true);
    expect(signals).toHaveLength(1);
    expect(await store.get(sha(LOGO))).toBeNull();
  });

  it('F2: cancellation during a cached-picture read prevents the next fetch', async () => {
    const controller = new AbortController();
    const entered = deferred<undefined>();
    const release = deferred<Uint8Array | null>();
    let fetches = 0;
    const settled = loadArt(sha(LOGO), {
      gateways: ['https://first.example'],
      store: { get: async () => { entered.resolve(undefined); return release.promise; }, put: async () => undefined },
      fetch: (async () => { fetches += 1; return new Response(null, { status: 503 }); }) as typeof fetch,
    }, controller.signal).catch(() => null);
    await entered.promise;
    controller.abort();
    release.resolve(null);
    await settled;
    expect(fetches).toBe(0);
  });

  it('F2: cancellation during the response body prevents storing it or fetching again', async () => {
    const controller = new AbortController();
    const entered = deferred<undefined>();
    const release = deferred<Uint8Array>();
    const store = new MemoryArtStore();
    let fetches = 0;
    const response = new Response(new ReadableStream({ async pull(stream) { entered.resolve(undefined); const bytes = await release.promise; if (!controller.signal.aborted) { stream.enqueue(bytes); stream.close(); } } }));
    const settled = loadArt(sha(LOGO), {
      gateways: ['https://first.example', 'https://fallback.example'], store,
      fetch: (async () => { fetches += 1; return response; }) as typeof fetch,
    }, controller.signal).catch(() => null);
    await entered.promise;
    controller.abort();
    release.resolve(new Uint8Array(LOGO));
    await settled;
    expect(fetches).toBe(1);
    expect(await store.get(sha(LOGO))).toBeNull();
  });
});
