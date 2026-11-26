/**
 * What the core v1 gateway serves (S10a § 3.5; chain-data-platform § 2.6) and the site parses: one box's snapshot
 * (`sh.core-box.v1`), the feed (`sh.core-feed.v1`, one card per shown box from ONE answer, BC-085) and a wallet across
 * boxes (`sh.core-wallet.v1`, grouped by box address, BC-089). Every answer carries `asOf {block, hash, tier}` and
 * decimal strings for amounts; per box `verified` (the last audit) and `stale` (BC-094). Browser-safe: no Node, no RPC.
 *
 * The builders take a box's state and row; the parsers check an untrusted answer field by field and never guess.
 */
import { PLATFORM_EPOCH_SECONDS } from '@squarehole/box-spec';
import { boxRowFromJson, boxRowToJson, PLATFORM_CAP_Q, type BoxRow, type BoxRowJson } from './core-row';
import { rawCid, curveRetainedQ, fillBps, hookHoldings, priceQPerT, qValueOfT } from './core-math';
import type { CoreBoxState, CorePhase } from './derive-core';

export const CORE_BOX_SCHEMA = 'sh.core-box.v1';
export const CORE_FEED_SCHEMA = 'sh.core-feed.v1';
export const CORE_WALLET_SCHEMA = 'sh.core-wallet.v1';

export type AsOfTier = 'head' | 'confirmed' | 'finalized';

export interface AsOf {
  readonly block: string;
  readonly hash: `0x${string}`;
  readonly timestamp: string;
  readonly tier: AsOfTier;
}

/** The last audit (BC-080): when, whether it matched, what did not, and the chain reads it took (shown on the page). */
export interface AuditView {
  readonly block: string;
  readonly ok: boolean;
  readonly mismatches: readonly string[];
  readonly reads: Readonly<Record<string, string>>;
}

