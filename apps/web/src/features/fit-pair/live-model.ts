/**
 * The live curve on the client (v2 T19; docs/design/realtime-chain-data.md § 6.2, § 7). Strict parsers for the
 * gateway's `sh.live-pool.v1` JSON (snapshot and SSE events), the typed model the page renders (bigint in logic), and
 * the pure reducer that folds events into it.
 *
 * Trust: the gateway is an optional accelerator (C19), so everything it sends is untrusted data (UI-10). Every field
 * is shape-checked; a frame for another chain or pool is refused; the curve figures (ETH raised, FIT sold, the band)
 * are recomputed here from the pool's √price with this market's own curve shape; and the launch window (which gates the
 * Uniswap link and marks the next block's tax) is computed here from the head and this market's open block, never
 * taken from the frame. When the gateway's figures or window differ from that recomputation, or its curve is not this
 * market's, the data is marked unverified instead of shown as live. The price itself is compared with a direct chain
 * read by the controller (live-controller.ts, the spot check).
 */
import {
  curvePoint,
  priceDecimal,
  SNAPSHOT_SCHEMA,
  tierOf,
  windowView,
  type CurveShape,
  type LaunchPhase,
  type Tier,
} from '@squarehole/indexer/client';
import { isAddress } from '@squarehole/domain';
import type { FitMarketTarget } from './fit-target';

export class LiveDataError extends Error {
  override readonly name = 'LiveDataError';
}

export interface CurveFigures {
  /** ETH principal the curve position holds, net of sells; fees excluded (the band's numerator). */
  readonly retainedWei: bigint;
  readonly soldRaw: bigint;
  readonly leftRaw: bigint;
  /** retained ÷ 4.206980085 ETH, 0..10,000 (the only drawing number). */
  readonly fillBps: number;
  /** retained ÷ the curve's full raise (the same number on the Misfits curve). */
  readonly curveBps: number;
  /** ETH per FIT at the pool price, truncated. */
  readonly priceEthPerToken: string;
}

export interface LiveState {
  readonly block: bigint;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  readonly figures: CurveFigures;
  readonly phase: LaunchPhase;
  /** FIT burned since issuance (initial supply − totalSupply); null when the source does not know. */
  readonly burnedRaw: bigint | null;
  /** Launch-window tax collected by the router (indexer only). */
  readonly taxWei: bigint | null;
  /** Pool fees paid so far on the buy side in ETH and the sell side in the token (indexer only; F77's Pool card). */
  readonly feesWei?: bigint | null;
  readonly feesTokenRaw?: bigint | null;
  readonly swapCount: number | null;
  readonly completedBlock: bigint | null;
  readonly graduatesFromBlock: bigint | null;
  readonly migratedBlock: bigint | null;
  readonly liquidityOpensAtBlock: bigint | null;
}

export interface LiveTrade {
  readonly id: string;
  readonly block: bigint;
  readonly blockHash: string;
  readonly timestamp: bigint;
  readonly txHash: string;
  readonly logIndex: number;
  readonly side: 'buy' | 'sell';
  readonly route: 'launch_router' | 'bootstrap' | 'other';
  /** ETH into the pool (buy, fee included) or out of it (sell). */
  readonly ethRaw: bigint;
  /** FIT out (buy) or in (sell, fee included). */
  readonly tokenRaw: bigint;
  readonly taxRaw: bigint;
  readonly trader: string | null;
  readonly priceAfterEthPerToken: string;
  readonly fillBpsAfter: number;
}

export interface LiveWindow {
  readonly status: 'before_open' | 'router_window' | 'open';
  readonly openBlock: bigint;
  readonly closeBlock: bigint;
  readonly nextBlock: bigint;
  readonly blocksToOpen: bigint;
  readonly blocksToClose: bigint;
  readonly nextBlockTaxPips: number;
  readonly etaOpenUnix: bigint | null;
  readonly etaCloseUnix: bigint | null;
}

export interface LiveHead {
  readonly number: bigint;
  readonly hash: string;
  readonly timestamp: bigint;
}

