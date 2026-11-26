import { boxCurve } from '../../../box-spec/src/layout-v2';
import { decodeFunctionData, encodeFunctionResult, encodeAbiParameters, keccak256, toHex, zeroAddress, type Hex } from 'viem';
import type { Eip1193Request } from '../write/eip1193';
import { prepareTradeSepolia } from './trade';
import { TRADE_ABI } from './abi';
import { getTickAtSqrtPrice } from '../../../box-spec/src/v4-math';
import { simulatePoolSwap } from './pool';

export const COORDINATOR = '0x0000000000000000000000000000000000000010';
export const TOKEN = '0xf000000000000000000000000000000000000020';
export const HOOK = '0x0000000000000000000000000000000000002AE0';
export const ROUTER = '0x0000000000000000000000000000000000000030';
export const POOL = '0x0000000000000000000000000000000000000040';
export const MANAGER = '0x0000000000000000000000000000000000000050';
export const COIN = '0x0000000000000000000000000000000000000060';
export const USER = '0x0000000000000000000000000000000000000070';
export const CODE = '0x6001600055';
export const LOCAL = { poolSwapTest: POOL, poolManager: MANAGER, poolSwapTestCodeHash: keccak256(CODE) } as const;

// A block-pinned RPC double, never a network client. Exported only for executor tests.
export function fixture(options: { phase?: number; p?: `0x${string}`; raise?: bigint; allowance?: bigint; output?: bigint; estimate?: bigint; spot?: bigint; storage?: Record<string, bigint>; taxPips?: bigint } = {}) {
  // `taxPips`: the launch router's tax at the current step, in millionths, for its `quote` view (none by default).
  const state = { chainId: 31337, manager: MANAGER as Hex, phase: 3, p: zeroAddress, raise: 10n ** 18n, allowance: 0n,
    output: 1_000_001n, estimate: 1_000_000n, timestamp: 1_000n, code: CODE as Hex, taxPips: 0n, ...options };
  const curve = boxCurve(state.raise, false);
  const spot = state.spot ?? (curve.sqrtPriceStartX96 + curve.sqrtPriceEndX96) / 2n;
  const poolId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [state.p, TOKEN, 10000, 60, HOOK]));
  const base = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));
  const mapSlot = (i: bigint, offset: bigint) => keccak256(encodeAbiParameters([{ type: 'int256' }, { type: 'uint256' }], [i, BigInt(base) + offset]));
  const storage: Record<string, bigint> = options.storage ?? {
    [base]: spot | (BigInt.asUintN(24, BigInt(getTickAtSqrtPrice(spot))) << 160n) | (10000n << 208n),
    [toHex(BigInt(base) + 3n, { size: 32 })]: curve.liquidity,
  };
  if (!options.storage) {
    for (let word = -58; word <= 57; word++) storage[mapSlot(BigInt(word), 5n)] = 0n;
    for (const [tick, net] of [[curve.tickLower, curve.liquidity], [curve.tickUpper, -curve.liquidity]] as const) {
      const compressed = tick / 60;
      const slot = mapSlot(BigInt(Math.floor(compressed / 256)), 5n);
      storage[slot] = (storage[slot] ?? 0n) | (1n << BigInt((compressed % 256 + 256) % 256));
      storage[mapSlot(BigInt(tick), 4n)] = curve.liquidity | (BigInt.asUintN(128, net) << 128n);
    }
  }
  const load = async (slot: Hex): Promise<bigint> => {
    const value = storage[slot];
    if (value === undefined) throw new Error(`unexpected storage slot ${slot}`);
    return value;
  };
  const calls: { method: string; params?: unknown }[] = [];
  const rpc: Eip1193Request = async request => {
    calls.push(request);
    if (request.method === 'eth_chainId') return `0x${state.chainId.toString(16)}`;
    if (request.method === 'eth_getCode') return state.code;
    if (request.method === 'eth_getBlockByNumber') return { number: '0x10', hash: `0x${'ab'.repeat(32)}`,
      timestamp: `0x${state.timestamp.toString(16)}`, baseFeePerGas: '0x1', transactions: [] };
    if (request.method === 'eth_estimateGas') return `0x${state.estimate.toString(16)}`;
    // SH-SEND-FEES: the sender's fee and funds reads (a 1-wei base fee above; the RPC suggests a 1-wei tip; 1,000 ETH).
    if (request.method === 'eth_maxPriorityFeePerGas') return '0x1';
    if (request.method === 'eth_getBalance') return `0x${(10n ** 21n).toString(16)}`;
    if (request.method !== 'eth_call') throw new Error(`unexpected ${request.method}`);
    const [call] = request.params as [{ to: string; data: Hex }];
    const decoded = decodeFunctionData({ abi: TRADE_ABI, data: call.data });
    const values: Record<string, unknown> = { token: TOKEN, q: state.p, hook: HOOK, launchRouter: ROUTER,
      coordinator: COORDINATOR, poolManager: state.manager, manager: state.manager, raise: state.raise,
      phase: state.phase, poolKey: { currency0: state.p, currency1: TOKEN, fee: 10000, tickSpacing: 60, hooks: HOOK },
      boxIdOf: [true, 0n], allowance: state.allowance, buy: state.output };
    if (decoded.functionName === 'extsload') values.extsload = toHex(await load(decoded.args[0]), { size: 32 });
    if (decoded.functionName === 'quote') {
      // The router's split of a window buy's input (BoxLaunchRouterV2 `quote`): the tax rounded up, the rest swapped.
      const [qIn] = decoded.args;
      const tax = (qIn * state.taxPips + 999_999n) / 1_000_000n;
      values.quote = [tax, qIn - tax];
    }
    if (decoded.functionName === 'swap') {
      const [, params] = decoded.args;
      const result = await simulatePoolSwap(load, base, params.zeroForOne, -params.amountSpecified, params.sqrtPriceLimitX96);
      const delta0 = params.zeroForOne ? -result.input : result.output;
      const delta1 = params.zeroForOne ? result.output : -result.input;
      values.swap = BigInt.asIntN(256, (BigInt.asUintN(128, delta0) << 128n) | BigInt.asUintN(128, delta1));
    }
    return encodeFunctionResult({ abi: TRADE_ABI, functionName: decoded.functionName, result: values[decoded.functionName] as never });
  };
  const prepare = (side: 'buy' | 'sell' = 'buy', amountIn = 10n ** 16n, toleranceBps?: bigint) => prepareTradeSepolia({
    rpc, chainId: state.chainId, coordinator: COORDINATOR, from: USER, side, amountIn,
    localDeployment: LOCAL, ...(toleranceBps === undefined ? {} : { toleranceBps }),
  });
  return { state, rpc, calls, prepare, base, storage };
}