export interface CoreBoxView {
  readonly schema: typeof CORE_BOX_SCHEMA;
  readonly chainId: number;
  readonly token: `0x${string}`;
  readonly row: BoxRowJson;
  readonly asOf: AsOf;
  /** null: not audited yet; false: the chain disagrees (Unverified: no FDV, no price-built figure). */
  readonly verified: boolean | null;
  readonly stale: boolean;
  readonly phase: CorePhase;
  readonly blocks: {
    readonly creation: string;
    readonly closedAt: string | null;
    readonly migratedAt: string | null;
  };
  /** The open and the end of the launch window (Unix seconds; the row's openAt and windowEndsAt, open-at-clock-time.md). */
  readonly times: {
    readonly openAt: string;
    readonly windowEndsAt: string;
  };
  readonly price: { readonly sqrtPriceX96: string | null; readonly tick: number | null; readonly qPerT: string | null };
  readonly curve: { readonly raise: string; readonly retainedQ: string | null; readonly fillBps: number | null };
  readonly supply: { readonly total: string; readonly burned: string };
  /** price × supply in raw Q (a fully diluted value); null when the price is unknown. */
  readonly fdvQ: string | null;
  readonly trading: { readonly swaps: number; readonly buys: number; readonly sells: number; readonly volumeQ: string; readonly volumeT: string; readonly lastTradeBlock: string | null };
  readonly launch: { readonly taxQ: string; readonly windowBuys: number; readonly bootstrapQ: string; readonly creatorBuyQ: string; readonly sweptQ: string; readonly sweptToDepth: boolean | null };
  readonly fees: {
    readonly batches: number;
    readonly collectedQ: string;
    readonly collectedT: string;
    readonly toReserveQ: string;
    readonly tipQ: string;
    readonly qFit: string;
    readonly qDepth: string;
    readonly qPlatform: string;
    readonly qReward: string;
    readonly tBurned: string;
    readonly tDepth: string;
    readonly tFit: string;
    readonly tReward: string;
    /** Box 0 after graduation: the 13/15 T that funds the per-Misfit stream (in no BatchSplit field). */
    readonly tToStream: string;
    /** Box 0: the held platform share's part above the cap, to depth at the settlement (in no BatchSplit field). */
    readonly qDepthSettled: string;
    /** Box 0: REV-16 returns of FIT's executor's own swap fees, to FIT. */
    readonly qFitReturned: string;
  };
  /**
   * Box 0's platform share: `credited` (kept for the Safe, all time), `held` (before graduation, waiting in the
   * receiver), the epoch NOW (30 days from graduation; null before the settlement) and what was kept in it (0 in an
   * epoch with no credit yet), as `platformEpoch()` says.
   */
  readonly platform: { readonly credited: string; readonly held: string; readonly toDepth: string; readonly epoch: string | null; readonly keptInEpoch: string; readonly paid: string; readonly capQ: string };
  readonly pool: {
    readonly liquidity: string;
    readonly layout: { readonly askLiquidity: string; readonly bidLiquidity: string; readonly sentinelLiquidity: string; readonly qFromCurve: string; readonly tFromCurve: string } | null;
    /** Q and T in the hook's positions at the price (graduated only; I: v4 maths over the positions). */
    readonly holdings: { readonly q: string; readonly t: string } | null;
    readonly pairedLiquidity: string;
    /** T the coordinator holds for the pool until graduation (`poolShare()`: its T balance, from T's transfers). */
    readonly poolShare: string;
    readonly depthHeldQ: string;
    readonly depthHeldT: string;
    readonly depthFundedQ: string;
    readonly depthFundedT: string;
    readonly settled: boolean;
    readonly adds: number;
    readonly conversions: number;
    readonly convertedQ: string;
    readonly convertedT: string;
    readonly skips: number;
    readonly lastSkipReason: number | null;
    readonly lastAddBlock: string | null;
  };
  readonly graduation: { readonly block: string; readonly caller: string; readonly poolShare: string; readonly tokenDustBurned: string; readonly reward: string; readonly rewardClaimed: string } | null;
  /** `outside` = N − inside (the vault's `outside()`), from the vault events' `insideAfter`. */
  readonly vault: { readonly collectionSize: string | null; readonly inside: string | null; readonly outside: string | null; readonly escrow: string | null; readonly hidden: string | null; readonly tickets: string | null; readonly gateOpen: boolean };
  readonly draws: {
    readonly placeholdersTaken: string;
    readonly placeholdersHandedBack: string;
    readonly opened: number;
    readonly drawsRequested: number;
    readonly drawsSettled: number;
    readonly wordRequestedRound: string | null;
    readonly wordStored: boolean;
    readonly terminal: boolean;
  };
  readonly stream: { readonly started: boolean; readonly claimed: string; readonly burned: string; readonly funded: string };
  readonly audit: AuditView | null;
  /**
   * Views read at one block for display, where no event gives the figure (the hook's depth budget, the stream's index):
   * the indexer reads them at every block where the box had an event (and the audit's reads, whichever is newer); a
   * direct view reads them at its block. Null when none was read yet.
   */
  readonly reads: Readonly<Record<string, string>> | null;
  /** The block `reads` were taken at (null: none yet). */
  readonly readsBlock: string | null;
  /**
   * Whether `reads` still hold at `asOf`: no event of the box since `readsBlock` (each of these views changes only with
   * one). False: a read failed since; the page labels them "at block N (last check)".
   */
  readonly readsCurrent: boolean;
  /** Where the view came from: the indexer (events since creation) or a direct read at one block (no volume, no trades). */
  readonly source: 'indexer' | 'direct';
}

export interface FeedCard {
  readonly token: `0x${string}`;
  readonly row: BoxRowJson;
  readonly phase: CorePhase;
  readonly fillBps: number | null;
  readonly retainedQ: string | null;
  readonly qPerT: string | null;
  readonly fdvQ: string | null;
  readonly volumeQ: string;
  /** SH-TA-12: T burned so far, raw (the box view's `supply.burned`); absent from an older gateway (unknown, not zero). */
  readonly burnedT?: string;
  readonly asOf: AsOf;
  readonly verified: boolean | null;
  readonly stale: boolean;
}

