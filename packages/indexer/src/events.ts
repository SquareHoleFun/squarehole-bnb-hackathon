/**
 * The v2 events this service reads, as human-readable ABI (the signatures of FitPoolHook, FitFeeCollector,
 * FitBuybackBurner, LaunchTaxRouter, RouteRehearsalGenesis, MisfitsGenesis, FitTokenBase and the v4 PoolManager). The
 * recorded Sepolia fixtures (the route rehearsal and the full v2 deployment) check every topic against real logs
 * (`events.test.ts`, `sepolia-full.test.ts`).
 *
 * Traps (research report § 2, checked on the live bootstrap swap):
 * - `Swap` amounts are the SWAPPER's deltas despite the NatSpec: a buy (ETH in) has amount0 < 0 and amount1 > 0.
 * - Every swap also emits `ModifyLiquidity(Δ = 0, sender = hook)`: the fee collection, not a liquidity change.
 * - `Donate` cannot happen (the hook refuses it); seeing one is an anomaly worth flagging.
 */
import { decodeEventLog, parseAbi, toEventSelector, type Address, type Hex } from 'viem';

export const poolManagerEventsAbi = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  'event Donate(bytes32 indexed id, address indexed sender, uint256 amount0, uint256 amount1)',
]);

export const launchEventsAbi = parseAbi([
  // FitPoolHook
  'event PoolLaunched(bytes32 indexed poolId, int24 tickLower, int24 tickUpper, uint128 liquidity, uint160 sqrtPriceX96, uint256 fitDeposited)',
  'event PoolFeesRealised(bytes32 indexed poolId, uint256 ethFee, uint256 fitFee)',
  'event PoolFeeNotifyFailed(bytes32 indexed poolId, address indexed swapper, uint256 ethFee, uint256 fitFee)',
  // FitPoolHook since the graduation step (T16/T17): the completion latch and the migration to layout b'
  'event CurveCompleted(uint256 blockNumber, uint160 sqrtPriceX96)',
  'event CurveReopened(uint256 blockNumber, uint160 sqrtPriceX96)',
  'event Migrated(bytes32 indexed poolId, uint256 ethFromCurve, uint256 tokenFromCurve, uint128 bidLiquidity, uint128 sentinelLiquidity, uint128 askLiquidity, uint256 tokenPulled, uint256 ethDust)',
  // FitTokenBase (ERC-20)
  'event Transfer(address indexed from, address indexed to, uint256 amount)',
  // FitFeeCollector
  'event ExecutorFeesTagged(uint256 ethFee)',
  'event Flushed(uint256 ethToIntake, uint256 ethToBudget, uint256 fitBurned, uint256 fitWaiting)',
  // FitBuybackBurner / BuybackBurner
  'event FeesReceived(address indexed from, uint256 amount, uint256 toTreasury, uint256 toBudget)',
  'event BudgetFunded(address indexed from, uint256 amount)',
  'event TreasuryPaid(uint256 amount)',
  'event TreasuryPaymentDeferred(uint256 amount)',
  'event TokensBurned(uint256 bought, uint256 unsolicited)',
  // LaunchTaxRouter
  'event TaxedBuy(address indexed buyer, address indexed recipient, uint256 blockOffset, uint256 ethIn, uint256 tax, uint256 tokensOut)',
  'event Bootstrapped(address indexed recipient, uint256 ethIn, uint256 tokensOut)',
  'event Swept(address indexed treasury, uint256 amount)',
  // RouteRehearsalGenesis and MisfitsGenesis (the same LaunchWindowAnnounced)
  'event LaunchWindowAnnounced(address router, uint256 openBlock, uint256 closeBlock)',
  'event RehearsalGenesis(address token, address hook, address collector, address executor, address treasury, uint256 curveTokens, uint256 poolShare, uint256 bootstrapTokensBurned)',
  // MisfitsGenesis (the full v2 deployment): decoded by name only; the state follows the hook's and the token's events
  'event Genesis(address fit, address misfits, address vault, address hook, address collector, address executor, address platformWallet, uint256 curveFit, uint256 poolShare, uint256 bootstrapFitBurned)',
  'event GenesisCompleted(address placeholders, address executor)',
  'event Graduated(uint256 blockNumber)',
]);