export interface LiveFinality {
  readonly confirmedBlock: bigint;
  readonly safeBlock: bigint | null;
  readonly finalizedBlock: bigint | null;
}

export interface LiveData {
  readonly origin: 'indexer' | 'direct';
  readonly head: LiveHead;
  readonly confirmations: number;
  readonly finality: LiveFinality;
  /** The newest block's state ("in block N · not final"). */
  readonly state: LiveState;
  /** The state `confirmations` deep; the same object as `state` when nothing differs. */
  readonly confirmed: LiveState;
  readonly window: LiveWindow;
  /** Newest first, at most `MAX_TRADES`. The direct chain read has none. */
  readonly trades: readonly LiveTrade[];
  /** The gateway follows another curve than this market (from its snapshot; kept until the next snapshot). */
  readonly curveMismatch: string | null;
  /** The newest state's served figures differ from the recomputation. */
  readonly stateMismatch: string | null;
}

/** Why this data does not match this market (then it is unverified, never live), or null. */
export function mismatchOf(data: Pick<LiveData, 'curveMismatch' | 'stateMismatch'>): string | null {
  return data.curveMismatch ?? data.stateMismatch;
}

export const MAX_TRADES = 25;

export type LiveEvent =
  | { readonly type: 'snapshot'; readonly data: LiveData }
  | { readonly type: 'block'; readonly head: LiveHead; readonly finality: LiveFinality; readonly state: LiveState; readonly confirmed: LiveState | null; readonly window: LiveWindow; readonly trades: readonly LiveTrade[]; readonly mismatch: string | null }
  | {
      readonly type: 'reorg';
      readonly fromBlock: bigint;
      readonly toBlock: bigint;
      readonly depth: number;
      readonly droppedTradeIds: readonly string[];
      readonly head: LiveHead;
      readonly finality: LiveFinality;
      readonly state: LiveState;
      readonly confirmed: LiveState | null;
      readonly window: LiveWindow;
      readonly mismatch: string | null;
    }
  | { readonly type: 'resync'; readonly reason: string }
  | { readonly type: 'traders'; readonly block: bigint; readonly traders: readonly { readonly id: string; readonly trader: string }[] }
  | { readonly type: 'finality'; readonly finality: LiveFinality }
  | { readonly type: 'status'; readonly indexer: 'live' | 'stale' | 'unverified'; readonly reason: string | null };

export const LIVE_EVENT_TYPES = Object.freeze(['snapshot', 'block', 'reorg', 'resync', 'traders', 'finality', 'status'] as const);
export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

// ------------------------------------------------------------------------------------------------ field checks

const UINT = /^(0|[1-9][0-9]{0,77})$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})(\.[0-9]{1,78})?$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const LAUNCH_PHASES: ReadonlySet<string> = new Set(['curve', 'completed', 'migrated']);
const WINDOW_STATUSES: ReadonlySet<string> = new Set(['before_open', 'router_window', 'open']);

type Json = Record<string, unknown>;

function obj(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new LiveDataError(`${what} must be an object`);
  return value as Json;
}

function uint(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !UINT.test(value)) throw new LiveDataError(`${what} must be a decimal integer string`);
  return BigInt(value);
}

function optionalUint(value: unknown, what: string): bigint | null {
  return value === null || value === undefined ? null : uint(value, what);
}

function int(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new LiveDataError(`${what} must be an integer in [${min}, ${max}]`);
  return value;
}

function decimal(value: unknown, what: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new LiveDataError(`${what} must be a decimal string`);
  return value;
}

function hash(value: unknown, what: string): string {
  if (typeof value !== 'string' || !HEX32.test(value)) throw new LiveDataError(`${what} must be a 32-byte hex value`);
  return value.toLowerCase();
}

function id(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || !/^[0-9A-Za-z:_-]+$/.test(value)) throw new LiveDataError(`${what} must be an id`);
  return value;
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, '').trim();
  return clean.length === 0 ? null : clean.slice(0, max);
}

function array(value: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new LiveDataError(`${what} must be a list of at most ${max}`);
  return value;
}

// ------------------------------------------------------------------------------------------------ curve figures

