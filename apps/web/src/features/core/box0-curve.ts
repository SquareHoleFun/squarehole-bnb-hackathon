/**
 * Box 0's live curve on its row page (SH-BOX0-LIVE-CURVE; founder, 2026-10-20: "The Misfits box does not have a token
 * curve? There was one in the past"). The sample launch page's "Bonding curve" card (fit-pair/CurvePanel.tsx) is reused
 * as it is; this file turns box 0's snapshot (`sh.core-box.v1`: the live gateway's answer, or a direct chain read at one
 * block, C19) into the card's two inputs: a market target built from the row alone (its curve range, raise, addresses
 * and token symbol; BC-086) and a live view (the one block's state and a freshness word).
 *
 * Trust, as on the sample page: the gateway is untrusted data. Its ETH in the curve, its fill and its price are
 * recomputed here from the √price it reports with the row's own curve; when they differ, the card is Unverified (no
 * price), never Live. "Its price matched a direct chain read" is said only when the gateway's audit read that same
 * √price from the pool at a block whose reads still hold. Freshness follows the page's own words: Unverified, Stale
 * (the gateway's word, a failed refresh or the clock), a direct read, else Live.
 *
 * Only box 0 (by registry and id), and only a curve the card can draw honestly: native ETH as Q (currency0, 18
 * decimals, "ETH per 1M"), T as currency1 (buys move the tick down) and a tick range the drawing's 32 steps divide.
 * Information only: nothing here can send anything.
 */
import type { BoxRow } from '@squarehole/chain';
import type { Address } from '@squarehole/domain';
import { curvePoint, curveRetainedQ, fillBps, priceQPerT, type CoreBoxView, type CurveShape } from '@squarehole/indexer/client';
import type { FitMarketTarget, Hex32 } from '../fit-pair/fit-target';
import type { Freshness, LiveView } from '../fit-pair/live-controller';
import type { LiveData, LiveState } from '../fit-pair/live-model';
import { LAUNCH_NAMES } from '../fit-pair/market-names';

/** The drawing's steps (curve-chart.ts: `curveDrawPoints(32, …)` needs them to divide the tick range). */
const DRAW_STEPS = 32;

export interface Box0Curve {
  readonly target: FitMarketTarget;
  readonly view: LiveView;
}

/** The row's curve as the card draws it, or null when the card cannot draw it honestly (see the file's note). */
export function rowCurveShape(row: BoxRow): CurveShape | null {
  const c = row.curve;
  const span = c.tickUpper - c.tickLower;
  if (row.tIsCurrency0 || row.qAsset.qClass !== 'NATIVE_ETH' || row.qAsset.decimals !== 18) return null;
  if (span <= 0 || span % DRAW_STEPS !== 0 || c.liquidity <= 0n || row.raise <= 0n) return null;
  return Object.freeze({
    sqrtPriceLowerX96: c.sqrtPriceLowerX96,
    sqrtPriceUpperX96: c.sqrtPriceUpperX96,
    tickLower: c.tickLower,
    tickUpper: c.tickUpper,
    liquidity: c.liquidity,
    // The whole range holds exactly the raise (BoxLayoutV1), and the band's 100% is the raise.
    raiseWei: row.raise,
    targetWei: row.raise,
    tokensDeposited: c.curveT,
  });
}

const role = (row: BoxRow, name: keyof BoxRow['contracts']): Address | null => (row.contracts[name] as Address | null) ?? null;

/** The card's market target from the row alone. Block-based launch fields are unused by the card (core v1 opens by time). */
function targetOf(row: BoxRow, curve: CurveShape): FitMarketTarget {
  return Object.freeze({
    kind: 'chain',
    chainId: row.chainId,
    // Not shown by the curve card; the page's header names the network.
    networkLabel: '',
    label: '',
    names: Object.freeze({ ...LAUNCH_NAMES, tokenName: row.spec.tokenName, tokenSymbol: row.spec.tokenSymbol }),
    token: role(row, 'token') as Address,
    poolId: row.poolId.toLowerCase() as Hex32,
    poolManager: row.poolManager as Address,
    hook: role(row, 'hook') as Address,
    launchRouter: role(row, 'launchRouter'),
    vault: role(row, 'vault'),
    placeholders: null,
    collection: role(row, 'collection'),
    genesis: null,
    collector: null,
    executor: role(row, 'executor'),
    randomnessSource: row.randomness as Address,
    deployBlock: row.creationBlock,
    openBlock: row.creationBlock,
    closeBlock: row.creationBlock,
    collectionSize: BigInt(row.spec.n),
    curve,
    curveName: 'misfits',
    indexerOrigin: null,
    rpcUrl: null,
  });
}

const big = (value: string | null): bigint | null => (value === null ? null : BigInt(value));

