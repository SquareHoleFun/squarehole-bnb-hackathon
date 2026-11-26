/**
 * The core v1/v2 pipeline: ONE per chain, a reducer per box (S10a § 3.2; chain-data-platform § 2.2). The PoC's per-block
 * rules (pipeline.ts) move from "the pool" to "the chain": one block window, one walk-back, and per box its own state.
 *
 * - **Discovery (BC-073)**: boxes come only from the manifest's registries (`BoxCreated` + `BoxSpec`, decoded by the
 *   chain package's row decoder; logs of any other address do not count). A new box's code is checked at its creation
 *   block (discovery.ts); the creation block's logs are re-read for its addresses and pool id (a box trades in its
 *   creation block: the bootstrap runs inside `createBox`), then it is followed from the next block. Its start is its
 *   row's creation block, never a setting.
 * - **Blocks**: three `getLogs` requests by block hash per block, chunked as needed (shown contracts, registries,
 *   drand; PoolManager by pool ids; CoW settlements by inbox owners), routed to each box.
 * - **Reorgs (BC-077)**: a new head whose parent is not ours walks back by parent hash to the newest block we hold;
 *   every box rolls back to that common ancestor (its states above it dropped; a box whose `BoxCreated` is gone leaves the
 *   feed), then the new branch is applied. An ancestor beyond the window (128 blocks) rebuilds every box from its
 *   creation block. A gap of more than 64 blocks first checks the held blocks against the chain by number (the newest
 *   still canonical stays, the rest roll back; none is a rebuild), and its range backfill's log reads are anchored to
 *   the range's end and the head it continues, so they cannot mix branches (R2, review 2026-10-07).
 * - **Pictures (SH-NO-PICTURE-GATE, founder 2026-10-24)**: listing never waits for pictures. A box that passes the code
 *   checks is listed at its first sighting, its logo and collection cover available or not; the site shows a plain
 *   placeholder for a picture until bytes that hash to the spec's commitment load, and never shows other bytes
 *   (apps/web box-pictures.ts). A restart lists the same boxes again: nothing here depends on a picture store.
 * - **Audit (BC-080)**: every 32 blocks, each shown box's views at the head's hash against its state (audit.ts). A
 *   mismatch marks that box Unverified and repairs it alone (its logs re-read from its creation block); others are
 *   untouched (BC-094).
 * - **Display reads**: the few views the page shows that no event gives (the hook's depth budget, the stream's index)
 *   are read at every head block where the box had an event, before its new state is served, and once at the end of a
 *   range backfill: each changes only with an event of the box, so they hold until its next one.
 * - **Output**: per block, every box's snapshot and the feed are current (the gateway reads them), and a block result goes to the
 *   history writer (trades, activity, transfers; rollbacks and resets as their own messages).
 */
import { drandSourceOf, rowsFromRegistryLogs, rowAddresses, coreVersion1, REGISTRY_TOPIC0, type BoxRow, type DeployedCoreManifest, type RoleName } from '@squarehole/chain';
import type { QAsset } from '@squarehole/box-spec';
import { zeroAddress, type Address, type Hex } from 'viem';
import type { RawLog } from '../events';
import { groupByBlock, logsOfHash, unionLogs } from '../log-sets';
import type { BlockHeader } from '../model';
import { compareAudit, readBox, readDisplay, type AuditResult } from './audit';
import { CORE_TOPIC0, POOL_TOPIC0, decodeBoxLogs, type BoxRoute } from './core-events';
import type { BlockAnchor, CoreReader, LogFilter } from './core-reader';
import { itemView, type CoreItemView, boxView, feedCard, type AsOf, type AuditView, type CoreBoxView, type FeedView } from './core-views';
import { applyCoreBlock, initialCoreState, phaseAt, type BlockAt, type CoreActivity, type CoreBoxState, type CoreTrade, type CoreTransfer } from './derive-core';
import { checkBoxAtCreation, type BoxVerdict } from './discovery';
import { isRowV2, isSetRowV2, jsonV2, type IndexedRow, type BoxRowV2, type SetBoxRowV2 } from './core-row';
import { CORE_TOPIC0_V2, type DeployedCoreManifestV2 } from './v2/chain-v2';
import { checkBoxV2, rowsFromV2Logs } from './v2/discovery-v2';
import { decodeV2Logs, routeV2, type CoreEventV2, type RouteV2 } from './v2/events-v2';
import { listingBookV2, readListingDetailV2, readListingDetailV21, validateListingDetailV2, type ListingDetailV2 } from './v2/listings-v2';
import { compareMoneyV2, readMoneyV2, refusedAtHash } from './v2/money-v2';
import { readInboxWiringV21 } from './v2/chain-v2';
import { applyV2Block, liveViewV2, platformBookV2, type LiveStateV2 } from './v2/views-v2';
import { protocolTotalsV2 } from './v2/protocol-stats-v2';
import { holdersPageV2, type HoldersOptionsV2 } from './v2/holders-v2';

import type { SetReleaseManifest, SetFeedWire, SetBoxWire, SetMembersWire } from '@squarehole/chain/core/set-v2';
import { checkSetStartup, checkSetBoxV2, rowsFromSetLogs } from './set-v2/discovery';
import { SET_TOPICS, setRoute } from './set-v2/events';
import { applySetBlock, setBoxData, type SetStateV2 } from './set-v2/state';
import { projectSetRow } from './set-v2/project';

export const CORE_BLOCKS_KEPT = 128;
/** Pending history callbacks, including rollbacks and resets. Slow persistence throttles heads here. */
export const HISTORY_MESSAGES_MAX = 256;
const AUDIT_EVERY = 32;
const RECENT_KEPT = 500;
export const RANGE_TAIL = 32n;
const SHORT_GAP = 64n;

/**
 * How catch-up paces itself (SH-259). The defaults were tuned to 12-second blocks: a gap of up to `shortGap` blocks is
 * applied block by block, a longer one is read as an anchored range that stops `rangeTail` blocks below its target.
 * At sub-second blocks (BNB Chain testnet: 0.45 s, measured) one block of the per-block path costs several RPC round
 * trips, longer than a block, so that path never catches up. The fast pace reads every gap of more than `shortGap`
 * blocks as one anchored range up to the target itself, and holds the headers of the range's newest `linkedTail`
 * blocks, linked by parent hash down from the anchored end, so a reorg near the head still rolls back block by block
 * instead of rebuilding. `auditRanges` lets a range's blocks count toward the audit period (`auditEvery` blocks);
 * otherwise only per-block applies count, and a chain followed by ranges would hardly ever be audited.
 */
export interface CorePace {
  readonly shortGap: bigint;
  readonly rangeTail: bigint;
  readonly linkedTail: bigint;
  readonly auditRanges: boolean;
  /**
   * Whether a range reads each v2 box's money at every block with logs (the 12-second pace, as before) or only at the
   * range's end. The money a page shows is the head's; the reads in between cost a round trip each and, at 0.45 s
   * blocks, were most of a busy range's time (fast-pace.test.ts). Trades, activity and transfers come from logs either way.
   */
  readonly rangeMoneyEveryBlock: boolean;
  /**
   * Blocks the index may trail the newest head seen before the gateway calls it behind (`following: false`, Stale
   * snapshots, the claims route 503). 3 at 12 s blocks (36 s, as before); at 0.45 s the measured steady lag is 8 blocks
   * and at most 16, so the fast pace allows 33 blocks, about 15 s (SH-259 review 13).
   */
  readonly lagBlocks: bigint;
  /**
   * How many headers of a range's blocks with logs are read at once (job306 point 7): one, in block order, at the
   * 12-second pace (as at 171c3b4e); a fixed four at the fast pace. Never more, whatever the backlog: the reads
   * waiting are a counter, not a promise per block.
   */
  readonly headerReads?: number;
}
export const PACE_12S: CorePace = Object.freeze({ shortGap: SHORT_GAP, rangeTail: RANGE_TAIL, linkedTail: 0n, auditRanges: false, rangeMoneyEveryBlock: true, lagBlocks: 3n, headerReads: 1 });
export const PACE_FAST: CorePace = Object.freeze({ shortGap: 2n, rangeTail: 0n, linkedTail: 16n, auditRanges: true, rangeMoneyEveryBlock: false, lagBlocks: 33n, headerReads: 4 });
/** The pace for a chain's block time: under two seconds a block is the fast pace, otherwise the 12-second one. */
export function paceForBlockTime(blockMs: number): CorePace {
  if (!Number.isFinite(blockMs) || blockMs <= 0) throw new Error('block time must be a positive number of milliseconds');
  return blockMs < 2_000 ? PACE_FAST : PACE_12S;
}
const INITIAL_BACKFILL_WAIT_MS = 15_000;
const MAX_BACKFILL_WAIT_MS = 1_800_000;

export interface HeldBlock {
  readonly number: bigint;
  readonly hash: Hex;
  readonly parentHash: Hex;
  readonly timestamp: bigint;
}

export interface BoxBlockResult {
  readonly token: string;
  readonly registry: Address;
  readonly boxId: bigint;
  readonly trades: readonly CoreTrade[];
  readonly activity: readonly CoreActivity[];
  readonly transfers: readonly CoreTransfer[];
}

export interface CoreBlockResult {
  readonly chainId: number;
  readonly block: HeldBlock;
  /** Rows first seen in this block (shown or not). */
  readonly rows: readonly { readonly row: IndexedRow; readonly verdict: BoxVerdict }[];
  readonly boxes: readonly BoxBlockResult[];
}

