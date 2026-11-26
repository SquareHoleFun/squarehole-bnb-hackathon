/** Exact-input subset of pinned v4 Pool/SwapMath/TickBitmap/SqrtPriceMath. All state is block-pinned.
 * Tick indices are bounded integers; amounts, fees, liquidity and prices stay bigint.
 * The registered box hook returns zero swap deltas and no fee override. The final helper eth_call
 * independently checks the replay's delta, including hook gates, settlement and token transfers.
 */
import { encodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
import { Q96, MIN_TICK, MAX_TICK, getSqrtPriceAtTick, getTickAtSqrtPrice, getAmount0Delta, getAmount1Delta } from '@squarehole/box-spec/v4-math';

const U256 = (1n << 256n) - 1n;
const up = (n: bigint, d: bigint): bigint => (n + d - 1n) / d;
export interface PoolQuote { readonly price: bigint; readonly input: bigint; readonly output: bigint }

/** SwapMath.computeSwapStep, exact input only. Includes SqrtPriceMath's uint256 overflow fallback. */
export function swapStep(spot: bigint, target: bigint, liquidity: bigint, remaining: bigint, fee: bigint): PoolQuote {
  const buy = spot >= target;
  const available = remaining * (1_000_000n - fee) / 1_000_000n;
  const toTarget = buy ? getAmount0Delta(target, spot, liquidity, true) : getAmount1Delta(spot, target, liquidity, true);
  let price: bigint;
  let input: bigint;
  if (available >= toTarget) {
    price = target;
    input = toTarget + (fee === 1_000_000n ? 0n : up(toTarget * fee, 1_000_000n - fee));
  } else {
    if (liquidity === 0n) throw new Error('invalid pool liquidity');
    if (!buy) price = spot + available * Q96 / liquidity;
    else if (available === 0n) price = spot;
    else {
      const n = liquidity << 96n;
      const product = available * spot;
      price = product <= U256 && n + product <= U256
        ? up(n * spot, n + product) : up(n, n / spot + available);
    }
    input = remaining;
  }
  const output = buy ? getAmount1Delta(price, spot, liquidity, false) : getAmount0Delta(spot, price, liquidity, false);
  return { price, input, output };
}

export type PoolStorageRead = (slot: Hex) => Promise<bigint>;
const mappingSlot = (index: bigint, slot: bigint): Hex => keccak256(encodeAbiParameters([{ type: 'int256' }, { type: 'uint256' }], [index, slot]));

/** Replay all v4 word boundaries, including empty words, to preserve per-step rounding exactly. */
export async function simulatePoolSwap(read: PoolStorageRead, base: Hex, buy: boolean, amount: bigint, limit: bigint, expectedLpFee = 10000n): Promise<PoolQuote> {
  const cache = new Map<Hex, bigint>();
  const load = async (slot: Hex): Promise<bigint> => {
    const found = cache.get(slot);
    if (found !== undefined) return found;
    const value = await read(slot);
    cache.set(slot, value);
    return value;
  };
  const slot0 = await load(base);
  let price = slot0 & ((1n << 160n) - 1n);
  let tick = Number(BigInt.asIntN(24, slot0 >> 160n));
  let liquidity = (await load(toHex(BigInt(base) + 3n, { size: 32 }))) & ((1n << 128n) - 1n);
  const lpFee = (slot0 >> 208n) & 0xffffffn;
  const protocol = (slot0 >> (buy ? 184n : 196n)) & 0xfffn;
  if (lpFee !== expectedLpFee || protocol > 1000n || price <= 0n || (buy ? limit >= price : limit <= price)) throw new Error('invalid pool state');
  const fee = protocol + lpFee - protocol * lpFee / 1_000_000n;
  let remaining = amount;
  let output = 0n;
  // At spacing 60 the whole tick domain has < 30,000 initialized ticks. Bound hostile RPC work.
  for (let steps = 0; remaining > 0n && price !== limit; steps++) {
    if (steps >= 30_000) throw new Error('pool quote step limit');
    const compressed = Math.floor(tick / 60) + (buy ? 0 : 1);
    const word = Math.floor(compressed / 256);
    const bit = compressed - word * 256;
    const bitmap = await load(mappingSlot(BigInt(word), BigInt(base) + 5n));
    const masked = buy ? bitmap & ((1n << BigInt(bit + 1)) - 1n) : bitmap & (U256 ^ ((1n << BigInt(bit)) - 1n));
    let nextBit = buy ? 0 : 255;
    if (masked !== 0n) {
      nextBit = bit;
      while ((masked & (1n << BigInt(nextBit))) === 0n) nextBit += buy ? -1 : 1;
    }
    const nextTick = Math.max(MIN_TICK, Math.min(MAX_TICK, (word * 256 + nextBit) * 60));
    const nextPrice = getSqrtPriceAtTick(nextTick);
    const target = buy ? (nextPrice > limit ? nextPrice : limit) : (nextPrice < limit ? nextPrice : limit);
    const step = swapStep(price, target, liquidity, remaining, fee);
    remaining -= step.input;
    output += step.output;
    const previous = price;
    price = step.price;
    if (price === nextPrice) {
      if (masked !== 0n) {
        const packed = await load(mappingSlot(BigInt(nextTick), BigInt(base) + 4n));
        const net = BigInt.asIntN(128, packed >> 128n);
        liquidity += buy ? -net : net;
        if (liquidity < 0n || liquidity >= 1n << 128n) throw new Error('invalid pool liquidity');
      }
      tick = buy ? nextTick - 1 : nextTick;
    } else if (price !== previous) tick = getTickAtSqrtPrice(price);
  }
  return { price, input: amount - remaining, output };
}