/** Why the gateway's curve figures disagree with its own √price (then Unverified), or null. */
function mismatchOf(view: CoreBoxView, curve: CurveShape, sqrt: bigint, expectedRetained: bigint, expectedFill: number): string | null {
  const served = big(view.curve.retainedQ);
  if (view.curve.raise !== curve.raiseWei.toString()) return 'raise';
  if (served !== expectedRetained || view.curve.fillBps !== expectedFill) return 'curve';
  if (view.price.qPerT !== priceQPerT(sqrt, { tIsCurrency0: false, qDecimals: 18, tDecimals: 18 })) return 'price';
  return null;
}

/** The block of a chain read the gateway's audit took of this same √price, if its reads still hold. */
function checkedBlockOf(view: CoreBoxView): bigint | null {
  if (view.verified !== true || !view.readsCurrent || view.readsBlock === null || view.reads === null) return null;
  return view.reads['pool.sqrtPriceX96'] === view.price.sqrtPriceX96 ? BigInt(view.readsBlock) : null;
}

const NO_DATA: Omit<LiveView, 'freshness'> = Object.freeze({ source: null, data: null, staleSinceBlock: null, reason: null, reorg: null, transport: 'none', checkedBlock: null, catchingUp: false });

/**
 * Box 0's curve card inputs from its snapshot, or null when the page shows no curve card (not box 0, or a curve the
 * card cannot draw). `stale` is the page's own word (the gateway's, a failed refresh, the clock).
 */
export function box0Curve(row: BoxRow, view: CoreBoxView, options: { readonly stale: boolean }): Box0Curve | null {
  if (!row.isBox0) return null;
  const curve = rowCurveShape(row);
  if (curve === null) return null;
  const target = targetOf(row, curve);
  const sqrt = big(view.price.sqrtPriceX96);
  if (sqrt === null || view.price.tick === null || view.price.qPerT === null) return { target, view: { ...NO_DATA, freshness: 'unavailable' } };
  const block = BigInt(view.asOf.block);
  const graduated = view.phase === 'graduated';
  // Tokens out of and left in the curve at √P (the card's "Sold"); ETH in the curve by the gateway's own rule (core-math):
  // the whole raise once the price is at or past the graduation edge, and after graduation (the pool's price moves on).
  const point = curvePoint(sqrt, curve);
  const range = { tIsCurrency0: false, raise: row.raise, sqrtPriceLowerX96: curve.sqrtPriceLowerX96, sqrtPriceUpperX96: curve.sqrtPriceUpperX96, liquidity: curve.liquidity };
  const retained = graduated ? row.raise : curveRetainedQ(range, sqrt);
  const fill = fillBps(retained, row.raise);
  const mismatch = mismatchOf(view, curve, sqrt, retained, fill);
  const state: LiveState = Object.freeze({
    block,
    sqrtPriceX96: sqrt,
    tick: view.price.tick,
    figures: Object.freeze({ retainedWei: retained, soldRaw: point.soldRaw, leftRaw: point.leftRaw, fillBps: fill, curveBps: fill, priceEthPerToken: view.price.qPerT }),
    // The card's phases: the curve (upcoming, the window, bonding and graduating: the curve's own words cover them,
    // the header carries the phase) or complete. Core v1 opens by the clock, so no block-based launch window here.
    phase: graduated ? 'migrated' : 'curve',
    burnedRaw: BigInt(view.supply.burned),
    taxWei: BigInt(view.launch.taxQ),
    swapCount: view.trading.swaps,
    completedBlock: big(view.blocks.closedAt),
    graduatesFromBlock: null,
    migratedBlock: big(view.blocks.migratedAt),
    liquidityOpensAtBlock: null,
  });
  const data: LiveData = Object.freeze({
    origin: view.source === 'direct' ? 'direct' : 'indexer',
    head: Object.freeze({ number: block, hash: view.asOf.hash, timestamp: BigInt(view.asOf.timestamp) }),
    confirmations: 0,
    finality: Object.freeze({ confirmedBlock: block, safeBlock: null, finalizedBlock: null }),
    state,
    confirmed: state,
    window: Object.freeze({ status: 'open', openBlock: block, closeBlock: block, nextBlock: block + 1n, blocksToOpen: 0n, blocksToClose: 0n, nextBlockTaxPips: 0, etaOpenUnix: null, etaCloseUnix: null }),
    trades: [],
    curveMismatch: mismatch,
    stateMismatch: null,
  });
  const unverified = view.verified === false || mismatch !== null;
  const freshness: Freshness = unverified ? 'unverified' : options.stale ? 'stale' : view.source === 'direct' ? 'direct' : 'live';
  return {
    target,
    view: Object.freeze({
      freshness,
      source: view.source === 'direct' ? 'direct' : 'poll',
      data,
      staleSinceBlock: freshness === 'stale' ? block : null,
      reason: mismatch !== null ? 'The service’s curve figures disagree with its own price, so the price is not shown.' : null,
      reorg: null,
      transport: view.source === 'direct' ? 'direct' : 'poll',
      checkedBlock: view.source === 'direct' ? null : checkedBlockOf(view),
      catchingUp: false,
    }),
  };
}