export interface FeedView {
  readonly schema: typeof CORE_FEED_SCHEMA;
  readonly chainId: number;
  readonly asOf: AsOf | null;
  readonly cards: readonly FeedCard[];
  /** Boxes recorded but not shown, with why (a failed code check, a template this build does not show). */
  readonly hidden: readonly { readonly registry: string; readonly boxId: string; readonly reason: string }[];
}

export interface WalletBox {
  readonly token: `0x${string}`;
  readonly row: BoxRowJson;
  /** T held, raw (in this box's own token; never summed with another box's). */
  readonly t: string;
  readonly items: readonly string[];
  readonly tickets: readonly string[];
  /** The stream's owedOf(address) read at `asOf`; null when the box has no stream or it was not read. */
  readonly streamOwed: string | null;
  /** Open draw tickets this address drew (requested or settled, not yet opened); absent from an older gateway. */
  readonly draws?: readonly string[];
}

export interface WalletView {
  readonly schema: typeof CORE_WALLET_SCHEMA;
  readonly chainId: number;
  readonly address: `0x${string}`;
  readonly asOf: AsOf | null;
  readonly boxes: readonly WalletBox[];
}

const str = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());

export interface ViewInputs {
  readonly row: BoxRow;
  readonly state: CoreBoxState;
  readonly asOf: AsOf;
  readonly verified: boolean | null;
  readonly stale: boolean;
  readonly audit: AuditView | null;
  /** Display reads newer than the audit's (see CoreBoxView.reads); the newer of the two is served. */
  readonly display?: { readonly block: string; readonly values: Readonly<Record<string, string>> } | null;
  /** The block of the box's last event (its newest state): reads at or after it are current. */
  readonly lastEventBlock?: bigint;
}

/**
 * Box 0's platform epoch NOW and what was kept in it (`platformEpoch()`): ⌊(t − graduatedAt) / 30 days⌋ at the
 * state's time, from the settlement on; an epoch with no credit yet has kept nothing. (0, 0) before the settlement, as
 * the contract's view.
 */
export function platformNow(state: CoreBoxState): { readonly epoch: bigint | null; readonly kept: bigint } {
  const g = state.graduation;
  if (!state.depth.settled || !g) return { epoch: null, kept: 0n };
  const epoch = state.timestamp > g.timestamp ? (state.timestamp - g.timestamp) / BigInt(PLATFORM_EPOCH_SECONDS) : 0n;
  return { epoch, kept: state.platform.epoch === epoch ? state.platform.keptInEpoch : 0n };
}

/** T the coordinator holds for the pool (`poolShare()`): its T balance while launched and not graduated, else 0. */
export function poolShareOf(row: BoxRow, state: CoreBoxState): bigint {
  if (!state.launched || state.graduation !== null) return 0n;
  return state.balances.get((row.contracts.coordinator as string).toLowerCase()) ?? 0n;
}