export const TOPICS = Object.freeze({
  Initialize: toEventSelector(poolManagerEventsAbi[0]),
  ModifyLiquidity: toEventSelector(poolManagerEventsAbi[1]),
  Swap: toEventSelector(poolManagerEventsAbi[2]),
  Donate: toEventSelector(poolManagerEventsAbi[3]),
});

/** The PoolManager topics filtered by poolId (topic1) in the per-block `getLogs`. */
export const POOL_MANAGER_TOPIC0: readonly Hex[] = Object.freeze([TOPICS.Swap, TOPICS.ModifyLiquidity, TOPICS.Initialize, TOPICS.Donate]);

const launchTopic = (name: (typeof launchEventsAbi)[number]['name']): Hex => {
  const item = launchEventsAbi.find((entry) => entry.name === name);
  if (!item) throw new Error(`unknown launch event ${name}`);
  return toEventSelector(item);
};

export const LAUNCH_TOPICS = Object.freeze({
  PoolLaunched: launchTopic('PoolLaunched'),
  PoolFeesRealised: launchTopic('PoolFeesRealised'),
  PoolFeeNotifyFailed: launchTopic('PoolFeeNotifyFailed'),
  CurveCompleted: launchTopic('CurveCompleted'),
  CurveReopened: launchTopic('CurveReopened'),
  Migrated: launchTopic('Migrated'),
  Transfer: launchTopic('Transfer'),
  Flushed: launchTopic('Flushed'),
  TokensBurned: launchTopic('TokensBurned'),
  TaxedBuy: launchTopic('TaxedBuy'),
  Bootstrapped: launchTopic('Bootstrapped'),
  Swept: launchTopic('Swept'),
  LaunchWindowAnnounced: launchTopic('LaunchWindowAnnounced'),
});

/** topic0s of the launch contracts' events that change what the service shows (the getLogs topic filter). */
export const LAUNCH_TOPIC0: readonly Hex[] = Object.freeze(Object.values(LAUNCH_TOPICS));

/** The zero address as a 32-byte topic (a burn is Transfer(from, to = 0)). */
export const ZERO_TOPIC: Hex = `0x${'0'.repeat(64)}`;

/** A log as the RPC returns it (viem's `Log` narrowed to what decoding needs; bigint block numbers). */
export interface RawLog {
  readonly address: Address;
  readonly topics: readonly Hex[];
  readonly data: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly transactionIndex: number;
  readonly logIndex: number;
  readonly removed?: boolean;
}

export interface LogRef {
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly txIndex: number;
  readonly logIndex: number;
}

export type DecodedEvent =
  | { readonly kind: 'swap'; readonly ref: LogRef; readonly sender: Address; readonly amount0: bigint; readonly amount1: bigint; readonly sqrtPriceX96: bigint; readonly liquidity: bigint; readonly tick: number; readonly feePips: number }
  | { readonly kind: 'modify_liquidity'; readonly ref: LogRef; readonly sender: Address; readonly liquidityDelta: bigint; readonly tickLower: number; readonly tickUpper: number; readonly salt: Hex }
  | { readonly kind: 'initialize'; readonly ref: LogRef; readonly sqrtPriceX96: bigint; readonly tick: number }
  | { readonly kind: 'donate'; readonly ref: LogRef; readonly amount0: bigint; readonly amount1: bigint }
  | { readonly kind: 'pool_launched'; readonly ref: LogRef; readonly liquidity: bigint; readonly sqrtPriceX96: bigint; readonly tokensDeposited: bigint }
  | { readonly kind: 'fees_realised'; readonly ref: LogRef; readonly ethFee: bigint; readonly tokenFee: bigint }
  | { readonly kind: 'fee_notify_failed'; readonly ref: LogRef; readonly ethFee: bigint; readonly tokenFee: bigint }
  | { readonly kind: 'transfer'; readonly ref: LogRef; readonly from: Address; readonly to: Address; readonly amount: bigint }
  | { readonly kind: 'flushed'; readonly ref: LogRef; readonly ethToIntake: bigint; readonly ethToBudget: bigint; readonly tokensBurned: bigint; readonly tokensWaiting: bigint }
  | { readonly kind: 'executor_burn'; readonly ref: LogRef; readonly bought: bigint; readonly unsolicited: bigint }
  | { readonly kind: 'taxed_buy'; readonly ref: LogRef; readonly buyer: Address; readonly recipient: Address; readonly blockOffset: bigint; readonly ethIn: bigint; readonly tax: bigint; readonly tokensOut: bigint }
  | { readonly kind: 'bootstrapped'; readonly ref: LogRef; readonly recipient: Address; readonly ethIn: bigint; readonly tokensOut: bigint }
  | { readonly kind: 'swept'; readonly ref: LogRef; readonly amount: bigint }
  | { readonly kind: 'window_announced'; readonly ref: LogRef; readonly router: Address; readonly openBlock: bigint; readonly closeBlock: bigint }
  | { readonly kind: 'curve_completed'; readonly ref: LogRef; readonly completedBlock: bigint; readonly sqrtPriceX96: bigint }
  | { readonly kind: 'curve_reopened'; readonly ref: LogRef; readonly reopenedBlock: bigint; readonly sqrtPriceX96: bigint }
  | { readonly kind: 'migrated'; readonly ref: LogRef; readonly ethFromCurve: bigint; readonly tokenFromCurve: bigint; readonly bidLiquidity: bigint; readonly sentinelLiquidity: bigint; readonly askLiquidity: bigint; readonly tokenPulled: bigint; readonly ethDust: bigint }
  | { readonly kind: 'other'; readonly ref: LogRef; readonly address: Address; readonly name: string };

