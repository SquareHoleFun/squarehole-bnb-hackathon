import { boxCurve, type BoxCurve } from '@squarehole/box-spec/layout-v2';
import { isqrt, MIN_SQRT_PRICE, MAX_SQRT_PRICE } from '@squarehole/box-spec/v4-math';
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, isAddress, keccak256, zeroAddress, type Abi, type ContractFunctionReturnType, type Address, type Hex } from 'viem';
import { BNB_TESTNET_CHAIN_ID, TESTNET_CHAIN_ID } from '../config/networks';
import { EIP7825_TX_GAS_CAP } from '../write/chains';
import { quantity, toQuantity, type Eip1193Request } from '../write/eip1193';
import { createChainReader } from '../write/rpc';
import { TRADE_ABI } from './abi';
import { decodeTradeRevert, isReadFailure } from './revert';
import { simulatePoolSwap, type PoolQuote } from './pool';

export interface TradeDeployment {
  readonly poolSwapTest: Address;
  readonly poolManager: Address;
  readonly poolSwapTestCodeHash: Hex;
  /**
   * SH-258, BNB Chain testnet only: the v2 release's box registry from the build's verified manifest (Sepolia's is
   * pinned below; the local alpha has none). A box it does not list is refused.
   */
  readonly boxRegistry?: Address;
}

/**
 * SH-258: the chains the trade and coin calls run on: the local alpha (31337) and this build's test network (Sepolia,
 * or BNB Chain testnet under `SH_TESTNET=bnb`). BNB Chain testnet's addresses come from its own deployment record,
 * passed as `localDeployment`, never from a pin.
 */
export const isTradeChain = (chainId: unknown): chainId is number => chainId === 31337 || chainId === TESTNET_CHAIN_ID;
const BNB_TRADE = TESTNET_CHAIN_ID === BNB_TESTNET_CHAIN_ID;
export const SEPOLIA_TRADE_DEPLOYMENT: TradeDeployment = Object.freeze({
  poolSwapTest: '0x9B6b46e2c869aa39918Db7f52f5557FE577B6eEe',
  poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
  poolSwapTestCodeHash: '0xf8a61d4430eff587aa3c2fea734e3a5e54125a7e516fe1734b2c3c5f0cf1ac39',
});
// The v2 release in deployments/core-v1/11155111.json, never supplied by the caller.
const SEPOLIA_BOX_REGISTRY = '0x5D2866EF084d801aE734D3A2A6E4F7179898737C';
export const DEFAULT_TOLERANCE_BPS = 200n;
export const MIN_TRADE_GAS = 4_000_000n;
export type TradeSide = 'buy' | 'sell';
export interface TradeCall { readonly to: Address; readonly data: Hex; readonly value: bigint }
export interface TradeOptions {
  readonly rpc: Eip1193Request;
  readonly chainId: number;
  /** The site's verified box coordinator, never a user-entered pool key or router. */
  readonly coordinator: Address;
  readonly from: Address;
  readonly side: TradeSide;
  readonly amountIn: bigint;
  readonly toleranceBps?: bigint;
  /** Required on 31337 (the local deployment manifest) and on BNB Chain testnet (its record). Never honored on Sepolia. */
  readonly localDeployment?: TradeDeployment;
  /**
   * SH-ONE-PRESS-TRADE af1: the bounds of the quote the person pressed on (that plan's own `priceLimitX96` and
   * `minimumOutput`), for the plan made again after its approval. The plan's own bound is never looser than these: a
   * pool trade's price limit is the tighter of the two, a window buy's minimum the higher.
   */
  readonly floor?: TradeFloor;
}
/** The bounds of a plan the person pressed on (`TradeOptions.floor`); null where a bound does not apply. */
export interface TradeFloor {
  readonly sqrtPriceLimitX96: bigint | null;
  readonly minimumOutput: bigint | null;
}
export interface TradePlan {
  readonly chainId: number;
  readonly from: Address;
  readonly coordinator: Address;
  readonly token: Address;
  readonly p: Address;
  readonly hook: Address;
  readonly router: Address;
  readonly deployment: TradeDeployment & { readonly chainId: number };
  readonly phase: number;
  readonly side: TradeSide;
  readonly amountIn: bigint;
  readonly toleranceBps: bigint;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly blockTimestamp: bigint;
  readonly deadline: bigint;
  readonly call: TradeCall | null;
  /** Includes the exact approval even if already present; send only when reason is approval_required. */
  readonly approvals: readonly TradeCall[];
  readonly revoke: TradeCall | null;
  readonly expectedOutput: bigint | null;
  readonly expectedInput: bigint | null;
  /** Display only: this buy reaches the curve end, with input including any retained launch tax. Graduation is separate. */
  readonly raiseEnd: { readonly input: bigint } | null;
  readonly expectedSqrtPriceX96: bigint | null;
  /** A pool trade's price limit (the one its call carries, or would carry once approved); null for a window buy. */
  readonly priceLimitX96: bigint | null;
  /** A window buy's minimum output (its call's, or its figure's with the tolerance before the approval); else null. */
  readonly minimumOutput: bigint | null;
  readonly warning: string | null;
  readonly gasLimit: bigint;
  readonly reason: 'approval_required' | null;
}
export type TradePreparation = { readonly ok: true; readonly plan: TradePlan } | { readonly ok: false; readonly reason: string };

