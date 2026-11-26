/**
 * Which boxes a data source has (F46: the home feed is a feed of boxes):
 * - Demo: the Demo Misfits (the Demo market, `DEMO_FIT_TARGET`), the boxes created on the creation page in this tab
 *   (newest first) and the five Demo boxes;
 * - local chain and Sepolia: one box per market record the build carries (`resolveFitTarget`). A record with neutral
 *   names is a rehearsal: a normal card with "Rehearsal · test set", never Featured, no teasers, no composition and no
 *   Misfits wording. Factory boxes come later behind the same record shape.
 * The edition size N is the record's (and on the page, the vault's), never a constant.
 */
import type { DataSourceId } from '../data-source';
import type { CoreFeed } from '../core/core-client';
import { DEMO_BOX0_ROW } from '../core/demo-row';
import { demoV2Boxes } from '../core/v2/demo-v2';
import { recordFromRow, rowBoxId } from '../core/row-record';
import { rowSummary, staleByClock } from '../core/row-summary';
import { box0SetupLine, v2SetupLine } from '../fit-pair/box0-fees';
import { resolveFitTarget, type FitBuild, type FitMarketTarget } from '../fit-pair/fit-target';
import { formatBoxId } from './box-id';
import type { BoxRecord, BoxSummary } from './box-model';
import { DEMO_BOXES } from './demo-boxes';
import { PRODUCTION_NOT_DEPLOYED, SEPOLIA_NOT_DEPLOYED } from '../data-source/data-source';
import { TESTNET } from '../data-source/testnet';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

/** A launch market (the Misfits, a rehearsal, a local fixture) as a box. */
export function launchRecord(target: FitMarketTarget): BoxRecord {
  const names = target.names;
  const launch = names.kind === 'launch';
  return Object.freeze({
    id: formatBoxId(target.chainId, target.token),
    chainId: target.chainId,
    networkLabel: target.networkLabel,
    kind: 'genesis',
    name: names.collectionName,
    ticker: names.tokenSymbol,
    pairAsset: 'ETH',
    pairDecimals: 18,
    token: target.token,
    vault: target.vault,
    itemCount: target.collectionSize,
    itemNoun: names.items,
    demo: DEMO_BUILD && target.kind === 'demo',
    featured: launch,
    rehearsal: !launch,
    order: 4,
    market: target,
    demoState: null,
    demoFigures: null,
    art: null,
    line: null,
    // F77: the Demo shows box 0's design; a deployed market keeps its own (v2) code's split (FeeDisclosure's rule).
    setup: DEMO_BUILD && target.kind === 'demo' ? box0SetupLine(names.tokenSymbol, names.item) : v2SetupLine(names.tokenSymbol),
    claims: 'per-item',
    spec: null,
    // The Demo Misfits are box 0 as a row (S10a § 5): box 0's fixture spec on the Demo's invented addresses. A v2
    // market record (the rehearsal) has no row.
    row: DEMO_BUILD && target.kind === 'demo' ? { row: DEMO_BOX0_ROW, network: 'demo' as const } : null,
  });
}

/**
 * Whether the Misfits pack (teasers, composition, tagline) attaches to a box (BC-095): by box 0's row (its registry and
 * id, so its collection), never by a name; a v2 market record without a row keeps its own rule (its launch names).
 */
export function misfitsPackFor(record: BoxRecord): boolean {
  if (record.row) return record.row.row.isBox0 && record.row.row.contracts.collection !== null;
  return record.market?.names.kind === 'launch';
}

/** Core v1 on this source (S10a): what the feed answer said, with each row box's own summary (BC-085). */
export type CoreSourcesState =
  | { readonly status: 'none' | 'awaiting-broadcast' | 'invalid'; readonly reason: string }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly reason: string }
  | {
      readonly status: 'ready';
      readonly via: CoreFeed['via'];
      readonly summaries: ReadonlyMap<string, BoxSummary>;
      readonly dropped: number;
      /** The last refresh failed: the cards are the last good answer's, each marked Stale. */
      readonly refreshError?: string | null;
      /** The build's indexer did not answer: the cards were read from the chain. */
      readonly indexerError?: string | null;
    };

export interface BoxSources {
  readonly boxes: readonly BoxRecord[];
  /** The source's launch market, if any (the feed runs one live curve for it). */
  readonly launch: FitMarketTarget | null;
  /** Why there is no launch box on this source (not configured, invalid), or null. */
  readonly missing: string | null;
  readonly core: CoreSourcesState;
  /** Boxes that open by link but are not in the feed yet (the Demo v2 boxes, wave 1). */
  readonly linkOnly?: readonly BoxRecord[];
  /**
   * SH-SITE-FIXES-10: whether a box missing from `boxes` is known to be absent, over every part of the source (core v1,
   * v2, the add-on); absent here: from `core` alone (`lookupOf`).
   */
  readonly lookup?: SourcesLookup;
  /** Reads again the parts that could not be read at all (the box page's Retry, the feed's and My Box's, SH-246). */
  readonly retry?: () => void;
  /**
   * SH-246: the v2 feed's reads on its own (null: the source has no v2 part), for what depends on the v2 boxes alone
   * (My Box's claims): still loading, answered, or never answered with its error.
   */
  readonly v2?: LookupPart | null;
  /** SH-246: box 0's feed (core v1) on its own (null: the source has none), for /misfits. */
  readonly v1?: LookupPart | null;
}

