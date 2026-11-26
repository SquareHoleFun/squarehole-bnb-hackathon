/**
 * Synthetic but exact trades for tests: a swap on the one-position curve computed with the ported v4 math
 * (computeSwapStepExactIn, positionFeeFromSwap) and encoded as the logs the PoolManager, the hook and the launch
 * router emit, in their on-chain order (Swap → ModifyLiquidity Δ0 → PoolFeesRealised → TaxedBuy). The rehearsal pool
 * had no trade after the bootstrap buy when the fixture was recorded, so multi-trade paths come from here.
 */
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex } from 'viem';
import type { PoolTarget } from '../src/config';
import { launchEventsAbi, poolManagerEventsAbi, type RawLog } from '../src/events';
import type { BlockHeader } from '../src/model';
import { REHEARSAL_SHAPE } from '../src/shape';
import { computeSwapStepExactIn, positionFeeFromSwap, tickAtSqrtPrice } from '../src/v4-math';

export interface SynthSwap {
  readonly logs: RawLog[];
  readonly sqrtAfter: bigint;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly fee: bigint;
  readonly positionFee: bigint;
}

function dataOf(types: readonly { type: string }[], values: readonly unknown[]): Hex {
  return encodeAbiParameters(types as never, values as never);
}

/**
 * One exact-input swap at `sqrtBefore`. `buy` = ETH in (zeroForOne). The swap never crosses the range edge in these
 * tests (the caller keeps amounts small), so one step is the whole swap, as in Pool.swap for a single position.
 */
export function synthSwap(
  target: PoolTarget,
  header: BlockHeader,
  tx: Hex,
  firstLogIndex: number,
  sqrtBefore: bigint,
  buy: boolean,
  amountIn: bigint,
  options: { sender?: Address; tax?: bigint; buyer?: Address } = {},
): SynthSwap {
  const L = REHEARSAL_SHAPE.liquidity;
  const limit = buy ? REHEARSAL_SHAPE.sqrtPriceLowerX96 : REHEARSAL_SHAPE.sqrtPriceUpperX96;
  const step = computeSwapStepExactIn(sqrtBefore, limit, L, amountIn, BigInt(REHEARSAL_SHAPE.lpFeePips));
  if (step.sqrtPriceNextX96 === limit) throw new Error('synthetic swap reached the range edge');
  const positionFee = positionFeeFromSwap(step.feeAmount, L);
  const sender = options.sender ?? target.launchRouter;
  const amount0 = buy ? -(step.amountIn + step.feeAmount) : step.amountOut;
  const amount1 = buy ? step.amountOut : -(step.amountIn + step.feeAmount);
  const base = { blockNumber: header.number, blockHash: header.hash, transactionHash: tx, transactionIndex: 0 };
  const swapTopics = encodeEventTopics({ abi: poolManagerEventsAbi, eventName: 'Swap', args: { id: target.poolId, sender } }) as Hex[];
  const logs: RawLog[] = [
    {
      ...base,
      logIndex: firstLogIndex,
      address: target.poolManager,
      topics: swapTopics,
      data: dataOf(
        [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
        [amount0, amount1, step.sqrtPriceNextX96, L, tickAtSqrtPrice(step.sqrtPriceNextX96), REHEARSAL_SHAPE.lpFeePips],
      ),
    },
    {
      ...base,
      logIndex: firstLogIndex + 1,
      address: target.poolManager,
      topics: encodeEventTopics({ abi: poolManagerEventsAbi, eventName: 'ModifyLiquidity', args: { id: target.poolId, sender: target.hook } }) as Hex[],
      data: dataOf([{ type: 'int24' }, { type: 'int24' }, { type: 'int256' }, { type: 'bytes32' }], [REHEARSAL_SHAPE.tickLower, REHEARSAL_SHAPE.tickUpper, 0n, `0x${'0'.repeat(64)}`]),
    },
    {
      ...base,
      logIndex: firstLogIndex + 2,
      address: target.hook,
      topics: encodeEventTopics({ abi: launchEventsAbi, eventName: 'PoolFeesRealised', args: { poolId: target.poolId } }) as Hex[],
      data: dataOf([{ type: 'uint256' }, { type: 'uint256' }], [buy ? positionFee : 0n, buy ? 0n : positionFee]),
    },
  ];
  if (options.tax !== undefined) {
    const buyer = options.buyer ?? '0x000000000000000000000000000000000000b0b0';
    logs.push({
      ...base,
      logIndex: firstLogIndex + 3,
      address: target.launchRouter,
      topics: encodeEventTopics({ abi: launchEventsAbi, eventName: 'TaxedBuy', args: { buyer, recipient: buyer } }) as Hex[],
      data: dataOf([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [0n, amountIn + options.tax, options.tax, step.amountOut]),
    });
  }
  return { logs, sqrtAfter: step.sqrtPriceNextX96, amountIn: step.amountIn, amountOut: step.amountOut, fee: step.feeAmount, positionFee };
}

/** A token burn (Transfer to 0x0) from `from`. */
export function synthBurn(target: PoolTarget, header: BlockHeader, tx: Hex, logIndex: number, from: Address, amount: bigint): RawLog {
  return {
    blockNumber: header.number,
    blockHash: header.hash,
    transactionHash: tx,
    transactionIndex: 1,
    logIndex,
    address: target.token,
    topics: encodeEventTopics({ abi: launchEventsAbi, eventName: 'Transfer', args: { from, to: '0x0000000000000000000000000000000000000000' } }) as Hex[],
    data: dataOf([{ type: 'uint256' }], [amount]),
  };
}

export function txHash(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}` as Hex;
}