// Only plans actually read, validated and simulated here can cross the send boundary. Serialized or copied objects
// are deliberately not authority. Every nested value is frozen before the plan is handed to the caller.
const preparedPlans = new WeakSet<TradePlan>();
export class TradeRefusedError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'TradeRefusedError'; }
}
export function requireTrade(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new TradeRefusedError(reason);
}
export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const validAddress = (a: string, native = false): boolean => isAddress(a) && (native || a !== zeroAddress);
const validTolerance = (bps: bigint): boolean => typeof bps === 'bigint' && bps >= 10n && bps <= 2000n;

/** Buy caps P/T growth; sell caps P/T loss. Round towards the spot, never widening the tolerance. */
export function priceLimit(spot: bigint, side: TradeSide, bps = DEFAULT_TOLERANCE_BPS, curve?: BoxCurve, currentPrice = spot): bigint {
  requireTrade(validTolerance(bps), 'invalid_tolerance');
  requireTrade(spot > MIN_SQRT_PRICE && spot < MAX_SQRT_PRICE, 'invalid_price');
  const numerator = spot * spot * 10000n;
  const denominator = side === 'buy' ? 10000n + bps : 10000n - bps;
  let limit = isqrt(numerator / denominator);
  if (side === 'buy' && limit * limit * denominator < numerator) limit++;
  if (limit <= MIN_SQRT_PRICE) limit = MIN_SQRT_PRICE + 1n;
  if (limit >= MAX_SQRT_PRICE) limit = MAX_SQRT_PRICE - 1n;
  if (curve) {
    if (side === 'buy' && limit < curve.sqrtPriceEndX96) limit = curve.sqrtPriceEndX96;
    if (side === 'sell' && limit > curve.sqrtPriceStartX96) limit = curve.sqrtPriceStartX96;
  }
  requireTrade(side === 'buy' ? limit < currentPrice : limit > currentPrice, 'price_limit_unavailable');
  return limit;
}

export function tradeGasLimit(estimate: bigint): bigint {
  requireTrade(estimate > 0n, 'invalid_gas_estimate');
  const buffered = (estimate * 120n + 99n) / 100n;
  const limit = buffered > MIN_TRADE_GAS ? buffered : MIN_TRADE_GAS;
  requireTrade(limit <= EIP7825_TX_GAS_CAP, 'gas_cap');
  return limit;
}

type ReadName = 'boxIdOf' | 'token' | 'q' | 'hook' | 'launchRouter' | 'coordinator' | 'poolManager' | 'manager' | 'raise' | 'phase' | 'poolKey' | 'extsload' | 'allowance' | 'quote';
export async function readTradeContract<N extends ReadName>(rpc: Eip1193Request, to: Address, name: N, block: bigint | 'latest', args?: readonly unknown[]): Promise<ContractFunctionReturnType<typeof TRADE_ABI, 'view', N>> {
  const data = encodeFunctionData({ abi: TRADE_ABI as Abi, functionName: name as string, args });
  const result = await createChainReader(rpc).call({ to, data }, block);
  return decodeFunctionResult({ abi: TRADE_ABI as Abi, functionName: name as string, data: result }) as ContractFunctionReturnType<typeof TRADE_ABI, 'view', N>;
}

