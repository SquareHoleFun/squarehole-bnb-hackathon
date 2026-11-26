/**
 * Who traded. `Swap.sender` is a router, not the wallet, so the trader comes from elsewhere:
 *
 * - A launch-router buy names its buyer in `TaxedBuy.buyer` (the router's `msg.sender`): derive.ts takes it from
 *   there, with no lookup at all. During the launch window every trade is a router buy, so the busiest blocks need
 *   no sender call.
 * - Any other swap needs the transaction's `from`: one `eth_getTransactionByHash` for a single transaction, or ONE
 *   `eth_getBlockByHash(hash, true)` for a block with two or more (instead of one request per transaction).
 *   Cached in memory and in the store (24 h).
 *
 * The lookup has a time budget on the live path: a block whose senders are not back in time goes out without them
 * (`trader: null`) and a `traders` frame follows once they are (retried on failure, never cached as null).
 */
import type { Address, Hex } from 'viem';
import type { ChainReader } from './chain-reader';
import type { DecodedEvent } from './events';
import type { HotStore } from './store/types';

export interface SenderMetrics {
  senderCalls: number;
  senderBlockCalls: number;
  sendersLate: number;
  senderFailures: number;
}

export interface SenderResult {
  /** Senders known now (cache or a lookup that came back within the budget). */
  readonly known: ReadonlyMap<Hex, Address>;
  /** Newly fetched pairs to write to the store's cache with the block. */
  readonly fetched: readonly (readonly [Hex, Address])[];
  /** The rest, still coming (budget ran out or the lookup failed and is being retried); null when nothing is. */
  readonly later: Promise<ReadonlyMap<Hex, Address>> | null;
}

export interface SenderResolverOptions {
  readonly reader: ChainReader;
  readonly store: HotStore;
  readonly metrics: SenderMetrics;
  /** Waits before each retry of a failed lookup. */
  readonly retryMs: readonly number[];
}

const CACHE_LIMIT = 10_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Swap transactions of the block that have no `TaxedBuy` (router buys name their buyer; see derive.ts). */
export function txsNeedingSender(events: readonly DecodedEvent[]): Hex[] {
  const named = new Set(events.filter((e) => e.kind === 'taxed_buy').map((e) => e.ref.txHash));
  return [...new Set(events.filter((e) => e.kind === 'swap' && !named.has(e.ref.txHash)).map((e) => e.ref.txHash))];
}

export class SenderResolver {
  private readonly options: SenderResolverOptions;
  private readonly cache = new Map<Hex, Address>();

  constructor(options: SenderResolverOptions) {
    this.options = options;
  }

  private remember(pairs: Iterable<readonly [Hex, Address]>): void {
    if (this.cache.size > CACHE_LIMIT) this.cache.clear();
    for (const [tx, from] of pairs) this.cache.set(tx, from);
  }

  /** One read for the whole block when two or more transactions need a sender, else one per transaction. */
  private async fetch(blockHash: Hex, txs: readonly Hex[]): Promise<Map<Hex, Address>> {
    const { reader, metrics } = this.options;
    const out = new Map<Hex, Address>();
    if (txs.length >= 2) {
      metrics.senderCalls += 1;
      metrics.senderBlockCalls += 1;
      const all = await reader.blockSenders(blockHash);
      for (const tx of txs) {
        const from = all.get(tx) ?? all.get(tx.toLowerCase() as Hex);
        if (from) out.set(tx, from);
      }
    } else {
      for (const tx of txs) {
        metrics.senderCalls += 1;
        const from = await reader.txSender(tx);
        if (from) out.set(tx, from);
      }
    }
    this.remember(out);
    return out;
  }

  private async retry(blockHash: Hex, txs: readonly Hex[]): Promise<Map<Hex, Address>> {
    for (const wait of this.options.retryMs) {
      await sleep(wait);
      try {
        return await this.fetch(blockHash, txs);
      } catch {
        this.options.metrics.senderFailures += 1;
      }
    }
    console.warn(`[indexer] senders of ${txs.length} transaction(s) in ${blockHash} still unavailable; their trades show no trader`);
    return new Map();
  }

  /**
   * `budgetMs` null: wait for the lookup (backfill). Otherwise give up waiting after `budgetMs` and hand the rest to
   * `later`, so a slow or rate-limited RPC never holds a block back.
   */
  async forBlock(blockHash: Hex, txs: readonly Hex[], budgetMs: number | null): Promise<SenderResult> {
    const known = new Map<Hex, Address>();
    const cached = await Promise.all(txs.map(async (tx) => [tx, this.cache.get(tx) ?? (await this.options.store.txSender(tx).catch(() => null))] as const));
    const missing: Hex[] = [];
    for (const [tx, from] of cached) {
      if (from) known.set(tx, from);
      else missing.push(tx);
    }
    this.remember(known);
    if (missing.length === 0) return { known, fetched: [], later: null };

    const lookup = this.fetch(blockHash, missing);
    const outcome = await Promise.race([
      lookup.then((found) => ({ found }), () => ({ failed: true as const })),
      ...(budgetMs === null ? [] : [sleep(budgetMs).then(() => ({ timedOut: true as const }))]),
    ]);
    if ('found' in outcome) {
      for (const [tx, from] of outcome.found) known.set(tx, from);
      return { known, fetched: [...outcome.found], later: null };
    }
    this.options.metrics.sendersLate += 1;
    if ('failed' in outcome) {
      this.options.metrics.senderFailures += 1;
      return { known, fetched: [], later: this.retry(blockHash, missing) };
    }
    return {
      known,
      fetched: [],
      later: lookup.catch(() => {
        this.options.metrics.senderFailures += 1;
        return this.retry(blockHash, missing);
      }),
    };
  }
}