/** A box's snapshot from its state at `asOf`. Price-built figures (FDV) are left out when the box is Unverified. */
export function boxView({ row, state, asOf, verified, stale, audit, display = null, lastEventBlock }: ViewInputs): CoreBoxView {
  const side = { tIsCurrency0: row.tIsCurrency0, qDecimals: row.qAsset.decimals, tDecimals: 18 };
  const sqrt = state.sqrtPriceX96;
  const curveRange = { tIsCurrency0: row.tIsCurrency0, raise: row.raise, sqrtPriceLowerX96: row.curve.sqrtPriceLowerX96, sqrtPriceUpperX96: row.curve.sqrtPriceUpperX96, liquidity: row.curve.liquidity };
  const onCurve = state.phase !== 'graduated' && sqrt !== null;
  const retained = onCurve ? curveRetainedQ(curveRange, sqrt) : state.phase === 'graduated' ? row.raise : null;
  const fdv = sqrt === null || verified === false ? null : qValueOfT(sqrt, row.tIsCurrency0, state.supply);
  const layout = state.layout;
  const holdings =
    layout && sqrt !== null && state.phase === 'graduated'
      ? hookHoldings({ askLiquidity: layout.askLiquidity, bidLiquidity: layout.bidLiquidity, sentinelLiquidity: layout.sentinelLiquidity, pairedLiquidity: state.depth.pairedLiquidity }, { tIsCurrency0: row.tIsCurrency0, tickLower: row.curve.tickLower, tickUpper: row.curve.tickUpper }, sqrt)
      : null;
  const g = state.graduation;
  const now = platformNow(state);
  const n = state.vault.collectionSize ?? BigInt(row.spec.n);
  // The newer of the audit's reads and the display reads (both at one block each).
  const auditBlock = audit ? BigInt(audit.block) : null;
  const displayBlock = display ? BigInt(display.block) : null;
  const useDisplay = displayBlock !== null && (auditBlock === null || displayBlock >= auditBlock);
  const reads = useDisplay ? { ...(audit?.reads ?? {}), ...(display?.values ?? {}) } : (audit?.reads ?? null);
  const readsBlock = useDisplay ? displayBlock : auditBlock;
  return {
    schema: CORE_BOX_SCHEMA,
    chainId: row.chainId,
    token: (row.contracts.token as string).toLowerCase() as `0x${string}`,
    row: boxRowToJson(row),
    asOf,
    verified,
    stale,
    phase: state.phase,
    blocks: { creation: row.creationBlock.toString(), closedAt: str(state.closedAtBlock), migratedAt: str(state.migratedAtBlock) },
    times: { openAt: row.openAt.toString(), windowEndsAt: row.windowEndsAt.toString() },
    price: { sqrtPriceX96: str(sqrt), tick: state.tick, qPerT: sqrt === null ? null : priceQPerT(sqrt, side) },
    curve: { raise: row.raise.toString(), retainedQ: str(retained), fillBps: retained === null ? null : fillBps(retained, row.raise) },
    supply: { total: state.supply.toString(), burned: state.burned.toString() },
    fdvQ: str(fdv),
    trading: { swaps: state.swaps, buys: state.buys, sells: state.sells, volumeQ: state.volumeQ.toString(), volumeT: state.volumeT.toString(), lastTradeBlock: str(state.lastTradeBlock) },
    launch: { taxQ: state.taxQ.toString(), windowBuys: state.windowBuys, bootstrapQ: state.bootstrapQ.toString(), creatorBuyQ: state.creatorBuyQ.toString(), sweptQ: state.sweptQ.toString(), sweptToDepth: state.sweptToDepth },
    fees: {
      batches: state.fees.batches,
      collectedQ: state.fees.collectedQ.toString(),
      collectedT: state.fees.collectedT.toString(),
      toReserveQ: state.fees.toReserveQ.toString(),
      tipQ: state.fees.tipQ.toString(),
      qFit: state.fees.qFit.toString(),
      qDepth: state.fees.qDepth.toString(),
      qPlatform: state.fees.qPlatform.toString(),
      qReward: state.fees.qReward.toString(),
      tBurned: state.fees.tBurned.toString(),
      tDepth: state.fees.tDepth.toString(),
      tFit: state.fees.tFit.toString(),
      tReward: state.fees.tReward.toString(),
      tToStream: state.fees.tToStream.toString(),
      qDepthSettled: state.fees.qDepthSettled.toString(),
      qFitReturned: state.fees.qFitReturned.toString(),
    },
    platform: { credited: state.platform.credited.toString(), held: state.platform.held.toString(), toDepth: state.platform.toDepth.toString(), epoch: str(now.epoch), keptInEpoch: now.kept.toString(), paid: state.platform.paid.toString(), capQ: PLATFORM_CAP_Q.toString() },
    pool: {
      liquidity: state.liquidity.toString(),
      layout: layout ? { askLiquidity: layout.askLiquidity.toString(), bidLiquidity: layout.bidLiquidity.toString(), sentinelLiquidity: layout.sentinelLiquidity.toString(), qFromCurve: layout.qFromCurve.toString(), tFromCurve: layout.tFromCurve.toString() } : null,
      holdings: holdings ? { q: holdings.q.toString(), t: holdings.t.toString() } : null,
      pairedLiquidity: state.depth.pairedLiquidity.toString(),
      poolShare: poolShareOf(row, state).toString(),
      depthHeldQ: state.depth.heldQ.toString(),
      depthHeldT: state.depth.heldT.toString(),
      depthFundedQ: state.depth.fundedQ.toString(),
      depthFundedT: state.depth.fundedT.toString(),
      settled: state.depth.settled,
      adds: state.depth.adds,
      conversions: state.depth.conversions,
      convertedQ: state.depth.convertedQ.toString(),
      convertedT: state.depth.convertedT.toString(),
      skips: state.depth.skips,
      lastSkipReason: state.depth.lastSkipReason,
      lastAddBlock: str(state.depth.lastAddBlock),
    },
    graduation: g ? { block: g.block.toString(), caller: g.caller.toLowerCase(), poolShare: g.poolShare.toString(), tokenDustBurned: g.tokenDustBurned.toString(), reward: g.reward.toString(), rewardClaimed: state.rewardClaimed.toString() } : null,
    vault: { collectionSize: str(state.vault.collectionSize), inside: str(state.vault.inside), outside: state.vault.inside === null ? null : (n > state.vault.inside ? n - state.vault.inside : 0n).toString(), escrow: str(state.vault.escrow), hidden: str(state.vault.hidden), tickets: str(state.vault.tickets), gateOpen: state.vault.gateOpen },
    draws: {
      placeholdersTaken: state.draws.placeholdersTaken.toString(),
      placeholdersHandedBack: state.draws.placeholdersHandedBack.toString(),
      opened: state.draws.opened,
      drawsRequested: state.draws.drawsRequested,
      drawsSettled: state.draws.drawsSettled,
      wordRequestedRound: str(state.draws.wordRequestedRound),
      wordStored: state.draws.wordStored,
      terminal: state.draws.terminal,
    },
    stream: { started: state.stream.started, claimed: state.stream.claimed.toString(), burned: state.stream.burned.toString(), funded: state.stream.funded.toString() },
    audit,
    reads,
    readsBlock: str(readsBlock),
    readsCurrent: readsBlock !== null && (lastEventBlock === undefined || readsBlock >= lastEventBlock),
    source: 'indexer',
  };
}