export interface DecodeTarget {
  readonly poolId: Hex;
  readonly poolManager: Address;
  readonly token: Address;
  readonly hook: Address;
  readonly collector: Address;
  readonly executor: Address;
  readonly launchRouter: Address;
  readonly genesis: Address;
}

function refOf(log: RawLog): LogRef {
  return { blockNumber: log.blockNumber, blockHash: log.blockHash, txHash: log.transactionHash, txIndex: log.transactionIndex, logIndex: log.logIndex };
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Decodes one log of the pool or of the launch contracts. Returns null for logs that are not ours (another pool, an
 * address outside the target) or that do not decode (an unknown event of one of our contracts is kept as `other`).
 * An event of the right name from the WRONG contract is refused (a token `Transfer` only counts from the token).
 */
export function decodePoolLog(log: RawLog, target: DecodeTarget): DecodedEvent | null {
  if (log.removed) return null;
  const ref = refOf(log);
  if (same(log.address, target.poolManager)) {
    if (!log.topics[1] || !same(log.topics[1], target.poolId)) return null;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: poolManagerEventsAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
    } catch {
      return null;
    }
    switch (decoded.eventName) {
      case 'Swap': {
        const a = decoded.args;
        return { kind: 'swap', ref, sender: a.sender, amount0: a.amount0, amount1: a.amount1, sqrtPriceX96: a.sqrtPriceX96, liquidity: a.liquidity, tick: a.tick, feePips: a.fee };
      }
      case 'ModifyLiquidity': {
        const a = decoded.args;
        return { kind: 'modify_liquidity', ref, sender: a.sender, liquidityDelta: a.liquidityDelta, tickLower: a.tickLower, tickUpper: a.tickUpper, salt: a.salt };
      }
      case 'Initialize':
        return { kind: 'initialize', ref, sqrtPriceX96: decoded.args.sqrtPriceX96, tick: decoded.args.tick };
      case 'Donate':
        return { kind: 'donate', ref, amount0: decoded.args.amount0, amount1: decoded.args.amount1 };
    }
  }
  const ours = [target.token, target.hook, target.collector, target.executor, target.launchRouter, target.genesis];
  if (!ours.some((address) => same(address, log.address))) return null;
  let decoded;
  try {
    decoded = decodeEventLog({ abi: launchEventsAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
  } catch {
    return { kind: 'other', ref, address: log.address, name: log.topics[0] ?? 'anonymous' };
  }
  const from = (address: Address): boolean => same(log.address, address);
  switch (decoded.eventName) {
    case 'PoolLaunched':
      if (!from(target.hook) || !same(decoded.args.poolId, target.poolId)) return null;
      return { kind: 'pool_launched', ref, liquidity: decoded.args.liquidity, sqrtPriceX96: decoded.args.sqrtPriceX96, tokensDeposited: decoded.args.fitDeposited };
    case 'PoolFeesRealised':
      if (!from(target.hook) || !same(decoded.args.poolId, target.poolId)) return null;
      return { kind: 'fees_realised', ref, ethFee: decoded.args.ethFee, tokenFee: decoded.args.fitFee };
    case 'PoolFeeNotifyFailed':
      if (!from(target.hook) || !same(decoded.args.poolId, target.poolId)) return null;
      return { kind: 'fee_notify_failed', ref, ethFee: decoded.args.ethFee, tokenFee: decoded.args.fitFee };
    case 'Transfer':
      if (!from(target.token)) return null;
      return { kind: 'transfer', ref, from: decoded.args.from, to: decoded.args.to, amount: decoded.args.amount };
    case 'Flushed':
      if (!from(target.collector)) return null;
      return { kind: 'flushed', ref, ethToIntake: decoded.args.ethToIntake, ethToBudget: decoded.args.ethToBudget, tokensBurned: decoded.args.fitBurned, tokensWaiting: decoded.args.fitWaiting };
    case 'TokensBurned':
      if (!from(target.executor)) return null;
      return { kind: 'executor_burn', ref, bought: decoded.args.bought, unsolicited: decoded.args.unsolicited };
    case 'TaxedBuy':
      if (!from(target.launchRouter)) return null;
      return { kind: 'taxed_buy', ref, buyer: decoded.args.buyer, recipient: decoded.args.recipient, blockOffset: decoded.args.blockOffset, ethIn: decoded.args.ethIn, tax: decoded.args.tax, tokensOut: decoded.args.tokensOut };
    case 'Bootstrapped':
      if (!from(target.launchRouter)) return null;
      return { kind: 'bootstrapped', ref, recipient: decoded.args.recipient, ethIn: decoded.args.ethIn, tokensOut: decoded.args.tokensOut };
    case 'Swept':
      if (!from(target.launchRouter)) return null;
      return { kind: 'swept', ref, amount: decoded.args.amount };
    case 'CurveCompleted':
      if (!from(target.hook)) return null;
      return { kind: 'curve_completed', ref, completedBlock: decoded.args.blockNumber, sqrtPriceX96: decoded.args.sqrtPriceX96 };
    case 'CurveReopened':
      if (!from(target.hook)) return null;
      return { kind: 'curve_reopened', ref, reopenedBlock: decoded.args.blockNumber, sqrtPriceX96: decoded.args.sqrtPriceX96 };
    case 'Migrated': {
      if (!from(target.hook) || !same(decoded.args.poolId, target.poolId)) return null;
      const a = decoded.args;
      return { kind: 'migrated', ref, ethFromCurve: a.ethFromCurve, tokenFromCurve: a.tokenFromCurve, bidLiquidity: a.bidLiquidity, sentinelLiquidity: a.sentinelLiquidity, askLiquidity: a.askLiquidity, tokenPulled: a.tokenPulled, ethDust: a.ethDust };
    }
    case 'LaunchWindowAnnounced':
      if (!from(target.genesis)) return null;
      return { kind: 'window_announced', ref, router: decoded.args.router, openBlock: decoded.args.openBlock, closeBlock: decoded.args.closeBlock };
    default:
      return { kind: 'other', ref, address: log.address, name: decoded.eventName };
  }
}

/**
 * The events the state depends on: everything decoded except unknown events and token transfers other than burns.
 * The bloom pre-check (bloom.ts) and the audit (pipeline.ts) are defined over exactly this set.
 */
export function isStateRelevant(event: DecodedEvent): boolean {
  if (event.kind === 'other') return false;
  if (event.kind === 'transfer') return event.to.toLowerCase() === '0x0000000000000000000000000000000000000000';
  return true;
}

/** Decodes and orders a block's logs (by log index; the two `getLogs` calls return disjoint sets). */
export function decodeBlockLogs(logs: readonly RawLog[], target: DecodeTarget): DecodedEvent[] {
  const seen = new Set<string>();
  const events: DecodedEvent[] = [];
  for (const log of [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))) {
    const key = `${log.blockHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const event = decodePoolLog(log, target);
    if (event) events.push(event);
  }
  return events;
}