/** Every curve number at √P, recomputed with this market's shape (the same code the indexer runs). */
export function figuresAt(sqrtPriceX96: bigint, curve: CurveShape): CurveFigures {
  const point = curvePoint(sqrtPriceX96, curve);
  return Object.freeze({
    retainedWei: point.retainedWei,
    soldRaw: point.soldRaw,
    leftRaw: point.leftRaw,
    fillBps: point.fillBps,
    curveBps: point.curveBps,
    priceEthPerToken: priceDecimal(sqrtPriceX96),
  });
}

interface Parsed<T> {
  readonly value: T;
  readonly mismatch: string | null;
}

function parseState(raw: unknown, curve: CurveShape, what: string): Parsed<LiveState> {
  const s = obj(raw, what);
  const sqrtPriceX96 = uint(s.sqrtPriceX96, `${what}.sqrtPriceX96`);
  if (sqrtPriceX96 === 0n || sqrtPriceX96 >= 1n << 160n) throw new LiveDataError(`${what}.sqrtPriceX96 is outside the pool's range`);
  const phase = s.launchPhase ?? 'curve';
  if (typeof phase !== 'string' || !LAUNCH_PHASES.has(phase)) throw new LiveDataError(`${what}.launchPhase is unknown`);
  const figures = figuresAt(sqrtPriceX96, curve);
  const served = {
    retainedWei: uint(s.retainedWei, `${what}.retainedWei`),
    soldRaw: uint(s.soldRaw, `${what}.soldRaw`),
    fillBps: int(s.fillBps, `${what}.fillBps`, 0, 10_000),
    curveBps: int(s.curveBps, `${what}.curveBps`, 0, 10_000),
  };
  const differs =
    served.retainedWei !== figures.retainedWei || served.soldRaw !== figures.soldRaw || served.fillBps !== figures.fillBps || served.curveBps !== figures.curveBps;
  const state: LiveState = Object.freeze({
    block: uint(s.block, `${what}.block`),
    sqrtPriceX96,
    tick: int(s.tick, `${what}.tick`, -887_272, 887_272),
    figures,
    phase: phase as LaunchPhase,
    burnedRaw: uint(s.burnedRaw, `${what}.burnedRaw`),
    taxWei: uint(s.taxWei, `${what}.taxWei`),
    feesWei: optionalUint(s.feesWei, `${what}.feesWei`),
    feesTokenRaw: optionalUint(s.feesTokenRaw, `${what}.feesTokenRaw`),
    swapCount: int(s.swapCount, `${what}.swapCount`, 0, Number.MAX_SAFE_INTEGER),
    completedBlock: optionalUint(s.completedBlock, `${what}.completedBlock`),
    graduatesFromBlock: optionalUint(s.graduatesFromBlock, `${what}.graduatesFromBlock`),
    migratedBlock: optionalUint(s.migratedBlock, `${what}.migratedBlock`),
    liquidityOpensAtBlock: optionalUint(s.liquidityOpensAtBlock, `${what}.liquidityOpensAtBlock`),
  });
  return { value: state, mismatch: differs ? 'The live service’s curve figures do not match the pool price on this market’s curve.' : null };
}

function parseHead(raw: unknown): LiveHead {
  const h = obj(raw, 'head');
  return Object.freeze({ number: uint(h.number, 'head.number'), hash: hash(h.hash, 'head.hash'), timestamp: uint(h.timestamp, 'head.timestamp') });
}

function parseFinality(raw: unknown): LiveFinality {
  const f = obj(raw, 'finality');
  return Object.freeze({
    confirmedBlock: uint(f.confirmedBlock, 'finality.confirmedBlock'),
    safeBlock: optionalUint(f.safeBlock, 'finality.safeBlock'),
    finalizedBlock: optionalUint(f.finalizedBlock, 'finality.finalizedBlock'),
  });
}