/** The feed card of a box: its own state and figure (BC-085), its own asOf, verified and stale (BC-094). */
export function feedCard(view: CoreBoxView): FeedCard {
  return {
    token: view.token,
    row: view.row,
    phase: view.phase,
    fillBps: view.curve.fillBps,
    retainedQ: view.curve.retainedQ,
    qPerT: view.verified === false ? null : view.price.qPerT,
    fdvQ: view.fdvQ,
    volumeQ: view.trading.volumeQ,
    burnedT: view.supply.burned,
    asOf: view.asOf,
    verified: view.verified,
    stale: view.stale,
  };
}

// ------------------------------------------------------------------------------------------------ parsing

export class CoreViewError extends Error {
  override readonly name = 'CoreViewError';
}

const UINT = /^(0|[1-9][0-9]{0,77})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PHASES = new Set<CorePhase>(['upcoming', 'window', 'bonding', 'graduating', 'graduated']);

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new CoreViewError(`${what} must be an object`);
  return v as Record<string, unknown>;
};
const uint = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !UINT.test(v)) throw new CoreViewError(`${what} must be a decimal string`);
  return v;
};
const uintOrNull = (v: unknown, what: string): string | null => (v === null ? null : uint(v, what));

function asOf(v: unknown): AsOf {
  const a = obj(v, 'asOf');
  if (typeof a.hash !== 'string' || !HASH.test(a.hash)) throw new CoreViewError('asOf.hash must be a block hash');
  if (a.tier !== 'head' && a.tier !== 'confirmed' && a.tier !== 'finalized') throw new CoreViewError('asOf.tier is unknown');
  return { block: uint(a.block, 'asOf.block'), hash: a.hash as `0x${string}`, timestamp: uint(a.timestamp, 'asOf.timestamp'), tier: a.tier };
}