export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('required fixture value missing');
  return value;
}

/** Hold the first chain read so tests can mutate caller-owned options while preparation is pending. */
export function deferredChainRpc(next: Eip1193Request) {
  let signal: (() => void) | undefined;
  let release: ((value: Hex) => void) | undefined;
  const started = new Promise<void>(resolve => { signal = resolve; });
  const response = new Promise<Hex>(resolve => { release = resolve; });
  let first = true;
  const rpc: Eip1193Request = request => {
    if (first && request.method === 'eth_chainId') {
      first = false;
      required(signal)();
      return response;
    }
    return next(request);
  };
  return { rpc, started, resolve: (value: Hex) => required(release)(value) };
}

export interface CapturedPoolState {
  readonly base: Hex;
  readonly storage: Record<string, string>;
  readonly raise: string;
  readonly amount: string;
  readonly spot: string;
  readonly input: string;
  readonly output: string;
  readonly afterPrice: string;
}

/** Relocate only mapping keys for the fixture's deployment addresses; the captured words stay untouched. */
export function capturedFixture(input: CapturedPoolState, buy: boolean, graduated = false) {
  const options = { raise: BigInt(input.raise), allowance: BigInt(input.amount), phase: graduated ? 5 : 3 };
  const base = fixture(options).base;
  const source = (slot: Hex) => BigInt(required(input.storage[slot]));
  const slot = (base: Hex, i: bigint, offset: bigint) => keccak256(encodeAbiParameters([{ type: 'int256' }, { type: 'uint256' }], [i, BigInt(base) + offset]));
  const storage: Record<string, bigint> = {
    [base]: source(input.base),
    [toHex(BigInt(base) + 3n, { size: 32 })]: source(toHex(BigInt(input.base) + 3n, { size: 32 })),
  };
  for (let word = -58; word <= 57; word++) {
    const bitmap = source(slot(input.base, BigInt(word), 5n));
    storage[slot(base, BigInt(word), 5n)] = bitmap;
    for (let bit = 0; bit < 256; bit++) if ((bitmap & (1n << BigInt(bit))) !== 0n) {
      const tick = BigInt((word * 256 + bit) * 60);
      storage[slot(base, tick, 4n)] = source(slot(input.base, tick, 4n));
    }
  }
  const f = fixture({ ...options, storage });
  const rpc: Eip1193Request = async r => {
    if (r.method === 'eth_call' && decodeFunctionData({ abi: TRADE_ABI, data: (r.params as [{ data: Hex }])[0].data }).functionName === 'swap') {
      // Independent executed Solidity result, not the TypeScript swap mirror.
      const amount0 = buy ? -BigInt(input.input) : BigInt(input.output);
      const amount1 = buy ? BigInt(input.output) : -BigInt(input.input);
      return encodeFunctionResult({ abi: TRADE_ABI, functionName: 'swap', result: BigInt.asIntN(256, (BigInt.asUintN(128, amount0) << 128n) | BigInt.asUintN(128, amount1)) });
    }
    return f.rpc(r);
  };
  return { ...f, rpc, prepare: () => prepareTradeSepolia({ rpc, chainId: 31337, coordinator: COORDINATOR, from: USER, side: buy ? 'buy' : 'sell', amountIn: BigInt(input.amount), localDeployment: LOCAL }) };
}
