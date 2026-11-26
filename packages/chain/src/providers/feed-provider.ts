/**
 * `FeedProvider` over RPC + the log index (03-FEED; ADR-0003 cursor/snapshot semantics). Snapshots are pinned to one
 * block; cursors bind to the snapshot id; up to four snapshots are held so an open page keeps its order while a
 * newer snapshot exists ("Ranking updated"). When the chain cannot be read, the last good snapshot is served as
 * `stale`; with none, the read fails (never an empty feed).
 *
 * Staleness is decided when a snapshot is SERVED, not only when it is built, and applies to every read of it (the
 * feed, `readPair`, `readPairDetail`, `readMarket`, pinned or latest): a held snapshot is `stale` while the chain
 * cannot be read (until a read succeeds again) or once its block is older than the chain's wall-clock rule.
 */
import {
  FeedQueryError,
  canonicalPairId,
  paginateFeed,
  parsePairId,
  selectFeed,
  validateFeedSnapshot,
  type FeedProvider,
  type FeedQuery,
  type FeedSnapshot,
  type PairDetail,
  type PairId,
  type PairRecord,
  type SnapshotHead,
} from '@squarehole/domain';
import { getAddress } from 'viem';
import { LOCAL_CHAIN_ID } from '../config/chains';
import { isAbortError, throwIfAborted } from '../errors';
import type { ChainContext } from './context';
import { buildPairDetail } from './detail';
import type { ChainPairMarket } from './model';
import { buildEntry, buildSnapshot, isStale, type ChainSnapshot, type SnapshotEntry } from './snapshot';

const HELD_SNAPSHOTS = 4;

export interface ChainFeedProvider extends FeedProvider {
  readonly mode: 'demo' | 'live';
  readonly chainId: number;
  readPairDetail(pairId: PairId, signal?: AbortSignal): Promise<PairDetail | null>;
  latestSnapshot(signal?: AbortSignal): Promise<SnapshotHead>;
  /**
   * Chain-derived market view (Q-denominated price, market cap, FDV, turnover, holders, burns, disclosures, provenance).
   * With `snapshotId`, read from that held snapshot (the feed's rows and their figures stay at one block); an unknown
   * id is `FeedQueryError('unknown_snapshot')`, never a silent switch to a newer block.
   */
  readMarket(pairId: PairId, options?: { readonly snapshotId?: string; readonly signal?: AbortSignal }): Promise<ChainPairMarket | null>;
  /** Diagnostics of the newest snapshot (index sync, missing pairs, source). */
  lastSnapshotInfo(): Pick<ChainSnapshot, 'snapshotId' | 'sync' | 'syncError' | 'pairSource' | 'missingPairs' | 'provenance'> | null;
}

/** Every provenance of the snapshot already says stale (built stale by the wall-clock rule, or a stale copy). */
function isStaleThroughout(snapshot: ChainSnapshot): boolean {
  if (snapshot.provenance.state !== 'stale') return false;
  for (const entry of snapshot.entries.values()) {
    if (entry.record.provenance.state !== 'stale' || entry.market.provenance.state !== 'stale') return false;
  }
  return true;
}