function phase(v: unknown): CorePhase {
  if (typeof v !== 'string' || !PHASES.has(v as CorePhase)) throw new CoreViewError(`phase ${String(v)} is unknown`);
  return v as CorePhase;
}

export interface ParseOptions {
  readonly chainId: number;
  /** The manifest's version-1 registry (box 0's), for the row's isBox0. */
  readonly box0Registry: `0x${string}` | null;
  /** Registries the manifest names: a row of any other is refused. */
  readonly registries: readonly string[];
}

/** A row from an answer, re-decoded and re-checked (the spec against its hash, roles, Q) by the chain package. */
export function parseRow(json: unknown, options: ParseOptions): BoxRow {
  const row = boxRowFromJson(json, { chainId: options.chainId, box0Registry: options.box0Registry });
  if (!options.registries.some((r) => r.toLowerCase() === row.registry.toLowerCase())) throw new CoreViewError(`row of registry ${row.registry}, which the manifest does not name`);
  return row;
}

export interface ParsedCard {
  readonly row: BoxRow;
  readonly card: FeedCard;
}

/** The feed answer: every card checked; a malformed card is dropped and counted, never shown with guessed fields. */
export function parseFeedView(json: unknown, options: ParseOptions): { readonly cards: readonly ParsedCard[]; readonly dropped: number; readonly asOf: AsOf | null } {
  const v = obj(json, 'feed');
  if (v.schema !== CORE_FEED_SCHEMA) throw new CoreViewError(`schema must be ${CORE_FEED_SCHEMA}`);
  if (v.chainId !== options.chainId) throw new CoreViewError(`the feed is for chain ${String(v.chainId)}, not ${options.chainId}`);
  if (!Array.isArray(v.cards)) throw new CoreViewError('cards must be an array');
  const cards: ParsedCard[] = [];
  let dropped = 0;
  for (const raw of v.cards) {
    try {
      const c = obj(raw, 'card');
      const row = parseRow(c.row, options);
      const token = (row.contracts.token as string).toLowerCase();
      if (typeof c.token !== 'string' || c.token.toLowerCase() !== token) throw new CoreViewError('card token differs from its row');
      const fill = c.fillBps === null ? null : Number(c.fillBps);
      if (fill !== null && (!Number.isInteger(fill) || fill < 0 || fill > 10_000)) throw new CoreViewError('fillBps out of range');
      if (c.qPerT !== null && (typeof c.qPerT !== 'string' || !/^\d+(\.\d+)?$/.test(c.qPerT))) throw new CoreViewError('qPerT must be a decimal');
      cards.push({
        row,
        card: {
          token: token as `0x${string}`,
          row: c.row as BoxRowJson,
          phase: phase(c.phase),
          fillBps: fill,
          retainedQ: uintOrNull(c.retainedQ, 'retainedQ'),
          qPerT: c.qPerT as string | null,
          fdvQ: uintOrNull(c.fdvQ, 'fdvQ'),
          volumeQ: uint(c.volumeQ, 'volumeQ'),
          ...(c.burnedT === undefined ? {} : { burnedT: uint(c.burnedT, 'burnedT') }),
          asOf: asOf(c.asOf),
          verified: c.verified === null ? null : c.verified === true,
          stale: c.stale === true,
        },
      });
    } catch {
      dropped += 1;
    }
  }
  return { cards, dropped, asOf: v.asOf === null || v.asOf === undefined ? null : asOf(v.asOf) };
}