/** The launch window at a head, as the indexer computes it (relative to the next block), from this market's blocks. */
export function liveWindowAt(head: { readonly number: bigint; readonly hash: string; readonly timestamp: bigint }, target: Pick<FitMarketTarget, 'openBlock' | 'closeBlock'>): LiveWindow {
  const view = windowView({ number: head.number, hash: head.hash as `0x${string}`, parentHash: head.hash as `0x${string}`, timestamp: head.timestamp }, target);
  return Object.freeze({
    status: view.status,
    openBlock: BigInt(view.openBlock),
    closeBlock: BigInt(view.closeBlock),
    nextBlock: BigInt(view.nextBlock),
    blocksToOpen: BigInt(view.blocksToOpen),
    blocksToClose: BigInt(view.blocksToClose),
    nextBlockTaxPips: view.nextBlockTaxPips,
    etaOpenUnix: view.etaOpenUnix === null ? null : BigInt(view.etaOpenUnix),
    etaCloseUnix: view.etaCloseUnix === null ? null : BigInt(view.etaCloseUnix),
  });
}

/**
 * The window shown is always this market's, computed from the head; the served one is only shape-checked and compared
 * (a gateway following another deployment, or a buggy one, would otherwise decide the Uniswap gate).
 */
function checkedWindow(raw: unknown, head: LiveHead, target: FitMarketTarget): Parsed<LiveWindow> {
  const served = parseWindow(raw);
  const own = liveWindowAt(head, target);
  const same =
    served.status === own.status &&
    served.openBlock === own.openBlock &&
    served.closeBlock === own.closeBlock &&
    served.nextBlock === own.nextBlock &&
    served.blocksToOpen === own.blocksToOpen &&
    served.blocksToClose === own.blocksToClose &&
    served.nextBlockTaxPips === own.nextBlockTaxPips;
  return {
    value: own,
    mismatch: same ? null : `The live service’s launch window (open block ${served.openBlock}, ${served.status.replace('_', ' ')}) is not this market’s (open block ${own.openBlock}, ${own.status.replace('_', ' ')}).`,
  };
}

function parseWindow(raw: unknown): LiveWindow {
  const w = obj(raw, 'window');
  if (typeof w.status !== 'string' || !WINDOW_STATUSES.has(w.status)) throw new LiveDataError('window.status is unknown');
  return Object.freeze({
    status: w.status as LiveWindow['status'],
    openBlock: uint(w.openBlock, 'window.openBlock'),
    closeBlock: uint(w.closeBlock, 'window.closeBlock'),
    nextBlock: uint(w.nextBlock, 'window.nextBlock'),
    blocksToOpen: uint(w.blocksToOpen, 'window.blocksToOpen'),
    blocksToClose: uint(w.blocksToClose, 'window.blocksToClose'),
    nextBlockTaxPips: int(w.nextBlockTaxPips, 'window.nextBlockTaxPips', 0, 1_000_000),
    etaOpenUnix: optionalUint(w.etaOpenUnix, 'window.etaOpenUnix'),
    etaCloseUnix: optionalUint(w.etaCloseUnix, 'window.etaCloseUnix'),
  });
}

const SIDES: ReadonlySet<string> = new Set(['buy', 'sell']);
const ROUTES: ReadonlySet<string> = new Set(['launch_router', 'bootstrap', 'other']);

function parseTrade(raw: unknown, index: number): LiveTrade {
  const what = `trades[${index}]`;
  const t = obj(raw, what);
  if (typeof t.side !== 'string' || !SIDES.has(t.side)) throw new LiveDataError(`${what}.side is unknown`);
  if (typeof t.route !== 'string' || !ROUTES.has(t.route)) throw new LiveDataError(`${what}.route is unknown`);
  const trader = t.trader === null || t.trader === undefined ? null : typeof t.trader === 'string' && isAddress(t.trader) ? t.trader : null;
  return Object.freeze({
    id: id(t.id, `${what}.id`),
    block: uint(t.block, `${what}.block`),
    blockHash: hash(t.blockHash, `${what}.blockHash`),
    timestamp: uint(t.timestamp, `${what}.timestamp`),
    txHash: hash(t.txHash, `${what}.txHash`),
    logIndex: int(t.logIndex, `${what}.logIndex`, 0, 99_999),
    side: t.side as LiveTrade['side'],
    route: t.route as LiveTrade['route'],
    ethRaw: uint(t.ethRaw, `${what}.ethRaw`),
    tokenRaw: uint(t.tokenRaw, `${what}.tokenRaw`),
    taxRaw: uint(t.taxRaw, `${what}.taxRaw`),
    trader,
    priceAfterEthPerToken: decimal(t.priceAfterEthPerToken, `${what}.priceAfterEthPerToken`),
    fillBpsAfter: int(t.fillBpsAfter, `${what}.fillBpsAfter`, 0, 10_000),
  });
}

