import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, isAddress, keccak256, zeroAddress, type Abi, type ContractFunctionReturnType, type Address, type Hex } from 'viem';
import { MIN_SQRT_PRICE, MAX_SQRT_PRICE } from '@squarehole/box-spec/v4-math';
import { EIP7825_TX_GAS_CAP } from '../write/chains';
import { quantity, toQuantity, type Eip1193Request } from '../write/eip1193';
import { createChainReader, type RpcBlock } from '../write/rpc';
import { COIN_ABI, TRADE_ABI } from './abi';
import { coinDeployment, type CoinDeployment } from './coin-deployment';
import { checkHelperCode, copyFloor, DEFAULT_TOLERANCE_BPS, failureReason, MIN_TRADE_GAS, pressedLimit, priceLimit, readTradeContract, requireTrade, sameAddress, tradeGasLimit, TradeRefusedError, type TradeCall, type TradeFloor } from './trade';
import { simulatePoolSwap } from './pool';

export const MIN_FAUCET_GAS = 480_000n;
const DRIP_AMOUNT = 10n ** 18n;
export interface CoinOptions {
  readonly rpc: Eip1193Request;
  readonly chainId: number;
  readonly from: Address;
  /** The 31337 alpha manifest's coinDeployment. Never honored on Sepolia. */
  readonly localDeployment?: unknown;
}
export interface PairSwapOptions extends CoinOptions {
  readonly input: Address;
  readonly output: Address;
  readonly amountIn: bigint;
  readonly toleranceBps?: bigint;
  /** SH-ONE-PRESS-TRADE af1: the pressed quote's price limit (`TradeOptions.floor`); its minimum does not apply here. */
  readonly floor?: TradeFloor;
}
export interface FaucetState {
  readonly open: boolean;
  readonly admitted: boolean;
  readonly nextDripAt: bigint;
  readonly dailyRemaining: bigint;
}
export interface CoinState {
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly blockTimestamp: bigint;
  readonly faucet: FaucetState;
  readonly balances: readonly { readonly coin: Address; readonly balance: bigint }[];
}
export interface CoinPlan {
  readonly kind: 'faucet' | 'pair';
  readonly chainId: number;
  readonly from: Address;
  readonly deployment: CoinDeployment;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly blockTimestamp: bigint;
  readonly deadline: bigint;
  readonly call: TradeCall | null;
  readonly approvals: readonly TradeCall[];
  readonly revoke: TradeCall | null;
  readonly gasLimit: bigint;
  readonly reason: 'approval_required' | null;
  readonly expectedInput: bigint | null;
  readonly expectedOutput: bigint | null;
  readonly expectedSqrtPriceX96: bigint | null;
  /** A pair swap's amount in (null for the drip), its price limit, and no minimum (pool trades have none). */
  readonly amountIn: bigint | null;
  readonly priceLimitX96: bigint | null;
  readonly minimumOutput: null;
  readonly warning: string | null;
}
export type CoinPreparation = { readonly ok: true; readonly plan: CoinPlan }
  | { readonly ok: false; readonly reason: string; readonly nextDripAt?: bigint };