/** One box's snapshot answer, checked (the fields the site shows; the rest is kept as given). */
export function parseBoxView(json: unknown, options: ParseOptions): { readonly row: BoxRow; readonly view: CoreBoxView } {
  const v = obj(json, 'box');
  if (v.schema !== CORE_BOX_SCHEMA) throw new CoreViewError(`schema must be ${CORE_BOX_SCHEMA}`);
  if (v.chainId !== options.chainId) throw new CoreViewError(`the box is on chain ${String(v.chainId)}, not ${options.chainId}`);
  const row = parseRow(v.row, options);
  if (typeof v.token !== 'string' || v.token.toLowerCase() !== (row.contracts.token as string).toLowerCase()) throw new CoreViewError('token differs from its row');
  asOf(v.asOf);
  phase(v.phase);
  for (const key of ['supply', 'curve', 'fees', 'platform', 'pool', 'vault', 'draws', 'stream', 'trading', 'launch', 'blocks', 'times', 'price']) obj(v[key], key);
  const times = obj(v.times, 'times');
  if (uint(times.openAt, 'times.openAt') !== row.openAt.toString() || uint(times.windowEndsAt, 'times.windowEndsAt') !== row.windowEndsAt.toString()) throw new CoreViewError('times differ from the row');
  const supply = obj(v.supply, 'supply');
  uint(supply.total, 'supply.total');
  uint(supply.burned, 'supply.burned');
  const fees = obj(v.fees, 'fees');
  for (const [key, value] of Object.entries(fees)) if (key !== 'batches') uint(value, `fees.${key}`);
  // The parts of box 0's split no BatchSplit reports (an answer without them would under-count the Fees card).
  for (const key of ['tToStream', 'qDepthSettled', 'qFitReturned']) uint(fees[key], `fees.${key}`);
  const platform = obj(v.platform, 'platform');
  for (const key of ['credited', 'held', 'keptInEpoch']) uint(platform[key], `platform.${key}`);
  uint(obj(v.pool, 'pool').poolShare, 'pool.poolShare');
  if (typeof v.readsCurrent !== 'boolean') throw new CoreViewError('readsCurrent must be a boolean');
  uintOrNull(v.readsBlock ?? null, 'readsBlock');
  uintOrNull(v.fdvQ, 'fdvQ');
  return { row, view: v as unknown as CoreBoxView };
}

/** A wallet answer, checked; boxes are keyed by their token address (BC-089), never by ticker. */
export function parseWalletView(json: unknown, options: ParseOptions): { readonly boxes: readonly { readonly row: BoxRow; readonly box: WalletBox }[]; readonly asOf: AsOf | null } {
  const v = obj(json, 'wallet');
  if (v.schema !== CORE_WALLET_SCHEMA) throw new CoreViewError(`schema must be ${CORE_WALLET_SCHEMA}`);
  if (v.chainId !== options.chainId) throw new CoreViewError(`the wallet answer is for chain ${String(v.chainId)}`);
  if (typeof v.address !== 'string' || !ADDRESS.test(v.address)) throw new CoreViewError('address must be an address');
  if (!Array.isArray(v.boxes)) throw new CoreViewError('boxes must be an array');
  const boxes = v.boxes.map((raw) => {
    const b = obj(raw, 'wallet box');
    const row = parseRow(b.row, options);
    const list = (x: unknown, what: string): string[] => {
      if (!Array.isArray(x)) throw new CoreViewError(`${what} must be an array`);
      return x.map((id, i) => uint(id, `${what}[${i}]`));
    };
    return { row, box: { token: (row.contracts.token as string).toLowerCase() as `0x${string}`, row: b.row as BoxRowJson, t: uint(b.t, 't'), items: list(b.items, 'items'), tickets: list(b.tickets, 'tickets'), streamOwed: uintOrNull(b.streamOwed ?? null, 'streamOwed'), ...(b.draws === undefined ? {} : { draws: list(b.draws, 'draws') }) } };
  });
  return { boxes, asOf: v.asOf === null || v.asOf === undefined ? null : asOf(v.asOf) };
}


export interface ItemArtRef {
  readonly sha256: `0x${string}`;
  readonly cid: string;
}
export type ItemArtRole = 'image' | 'avatar' | 'model';
export interface CoreItemView {
  readonly schema: 'sh.core-item.v1';
  readonly chainId: number;
  readonly token: `0x${string}`;
  readonly id: string;
  readonly asOf: AsOf;
  readonly revealed: boolean;
  readonly traitsPacked: string | null;
  readonly traits: readonly { readonly trait_type: string; readonly value: string }[];
  readonly art: Readonly<Record<ItemArtRole, ItemArtRef | null>> | null;
}