export async function checkHelperCode(rpc: Eip1193Request, deployment: TradeDeployment, block: bigint | 'latest'): Promise<void> {
  const code = await rpc({ method: 'eth_getCode', params: [deployment.poolSwapTest, block === 'latest' ? block : toQuantity(block)] });
  requireTrade(typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(code), 'helper_code_missing');
  requireTrade(keccak256(code as Hex).toLowerCase() === deployment.poolSwapTestCodeHash.toLowerCase(), 'helper_code_hash_mismatch');
  requireTrade(sameAddress(await readTradeContract(rpc, deployment.poolSwapTest, 'manager', block), deployment.poolManager), 'helper_manager_mismatch');
}

/**
 * Why a plan was not made: the plan's own refusal, the contract's decoded revert, `rpc_failed` for a read the RPC did
 * not answer (SH-ONE-PRESS-TRADE: a public RPC's node often lacks the block another just named, revert.ts
 * `isReadFailure`), else `read_or_simulation_failed`.
 */
export function failureReason(error: unknown): string {
  if (error instanceof TradeRefusedError) return error.reason;
  const decoded = decodeTradeRevert(error);
  if (decoded !== 'unknown_revert') return decoded;
  return isReadFailure(error) ? 'rpc_failed' : 'read_or_simulation_failed';
}

/** No wallet request. Rerun after each confirmed approval, so simulation uses the post-approval block. */
export async function prepareTradeSepolia(o: TradeOptions): Promise<TradePreparation> {
  try { return { ok: true, plan: await prepare(o) }; }
  catch (error) { return { ok: false, reason: failureReason(error) }; }
}

/** A caller's floor, copied before any await and checked: bigints or nulls only. */
export function copyFloor(floor: TradeFloor | undefined): TradeFloor | null {
  if (!floor) return null;
  const { sqrtPriceLimitX96, minimumOutput } = floor;
  requireTrade((sqrtPriceLimitX96 === null || typeof sqrtPriceLimitX96 === 'bigint') && (minimumOutput === null || typeof minimumOutput === 'bigint'), 'invalid_floor');
  return Object.freeze({ sqrtPriceLimitX96, minimumOutput });
}

/**
 * A pool trade's price limit with the pressed one (`floor`): the tighter of the two (closer to the spot). The pressed
 * limit must lie inside the price range and still ahead of the spot in the trade's direction; one the price has passed
 * already leaves no part of the trade within it.
 */
export function pressedLimit(limit: bigint, pressed: bigint | null, zeroForOne: boolean, spot: bigint): bigint {
  if (pressed === null) return limit;
  requireTrade(pressed > MIN_SQRT_PRICE && pressed < MAX_SQRT_PRICE, 'invalid_floor');
  requireTrade(zeroForOne ? pressed < spot : pressed > spot, 'price_limit_already_exceeded');
  return zeroForOne ? (pressed > limit ? pressed : limit) : (pressed < limit ? pressed : limit);
}