const prepared = new WeakSet<CoinPlan>();
export function assertPreparedCoinPlan(plan: CoinPlan): void { requireTrade(prepared.has(plan), 'unverified_plan'); }
function register(plan: CoinPlan): CoinPlan { Object.freeze(plan); prepared.add(plan); return plan; }
class CooldownRefused extends TradeRefusedError {
  constructor(readonly nextDripAt: bigint) { super('cooldown_active'); }
}
export function requireFaucet(state: FaucetState, timestamp: bigint): void {
  requireTrade(state.open || state.admitted, 'not_admitted');
  if (state.nextDripAt > timestamp) throw new CooldownRefused(state.nextDripAt);
  requireTrade(state.dailyRemaining >= DRIP_AMOUNT, 'daily_cap_reached');
}
async function result(fn: () => Promise<CoinPlan>): Promise<CoinPreparation> {
  try { return { ok: true, plan: await fn() }; }
  catch (error) {
    if (error instanceof CooldownRefused) return { ok: false, reason: error.reason, nextDripAt: error.nextDripAt };
    // The trade calls' own reading of a failure (trade.ts `failureReason`): a read the RPC did not answer is `rpc_failed`.
    return { ok: false, reason: failureReason(error) };
  }
}
export async function checkCoinCode(rpc: Eip1193Request, contract: CoinDeployment['teth'], at: bigint): Promise<void> {
  const code = await rpc({ method: 'eth_getCode', params: [contract.address, toQuantity(at)] });
  requireTrade(typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(code), 'coin_code_missing');
  requireTrade(contract.codeHash && keccak256(code as Hex).toLowerCase() === contract.codeHash.toLowerCase(), 'coin_code_hash_mismatch');
}
// Read caller-owned fields once, before any RPC await. context parses and freezes the nested record synchronously.
function snapshotOptions({ rpc, chainId, from, localDeployment }: CoinOptions): CoinOptions {
  return { rpc, chainId, from, localDeployment };
}
async function context(o: CoinOptions, blockNumber?: bigint) {
  const deployment = coinDeployment(o.chainId, o.localDeployment);
  requireTrade(typeof o.from === 'string' && isAddress(o.from) && o.from !== zeroAddress, 'invalid_address');
  const reader = createChainReader(o.rpc);
  requireTrade(await reader.chainId() === o.chainId, 'rpc_chain_mismatch');
  const block = await reader.getBlock(blockNumber ?? 'latest');
  requireTrade(block && (blockNumber === undefined || block.number === blockNumber), 'block_unavailable');
  await checkCoinCode(o.rpc, deployment.teth, block.number);
  return { deployment, reader, block };
}
export async function readFaucet(rpc: Eip1193Request, teth: Address, from: Address, at: bigint): Promise<FaucetState> {
  const reader = createChainReader(rpc);
  const read = async <N extends 'open' | 'admitted' | 'nextDripAt' | 'dailyRemaining'>(name: N): Promise<ContractFunctionReturnType<typeof COIN_ABI, 'view', N>> => {
    const data = encodeFunctionData({ abi: COIN_ABI as Abi, functionName: name as string, args: name === 'admitted' || name === 'nextDripAt' ? [from] : undefined });
    return decodeFunctionResult({ abi: COIN_ABI as Abi, functionName: name as string, data: await reader.call({ to: teth, data }, at) }) as ContractFunctionReturnType<typeof COIN_ABI, 'view', N>;
  };
  const [open, admitted, nextDripAt, dailyRemaining] = await Promise.all([read('open'), read('admitted'), read('nextDripAt'), read('dailyRemaining')]);
  return Object.freeze({ open, admitted, nextDripAt, dailyRemaining });
}
/** Explicit mined block required; a failed balance read is never substituted with zero. No wallet access. */
export async function readCoinStateSepolia(options: CoinOptions & { readonly blockNumber: bigint }): Promise<CoinState> {
  const o = snapshotOptions(options), { blockNumber } = options;
  requireTrade(typeof blockNumber === 'bigint' && blockNumber >= 0n, 'invalid_block');
  const { deployment, reader, block } = await context(o, blockNumber);
  const faucet = await readFaucet(o.rpc, deployment.teth.address, o.from, block.number);
  const balances = await Promise.all([deployment.teth.address, ...deployment.pairs.map(p => p.coin)].map(async coin => {
    const data = encodeFunctionData({ abi: COIN_ABI, functionName: 'balanceOf', args: [o.from] });
    return Object.freeze({ coin, balance: decodeFunctionResult({ abi: COIN_ABI, functionName: 'balanceOf', data: await reader.call({ to: coin, data }, block.number) }) });
  }));
  return Object.freeze({ blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp, faucet, balances: Object.freeze(balances) });
}
const metadata = (o: CoinOptions, deployment: CoinDeployment, block: RpcBlock) => ({ chainId: o.chainId, from: o.from, deployment,
  blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp, deadline: block.timestamp + 120n });