/** What the history writer is fed, in order. */
export type HistoryMessage =
  | { readonly type: 'block'; readonly result: CoreBlockResult }
  | { readonly type: 'rollback'; readonly chainId: number; readonly toBlock: bigint }
  | { readonly type: 'reset'; readonly chainId: number; readonly reason: string };

export interface CoreMetrics {
  blocksApplied: number;
  reorgs: number;
  maxReorgDepth: number;
  rebuilds: number;
  boxRepairs: number;
  audits: number;
  auditMismatches: number;
  errors: number;
  lastError: string | null;
}

export interface BoxEntry {
  readonly row: BoxRow;
  readonly route: BoxRoute;
  readonly verdict: BoxVerdict;
  /** States after the applied blocks that touched the box, ascending (phase is re-evaluated per block on read). */
  states: CoreBoxState[];
  verified: boolean | null;
  audit: AuditView | null;
  /** The display reads (audit.ts `displaySpecs`) at the newest block they were read at. */
  display: { readonly block: bigint; readonly values: Readonly<Record<string, string>> } | null;
  /** The last display read failed (logged once until one succeeds). */
  displayFailing: boolean;
  repairing: boolean;
  trades: CoreTrade[];
  activity: CoreActivity[];
}

export interface BoxEntryV2 {
  readonly version: 2;
  readonly row: BoxRowV2;
  readonly route: RouteV2;
  readonly verdict: BoxVerdict;
  states: LiveStateV2[];
  verified: boolean | null;
  audit: AuditView | null;
  repairing: boolean;
  trades: CoreTrade[];
  activity: CoreActivity[];
  /** The last head money read was refused: the box publishes no money and stays unverified (logged once, RC6RR-FC-1). */
  moneyFailing?: boolean;
}
export interface SetBoxEntryV2 {
  readonly version: 'set-v2'; readonly row: SetBoxRowV2; readonly route: RouteV2; readonly verdict: BoxVerdict;
  states: SetStateV2[]; repairing: boolean; trades: CoreTrade[]; activity: CoreActivity[];
}
type IndexedEntry = BoxEntry | BoxEntryV2 | SetBoxEntryV2;
const isSetEntry = (e: IndexedEntry): e is SetBoxEntryV2 => 'version' in e && e.version === 'set-v2';
const isEntryV2 = (entry: IndexedEntry): entry is BoxEntryV2 => 'version' in entry && entry.version === 2;

export interface CoreIndexerOptions {
  readonly setManifest?: SetReleaseManifest;
  readonly reader: CoreReader;
  readonly manifest: DeployedCoreManifest & { readonly releases?: DeployedCoreManifestV2['releases'] };
  readonly auditEvery?: number;
  readonly windowBlocks?: number;
  /** Catch-up pacing (default PACE_12S, today's behaviour). */
  readonly pace?: CorePace;
  /** Fed in order. Heads wait only at HISTORY_MESSAGES_MAX pending callbacks; idle() also waits for history. */
  readonly onHistory?: (message: HistoryMessage) => void | Promise<void>;
  /** Called after each committed change (snapshots and feed are current). */
  readonly onUpdate?: (tokens: readonly string[]) => void;
  /** TEST ONLY: a Q list for every version (synthetic boxes priced in every Q class); default: each version's own. */
  readonly qList?: readonly QAsset[];
}

const lower = (a: string): string => a.toLowerCase();
const same = (a: string | undefined, b: string | undefined): boolean => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
const rowKey = (row: IndexedRow): string => `${lower(row.registry)}:${row.boxId}`;

export class CoreChainIndexer {
  readonly metrics: CoreMetrics = { blocksApplied: 0, reorgs: 0, maxReorgDepth: 0, rebuilds: 0, boxRepairs: 0, audits: 0, auditMismatches: 0, errors: 0, lastError: null };
  readonly chainId: number;
  private readonly reader: CoreReader;
  private readonly setManifest: SetReleaseManifest | undefined;
  private readonly manifest: DeployedCoreManifestV2;
  private readonly registries: readonly { address: Address; startBlock: bigint }[];
  private readonly box0Registry: Address;
  private readonly startBlock: bigint;
  private readonly auditEvery: number;
  private readonly windowBlocks: number;
  private readonly pace: CorePace;
  private readonly onHistory: CoreIndexerOptions['onHistory'];
  private readonly onUpdate: CoreIndexerOptions['onUpdate'];
  private readonly qList: readonly QAsset[] | undefined;
  /** Every row seen, by `registry:boxId` (shown, unsupported or refused). */
  private readonly rows = new Map<string, { row: IndexedRow; verdict: BoxVerdict }>();
  /** Shown boxes by lowercase token. */
  readonly boxes = new Map<string, BoxEntry>();
  readonly boxesV2 = new Map<string, BoxEntryV2>();
  readonly setsV2 = new Map<string, SetBoxEntryV2>();
  /** Only canonical registry events: listing rollback is tied to the same head as box rollback. */
  private listingEvents: CoreEventV2[] = [];
  private readonly listingDetails = new WeakMap<CoreEventV2, ListingDetailV2>();
  private entries(): Map<string, IndexedEntry> { return new Map<string, IndexedEntry>([...this.boxes, ...this.boxesV2, ...this.setsV2]); }
  private putEntry(token: string, entry: IndexedEntry): void {
    if (isSetEntry(entry)) this.setsV2.set(token, entry); else if (isEntryV2(entry)) this.boxesV2.set(token, entry); else this.boxes.set(token, entry);
  }
  private dropEntry(token: string): void { this.boxes.delete(token); this.boxesV2.delete(token); this.setsV2.delete(token); }
  listingsV2(registry: Address) {
    const release = this.manifest.releases.find((r) => same(r.registry.address, registry));
    return listingBookV2(this.listingEvents.filter((e) => release && same(e.address, release.listingRegistry.address)));
  }
  v2ListingsView(registry: string) {
    const release = this.manifest.releases.find((r) => same(r.registry.address, registry));
    if (!release) return null;
    return { schema: 'sh.core-listings.v2' as const, chainId: this.chainId, registry: lower(registry), asOf: this.asOf(), listings: jsonV2(this.listingsV2(release.registry.address).listings.map((listing) => {
      const latest = [...this.listingEvents].reverse().find((e) => same(e.address, release.listingRegistry.address) && (e.name === 'ListingAdded' || e.name === 'RaiseUpdated') && e.args.id === listing.id);
      const detail = latest ? this.listingDetails.get(latest) : undefined;
      return { ...listing, detail: detail ?? null };
    })) };
  }
  v2BoxView(token: string) {
    const entry = this.boxesV2.get(lower(token)); const state = entry?.states.at(-1); const asOf = this.asOf();
    if (!entry || !state || !asOf) return null;
    return { schema: 'sh.core-box.v2' as const, chainId: this.chainId, token: lower(token), row: jsonV2(entry.row), asOf, stale: entry.repairing, verified: entry.verified, audit: entry.audit, ...jsonV2(liveViewV2(state, BigInt(asOf.timestamp))) };
  }
  v2HoldersView(token: string, options: HoldersOptionsV2) {
    const entry = this.boxesV2.get(lower(token)); const state = entry?.states.at(-1); const asOf = this.asOf();
    if (!entry || !state || !asOf) return null;
    return holdersPageV2(entry.row, state, asOf, options);
  }
  /** Current canonical commitments, including boxes still behind the legacy picture gate. */
  *v2PictureSpecs() {
    const head = this.head();
    if (!head) return;
    for (const { row } of this.rows.values()) {
      if (isRowV2(row) && row.creationBlock <= head.number) yield row.spec;
    }
  }
  /** Link rights belong only to the immutable registry creator of a listed box (every code-checked box is listed at
   * once since SH-NO-PICTURE-GATE, so there are no rows waiting for pictures). */
  v2CreatorOf(token: string): Address | null {
    const head = this.head();
    if (!head) return null;
    const shown = this.boxesV2.get(lower(token))?.row;
    if (shown && shown.creationBlock <= head.number) return shown.record.creator;
    return null;
  }
  v2FeedView() {
    const cards = [...this.boxesV2.keys()].flatMap((t) => { const view = this.v2BoxView(t); return view ? [view] : []; });
    const hidden = [...this.rows.values()].filter((r) => isRowV2(r.row) && r.verdict.classification !== 'shown').map((r) => ({ registry: lower(r.row.registry), boxId: String(r.row.boxId), reason: r.verdict.reason ?? '' }));
    const platform = this.manifest.releases.map((r) => {
      const views = [...this.boxesV2.values()].filter((entry) => same(entry.row.registry, r.registry.address)).flatMap((entry) => {
        const state = entry.states.at(-1); return state ? [state.view] : [];
      });
      return jsonV2({ registry: lower(r.registry.address), ...platformBookV2(views) });
    });
    return { schema: 'sh.core-feed.v2' as const, chainId: this.chainId, asOf: this.asOf(), cards, hidden, platform };
  }
  v2StatsView() {
    const asOf = this.asOf();
    const publishedBlock = asOf === null ? null : BigInt(asOf.block);
    // Range discovery can stage later creations before their blocks are published.
    const rows = [...this.rows.values()].map(({ row }) => row).filter(isRowV2)
      .filter(row => publishedBlock !== null && row.creationBlock <= publishedBlock);
    const totals = protocolTotalsV2(rows, this.boxesV2.values());
    return { schema: 'sh.core-stats.v2' as const, chainId: this.chainId, asOf, ...jsonV2({ ...totals,
      stale: totals.stale || asOf === null, coverage: { ...totals.coverage, complete: totals.coverage.complete && asOf !== null } }) };
  }