/**
 * SH-SITE-FIXES-10: what a box link may say while its box is not among the source's boxes. `loading`: a part of the
 * source has not answered yet (its first read, with its retry), so nothing is said; `unreachable`: a part could not be
 * read at all (no answer, and no earlier one kept), so the box may be there: unavailable, with a retry; `answered`: every
 * part answered, so the box is not there ("not found").
 */
export type SourcesLookup = { readonly status: 'answered' } | { readonly status: 'loading' } | { readonly status: 'unreachable'; readonly reason: string };

/** One part's reads: in flight (first answer pending), answered (some answer kept), and its last error. */
export interface LookupPart {
  readonly loading: boolean;
  readonly answered: boolean;
  readonly error: string | null;
}

/** The lookup over core v1's state and, where the source has them, v2's feed and the add-on's (null: no such part). */
export function lookupOf(v1: CoreSourcesState, v2: LookupPart | null = null, sets: LookupPart | null = null): SourcesLookup {
  if (v1.status === 'loading' || v2?.loading === true || sets?.loading === true) return { status: 'loading' };
  if (v1.status === 'error') return { status: 'unreachable', reason: v1.reason };
  for (const part of [v2, sets]) if (part && !part.answered && part.error !== null) return { status: 'unreachable', reason: part.error };
  return { status: 'answered' };
}

const NO_CORE: CoreSourcesState = Object.freeze({ status: 'none', reason: 'No core deployment.' });

/**
 * `created`: the boxes made on the creation page in this tab (Demo only, created-boxes.ts), next to the five Demo boxes:
 * many boxes side by side in one interface (F46, F69 C1).
 */
export function boxesFor(source: DataSourceId, build: FitBuild, created: readonly BoxRecord[] = [], v2: { readonly nowSec: bigint; readonly closed: ReadonlyMap<string, bigint> } | null = null): BoxSources {
  const isDemo = DEMO_BUILD && source === 'demo';
  const demo = isDemo ? [...created, ...DEMO_BOXES] : [];
  const linkOnly = isDemo && v2 !== null ? demoV2Boxes(v2.nowSec, v2.closed) : [];
  // SH-258: no FIT market where the test network has no box 0 (BNB Chain testnet): the chain sources never resolve one,
  // and a missing deployment says so in the source's own words instead of the FIT market's.
  if (!(import.meta.env?.SH_BNB !== true && TESTNET.switches.box0) && source === 'sepolia') return { boxes: demo, launch: null, missing: DEMO_BUILD ? SEPOLIA_NOT_DEPLOYED : PRODUCTION_NOT_DEPLOYED, core: NO_CORE, linkOnly };
  const resolution = resolveFitTarget(source, build);
  if (resolution.status !== 'ready') return { boxes: demo, launch: null, missing: resolution.reason, core: NO_CORE, linkOnly };
  const launch = launchRecord(resolution.target);
  return { boxes: isDemo ? [launch, ...demo] : [launch], launch: resolution.target, missing: null, core: NO_CORE, linkOnly };
}

/**
 * The source's core v1 boxes joined to its other boxes: one record per row of the feed answer, each with the summary
 * of its OWN card (BC-085), shown before the rest (box 0 first: Featured). A row record replaces nothing; a token
 * that is already listed (a v2 record of the same token cannot exist on a chain with core v1) is not listed twice.
 */
export function withCoreRows(sources: BoxSources, core: CoreSourcesState, feed: CoreFeed | null, network: 'local' | 'sepolia', nowMs: number, clockMs: number = nowMs, artGateways: readonly string[] = []): BoxSources {
  if (core.status !== 'ready' || feed === null) return { ...sources, core, missing: core.status === 'loading' ? null : sources.missing };
  const known = new Set(sources.boxes.map((b) => b.id));
  const records: BoxRecord[] = [];
  const summaries = new Map<string, BoxSummary>();
  for (const { row, card } of feed.cards) {
    const id = rowBoxId(row);
    if (known.has(id)) continue;
    const record = recordFromRow({ row, network }, { nowMs, artGateways });
    records.push(record);
    // Stale when the gateway says so, when this answer is the last good one (a refresh failed), or (Sepolia) by the clock.
    const stale = (core.refreshError ?? null) !== null || staleByClock(network, card.asOf.timestamp, clockMs);
    summaries.set(id, rowSummary(record, row, card, { stale }));
  }
  const ordered = records.sort((a, b) => (a.featured === b.featured ? b.order - a.order : a.featured ? -1 : 1));
  return { ...sources, boxes: [...ordered, ...sources.boxes], missing: null, core: { ...core, summaries } };
}

/** The box with this id on the source, or null. */
export function findBox(sources: BoxSources, id: string): BoxRecord | null {
  return sources.boxes.find((box) => box.id === id) ?? sources.linkOnly?.find((box) => box.id === id) ?? null;
}