async function estimate(o: CoinOptions, call: TradeCall, at: bigint, faucet: boolean): Promise<bigint> {
  const n = quantity(await o.rpc({ method: 'eth_estimateGas', params: [{ ...call, value: toQuantity(call.value), from: o.from }, toQuantity(at)] }), 'eth_estimateGas');
  if (!faucet) return tradeGasLimit(n);
  requireTrade(n > 0n, 'invalid_gas_estimate');
  const buffered = (n * 120n + 99n) / 100n;
  const gas = buffered > MIN_FAUCET_GAS ? buffered : MIN_FAUCET_GAS;
  requireTrade(gas <= EIP7825_TX_GAS_CAP, 'gas_cap');
  return gas;
}
export function prepareFaucetSepolia(options: CoinOptions): Promise<CoinPreparation> {
  return result(async () => {
    const o = snapshotOptions(options);
    const { deployment, reader, block } = await context(o);
    requireFaucet(await readFaucet(o.rpc, deployment.teth.address, o.from, block.number), block.timestamp);
    const call = Object.freeze({ to: deployment.teth.address, data: encodeFunctionData({ abi: COIN_ABI, functionName: 'drip' }), value: 0n });
    await reader.call({ ...call, from: o.from, gas: EIP7825_TX_GAS_CAP }, block.number);
    return register({ ...metadata(o, deployment, block), kind: 'faucet', call, approvals: Object.freeze([]), revoke: null,
      gasLimit: await estimate(o, call, block.number, true), reason: null, expectedInput: null, expectedOutput: DRIP_AMOUNT, expectedSqrtPriceX96: null,
      amountIn: null, priceLimitX96: null, minimumOutput: null, warning: null });
  });
}
export function preparePairSwapSepolia(options: PairSwapOptions): Promise<CoinPreparation> {
  return result(async () => {
    const o = snapshotOptions(options), { amountIn, input, output, toleranceBps } = options;
    const floor = copyFloor(options.floor);
    requireTrade(typeof amountIn === 'bigint' && amountIn > 0n && amountIn < 1n << 127n, 'invalid_amount');
    const bps = toleranceBps ?? DEFAULT_TOLERANCE_BPS;
    requireTrade(typeof bps === 'bigint' && bps >= 10n && bps <= 2000n, 'invalid_tolerance');
    const { deployment, reader, block } = await context(o);
    requireTrade(typeof input === 'string' && typeof output === 'string' && deployment.pairs.some(p =>
      sameAddress(input, deployment.teth.address) && sameAddress(output, p.coin) || sameAddress(output, deployment.teth.address) && sameAddress(input, p.coin)), 'pair_not_allowed');
    await checkHelperCode(o.rpc, deployment, block.number);
    await checkCoinCode(o.rpc, deployment.pairHelper, block.number);
    requireTrade(sameAddress(await readTradeContract(o.rpc, deployment.pairHelper.address, 'manager', block.number), deployment.poolManager), 'helper_manager_mismatch');
    const zeroForOne = BigInt(input) < BigInt(output);
    const key = { currency0: zeroForOne ? input : output, currency1: zeroForOne ? output : input, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
    const poolId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
    const base = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));
    const load = async (slot: Hex) => BigInt(await readTradeContract(o.rpc, deployment.poolManager, 'extsload', block.number, [slot]));
    const spot = await load(base) & ((1n << 160n) - 1n);
    requireTrade(spot > MIN_SQRT_PRICE && spot < MAX_SQRT_PRICE, 'pair_unavailable');
    const balanceData = encodeFunctionData({ abi: COIN_ABI, functionName: 'balanceOf', args: [o.from] });
    const balance = decodeFunctionResult({ abi: COIN_ABI, functionName: 'balanceOf', data: await reader.call({ to: input, data: balanceData }, block.number) });
    requireTrade(balance >= amountIn, 'insufficient_balance');
    const allowance = await readTradeContract(o.rpc, input, 'allowance', block.number, [o.from, deployment.poolSwapTest]);
    const approval = (amount: bigint): TradeCall => Object.freeze({ to: input, value: 0n, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'approve', args: [deployment.poolSwapTest, amount] }) });
    const revoke = approval(0n), approvals = [approval(amountIn)];
    if (allowance !== 0n && allowance !== amountIn) approvals.unshift(revoke);
    // The pool's own quote, replayed from its storage at the plan block (pool.ts): checked against the helper's
    // simulation once the exact approval is in place; before it, the figures the one press shows (SH-ONE-PRESS-TRADE),
    // which the plan made again after the approval must stay within the person's tolerance of (use-sends.ts `press`).
    let quote = await simulatePoolSwap(load, base, zeroForOne, amountIn, zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n, 3000n);
    requireTrade(quote.input > 0n && quote.output > 0n, 'amount_too_small');
    let limit = priceLimit(quote.price, zeroForOne ? 'buy' : 'sell', bps, undefined, spot);
    // SH-ONE-PRESS-TRADE af1: never looser than the pressed quote's limit; when that one binds, the replay runs to it.
    const bound = pressedLimit(limit, floor?.sqrtPriceLimitX96 ?? null, zeroForOne, spot);
    if (bound !== limit) {
      limit = bound;
      quote = await simulatePoolSwap(load, base, zeroForOne, amountIn, limit, 3000n);
      requireTrade(quote.input > 0n && quote.output > 0n, 'price_limit_already_exceeded');
    }
    let call: TradeCall | null = null, expectedInput: bigint | null = quote.input, expectedOutput: bigint | null = quote.output, gasLimit = MIN_TRADE_GAS;
    const expectedSqrtPriceX96: bigint | null = quote.price;
    if (allowance === amountIn) {
      call = Object.freeze({ to: deployment.poolSwapTest, value: 0n, data: encodeFunctionData({ abi: TRADE_ABI, functionName: 'swap', args: [key,
        { zeroForOne, amountSpecified: -amountIn, sqrtPriceLimitX96: limit }, { takeClaims: false, settleUsingBurn: false }, '0x'] }) });
      const delta = decodeFunctionResult({ abi: TRADE_ABI, functionName: 'swap', data: await reader.call({ ...call, from: o.from, gas: EIP7825_TX_GAS_CAP }, block.number) });
      const d0 = BigInt.asIntN(128, delta >> 128n), d1 = BigInt.asIntN(128, delta);
      expectedInput = -(zeroForOne ? d0 : d1); expectedOutput = zeroForOne ? d1 : d0;
      requireTrade(expectedInput === quote.input && expectedOutput === quote.output, 'pool_simulation_mismatch');
      gasLimit = await estimate(o, call, block.number, false);
    }
    return register({ ...metadata(o, deployment, block), kind: 'pair', call, approvals: Object.freeze(approvals), revoke, gasLimit,
      reason: call ? null : 'approval_required', expectedInput, expectedOutput, expectedSqrtPriceX96, amountIn, priceLimitX96: limit, minimumOutput: null,
      warning: 'Pool trades have only a price limit and may fill partially. Revoke unused token allowance. There is no minimum output or on-chain deadline.' });
  });
}