async function prepare(o: TradeOptions): Promise<TradePlan> {
  const { rpc, chainId, from, coordinator, side, amountIn, toleranceBps: requestedTolerance, localDeployment } = o;
  const floor = copyFloor(o.floor);
  requireTrade(isTradeChain(chainId), 'chain_not_allowed');
  requireTrade(validAddress(from) && validAddress(coordinator), 'invalid_address');
  requireTrade(side === 'buy' || side === 'sell', 'invalid_side');
  requireTrade(typeof amountIn === 'bigint' && amountIn > 0n && amountIn < (1n << 127n), 'invalid_amount');
  const toleranceBps = requestedTolerance ?? DEFAULT_TOLERANCE_BPS;
  requireTrade(validTolerance(toleranceBps), 'invalid_tolerance');
  const config = chainId === 11155111 ? SEPOLIA_TRADE_DEPLOYMENT : localDeployment;
  // Copy each deployment field before validating; retain the selected chain even for legacy local manifests.
  const deployment = config && Object.freeze({ chainId, poolSwapTest: config.poolSwapTest,
    poolManager: config.poolManager, poolSwapTestCodeHash: config.poolSwapTestCodeHash });
  requireTrade(deployment && validAddress(deployment.poolSwapTest) && validAddress(deployment.poolManager)
    && /^0x[0-9a-fA-F]{64}$/.test(deployment.poolSwapTestCodeHash), 'deployment_required');
  const reader = createChainReader(rpc);
  requireTrade(await reader.chainId() === chainId, 'rpc_chain_mismatch');
  const block = await reader.getBlock('latest');
  requireTrade(block, 'block_unavailable');
  const at = block.number;
  if (chainId === 11155111) {
    const [recorded] = await readTradeContract(rpc, SEPOLIA_BOX_REGISTRY, 'boxIdOf', at, [coordinator]);
    requireTrade(recorded, 'unregistered_box');
  } else if (BNB_TRADE && chainId === BNB_TESTNET_CHAIN_ID) {
    const registry = config?.boxRegistry;
    requireTrade(registry !== undefined && validAddress(registry), 'deployment_required');
    const [recorded] = await readTradeContract(rpc, registry, 'boxIdOf', at, [coordinator]);
    requireTrade(recorded, 'unregistered_box');
  }
  const [token, p, hook, router, manager, raise] = await Promise.all([
    readTradeContract(rpc, coordinator, 'token', at), readTradeContract(rpc, coordinator, 'q', at),
    readTradeContract(rpc, coordinator, 'hook', at), readTradeContract(rpc, coordinator, 'launchRouter', at),
    readTradeContract(rpc, coordinator, 'poolManager', at), readTradeContract(rpc, coordinator, 'raise', at),
  ]);
  requireTrade([token, hook, router].every(a => validAddress(a)) && validAddress(p, true), 'invalid_box_wiring');
  requireTrade(new Set([coordinator, token, hook, router, deployment.poolSwapTest, manager, p].map(a => a.toLowerCase())).size === 7, 'invalid_box_wiring');
  requireTrade(sameAddress(manager, deployment.poolManager) && BigInt(p) < BigInt(token), 'invalid_box_wiring');
  for (const target of [hook, router]) {
    const [c, t, q, pm] = await Promise.all((['coordinator', 'token', 'q', 'poolManager'] as const).map(name => readTradeContract(rpc, target, name, at)));
    requireTrade(c && t && q && pm && sameAddress(c, coordinator) && sameAddress(t, token) && sameAddress(q, p) && sameAddress(pm, manager), 'invalid_box_wiring');
  }
  requireTrade(sameAddress(await readTradeContract(rpc, router, 'hook', at), hook), 'invalid_box_wiring');
  requireTrade(sameAddress(await readTradeContract(rpc, hook, 'launchRouter', at), router), 'invalid_box_wiring');
  const [key, phase] = await Promise.all([readTradeContract(rpc, hook, 'poolKey', at), readTradeContract(rpc, hook, 'phase', at)]);
  requireTrade(sameAddress(key.currency0, p) && sameAddress(key.currency1, token) && sameAddress(key.hooks, hook)
    && key.fee === 10000 && key.tickSpacing === 60, 'invalid_pool_key');
  requireTrade(phase === 2 || phase === 3 || phase === 5, ({ 1: 'upcoming', 4: 'curve_closed', 6: 'failed' } as Record<number, string>)[phase] ?? 'unknown_phase');
  const windowBuy = phase === 2 && side === 'buy';
  const spender = windowBuy ? router : deployment.poolSwapTest;
  if (!windowBuy) await checkHelperCode(rpc, deployment, at);
  const inputCoin = side === 'buy' ? p : token;
  const value = inputCoin === zeroAddress ? amountIn : 0n;
  const approval = (amount: bigint): TradeCall => Object.freeze({ to: inputCoin, value: 0n,
    data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'approve', args: [spender, amount] }) });
  const allowance = inputCoin === zeroAddress ? amountIn : await readTradeContract(rpc, inputCoin, 'allowance', at, [from, spender]);
  const approvals: TradeCall[] = inputCoin === zeroAddress ? [] : [approval(amountIn)];
  if (allowance !== 0n && allowance !== amountIn) approvals.unshift(approval(0n));
  const deadline = block.timestamp + 120n;
  let call: TradeCall | null = null;
  let gasLimit = MIN_TRADE_GAS;
  let expectedOutput: bigint | null = null;
  let expectedInput: bigint | null = null;
  let expectedSqrtPriceX96: bigint | null = null;
  let poolQuote: PoolQuote | null = null;
  let raiseEnd: TradePlan['raiseEnd'] = null;
  const poolId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));
  const readSlot = async (word: Hex) => BigInt(await readTradeContract(rpc, manager, 'extsload', at, [word]));
  let limit = 0n;
  if (windowBuy) {
    // The router stops at the curve end too. Replay its net input at this block; the buyer pays that input plus the
    // retained launch tax, not the full typed amount on a closing fill (BoxLaunchRouterV2.buy).
    const [tax, swapIn] = await readTradeContract(rpc, router, 'quote', at, [amountIn]);
    requireTrade(swapIn > 0n, 'amount_too_small');
    const end = boxCurve(raise, false).sqrtPriceEndX96;
    const preview = await simulatePoolSwap(readSlot, slot, true, swapIn, end);
    requireTrade(preview.output > 0n, 'amount_too_small');
    expectedOutput = preview.output;
    if (preview.price === end) {
      let input = amountIn;
      if (preview.input < swapIn) {
        // quote(1 million raw units) gives the exact current pips, without inferring a rate from a rounded tax amount.
        const pips = 1_000_000n;
        const [rate] = await readTradeContract(rpc, router, 'quote', at, [pips]);
        const kept = (preview.input * rate + (pips - rate) - 1n) / (pips - rate);
        input = preview.input + (kept < tax ? kept : tax);
      }
      raiseEnd = Object.freeze({ input });
    }
  } else {
    // The pool's own quote, replayed from its storage at the plan block (pool.ts), and its price limit: checked against
    // the helper's simulation below once the exact approval is in place, and before it the figure the person sees.
    const spot = (await readSlot(slot)) & ((1n << 160n) - 1n);
    const curve = phase === 5 ? undefined : boxCurve(raise, false);
    const end = side === 'buy' ? curve?.sqrtPriceEndX96 ?? MIN_SQRT_PRICE + 1n : curve?.sqrtPriceStartX96 ?? MAX_SQRT_PRICE - 1n;
    requireTrade(side === 'buy' ? end < spot : end > spot, 'price_limit_unavailable');
    poolQuote = await simulatePoolSwap(readSlot, slot, side === 'buy', amountIn, end);
    limit = priceLimit(poolQuote.price, side, toleranceBps, curve, spot);
    // SH-ONE-PRESS-TRADE af1: never looser than the limit of the quote the person pressed on. When that limit is the
    // tighter one, the replay runs to it, so the figures (a part fill, if it binds) are the call's own.
    const bound = pressedLimit(limit, floor?.sqrtPriceLimitX96 ?? null, side === 'buy', spot);
    if (bound !== limit) {
      limit = bound;
      poolQuote = await simulatePoolSwap(readSlot, slot, side === 'buy', amountIn, limit);
      requireTrade(poolQuote.input > 0n && poolQuote.output > 0n, 'price_limit_already_exceeded');
    }
    expectedSqrtPriceX96 = poolQuote.price;
    if (side === 'buy' && curve !== undefined && poolQuote.price === curve.sqrtPriceEndX96) raiseEnd = Object.freeze({ input: poolQuote.input });
  }
  let minimumOutput: bigint | null = null;
  // A window buy's minimum: its figure less the tolerance, rounded up; never below the pressed quote's (af1).
  const minimumOf = (output: bigint): bigint => {
    const own = (output * (10000n - toleranceBps) + 9999n) / 10000n;
    const pressed = floor?.minimumOutput ?? null;
    return pressed !== null && pressed > own ? pressed : own;
  };
  if (allowance !== amountIn) {
    // SH-ONE-PRESS-TRADE: the figures before the exact approval, which the one press that approves and then trades
    // shows (use-sends.ts `press`); the plan made again after the approval simulates the real call, and its trade is
    // sent only when it stays within the person's tolerance of these. A pool trade: the replay above. A window buy: the
    // router's own split of the input at this block (`quote`: its step's tax and what it swaps), and the replay of that
    // swap to the curve's end, the router's own price limit for every buy.
    if (poolQuote) {
      expectedInput = poolQuote.input;
      expectedOutput = poolQuote.output;
    } else {
      requireTrade(expectedOutput !== null, 'amount_too_small');
      minimumOutput = minimumOf(expectedOutput);
      requireTrade(minimumOutput > 0n, 'minimum_output_zero');
    }
  } else {
    let data: Hex;
    if (windowBuy) {
      const quoteData = encodeFunctionData({ abi: TRADE_ABI, functionName: 'buy', args: [amountIn, 1n, from, deadline] });
      const quoted = await reader.call({ to: router, data: quoteData, value, from, gas: EIP7825_TX_GAS_CAP }, at);
      const output = decodeFunctionResult({ abi: TRADE_ABI, functionName: 'buy', data: quoted });
      expectedOutput = output;
      const minOut = minimumOf(output);
      requireTrade(minOut > 0n, 'minimum_output_zero');
      // Below the pressed quote's minimum (af1): the router would revert; said before anything is sent.
      requireTrade(output >= minOut, 'insufficient_output');
      minimumOutput = minOut;
      data = encodeFunctionData({ abi: TRADE_ABI, functionName: 'buy', args: [amountIn, minOut, from, deadline] });
    } else {
      data = encodeFunctionData({ abi: TRADE_ABI, functionName: 'swap', args: [key,
        { zeroForOne: side === 'buy', amountSpecified: -amountIn, sqrtPriceLimitX96: limit },
        { takeClaims: false, settleUsingBurn: false }, '0x'] });
    }
    call = Object.freeze({ to: spender, data, value });
    const simulated = await reader.call({ ...call, from, gas: EIP7825_TX_GAS_CAP }, at);
    if (poolQuote) {
      const delta = decodeFunctionResult({ abi: TRADE_ABI, functionName: 'swap', data: simulated });
      const amount0 = BigInt.asIntN(128, delta >> 128n);
      const amount1 = BigInt.asIntN(128, delta);
      expectedInput = -(side === 'buy' ? amount0 : amount1);
      expectedOutput = side === 'buy' ? amount1 : amount0;
      requireTrade(expectedInput === poolQuote.input && expectedOutput === poolQuote.output, 'pool_simulation_mismatch');
    } else {
      requireTrade(decodeFunctionResult({ abi: TRADE_ABI, functionName: 'buy', data: simulated }) === expectedOutput, 'router_simulation_mismatch');
    }
    // EIP-1474 clients supporting the block argument estimate the same state we simulated.
    // Fail closed if unsupported; do not silently estimate a different/latest block.
    gasLimit = tradeGasLimit(quantity(await rpc({ method: 'eth_estimateGas', params: [
      { to: call.to, data: call.data, value: toQuantity(call.value), from }, toQuantity(at),
    ] }), 'eth_estimateGas'));
  }
  const plan: TradePlan = Object.freeze({ chainId, from, coordinator, token, p, hook, router, deployment,
    phase, side, amountIn, toleranceBps, blockNumber: at, blockHash: block.hash, blockTimestamp: block.timestamp, deadline,
    expectedOutput, expectedInput, raiseEnd, expectedSqrtPriceX96, priceLimitX96: windowBuy ? null : limit, minimumOutput,
    warning: windowBuy ? null : 'Pool trades have only a price limit and may fill partially if the price moves or the curve ends. Unspent native input is refunded; revoke unused token allowance. There is no on-chain deadline.',
    call, approvals: Object.freeze(approvals), revoke: inputCoin === zeroAddress ? null : approval(0n), gasLimit,
    reason: call === null ? 'approval_required' : null });
  preparedPlans.add(plan);
  return plan;
}

/** Internal send authority: public for the isolated guard.ts import, never an alternate send path. */
export function assertPreparedPlan(plan: TradePlan): void { requireTrade(preparedPlans.has(plan), 'unverified_plan'); }