/** The immutable spec's v1 table: packed byte i is the 1-based value of type i (zero means absent). */
function itemTraits(table: `0x${string}`, packed: bigint): CoreItemView['traits'] {
  const bytes = Uint8Array.from(table.slice(2).match(/../g) ?? [], (byte) => parseInt(byte, 16));
  let at = 0;
  const byte = () => { const value = bytes[at++]; if (value === undefined) throw new Error('short metadata table'); return value; };
  const text = (size: number) => { if (at + size > bytes.length) throw new Error('short metadata table'); const value = new TextDecoder().decode(bytes.slice(at, at + size)); at += size; return value; };
  if (byte() !== 1) throw new Error('metadata table version');
  text(byte() * 256 + byte());
  const count = byte();
  const traits: { trait_type: string; value: string }[] = [];
  for (let i = 0; i < count; i++) {
    const name = text(byte());
    const values = byte();
    const selected = Number((packed >> BigInt(i * 8)) & 255n);
    for (let v = 1; v <= values; v++) {
      const value = text(byte());
      if (selected === v) traits.push({ trait_type: name, value });
    }
  }
  return traits;
}

export function itemView(row: BoxRow, state: CoreBoxState, id: bigint, asOf: AsOf): CoreItemView | null {
  if (!row.contracts.collection || row.spec.version !== 1 || id < row.spec.firstId || id >= row.spec.firstId + BigInt(row.spec.n)) return null;
  const record = state.reveals.get(id);
  const ref = (sha256: `0x${string}`): ItemArtRef | null => /^0x0{64}$/i.test(sha256) ? null : { sha256, cid: rawCid(sha256) };
  return {
    schema: 'sh.core-item.v1', chainId: row.chainId, token: row.contracts.token as `0x${string}`, id: id.toString(), asOf,
    revealed: record !== undefined, traitsPacked: record?.traitsPacked.toString() ?? null,
    traits: record ? itemTraits(row.spec.metadataTable, record.traitsPacked) : [],
    art: record ? { image: ref(record.imageHash), avatar: ref(record.avatarHash), model: ref(record.modelHash) } : null,
  };
}


/** Parse only this row's reveal answer; never accept arbitrary URLs or the API's trait labels. */
export function parseItemView(json: unknown, row: BoxRow): CoreItemView {
  const value = obj(json, 'item');
  const id = uint(value.id, 'item id');
  if (value.schema !== 'sh.core-item.v1' || value.chainId !== row.chainId || typeof value.token !== 'string' || value.token.toLowerCase() !== row.contracts.token?.toLowerCase()
    || BigInt(id) < row.spec.firstId || BigInt(id) >= row.spec.firstId + BigInt(row.spec.n) || typeof value.revealed !== 'boolean') throw new CoreViewError('wrong item');
  const at = asOf(value.asOf);
  const base = { schema: 'sh.core-item.v1' as const, chainId: row.chainId, token: row.contracts.token as `0x${string}`, id, asOf: at };
  if (!value.revealed) return { ...base, revealed: false, traitsPacked: null, traits: [], art: null };
  const packed = uint(value.traitsPacked, 'traitsPacked');
  if (BigInt(packed) >= 1n << 128n) throw new CoreViewError('traitsPacked too large');
  const art = obj(value.art, 'item art');
  const ref = (role: ItemArtRole): ItemArtRef | null => {
    if (art[role] === null) return null;
    const entry = obj(art[role], role);
    if (typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256) || /^0x0{64}$/i.test(entry.sha256)) throw new CoreViewError('bad art hash');
    const sha256 = entry.sha256.toLowerCase() as `0x${string}`;
    const cid = rawCid(sha256);
    if (entry.cid !== cid) throw new CoreViewError('art CID mismatch');
    return { sha256, cid };
  };
  return { ...base, revealed: true, traitsPacked: packed, traits: itemTraits(row.spec.metadataTable, BigInt(packed)), art: { image: ref('image'), avatar: ref('avatar'), model: ref('model') } };
}