function parseTrades(raw: unknown): LiveTrade[] {
  return array(raw, 'trades', 5_000).map(parseTrade);
}

function sameCurve(served: Json, curve: CurveShape): boolean {
  try {
    return (
      served.tickLower === curve.tickLower &&
      served.tickUpper === curve.tickUpper &&
      uint(served.liquidity, 'curve.liquidity') === curve.liquidity &&
      uint(served.raiseWei, 'curve.raiseWei') === curve.raiseWei &&
      uint(served.targetWei, 'curve.targetWei') === curve.targetWei
    );
  } catch {
    return false;
  }
}

const firstMismatch = (...values: (string | null)[]): string | null => values.find((value) => value !== null) ?? null;

/** Parses one event's JSON (`data:` of an SSE event, or the snapshot endpoint's body). Throws `LiveDataError`. */
export function parseLiveEvent(type: string, json: string, target: FitMarketTarget): LiveEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new LiveDataError(`The ${type} event is not JSON`);
  }
  const e = obj(raw, type);
  switch (type) {
    case 'snapshot': {
      if (e.schema !== SNAPSHOT_SCHEMA) throw new LiveDataError(`The snapshot schema is not ${SNAPSHOT_SCHEMA}`);
      if (e.chainId !== target.chainId || typeof e.poolId !== 'string' || e.poolId.toLowerCase() !== target.poolId.toLowerCase()) {
        throw new LiveDataError('The live service answered for another chain or pool');
      }
      const state = parseState(e.state, target.curve, 'state');
      const confirmed = e.confirmed === null ? null : parseState(e.confirmed, target.curve, 'confirmed');
      const curveMismatch = sameCurve(obj(e.curve, 'curve'), target.curve) ? null : 'The live service follows another curve than this FIT market.';
      const trades = parseTrades(e.trades).slice(0, MAX_TRADES);
      const head = parseHead(e.head);
      const window = checkedWindow(e.window, head, target);
      return {
        type,
        data: Object.freeze({
          origin: 'indexer',
          head,
          confirmations: int(e.confirmations, 'confirmations', 1, 64),
          finality: parseFinality(e.finality),
          state: state.value,
          confirmed: confirmed?.value ?? state.value,
          window: window.value,
          trades,
          curveMismatch,
          stateMismatch: firstMismatch(state.mismatch, confirmed?.mismatch ?? null, window.mismatch),
        }),
      };
    }
    case 'block': {
      const state = parseState(e.state, target.curve, 'state');
      const confirmed = e.confirmed === null ? null : parseState(e.confirmed, target.curve, 'confirmed');
      const head = parseHead(e.head);
      const window = checkedWindow(e.window, head, target);
      return {
        type,
        head,
        finality: parseFinality(e.finality),
        state: state.value,
        confirmed: confirmed?.value ?? null,
        window: window.value,
        trades: parseTrades(e.trades),
        mismatch: firstMismatch(state.mismatch, confirmed?.mismatch ?? null, window.mismatch),
      };
    }
    case 'reorg': {
      const state = parseState(e.state, target.curve, 'state');
      const confirmed = e.confirmed === null ? null : parseState(e.confirmed, target.curve, 'confirmed');
      const dropped = array(e.droppedTradeIds, 'droppedTradeIds', 5_000).map((value, index) => id(value, `droppedTradeIds[${index}]`));
      const head = parseHead(e.head);
      const window = checkedWindow(e.window, head, target);
      return {
        type,
        fromBlock: uint(e.fromBlock, 'fromBlock'),
        toBlock: uint(e.toBlock, 'toBlock'),
        depth: int(e.depth, 'depth', 0, 1_000_000),
        droppedTradeIds: dropped,
        head,
        finality: parseFinality(e.finality),
        state: state.value,
        confirmed: confirmed?.value ?? null,
        window: window.value,
        mismatch: firstMismatch(state.mismatch, confirmed?.mismatch ?? null, window.mismatch),
      };
    }
    case 'resync':
      return { type, reason: text(e.reason) ?? 'history was rewritten' };
    case 'traders': {
      const traders = array(e.traders, 'traders', 5_000).flatMap((value, index) => {
        const row = obj(value, `traders[${index}]`);
        return typeof row.trader === 'string' && isAddress(row.trader) ? [{ id: id(row.id, `traders[${index}].id`), trader: row.trader }] : [];
      });
      return { type, block: uint(e.block, 'block'), traders };
    }
    case 'finality':
      return { type, finality: parseFinality(e) };
    case 'status': {
      const indexer = e.indexer;
      if (indexer !== 'live' && indexer !== 'stale' && indexer !== 'unverified') throw new LiveDataError('status.indexer is unknown');
      return { type, indexer, reason: text(e.reason) };
    }
    default:
      throw new LiveDataError(`Unknown event type ${type}`);
  }
}

