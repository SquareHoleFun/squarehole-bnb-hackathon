/**
 * The indexer's in-memory view of recent history, mirroring what the store keeps: the last `BLOCKS_KEPT` blocks
 * (with holes where a range backfill skipped blocks without logs), the pool state after each, the raw logs applied
 * per block (memory only: a re-apply merges them with new answers instead of re-reading), and rings of the newest
 * trades and activity rows. The pipeline changes the window and the store in the same step.
 */
import type { Hex } from 'viem';
import type { RawLog } from './events';
import type { Activity, PoolState, Trade } from './model';
import { BLOCKS_KEPT, type StoredBlock } from './store/types';

export const RING_TRADES = 200;
export const RING_ACTIVITY = 100;

export class RecentWindow {
  private readonly genesis: () => PoolState;
  private blocks: StoredBlock[] = [];
  private states = new Map<bigint, PoolState>();
  private base: PoolState;
  private logs = new Map<bigint, { readonly hash: Hex; readonly logs: readonly RawLog[] }>();
  private tradeRing: Trade[] = [];
  private activityRing: Activity[] = [];

  constructor(genesis: () => PoolState) {
    this.genesis = genesis;
    this.base = genesis();
  }

  /** The state before the deploy block (nothing applied yet). */
  get baseState(): PoolState {
    return this.base;
  }

  head(): StoredBlock | null {
    return this.blocks.at(-1) ?? null;
  }

  latestState(): PoolState {
    return this.stateAtOrBefore(this.head()?.number ?? this.base.block);
  }

  stateAtOrBefore(block: bigint): PoolState {
    let best: PoolState | null = null;
    for (const state of this.states.values()) if (state.block <= block && (!best || state.block > best.block)) best = state;
    return best ?? this.base;
  }

  /** True when the window holds every block from `number` to the head (no range-backfill holes). */
  holdsEveryBlockFrom(number: bigint): boolean {
    const head = this.head();
    if (!head || number > head.number) return false;
    const needed = Number(head.number - number) + 1;
    const tail = this.blocks.slice(-needed);
    return tail.length === needed && tail[0]?.number === number;
  }

  blockAt(number: bigint): StoredBlock | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i -= 1) {
      const block = this.blocks[i];
      if (block?.number === number) return block;
      if (block && block.number < number) return undefined;
    }
    return undefined;
  }

  hashAt(number: bigint): Hex | undefined {
    return this.blockAt(number)?.hash;
  }

  /** Held blocks, oldest first. */
  heldBlocks(): readonly StoredBlock[] {
    return this.blocks;
  }

  /** The raw logs applied from `block`, or null when not known for that hash (a restart, or another branch). */
  appliedLogs(block: StoredBlock): readonly RawLog[] | null {
    const entry = this.logs.get(block.number);
    return entry && entry.hash.toLowerCase() === block.hash.toLowerCase() ? entry.logs : null;
  }

  trades(): readonly Trade[] {
    return this.tradeRing;
  }

  activity(): readonly Activity[] {
    return this.activityRing;
  }

  restore(blocks: readonly StoredBlock[], states: ReadonlyMap<bigint, PoolState>, trades: readonly Trade[], activity: readonly Activity[]): void {
    this.blocks = [...blocks];
    this.states = new Map(states);
    this.tradeRing = [...trades];
    this.activityRing = [...activity];
  }

  reset(): void {
    this.blocks = [];
    this.states = new Map();
    this.logs = new Map();
    this.tradeRing = [];
    this.activityRing = [];
    this.base = this.genesis();
  }

  /** One block on top (replacing any held block at or above its number). */
  add(block: StoredBlock, state: PoolState, logs: readonly RawLog[], trades: readonly Trade[], activity: readonly Activity[]): void {
    this.blocks = [...this.blocks.filter((b) => b.number < block.number), block].slice(-BLOCKS_KEPT);
    const floor = this.blocks[0]?.number ?? block.number;
    this.states.set(block.number, state);
    for (const key of [...this.states.keys()]) if (key < floor && this.states.size > BLOCKS_KEPT) this.states.delete(key);
    if (logs.length > 0) this.logs.set(block.number, { hash: block.hash, logs: [...logs] });
    else this.logs.delete(block.number);
    for (const key of [...this.logs.keys()]) if (key < floor) this.logs.delete(key);
    this.tradeRing = [...this.tradeRing, ...trades].slice(-RING_TRADES);
    this.activityRing = [...this.activityRing, ...activity].slice(-RING_ACTIVITY);
  }

  /** Removes everything above `ancestor`; returns the trades and activity rows that went with it. */
  dropAbove(ancestor: bigint): { readonly trades: readonly Trade[]; readonly activity: readonly Activity[] } {
    const dropped = { trades: this.tradeRing.filter((t) => t.block > ancestor), activity: this.activityRing.filter((a) => a.block > ancestor) };
    this.blocks = this.blocks.filter((b) => b.number <= ancestor);
    for (const key of [...this.states.keys()]) if (key > ancestor) this.states.delete(key);
    for (const key of [...this.logs.keys()]) if (key > ancestor) this.logs.delete(key);
    this.tradeRing = this.tradeRing.filter((t) => t.block <= ancestor);
    this.activityRing = this.activityRing.filter((a) => a.block <= ancestor);
    return dropped;
  }

  /** Replaces trades for which `patch` returns a new row; returns the new rows. */
  patchTrades(patch: (trade: Trade) => Trade | null): Trade[] {
    const patched: Trade[] = [];
    this.tradeRing = this.tradeRing.map((trade) => {
      const next = patch(trade);
      if (!next) return trade;
      patched.push(next);
      return next;
    });
    return patched;
  }
}