  private setAsOf() {
    const head = this.head();
    return head ? {block: String(head.number), hash: head.hash, tier: 'latest' as const} : null;
  }
  setFeedView(): SetFeedWire | null {
    const asOf = this.setAsOf(); if (!asOf) return null;
    return {schema:'sh.core-set-feed.v1',chainId:this.chainId,asOf,boxes:[...this.setsV2.values()].flatMap(e=>{
      const state=e.states.at(-1); return state ? [setBoxData(e.row,state)] : [];
    })};
  }
  setBoxView(token:string): SetBoxWire | null {
    const entry=this.setsV2.get(lower(token)), state=entry?.states.at(-1), asOf=this.setAsOf();
    return entry && state && asOf ? {schema:'sh.core-set-box.v1',chainId:this.chainId,asOf,box:setBoxData(entry.row,state)} : null;
  }
  setMembersView(token:string, offset=0n, limit=100): SetMembersWire | null {
    const entry=this.setsV2.get(lower(token)), state=entry?.states.at(-1), asOf=this.setAsOf();
    if(!entry || !state || !asOf || offset<0n || !Number.isInteger(limit) || limit<1 || limit>10000) return null;
    const members=state.membership.members.filter(m=>m.index>=offset).slice(0,limit);
    const next=offset+BigInt(members.length);
    return {schema:'sh.core-set-members.v1',chainId:this.chainId,asOf,registry:entry.row.registry,boxId:String(entry.row.boxId),
      collection:entry.row.spec.collection,setHash:entry.row.spec.setHash,offset:String(offset),nextOffset:next<BigInt(state.membership.members.length)?String(next):null,
      members:members.map(m=>({index:String(m.index),id:String(m.id),state:m.state}))};
  }
  setMoneyView(token:string) {
    const e=this.setsV2.get(lower(token)),state=e?.states.at(-1),asOf=this.setAsOf(),head=this.head();
    return state && asOf && head ? {schema:'sh.core-set-money.v1' as const,chainId:this.chainId,asOf,...jsonV2(liveViewV2(state, head.timestamp))} : null;
  }

  private blocks: HeldBlock[] = [];
  private busy: Promise<void> = Promise.resolve();
  private queuedHead: Promise<void> | null = null;
  private readonly historyWrites = new Set<Promise<void>>();
  private pending: { header: BlockHeader; arrivedAt: number } | null = null;
  private nextBackfillWaitMs = 0;
  private retryBackfillAt = 0;
  private sinceAudit = 0;
  private running = false;
  private lifecycle = new AbortController();
  private rebuilding = false;

  constructor(options: CoreIndexerOptions) {
    this.reader = options.reader;
    this.setManifest = options.setManifest;
    this.manifest = { ...options.manifest, releases: options.manifest.releases ?? [] };
    this.chainId = options.manifest.chainId;
    this.registries = [
      ...(options.setManifest ? [{address:options.setManifest.registry.address,startBlock:BigInt(options.setManifest.startBlock)}] : []),
      ...options.manifest.versions.map((v) => ({ address: v.registry.address, startBlock: BigInt(v.startBlock) })),
      ...this.manifest.releases.flatMap((r) => [r.registry, r.listingRegistry].map(({ address }) => ({ address, startBlock: BigInt(r.startBlock) }))),
    ];
    // A chain without the v1 family (BNB Chain testnet: `versions` is empty, no box 0) has no v1 rows to decode; the
    // zero address stands for a box 0 registry that does not exist (SH-259).
    this.box0Registry = options.manifest.versions.some((v) => v.version === 1) ? coreVersion1(options.manifest).registry.address : zeroAddress;
    // The earliest start of what the manifest names, never the chain's first block (with no v1, the releases' start).
    const starts = [...options.manifest.versions, ...this.manifest.releases, ...(options.setManifest ? [options.setManifest] : [])].map((v) => BigInt(v.startBlock));
    const [firstStart] = starts;
    if (firstStart === undefined) throw new Error('the manifest names no version, release or set to follow');
    this.startBlock = starts.reduce((min, start) => (start < min ? start : min), firstStart);
    this.auditEvery = options.auditEvery ?? AUDIT_EVERY;
    this.windowBlocks = options.windowBlocks ?? CORE_BLOCKS_KEPT;
    this.pace = options.pace ?? PACE_12S;
    if (this.pace.shortGap < 1n || this.pace.rangeTail < 0n || this.pace.linkedTail < 0n || this.pace.linkedTail > BigInt(this.windowBlocks)) {
      throw new Error('pace: shortGap at least 1, rangeTail and linkedTail at least 0, linkedTail within the window');
    }
    this.onHistory = options.onHistory;
    this.onUpdate = options.onUpdate;
    this.qList = options.qList;
  }

  private rowOptions(registry: Address): { chainId: number; registry: Address; box0Registry: Address; qList?: readonly QAsset[] } {
    return { chainId: this.chainId, registry, box0Registry: this.box0Registry, ...(this.qList ? { qList: this.qList } : {}) };
  }

  // ------------------------------------------------------------------------------------------------ reads

  head(): HeldBlock | null {
    return this.blocks.at(-1) ?? null;
  }