// ------------------------------------------------------------------------------------------------ reducer

function mergeTrades(current: readonly LiveTrade[], added: readonly LiveTrade[]): LiveTrade[] {
  const seen = new Set<string>();
  const merged: LiveTrade[] = [];
  // Newest first: the block's trades come in chain order.
  for (const trade of [...[...added].reverse(), ...current]) {
    if (seen.has(trade.id)) continue;
    seen.add(trade.id);
    merged.push(trade);
  }
  return merged.slice(0, MAX_TRADES);
}

/**
 * Folds one event into the data. `snapshot` replaces it; `block` and `reorg` carry the full state of their head;
 * `traders` and `finality` patch it; `status` and `resync` do not touch the data (the controller keeps them).
 * Returns null when an event needs data the client does not have yet (a block before any snapshot).
 */
export function applyLiveEvent(data: LiveData | null, event: LiveEvent): LiveData | null {
  switch (event.type) {
    case 'snapshot':
      return event.data;
    case 'block':
      if (data === null) return null;
      return Object.freeze({
        ...data,
        head: event.head,
        finality: event.finality,
        state: event.state,
        confirmed: event.confirmed ?? event.state,
        window: event.window,
        trades: mergeTrades(data.trades, event.trades),
        stateMismatch: event.mismatch,
      });
    case 'reorg': {
      if (data === null) return null;
      const dropped = new Set(event.droppedTradeIds);
      return Object.freeze({
        ...data,
        head: event.head,
        finality: event.finality,
        state: event.state,
        confirmed: event.confirmed ?? event.state,
        window: event.window,
        trades: data.trades.filter((trade) => !dropped.has(trade.id) && trade.block <= event.toBlock),
        stateMismatch: event.mismatch,
      });
    }
    case 'traders': {
      if (data === null) return null;
      const byId = new Map(event.traders.map((row) => [row.id, row.trader] as const));
      return Object.freeze({ ...data, trades: data.trades.map((trade) => (byId.has(trade.id) ? Object.freeze({ ...trade, trader: byId.get(trade.id) ?? trade.trader }) : trade)) });
    }
    case 'finality':
      return data === null ? null : Object.freeze({ ...data, finality: Object.freeze({ ...event.finality, confirmedBlock: data.finality.confirmedBlock }) });
    case 'status':
    case 'resync':
      return data;
  }
}

/** A row's settlement tier, recomputed from the head and the finality tags on every render (§ 4.4). */
export function tierOfBlock(block: bigint, data: Pick<LiveData, 'head' | 'confirmations' | 'finality'>): Tier {
  return tierOf(block, data.head.number, data.confirmations, data.finality.safeBlock, data.finality.finalizedBlock);
}