export function createChainFeedProvider(ctx: ChainContext): ChainFeedProvider {
  const mode = ctx.config.chainId === LOCAL_CHAIN_ID ? 'demo' : 'live';
  const held: ChainSnapshot[] = [];
  let building: Promise<ChainSnapshot> | null = null;
  let builtAt = 0;
  /** The last attempt to read the chain failed: held snapshots are served as stale until a read succeeds. */
  let outage = false;

  const remember = (snapshot: ChainSnapshot): void => {
    const existing = held.findIndex((candidate) => candidate.snapshotId === snapshot.snapshotId);
    if (existing >= 0) held.splice(existing, 1);
    held.push(snapshot);
    while (held.length > HELD_SNAPSHOTS) held.shift();
  };

  /** The same snapshot with every provenance (snapshot, records, entries' records and market views) marked stale. */
  const staleCopy = (snapshot: ChainSnapshot): ChainSnapshot => {
    const entries = new Map<string, SnapshotEntry>();
    for (const [key, entry] of snapshot.entries) {
      const provenance = { ...entry.record.provenance, state: 'stale' as const };
      entries.set(key, { ...entry, record: { ...entry.record, provenance }, market: { ...entry.market, provenance } });
    }
    return {
      ...snapshot,
      provenance: { ...snapshot.provenance, state: 'stale' },
      records: [...entries.values()].map((entry) => entry.record),
      entries,
    };
  };

  /** How a held snapshot is served now: stale during an outage or past the chain's wall-clock rule. */
  const present = (snapshot: ChainSnapshot): ChainSnapshot =>
    (outage || isStale(ctx, snapshot.block)) && !isStaleThroughout(snapshot) ? staleCopy(snapshot) : snapshot;

  async function latest(signal?: AbortSignal): Promise<ChainSnapshot> {
    const newest = held.at(-1);
    if (newest && ctx.now() - builtAt < ctx.snapshotReuseMs) return present(newest);
    building ??= buildSnapshot(ctx, signal)
      .then((snapshot) => {
        remember(snapshot);
        builtAt = ctx.now();
        outage = false;
        return snapshot;
      })
      .finally(() => {
        building = null;
      });
    try {
      return present(await building);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (!newest) throw error;
      outage = true;
      return present(newest);
    }
  }

  function resolve(snapshotId: string): ChainSnapshot {
    const found = held.find((snapshot) => snapshot.snapshotId === snapshotId);
    if (!found) throw new FeedQueryError('unknown_snapshot', 'The provider no longer holds this snapshot');
    return present(found);
  }

  function entryOf(snapshot: ChainSnapshot, pairId: PairId): SnapshotEntry | null {
    const parsed = parsePairId(pairId);
    if (parsed.chainId !== ctx.config.chainId) return null;
    return snapshot.entries.get(canonicalPairId(pairId)) ?? null;
  }

  /** Direct lookup at the newest block for a pair that is not (yet) in the snapshot (03-FEED degraded mode). */
  async function directEntry(pairId: PairId, signal?: AbortSignal): Promise<SnapshotEntry | null> {
    const parsed = parsePairId(pairId);
    if (parsed.chainId !== ctx.config.chainId) return null;
    await ctx.ensureChain();
    const block = await ctx.reader.block('latest');
    throwIfAborted(signal);
    const pair = await ctx.reader.registryPairOfToken(getAddress(parsed.address), block.number);
    if (!pair) return null;
    let synced = false;
    try {
      synced = (await ctx.indexer.sync(block, signal)).complete;
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    const platform = ctx.manifest.launches[ctx.config.platformLaunchKey]?.contracts.token.address.toLowerCase() ?? null;
    return buildEntry(ctx, pair, block, platform, synced);
  }

  async function findEntry(pairId: PairId, signal?: AbortSignal): Promise<SnapshotEntry | null> {
    const parsed = parsePairId(pairId);
    if (parsed.chainId !== ctx.config.chainId) return null;
    const snapshot = await latest(signal);
    return entryOf(snapshot, pairId) ?? (await directEntry(pairId, signal));
  }

  return {
    mode,
    chainId: ctx.config.chainId,

    async readFeed(query: FeedQuery, signal?: AbortSignal): Promise<FeedSnapshot> {
      throwIfAborted(signal);
      const snapshot = query.snapshotId === undefined ? await latest(signal) : resolve(query.snapshotId);
      const selection = selectFeed(snapshot.records, query);
      const page = paginateFeed(selection.rows, { snapshotId: snapshot.snapshotId, query, cursor: query.cursor, limit: query.limit });
      return validateFeedSnapshot(
        {
          snapshotId: snapshot.snapshotId,
          platform: selection.platform,
          platformMatchesQuery: selection.platformMatchesQuery,
          items: page.items,
          nextCursor: page.nextCursor,
          totalMatches: page.totalMatches,
          rewardAssets: [...snapshot.rewardAssets],
          provenance: snapshot.provenance,
        },
        { mode },
      );
    },

    async readPair(pairId: PairId, signal?: AbortSignal): Promise<PairRecord | null> {
      return (await findEntry(pairId, signal))?.record ?? null;
    },

    async latestSnapshot(signal?: AbortSignal): Promise<SnapshotHead> {
      const snapshot = await latest(signal);
      return { snapshotId: snapshot.snapshotId, asOf: snapshot.asOf };
    },

    async readPairDetail(pairId: PairId, signal?: AbortSignal): Promise<PairDetail | null> {
      const entry = await findEntry(pairId, signal);
      return entry ? buildPairDetail(ctx, entry) : null;
    },

    async readMarket(pairId: PairId, options: { readonly snapshotId?: string; readonly signal?: AbortSignal } = {}): Promise<ChainPairMarket | null> {
      const { snapshotId, signal } = options;
      throwIfAborted(signal);
      if (snapshotId === undefined) return (await findEntry(pairId, signal))?.market ?? null;
      return entryOf(resolve(snapshotId), pairId)?.market ?? null;
    },

    lastSnapshotInfo() {
      const newest = held.at(-1);
      if (!newest) return null;
      const { snapshotId, sync, syncError, pairSource, missingPairs, provenance } = present(newest);
      return { snapshotId, sync, syncError, pairSource, missingPairs, provenance };
    },
  };
}
