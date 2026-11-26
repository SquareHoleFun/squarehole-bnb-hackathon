/**
 * The Demo stream: behaves like the gateway's SSE stream (an `EventSource` look-alike) over the Demo chain. On open it
 * sends `snapshot` and `status`, then one `block` event per 12-second slot, through the same parser, reducer and
 * freshness rules as a real stream. Scenarios:
 * - `before_open`, `window`, `curve` (default), `completed`, `migrated`: where the launch stands;
 * - `stale`: the service reports stale and no block follows; `unverified`: the service reports a mismatch;
 * - `reorg`: the first new slot replaces the newest block (depth 1) and the stream continues on the new branch.
 * Nothing is read from a chain or the network, and every page that shows it says "Demo".
 */
import { toJson } from '@squarehole/indexer/client';
import { demoChainFor, type DemoChain, type DemoScenario } from './demo-chain';
import type { FitMarketTarget } from './fit-target';
import type { StreamLike } from './live-controller';

export const DEMO_BLOCK_MS = 12_000;

export interface DemoClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

type Listener = (event: { readonly data?: unknown }) => void;

export function createDemoStream(target: FitMarketTarget, scenario: DemoScenario, clock: DemoClock, chain: DemoChain = demoChainFor(target, scenario)): StreamLike {
  const listeners = new Map<string, Listener[]>();
  let readyState = 0;
  let seq = 1;
  let timer: unknown = null;
  let reorged = false;

  const emit = (type: string, data: string) => {
    for (const listener of listeners.get(type) ?? []) listener({ data });
  };
  const status = scenario === 'stale' ? { indexer: 'stale', reason: 'no new block' } : scenario === 'unverified' ? { indexer: 'unverified', reason: 'the indexer state differs from the chain' } : { indexer: 'live', reason: null };

  const slot = () => {
    timer = null;
    if (readyState !== 1) return;
    if (scenario === 'reorg' && !reorged) {
      reorged = true;
      const rolled = chain.rollback(1);
      emit('reorg', toJson(chain.reorgEvent(seq++, rolled)));
    } else {
      const block = chain.mineNext();
      emit('block', toJson(chain.blockEvent(seq++, block)));
    }
    timer = clock.setTimeout(slot, DEMO_BLOCK_MS);
  };

  const open = () => {
    timer = null;
    if (readyState === 2) return;
    readyState = 1;
    emit('open', '');
    emit('snapshot', toJson(chain.snapshot(clock.now())));
    emit('status', JSON.stringify({ ...status, atMs: clock.now() }));
    // A stale service sends no more blocks.
    if (scenario !== 'stale') timer = clock.setTimeout(slot, DEMO_BLOCK_MS);
  };

  timer = clock.setTimeout(open, 0);

  return {
    get readyState() {
      return readyState;
    },
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    close() {
      readyState = 2;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}