  hashAt(number: bigint): Hex | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i -= 1) {
      const b = this.blocks[i];
      if (!b) continue;
      if (b.number === number) return b.hash;
      if (b.number < number) return undefined;
    }
    return undefined;
  }

  /** Every row seen and its verdict (shown boxes, and the others with why). */
  allRows(): readonly { readonly row: IndexedRow; readonly verdict: BoxVerdict }[] {
    return [...this.rows.values()].sort((a, b) => (a.row.registry === b.row.registry ? (a.row.boxId < b.row.boxId ? -1 : 1) : a.row.registry < b.row.registry ? -1 : 1));
  }

  /**
   * A box's state at `block` (the newest at or below its number, its phase at that block: the open and the window by
   * the block's time), or null before its creation.
   */
  stateAt(entry: BoxEntry, block: BlockAt): CoreBoxState | null {
    let found: CoreBoxState | null = null;
    for (const state of entry.states) {
      if (state.block <= block.number) found = state;
      else break;
    }
    if (!found) return null;
    const r = entry.row;
    return { ...found, phase: phaseAt(block, r.openAt, r.windowEndsAt, found.closedAtBlock, found.migratedAtBlock) };
  }

  private latestState(entry: BoxEntry): CoreBoxState {
    return entry.states.at(-1) ?? initialCoreState(entry.row);
  }

  asOf(): AsOf | null {
    const h = this.head();
    return h ? { block: h.number.toString(), hash: h.hash, timestamp: h.timestamp.toString(), tier: 'head' } : null;
  }

  /** Reveals live in the same immutable block states as balances, so every rollback removes orphan art. */
  itemView(token: string, id: bigint): CoreItemView | null {
    const entry = this.boxes.get(lower(token));
    const head = this.head();
    const asOf = this.asOf();
    if (!entry || !head || !asOf || entry.repairing || entry.verified === false) return null;
    const state = this.stateAt(entry, head);
    return state ? itemView(entry.row, state, id, asOf) : null;
  }

  /** A shown box's snapshot at the head (null: unknown token, or nothing applied yet). */
  boxView(token: string): CoreBoxView | null {
    const entry = this.boxes.get(lower(token));
    const head = this.head();
    if (!entry || !head) return null;
    const state = this.stateAt(entry, head);
    if (!state) return null;
    const asOf = this.asOf();
    if (!asOf) return null;
    const display = entry.display ? { block: entry.display.block.toString(), values: entry.display.values } : null;
    const lastEventBlock = entry.states.at(-1)?.block;
    return boxView({
      row: entry.row,
      state: { ...state, block: head.number, blockHash: head.hash, timestamp: head.timestamp },
      asOf,
      verified: entry.verified,
      stale: entry.repairing,
      audit: entry.audit,
      display,
      ...(lastEventBlock !== undefined ? { lastEventBlock } : {}),
    });
  }

  /** The feed: one card per shown box, its own state (BC-085); the boxes not shown with why. */
  feedView(): FeedView {
    const cards = [...this.boxes.keys()].map((token) => this.boxView(token)).filter((v): v is CoreBoxView => v !== null).map(feedCard);
    const hidden = [...this.rows.values()].filter((r) => !isRowV2(r.row) && !isSetRowV2(r.row) && r.verdict.classification !== 'shown').map((r) => ({ registry: r.row.registry.toLowerCase(), boxId: r.row.boxId.toString(), reason: r.verdict.reason ?? '' }));
    return { schema: 'sh.core-feed.v1', chainId: this.chainId, asOf: this.asOf(), cards, hidden };
  }

  recent(token: string): { readonly trades: readonly CoreTrade[]; readonly activity: readonly CoreActivity[] } | null {
    const entry = this.entries().get(lower(token));
    return entry ? { trades: entry.trades, activity: entry.activity } : null;
  }

  // ------------------------------------------------------------------------------------------------ filters

  private filter(only?: readonly IndexedEntry[], listingEvents = this.listingEvents, blockNumber?: bigint): LogFilter {
    const entries = only ?? [...this.entries().values()];
    const addresses = new Set<string>(only ? [] : this.registries
      .filter((r) => blockNumber === undefined || r.startBlock <= blockNumber).map((r) => lower(r.address)));
    const topics = new Set<Hex>(only ? [] : REGISTRY_TOPIC0);
    const settlements = new Set<Address>();
    const owners = new Set<Hex>();
    for (const [source, list] of Object.entries(CORE_TOPIC0)) if (source !== 'poolManager' && source !== 'registry') for (const t of list) topics.add(t);
    for (const [source, list] of Object.entries(CORE_TOPIC0_V2)) if (source !== 'cowSettlement') for (const t of list) topics.add(t);
    for (const t of SET_TOPICS) if (this.setManifest) topics.add(t);
    for (const e of entries) {
      if (isSetEntry(e)) { for (const a of e.route.parts.keys()) addresses.add(a); }
      else if (isEntryV2(e)) {
        const route = this.v2Route(e.row, listingEvents);
        for (const a of [...route.parts.keys(), ...route.modules]) addresses.add(lower(a));
        for (const inbox of route.inboxes ?? []) {
          settlements.add(lower(inbox.settlement) as Address);
          owners.add(`0x${lower(inbox.router).slice(2).padStart(64, '0')}`);
        }
      } else for (const a of e.route.addresses.keys()) addresses.add(a);
    }
    if (entries.length > 0) {
      addresses.add(lower(this.manifest.chain.randomness.address));
      addresses.add(lower(drandSourceOf(this.manifest).address));
    }
    return { addresses: [...addresses] as Address[], topics: [...topics], poolManager: entries.length > 0 ? this.manifest.chain.poolManager.address : null, poolIds: entries.map((e) => e.row.poolId), poolTopics: POOL_TOPIC0,
      settlementAddresses: [...settlements], settlementTopics: CORE_TOPIC0_V2.cowSettlement ?? [], settlementOwners: [...owners] };
  }

  private v2Route(row: BoxRowV2, listings = this.listingEvents): RouteV2 {
    const book = listingBookV2(listings.filter((e) => same(e.address, row.release.listingRegistry.address)));
    return routeV2(row.release, this.manifest, book.listings, [row.record], row.feeModules, row.inbox ? [{ ...row.inbox, boxId: row.boxId }] : []);
  }
  private discovered(logs: readonly RawLog[]): IndexedRow[] {
    return [
      ...this.manifest.versions.flatMap((v) => rowsFromRegistryLogs(logs, this.rowOptions(v.registry.address)).rows),
      ...this.manifest.releases.flatMap((r) => rowsFromV2Logs(logs, r, this.chainId)),
      ...(this.setManifest ? rowsFromSetLogs(logs, this.setManifest, this.chainId) : []),
    ];
  }
  private async discoveredListings(logs: readonly RawLog[]): Promise<CoreEventV2[]> {
    const events: CoreEventV2[] = [];
    const seen = new Set(this.listingEvents.map((e) => `${e.ref.blockHash}:${e.ref.logIndex}`));
    for (const release of this.manifest.releases) {
      const decoded = decodeV2Logs(logs, routeV2(release, this.manifest, [], [])).filter((e) => e.source === 'listingRegistry' && !seen.has(`${e.ref.blockHash}:${e.ref.logIndex}`));
      // A call at a block hash sees the final row in that block, including multiple raise updates.
      const prefix = this.listingEvents.filter((e) => same(e.address, release.listingRegistry.address));
      for (let start = 0; start < decoded.length;) {
        let end = start + 1;
        while (end < decoded.length && decoded[end]?.ref.blockHash === decoded[start]?.ref.blockHash) end++;
        const blockEvents = decoded.slice(start, end);
        prefix.push(...blockEvents);
        const book = listingBookV2(prefix);
        const changes = blockEvents.filter((e) => e.name === 'ListingAdded' || e.name === 'RaiseUpdated');
        for (const id of new Set(changes.map((e) => e.args.id as number))) {
          const listing = book.byId(id);
          const event = [...changes].reverse().find((e) => e.args.id === id);
          if (!listing || !event) throw new Error('listing record missing for event');
          const readDetail = listing.checkedBurnSelector === undefined ? readListingDetailV2 : readListingDetailV21;
          const detail = await readDetail(this.reader, release, id, event.ref.blockHash);
          const prior = prefix.slice(0, -blockEvents.length).reverse().find((e) =>
            (e.name === 'ListingAdded' || e.name === 'RaiseUpdated') && e.args.id === id);
          validateListingDetailV2(detail, listing, prior ? this.listingDetails.get(prior) : undefined);
          for (const change of changes.filter((e) => e.args.id === id)) this.listingDetails.set(change, detail);
        }
        start = end;
      }
      events.push(...decoded);
    }
    return events;
  }

  /**
   * Both versions share publication and replay, but never decode one another's financial events. `isolateMoney` (the
   * head path): a v2 box whose money read the chain refuses at this block (an execution revert, such as an outside
   * coin the inbox cannot read) publishes its events with no money and is unverified until its next audit, so its
   * claim sends wait; one box can never stop the head for every box (RC6RR-FC-1). A node that could not answer still
   * fails the block, which is retried (CQ11-E). Replay and repair concern one box and still fail whole.
   */
  private async fold(entry: IndexedEntry, header: BlockHeader, logs: readonly RawLog[], reader: Pick<CoreReader, 'callAt'> = this.reader, isolateMoney = false, readMoney = true) {
    if (isSetEntry(entry)) {
      const outcome = await applySetBlock(entry.states.at(-1), header, logs, entry.row, reader);
      return {...outcome, save: () => { entry.states.push(outcome.state); }};
    }
    if (isEntryV2(entry)) {
      const route = this.v2Route(entry.row);
      const events = decodeV2Logs(logs, route).filter((e) => e.boxId === entry.row.boxId);
      const outcome = applyV2Block(entry.states.at(-1), header, events, entry.row);
      // A range block below the range's end at the fast pace: events only; the end's money follows in the same range.
      if (!readMoney) return { ...outcome, save: () => { entry.states.push(outcome.state); } };
      let money: Awaited<ReturnType<typeof readMoneyV2>> | null = null;
      let refused = '';
      try { money = await readMoneyV2(reader, entry.row, outcome.state.view, header.number, header.hash); }
      catch (error) {
        if (!isolateMoney || this.lifecycle.signal.aborted || !refusedAtHash(error)) throw error;
        // First line only: a transport error's later lines can name the RPC endpoint.
        refused = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
      }
      const state: LiveStateV2 = money ? { ...outcome.state, money } : outcome.state;
      return { ...outcome, state, save: () => {
        entry.states.push(state);
        if (money) { entry.moneyFailing = false; return; }
        if (!entry.moneyFailing) console.warn(`[core-indexer] v2 box ${entry.row.boxId}: money not read at ${header.number} (${refused}); its snapshot has no money and is unverified until a read and an audit succeed`);
        entry.moneyFailing = true;
        entry.verified = null;
      } };
    }
    const events = decodeBoxLogs(logs, entry.route);
    if (events.length === 0 && entry.states.length > 0) return null;
    const outcome = applyCoreBlock(this.latestState(entry), header, events, entry.row);
    return { ...outcome, save: () => entry.states.push(outcome.state) };
  }
  private saveOutcome(entry: IndexedEntry, outcome: NonNullable<Awaited<ReturnType<CoreChainIndexer['fold']>>>): void {
    outcome.save();
    entry.trades = [...entry.trades, ...outcome.trades].slice(-RECENT_KEPT);
    entry.activity = [...entry.activity, ...outcome.activity].slice(-RECENT_KEPT);
  }

  private routeOf(row: BoxRow): BoxRoute {
    const addresses = new Map(rowAddresses(row));
    // FIT's executor is box 0's; its swaps route by sender, its events (buy-and-burn) belong to box 0 only.
    if (!row.isBox0) addresses.delete(lower(row.contracts.executor as string));
    return {
      addresses: addresses as ReadonlyMap<string, RoleName>,
      poolManager: row.poolManager,
      poolId: row.poolId,
      randomness: row.randomness,
      drand: drandSourceOf(this.manifest).address,
      drandConsumers: new Set(row.contracts.tickets ? [lower(row.contracts.tickets)] : []),
    };
  }

  // ------------------------------------------------------------------------------------------------ lifecycle

  /** Catches up from the manifest's start block to the chain's head. */
  async start(): Promise<void> {
    const lifecycle = new AbortController();
    this.lifecycle.abort();
    this.lifecycle = lifecycle;
    this.resetBackfillWait();
    this.queuedHead = null;
    const chainId = await this.reader.chainId();
    if (lifecycle.signal.aborted) return;
    if (chainId !== this.chainId) throw new Error(`the RPC serves chain ${chainId}, the manifest names ${this.chainId}`);
    this.running = true;
    const head = await this.reader.latestHeader();
    if (this.setManifest) await checkSetStartup(this.reader, this.setManifest, head.hash);
    if (lifecycle.signal.aborted) return;
    await this.enqueue(head);
  }

  stop(): void {
    this.running = false;
    this.lifecycle.abort();
    this.pending = null;
    this.queuedHead = null;
  }

  onHead(header: BlockHeader): void {
    void this.enqueue(header);
  }

  enqueue(header: BlockHeader): Promise<void> {
    this.reader.observeHead?.(header);
    if (!this.pending || header.number >= this.pending.header.number) this.pending = { header, arrivedAt: performance.now() };
    if (this.queuedHead) return this.queuedHead;
    const work = this.schedule(`block ${header.number}`, async () => {
      this.queuedHead = null;
      const next = this.pending;
      this.pending = null;
      if (next) await this.handle(next.header, next.arrivedAt);
    });
    // At most one waiting head task, even while history backpressure holds the active task. Catch-up reads the gap.
    this.queuedHead = work;
    void work.then(() => { if (this.queuedHead === work) this.queuedHead = null; });
    return work;
  }

  private schedule(what: string, task: () => Promise<void>): Promise<void> {
    const signal = this.lifecycle.signal;
    this.busy = this.busy.then(async () => {
      if (!this.running || signal.aborted) return;
      try {
        await task();
      } catch (error) {
        this.metrics.errors += 1;
        this.metrics.lastError = `${what}: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[core-indexer] ${this.metrics.lastError}`);
      }
    });
    return this.busy;
  }

  /** Resolves once the queue is empty (tests, scripts). */
  async idle(): Promise<void> {
    for (;;) {
      const busy = this.busy;
      await busy;
      await Promise.all(this.historyWrites);
      if (busy === this.busy && this.historyWrites.size === 0) return;
    }
  }

  // ------------------------------------------------------------------------------------------------ blocks

  private async handle(header: BlockHeader, arrivedAt?: number): Promise<void> {
    const head = this.head();
    if (this.hashAt(header.number) === header.hash) return;
    if (!head) {
      await this.catchUp(header, arrivedAt);
      return;
    }
    if (header.number < head.number) {
      // A lagging source, or a shorter branch: a reorg is revealed by the next head of the new branch.
      if (this.hashAt(header.number) === undefined) return;
      await this.reorg(header, arrivedAt);
      return;
    }
    if (header.number > head.number + 1n) {
      await this.catchUp(header, arrivedAt);
      return;
    }
    if (header.number === head.number + 1n && header.parentHash === head.hash) {
      await this.apply(header);
      await this.maybeAudit();
      return;
    }
    await this.reorg(header, arrivedAt);
  }

  private resetBackfillWait(): void {
    this.retryBackfillAt = 0;
    this.nextBackfillWaitMs = 0;
  }

  /**
   * Up to `target`: a cold start or a long gap is a range backfill to 32 blocks below it (at least the start block, so
   * a head exists afterwards), then block by block; a short gap is block by block (each block's parent is checked, so a
   * replaced head is found by the reorg walk).
   */
  private async catchUp(target: BlockHeader, arrivedAt = performance.now()): Promise<void> {
    const { shortGap, rangeTail } = this.pace;
    const kept = this.head();
    if ((!kept || target.number - kept.number > shortGap) && arrivedAt < this.retryBackfillAt) return;
    // R2: a range is laid on the retained head without a parent check, so that head must be canonical first.
    if (kept && target.number - kept.number > shortGap) await this.dropNonCanonicalHead();
    const head = this.head();
    if (head && head.number >= target.number) return; // a rebuild above already passed the target
    if (!head || target.number - head.number > shortGap) {
      const from = head ? head.number + 1n : this.startBlock;
      const end = target.number - rangeTail > from ? target.number - rangeTail : from;
      const signal = this.lifecycle.signal;
      const to = end < target.number ? end : target.number;
      try {
        await this.rangeApply(from, to);
      } catch (cause) {
        const message = (cause instanceof Error ? cause.message : String(cause)).replace(/\s*[\r\n]+\s*/g, ' ');
        if (signal.aborted) throw new Error(message, { cause });
        const waitMs = this.nextBackfillWaitMs;
        if (waitMs === 0) {
          // A single refusal can clear by the next head.
          this.nextBackfillWaitMs = INITIAL_BACKFILL_WAIT_MS;
          throw new Error(message, { cause });
        }
        this.retryBackfillAt = performance.now() + waitMs;
        this.nextBackfillWaitMs = Math.min(waitMs * 2, MAX_BACKFILL_WAIT_MS);
        throw new Error(`${message}; next backfill due ${new Date(Date.now() + waitMs).toISOString()}`, { cause });
      }
      this.resetBackfillWait();
      // A cold start's first range is history, not a period of following the chain.
      if (this.pace.auditRanges && head) await this.maybeAudit(Number(to - from + 1n));
    }
    const from = this.head();
    if (!from) throw new Error('catch-up: no head after the backfill');
    for (let n = from.number + 1n; n < target.number; n += 1n) {
      const next = await this.reader.headerByNumber(n);
      if (!next) throw new Error(`block ${n} not available yet`);
      if (next.number !== n) throw new Error(`block ${n} mismatched (received ${next.number})`);
      await this.handle(next, arrivedAt);
    }
    if (target.number > from.number) await this.handle(target, arrivedAt);
  }

  /**
   * Before a range on a retained head (a long RPC outage, a stalled process): the newest held block still canonical by
   * number stays and everything above it rolls back, as a reorg does (BC-077); none at all is a rebuild. (The PoC
   * pipeline's `dropNonCanonicalHead`, pipeline.ts.)
   */
  private async dropNonCanonicalHead(): Promise<void> {
    const head = this.head();
    for (let i = this.blocks.length - 1; i >= 0; i -= 1) {
      const block = this.blocks[i];
      if (!block) continue;
      const onChain = await this.reader.headerByNumber(block.number);
      if (onChain?.hash !== block.hash) continue;
      if (head && block.number < head.number) await this.rollbackTo(block.number);
      return;
    }
    await this.rebuild(`no held block is canonical after a gap (head ${head?.number ?? 'none'})`);
  }

  /**
   * Range backfill [from, to]: rows first, then each shown box's logs; headers only for blocks with logs, and `to`.
   * Every read is anchored (R2): `to`'s header is read first, and each log read must come from an endpoint that holds
   * it and the retained head the range continues. Rows and entries stay staged until both log reads and every required
   * header have succeeded and matched, so a refused read leaves nothing behind for the next attempt.
   */
  private async rangeApply(from: bigint, to: bigint): Promise<void> {
    const end = await this.reader.headerByNumber(to);
    if (!end) throw new Error(`range backfill: header ${to} unavailable`);
    if (end.number !== to) throw new Error(`range backfill: header ${to} mismatched (received ${end.number})`);
    const base = this.head();
    if (base && base.number !== from - 1n) throw new Error(`range backfill from ${from} does not continue the head ${base.number}`);
    const anchors: BlockAnchor[] = [{ number: end.number, hash: end.hash }, ...(base ? [{ number: base.number, hash: base.hash }] : [])];
    const registryFilter: LogFilter = { addresses: [], topics: [...REGISTRY_TOPIC0, ...(CORE_TOPIC0_V2.registry ?? []), ...(CORE_TOPIC0_V2.listingRegistry ?? [])], poolManager: null, poolIds: [], poolTopics: [],
      settlementAddresses: [], settlementTopics: [], settlementOwners: [] };
    // Each release owns its start block. Group equal starts to retain batching on later catch-ups; all reads
    // hold the same anchors and finish before any discovery is published.
    const starts = new Map<bigint, Address[]>();
    for (const registry of this.registries) {
      const start = registry.startBlock > from ? registry.startBlock : from;
      if (start > to) continue;
      const addresses = starts.get(start) ?? [];
      addresses.push(registry.address);
      starts.set(start, addresses);
    }
    const registryLogs: RawLog[] = [];
    for (const [start, addresses] of starts) {
      registryLogs.push(...await this.reader.rangeLogs(start, to, { ...registryFilter, addresses }, anchors));
    }
    // Rows found here, checked at their own creation block (by its hash), are routed with the boxes' logs, then admitted.
    const staged: { row: IndexedRow; verdict: BoxVerdict; entry: IndexedEntry | null }[] = [];
    const newListings = await this.discoveredListings(registryLogs);
    for (const row of this.discovered(registryLogs)) {
      if (this.rows.has(rowKey(row)) || staged.some((s) => rowKey(s.row) === rowKey(row))) continue;
      const verdict = await this.classify(row, row.origin?.blockHash as Hex, end.hash, [...this.listingEvents, ...newListings]);
      if (!verdict) continue;
      staged.push({ row, verdict, entry: verdict.classification === 'shown' ? this.newEntry(row, verdict) : null });
    }
    const all = [...this.entries().values(), ...staged.flatMap((s) => (s.entry ? [s.entry] : []))];
    const boxLogs = all.length > 0 || this.manifest.releases.length > 0 ? await this.reader.rangeLogs(from, to, this.filter(all, [...this.listingEvents, ...newListings]), anchors) : [];
    const byBlock = groupByBlock(unionLogs(registryLogs, boxLogs));
    const numbers = [...byBlock.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    // job306 point 6: logs of one height from two branches (endpoint replicas straddling a fork) refuse the range; the
    // retry reads it again. Never the first hash's logs with the others dropped.
    for (const number of numbers) {
      const hashes = new Set((byBlock.get(number) ?? []).map((log) => log.blockHash.toLowerCase()));
      if (hashes.size > 1) throw new Error(`range backfill: the logs of block ${number} carry ${hashes.size} block hashes; read again`);
    }
    // job306 point 7: at most `headerReads` header reads at once (one at the 12-second pace), checked in block order.
    const read: (BlockHeader | null)[] = new Array(numbers.length).fill(null);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < numbers.length; i = next++) {
        const hash = byBlock.get(numbers[i] as bigint)?.[0]?.blockHash;
        read[i] = hash ? await this.reader.headerByHash(hash) : null;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.pace.headerReads ?? 1, numbers.length)) }, worker));
    const headers: BlockHeader[] = [];
    for (const [i, number] of numbers.entries()) {
      const hash = byBlock.get(number)?.[0]?.blockHash;
      const header = read[i] ?? null;
      if (!header || header.number !== number || !same(header.hash, hash)) throw new Error(`range backfill: header of block ${number} unavailable or mismatched`);
      headers.push(header);
    }
    // The fast pace (CorePace.linkedTail): the newest blocks below `end`, linked by parent hash down from it, are held
    // too (a block without logs is held without a fold), so the head's reorg walk finds every one of them.
    const linked = await this.linkedHeaders(from, end, base);
    for (const header of linked) {
      const logged = headers.find((h) => h.number === header.number);
      if (logged && !same(logged.hash, header.hash)) throw new Error(`range backfill: block ${header.number} changed branch`);
    }
    const ordered = [...headers, ...linked.filter((h) => !byBlock.has(h.number))].sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
    const fresh: IndexedEntry[] = [];
    for (const s of staged) {
      const entry = this.insert(s.row, s.verdict, s.entry);
      if (entry) fresh.push(entry);
    }
    try {
      for (const header of ordered) {
        if (byBlock.has(header.number)) {
          await this.commit(header, logsOfHash(byBlock.get(header.number) ?? [], header.hash),
            { quiet: true, fresh, money: this.pace.rangeMoneyEveryBlock || header.number === end.number });
        }
        else this.hold(header);
      }
      if (this.hashAt(end.number) !== end.hash) await this.commit(end, [], { quiet: true, fresh: [] });
    } catch (error) {
      // A failure during application may leave some blocks committed. Discard only unpublished creations; committed
      // state stays with its history and the usual head reconciliation rolls both back together if a reorg follows.
      const committed = this.head()?.number ?? from - 1n;
      for (const s of staged) {
        if (s.row.creationBlock <= committed) continue;
        this.rows.delete(rowKey(s.row));
        if (s.entry) this.dropEntry(lower(s.row.contracts.token as string));
      }
      throw error;
    }
    // The display reads once, at the backfill's last block (the blocks it passed over were not read one by one).
    const saveDisplays = await this.stageDisplays([...this.entries().values()], end);
    saveDisplays();
    this.notify([...this.entries().keys()]);
  }

  /**
   * The headers of the newest `linkedTail` blocks of [from, end) (none at the 12-second pace), read by number and
   * checked to link by parent hash up to the anchored `end`, and down to the retained head when the span starts at it.
   */
  private async linkedHeaders(from: bigint, end: BlockHeader, base: HeldBlock | null): Promise<BlockHeader[]> {
    const span = this.pace.linkedTail;
    if (span === 0n || end.number <= from) return [];
    const first = end.number - span + 1n > from ? end.number - span + 1n : from;
    const numbers: bigint[] = [];
    for (let n = first; n < end.number; n += 1n) numbers.push(n);
    const read = await Promise.all(numbers.map((n) => this.reader.headerByNumber(n)));
    const chain: BlockHeader[] = [];
    for (const [i, header] of read.entries()) {
      if (!header || header.number !== numbers[i]) throw new Error(`range backfill: header ${numbers[i]} unavailable or mismatched`);
      chain.push(header);
    }
    for (const [i, header] of chain.entries()) {
      const child = chain[i + 1] ?? end;
      if (!same(child.parentHash, header.hash)) throw new Error(`range backfill: block ${header.number} does not link to ${child.number}`);
    }
    const lowest = chain[0];
    if (lowest && base && lowest.number === base.number + 1n && !same(lowest.parentHash, base.hash)) {
      throw new Error(`range backfill: block ${lowest.number} does not continue the head ${base.number}`);
    }
    return chain;
  }

  /** A linked block without logs of ours: held for the reorg walk, nothing folded and nothing written. */
  private hold(header: BlockHeader): void {
    this.blocks.push({ number: header.number, hash: header.hash, parentHash: header.parentHash, timestamp: header.timestamp });
    this.trim();
  }

  /** Stage display reads and failure flags; the caller publishes them only when the block is accepted. */
  private async stageDisplays(entries: readonly IndexedEntry[], header: Pick<BlockHeader, 'number' | 'hash'>): Promise<() => void> {
    const saves = await Promise.all(
      entries.filter((entry): entry is BoxEntry => !isEntryV2(entry) && !isSetEntry(entry)).map(async (entry) => {
        try {
          const values = await readDisplay(this.reader, entry.row, header.hash);
          return () => {
            entry.display = { block: header.number, values };
            entry.displayFailing = false;
          };
        } catch (error) {
          return () => {
            if (!entry.displayFailing) console.warn(`[core-indexer] box ${entry.row.boxId}: display views not read at ${header.number} (${error instanceof Error ? error.message : String(error)}); the page shows the last ones with their block`);
            entry.displayFailing = true;
          };
        }
      }),
    );
    return () => { for (const save of saves) save(); };
  }

  /**
   * A new row's verdict: its code at its creation block (no state changes). Its pictures play no part: a box that
   * passes is listed at once, its pictures stored or not (SH-NO-PICTURE-GATE). Null once the indexer is stopping.
   */
  private async classify(row: IndexedRow, creationHash: Hex, headHash: Hex = creationHash, listings = this.listingEvents): Promise<BoxVerdict | null> {
    const signal = this.lifecycle.signal;
    if (signal.aborted) return null;
    let verdict: BoxVerdict;
    if (isSetRowV2(row)) {
      verdict = await checkSetBoxV2(this.reader, this.manifest, row.release, row, creationHash);
      if (verdict.classification === 'shown' && row.record.pricingListingId !== 0) {
        const listing = await readListingDetailV21(this.reader, projectSetRow(row).release, row.record.pricingListingId, creationHash);
        if (!same(listing.token, row.q)) throw new Error('set pricing listing differs');
        row.pDecimals = listing.decimals;
      }
    } else if (isRowV2(row)) {
      const checked = await checkBoxV2(this.reader, this.manifest, { registry: row.registry, record: row.record, encodedSpec: row.encodedSpec }, { creationHash, headHash, reviewed: [] });
      verdict = { classification: checked.classification, reason: checked.reason };
      row.marks = checked.marks;
      row.feeModules = checked.feeModules ?? [];
      if (verdict.classification === 'shown' && row.contracts.royaltyRouter) {
        row.inbox = await readInboxWiringV21(this.reader, row.contracts.royaltyRouter, creationHash);
      }
      if (verdict.classification === 'shown' && row.record.pricingListingId !== 0) {
        // Include staged admissions in this range/block; no uncommitted event is published on read failure.
        const recorded = listingBookV2(listings.filter(e => same(e.address, row.release.listingRegistry.address)
          && e.ref.blockNumber <= row.record.creationBlock)).byId(row.record.pricingListingId);
        const readDetail = recorded?.checkedBurnSelector === undefined ? readListingDetailV2 : readListingDetailV21;
        const listing = await readDetail(this.reader, row.release, row.record.pricingListingId, creationHash);
        if (recorded) validateListingDetailV2(listing, recorded);
        if (listing.id !== row.record.pricingListingId || !same(listing.token, row.q)) throw new Error('box pricing listing differs from its record');
        row.pDecimals = listing.decimals;
      }
    } else verdict = await checkBoxAtCreation(this.reader, this.manifest, row, creationHash);
    if (signal.aborted) return null;
    return verdict;
  }

  private newEntry(row: IndexedRow, verdict: BoxVerdict): IndexedEntry {
    if (isSetRowV2(row)) return {version: 'set-v2', row, route: setRoute(row.record, row.release), verdict, states: [], repairing: false, trades: [], activity: []};
    if (isRowV2(row)) return { version: 2, row, route: this.v2Route(row), verdict, states: [], verified: null, audit: null, repairing: false, trades: [], activity: [] };
    return { row, route: this.routeOf(row), verdict, states: [], verified: null, audit: null, display: null, displayFailing: false, repairing: false, trades: [], activity: [] };
  }

  /** Records a classified row; a shown one becomes a box. */
  private insert(row: IndexedRow, verdict: BoxVerdict, entry: IndexedEntry | null): IndexedEntry | null {
    this.rows.set(rowKey(row), { row, verdict });
    if (verdict.classification !== 'shown' || !entry) {
      console.warn(`[core-indexer] box ${row.boxId} of ${row.registry} not shown: ${verdict.reason}`);
      return null;
    }
    this.putEntry(lower(row.contracts.token as string), entry);
    return entry;
  }

  /** Deliver in chain order; only a full history backlog holds the serialized head queue. Nothing is dropped. */
  private async publishHistory(message: HistoryMessage): Promise<void> {
    if (!this.onHistory) return;
    const write = Promise.resolve(this.onHistory(message)).catch((error: unknown) => {
      this.metrics.errors += 1;
      this.metrics.lastError = `history: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[core-indexer] ${this.metrics.lastError}`);
    });
    this.historyWrites.add(write);
    void write.then(() => this.historyWrites.delete(write));
    if (this.historyWrites.size >= HISTORY_MESSAGES_MAX) {
      console.warn(`[core-indexer] history backpressure: ${this.historyWrites.size} messages pending; waiting for intake`);
      // All producers await this gate in chain order. One warning per stall, with no polling or extra messages.
      await this.historyWrites.values().next().value;
    }
  }

  private async apply(header: BlockHeader): Promise<void> {
    const logs = await this.reader.logsByHash(header.hash, this.filter(undefined, this.listingEvents, header.number));
    await this.commit(header, logs, { quiet: false, fresh: [] });
  }

  /** Folds one block into every box it touches (new boxes first admitted), keeps the window, writes and reports. */
  private async commit(header: BlockHeader, logs: readonly RawLog[], options: { quiet: boolean; fresh: readonly IndexedEntry[]; money?: boolean }): Promise<void> {
    const money = options.money ?? true;
    const signal = this.lifecycle.signal;
    let all = [...logs];
    const newRows: { row: IndexedRow; verdict: BoxVerdict }[] = [];
    const newListings = await this.discoveredListings(logs);
    // Re-read at this hash after discovering listings and box parts, including creation-transaction events.
    const combinedListings = [...this.listingEvents, ...newListings];
    const staged: { row: IndexedRow; verdict: BoxVerdict; entry: IndexedEntry | null }[] = [];
    for (const row of this.discovered(logs)) {
      const key = rowKey(row); const known = this.rows.get(key);
      if (known) { if (known.row.creationBlock === header.number) newRows.push(known); continue; }
      const verdict = await this.classify(row, header.hash, header.hash, combinedListings);
      if (!verdict) continue;
      const entry = verdict.classification === 'shown' ? this.newEntry(row, verdict) : null;
      staged.push({ row, verdict, entry });
    }
    const entries = [...this.entries().values(), ...staged.flatMap((s) => s.entry ? [s.entry] : [])];
    if (!options.quiet && (newListings.length > 0 || staged.some((s) => s.entry))) {
      all = unionLogs(all, logsOfHash(await this.reader.logsByHash(header.hash, this.filter(entries, combinedListings)), header.hash));
    }
    const results: BoxBlockResult[] = [];
    // Each touched box's new state first (pure), then, for a head block, its display reads at this block (before the
    // new state is served, so the page never pairs a new state with older reads), then the states go in.
    // Folds are staged and independent. Concurrent views share bounded Multicall3 batches across boxes at this hash;
    // Promise.all retains entry/history order and nothing is saved until every required fold has succeeded.
    type Touched = { token: string; entry: IndexedEntry; outcome: NonNullable<Awaited<ReturnType<CoreChainIndexer['fold']>>> };
    const folded = await Promise.all(entries.map(async (entry): Promise<Touched | null> => {
      const token = lower(entry.row.contracts.token as string);
      if (entry.row.creationBlock > header.number) return null;
      const outcome = await this.fold(entry, header, all, this.reader, true, money);
      return outcome ? { token, entry, outcome } : null;
    }));
    const touched = folded.filter((result): result is Touched => result !== null);
    const saveDisplays = options.quiet ? null : await this.stageDisplays(touched.map((t) => t.entry), header);
    if (touched.some((t) => ((money && isEntryV2(t.entry)) || isSetEntry(t.entry)))) {
      signal.throwIfAborted();
      const canonical = await this.reader.headerByNumber(header.number);
      if (!same(canonical?.hash, header.hash)) throw new Error('v2 money block changed before publication');
      signal.throwIfAborted();
    }
    // No await until the displays, folded states and head have all been published.
    saveDisplays?.();
    this.listingEvents = combinedListings;
    for (const s of staged) { this.insert(s.row, s.verdict, s.entry); newRows.push({ row: s.row, verdict: s.verdict }); }
    for (const { token, entry, outcome } of touched) {
      this.saveOutcome(entry, outcome);
      if (outcome.trades.length + outcome.activity.length + outcome.transfers.length > 0) {
        results.push({ token, registry: entry.row.registry, boxId: entry.row.boxId, trades: outcome.trades, activity: outcome.activity, transfers: outcome.transfers });
      }
    }
    const block: HeldBlock = { number: header.number, hash: header.hash, parentHash: header.parentHash, timestamp: header.timestamp };
    this.blocks.push(block);
    if (!options.quiet) this.resetBackfillWait();
    this.trim();
    this.metrics.blocksApplied += 1;
    await this.publishHistory({ type: 'block', result: { chainId: this.chainId, block, rows: newRows, boxes: results } });
    // A new head changes every box's snapshot (its asOf, and its phase by block number), so all are reported.
    if (!options.quiet) this.notify([...this.entries().keys()]);
  }

  /** Keeps the newest `windowBlocks` blocks, and per box the newest state at or below the window's floor. */
  private trim(): void {
    const head = this.head();
    if (!head) return;
    const floor = head.number - BigInt(this.windowBlocks);
    while (this.blocks.length > 0 && (this.blocks[0] as HeldBlock).number <= floor) this.blocks.shift();
    for (const entry of this.entries().values()) this.trimEntry(entry, floor);

  }

  private trimEntry(entry: IndexedEntry, floor: bigint): void {
    let keepFrom = 0;
    for (const [i, state] of entry.states.entries()) if (state.block <= floor) keepFrom = i;
    if (keepFrom > 0) { if (isSetEntry(entry)) entry.states = entry.states.slice(keepFrom); else if (isEntryV2(entry)) entry.states = entry.states.slice(keepFrom); else entry.states = entry.states.slice(keepFrom); }
  }

  private notify(tokens: readonly string[]): void {
    this.onUpdate?.(tokens);
  }

  // ------------------------------------------------------------------------------------------------ reorgs

  /** Walks the new branch back to the newest block we hold, rolls every box back to it, applies the branch. */
  private async reorg(header: BlockHeader, arrivedAt?: number): Promise<void> {
    const branch: BlockHeader[] = [header];
    let cursor = header;
    for (;;) {
      const known = this.hashAt(cursor.number - 1n);
      if (known === undefined || branch.length > this.windowBlocks) {
        await this.rebuild(`reorg deeper than the ${this.windowBlocks}-block window at ${header.number}`, arrivedAt);
        return;
      }
      if (known === cursor.parentHash) break;
      const parent = await this.reader.headerByHash(cursor.parentHash);
      if (!parent) throw new Error(`reorg: parent ${cursor.parentHash} of block ${cursor.number} unavailable`);
      branch.unshift(parent);
      cursor = parent;
    }
    const ancestor = cursor.number - 1n;
    await this.rollbackTo(ancestor);
    for (const block of branch) await this.apply(block);
    await this.maybeAudit();
  }

  /** Drops every block above `ancestor`; each box rolls back to it; boxes created above it are gone (BC-077). */
  async rollbackTo(ancestor: bigint): Promise<void> {
    const head = this.head();
    if (!head) return;
    const depth = Number(head.number - ancestor);
    this.metrics.reorgs += 1;
    this.metrics.maxReorgDepth = Math.max(this.metrics.maxReorgDepth, depth);
    this.blocks = this.blocks.filter((b) => b.number <= ancestor);
    this.listingEvents = this.listingEvents.filter((e) => e.ref.blockNumber <= ancestor);
    for (const [key, seen] of [...this.rows.entries()]) if (seen.row.creationBlock > ancestor) this.rows.delete(key);
    for (const [token, entry] of this.entries()) {
      if (entry.row.creationBlock > ancestor) {
        this.dropEntry(token);
        continue;
      }
      if (isSetEntry(entry)) entry.states = entry.states.filter((s) => s.block <= ancestor);
      else if (isEntryV2(entry)) {
        entry.states = entry.states.filter((s) => s.block <= ancestor);
        if (entry.audit && BigInt(entry.audit.block) > ancestor) { entry.audit = null; entry.verified = null; }
      }
      else { entry.states = entry.states.filter((s) => s.block <= ancestor); if (entry.display && entry.display.block > ancestor) entry.display = null; }
      entry.trades = entry.trades.filter((t) => t.block <= ancestor);
      entry.activity = entry.activity.filter((a) => a.block <= ancestor);
    }
    console.warn(`[core-indexer] reorg: rolled back ${depth} block(s) from ${head.number} to ${ancestor}`);
    await this.publishHistory({ type: 'rollback', chainId: this.chainId, toBlock: ancestor });
    this.notify([...this.entries().keys()]);
  }

  /** Starts over from the manifest's start block (every box from its creation block), up to the chain's head. */
  private async rebuild(reason: string, arrivedAt = performance.now()): Promise<void> {
    // A rebuild that leads to another rebuild means the chain does not link up (or a decoding bug): stop and report.
    if (this.rebuilding) throw new Error(`${reason}: the chain changed again during a rebuild; nothing more is applied until the next head`);
    this.rebuilding = true;
    try {
      await this.rebuildOnce(reason, arrivedAt);
    } finally {
      this.rebuilding = false;
    }
  }

  private async rebuildOnce(reason: string, arrivedAt: number): Promise<void> {
    this.metrics.rebuilds += 1;
    const deferred = arrivedAt < this.retryBackfillAt
      ? `; backfill deferred until ${new Date(Date.now() + this.retryBackfillAt - performance.now()).toISOString()}` : '';
    console.warn(`[core-indexer] ${reason}: rebuilding every box from its creation block${deferred}`);
    this.blocks = [];
    this.rows.clear();
    this.boxes.clear();
    this.boxesV2.clear();
    this.setsV2.clear();
    this.listingEvents = [];
    await this.publishHistory({ type: 'reset', chainId: this.chainId, reason });
    await this.catchUp(await this.reader.latestHeader(), arrivedAt);
  }

  // ------------------------------------------------------------------------------------------------ audit

  private async maybeAudit(blocks = 1): Promise<void> {
    this.sinceAudit += blocks;
    if (this.sinceAudit < this.auditEvery) return;
    this.sinceAudit = 0;
    await this.audit();
  }

  /** Audits every shown box at the head (BC-080); repairs the ones that disagree, alone. */
  async audit(): Promise<readonly { readonly token: string; readonly result: AuditResult }[]> {
    const head = this.head();
    if (!head) return [];
    this.metrics.audits += 1;
    const out: { token: string; result: AuditResult }[] = [];
    const entries = [...this.entries()];
    const { staged, canonical: initialCanonical } = await this.stageAudits(entries.map(([, entry]) => entry), head);
    let canonical = initialCanonical;
    for (const [i, [token, entry]] of entries.entries()) {
      const result = staged[i]?.publish(canonical);
      if (!result) continue;
      out.push({ token, result });
      if (!result.ok) {
        this.metrics.auditMismatches += 1;
        console.warn(`[core-indexer] audit: box ${entry.row.boxId} disagrees with the chain at ${head.number}: ${result.mismatches.join('; ')}`);
        await this.repairBox(entry);
        // A rejected repair already stops this loop. Its recheck must refresh canonicality for every
        // remaining staged box, even if this box's money read fails or the repaired box is v1.
        const recheck = await this.stageAudits([entry], head, canonical !== undefined);
        canonical = recheck.canonical ?? canonical;
        const again = recheck.staged[0]?.publish(canonical);
        if (again) out.push({ token, result: again });
      }
    }
    this.notify([...this.entries().keys()]);
    return out;
  }

  /** Read all boxes first; check canonicality only after the last dependency wave finishes. Repairs get a new pass. */
  private async stageAudits(entries: readonly IndexedEntry[], head: HeldBlock, checkHeader = false) {
    const staged = await Promise.all(entries.map(entry => this.stageAuditBox(entry, head)));
    const [canonical] = checkHeader || staged.some(read => read?.needsHeader)
      ? await Promise.allSettled([this.reader.headerByNumber(head.number)]) : [];
    return { staged, canonical };
  }

  private async stageAuditBox(entry: IndexedEntry, head: HeldBlock): Promise<{
    needsHeader: boolean;
    publish(canonical?: PromiseSettledResult<BlockHeader | null>): AuditResult | null;
  } | null> {
    // Sets reconcile membership and money at every published block. A refused read prevents publication.
    if (isSetEntry(entry)) return null;
    if (isEntryV2(entry)) {
      const signal = this.lifecycle.signal;
      const state = entry.states.at(-1);
      if (!state) return null;
      const unavailable = (error: unknown) => {
        if (signal.aborted) return null;
        entry.verified = null;
        console.warn(`[core-indexer] v2 audit unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      };
      try {
        const money = await readMoneyV2(this.reader, entry.row, state.view, head.number, head.hash);
        return { needsHeader: true, publish: canonical => {
          try {
            if (canonical?.status === 'rejected') throw canonical.reason;
            if (signal.aborted || canonical?.status !== 'fulfilled' || !same(canonical.value?.hash, head.hash)
              || !same(this.head()?.hash, head.hash)
              || this.boxesV2.get(lower(entry.row.contracts.token as string)) !== entry) return null;
            const result = compareMoneyV2(state, money);
            entry.verified = result.ok;
            entry.audit = { block: head.number.toString(), ok: result.ok, mismatches: result.mismatches, reads: money.values };
            return result;
          } catch (error) { return unavailable(error); }
        } };
      } catch (error) { return { needsHeader: false, publish: () => unavailable(error) }; }
    }
    const state = this.stateAt(entry, head);
    if (!state) return null;
    try {
      const reads = await readBox(this.reader, entry.row, head.number, head.hash);
      return { needsHeader: false, publish: canonical => {
        if (canonical && (canonical.status === 'rejected' || !same(canonical.value?.hash, head.hash))) return null;
        // The state at the head, with the head's time (the platform's epoch is a time rule).
        const result = compareAudit({ ...state, block: head.number, blockHash: head.hash, timestamp: head.timestamp }, reads, entry.row);
        entry.verified = result.ok;
        entry.audit = { block: head.number.toString(), ok: result.ok, mismatches: result.mismatches, reads: reads.values };
        return result;
      } };
    } catch (error) {
      return { needsHeader: false, publish: () => {
        console.warn(`[core-indexer] audit: box ${entry.row.boxId} not read (${error instanceof Error ? error.message : String(error)}); verdict unchanged`);
        return null;
      } };
    }
  }

  /** Re-reads one box's logs from its creation block and refolds it (the other boxes untouched; BC-094). */
  async repairBox(entry: IndexedEntry): Promise<void> {
    if (isSetEntry(entry)) { await this.rebuild('set replay requested'); return; }
    const head = this.head();
    if (!head) return;
    this.metrics.boxRepairs += 1;
    entry.repairing = true;
    this.notify([lower(entry.row.contracts.token as string)]);
    try {
      if (isEntryV2(entry)) {
        const signal = this.lifecycle.signal;
        const staged = this.newEntry(entry.row, entry.verdict);
        if (!isEntryV2(staged)) throw new Error('invalid v2 repair entry');
        const anchors = [{ number: head.number, hash: head.hash }, { number: entry.row.creationBlock, hash: entry.row.origin.blockHash }];
        let previous: BlockHeader | null = null;
        for (let from = entry.row.creationBlock; from <= head.number; from += 64n) {
          const to = from + 63n < head.number ? from + 63n : head.number;
          const logs = await this.reader.rangeLogs(from, to, this.filter([staged]), anchors);
          if (logs.some((l) => l.blockNumber < from || l.blockNumber > to)) throw new Error('v2 repair log outside range');
          const grouped = groupByBlock(logs);
          for (let number = from; number <= to; number++) {
            const header = await this.reader.headerByNumber(number);
            const group = grouped.get(number) ?? [];
            if (!header || header.number !== number || group.some((l) => !same(l.blockHash, header.hash))) throw new Error('v2 repair header changed branch');
            if (previous ? !same(header.parentHash, previous.hash) : !same(header.hash, entry.row.origin.blockHash)) throw new Error('v2 repair parent changed branch');
            signal.throwIfAborted();
            const outcome = await this.fold(staged, header, group);
            signal.throwIfAborted();
            if (outcome) this.saveOutcome(staged, outcome);
            this.trimEntry(staged, number - BigInt(this.windowBlocks));
            previous = header;
          }
        }
        if (!same(previous?.hash, head.hash) || !same((await this.reader.headerByNumber(head.number))?.hash, head.hash) || !same(this.head()?.hash, head.hash)) throw new Error('v2 repair head changed');
        signal.throwIfAborted();
        if (this.boxesV2.get(lower(entry.row.contracts.token as string)) !== entry) throw new Error('v2 repair entry changed');
        entry.states = staged.states; entry.trades = staged.trades; entry.activity = staged.activity;
        return;
      }
      const replay = await this.refold(entry.row, entry.route, head);
      entry.states = replay.states;
      entry.trades = replay.trades.slice(-RECENT_KEPT);
      entry.activity = replay.activity.slice(-RECENT_KEPT);
      this.trim();
    } finally {
      entry.repairing = false;
    }
  }

  /**
   * One box's logs from its creation block to `head`, folded from its initial state: its states, trades and activity,
   * for audit repair. Late admission uses the bounded, canonical replay above instead.
   */
  private async refold(row: BoxRow, route: BoxRoute, head: HeldBlock): Promise<{ states: CoreBoxState[]; trades: CoreTrade[]; activity: CoreActivity[] }> {
    const creationHash = row.origin?.blockHash;
    if (!creationHash) throw new Error('refold: creation block identity unavailable');
    const anchors: BlockAnchor[] = [{ number: head.number, hash: head.hash }, { number: row.creationBlock, hash: creationHash }];
    const logs = await this.reader.rangeLogs(row.creationBlock, head.number, this.filter([this.newEntry(row, { classification: 'shown', reason: null })]), anchors);
    const byBlock = groupByBlock(logs);
    const numbers = [...byBlock.keys()];
    numbers.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let state = initialCoreState(row);
    const states: CoreBoxState[] = [];
    const trades: CoreTrade[] = [];
    const activity: CoreActivity[] = [];
    for (const number of numbers) {
      const held = this.hashAt(number);
      const hash = held ?? byBlock.get(number)?.[0]?.blockHash ?? (number === row.creationBlock ? (row.origin?.blockHash as Hex | undefined) : undefined);
      const header = hash ? await this.reader.headerByHash(hash) : null;
      if (!header) throw new Error(`refold: header of block ${number} unavailable`);
      const outcome = applyCoreBlock(state, header, decodeBoxLogs(logsOfHash(byBlock.get(number) ?? [], header.hash), route), row);
      state = outcome.state;
      states.push(state);
      trades.push(...outcome.trades);
      activity.push(...outcome.activity);
    }
    return { states: states.length > 0 ? states : [state], trades, activity };
  }
}
