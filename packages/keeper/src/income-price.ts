import { parseAbi, type Abi, type Address, type PublicClient } from 'viem';
import { coordinatorV2Abi } from './abi';
import { listingRegistryV2Abi } from '../../chain/src/core/v2/abi-v2';
import { listingRoute } from '../../burn-bot/src/listing-routes';
import { getSqrtPriceAtTick, Q96 } from '../../box-spec/src/v4-math';

/** Keeper valuation policy only; no swap, listing-admission or F111 limit changes. */
export const TOKEN_INCOME_WINDOW = 3600;
export const TOKEN_INCOME_MAX_AGE = 1800n;
export const TOKEN_INCOME_MIN_DEPTH_WEI = 10n ** 19n;
const U256 = (1n << 256n) - 1n;
const Q192 = Q96 * Q96;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const address = (a: unknown): a is Address => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && BigInt(a) !== 0n;
const requireThat: (ok: unknown) => asserts ok = ok => { if (!ok) throw new Error('token income route unavailable'); };

const factoryAbi = parseAbi(['function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)']);
const poolAbi = parseAbi([
  'function token0() view returns (address)', 'function token1() view returns (address)',
  'function fee() view returns (uint24)', 'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function observations(uint256) view returns (uint32,int56,uint160,bool)',
  'function observe(uint32[]) view returns (int56[],uint160[])',
]);

export interface IncomeBlock { readonly number: bigint; readonly timestamp: bigint }
export interface IncomePrice {
  readonly route: string;
  /** Floor in wei, after each pool fee; throws if the entire input exceeds the depth allowance. */
  quote(amount: bigint): bigint;
}
interface Hop { numerator: bigint; denominator: bigint; fee: bigint; reserve: bigint }
const output = (amount: bigint, hop: Hop) => amount * (1_000_000n - hop.fee) / 1_000_000n * hop.numerator / hop.denominator;

/** Fixed-block, full-window cumulative readings. slot0's spot price/tick are never used. */
export async function readIncomePrice(pub: PublicClient, coordinator: Address, q: Address,
  block: IncomeBlock, now: bigint): Promise<IncomePrice> {
  requireThat(block.timestamp <= now && now - block.timestamp <= TOKEN_INCOME_MAX_AGE);
  const read = <T>(target: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    pub.readContract({ address: target, abi, functionName, args, blockNumber: block.number } as never) as Promise<T>;
  const registry = await read<Address>(coordinator, coordinatorV2Abi, 'listingRegistry');
  requireThat(address(registry));
  const [listed, id] = await read<readonly [boolean, number]>(registry, listingRegistryV2Abi, 'newestListingOf', [q]);
  requireThat(listed && Number.isInteger(id) && id >= 0);
  const listing = await read<{ id: number; token: Address }>(registry, listingRegistryV2Abi, 'listing', [id]);
  requireThat(listing.id === id && address(listing.token) && same(listing.token, q));
  const weth = await read<Address>(registry, listingRegistryV2Abi, 'weth');
  const chainId = await pub.getChainId();
  requireThat(Number.isSafeInteger(chainId) && chainId > 0);
  const pin = listingRoute(BigInt(chainId), registry, id, q), pools = pin.pools;
  requireThat(address(weth) && same(pin.weth, weth));
  const seen = new Set([q.toLowerCase()]), usedPools = new Set<string>();
  const hops: Hop[] = [];
  let input = q;
  for (const [i, pool] of pools.entries()) {
    requireThat(address(pool) && !usedPools.has(pool.toLowerCase()));
    usedPools.add(pool.toLowerCase());
    const token0 = await read<Address>(pool, poolAbi, 'token0');
    const token1 = await read<Address>(pool, poolAbi, 'token1');
    requireThat(address(token0) && address(token1) && BigInt(token0) < BigInt(token1));
    const forward = same(input, token0);
    requireThat(forward || same(input, token1));
    const next = forward ? token1 : token0;
    requireThat(same(input, pin.path[i] ?? '') && same(next, pin.path[i + 1] ?? '') && !seen.has(next.toLowerCase()));
    seen.add(next.toLowerCase());
    const fee = await read<number>(pool, poolAbi, 'fee');
    requireThat(Number.isInteger(fee) && fee >= 0 && fee < 1_000_000 && String(fee) === pin.fees[i]);
    const canonicalPool = await read<Address>(pin.factory, factoryAbi, 'getPool', [token0, token1, fee]);
    requireThat(address(canonicalPool) && same(canonicalPool, pool));
    const liquidity = await read<bigint>(pool, poolAbi, 'liquidity');
    const slot = await read<readonly [bigint, number, number, number, number, number, boolean]>(pool, poolAbi, 'slot0');
    requireThat(slot[6] && slot[3] >= 2);
    const observation = await read<readonly [number | bigint, bigint, bigint, boolean]>(pool, poolAbi, 'observations', [BigInt(slot[2])]);
    // Uniswap timestamps wrap at uint32; tolerate wrap, never a future/stale observation.
    const age = BigInt.asUintN(32, block.timestamp - BigInt(observation[0]));
    requireThat(observation[3] && age <= TOKEN_INCOME_MAX_AGE);
    const [ticks, secondsPerLiquidity] = await read<readonly [readonly [bigint, bigint], readonly [bigint, bigint]]>(pool, poolAbi, 'observe', [[TOKEN_INCOME_WINDOW, 0]]);
    requireThat(ticks.length === 2 && secondsPerLiquidity.length === 2);
    const delta = BigInt.asIntN(56, ticks[1] - ticks[0]);
    const window = BigInt(TOKEN_INCOME_WINDOW);
    let tick = delta / window;
    // Round against the input direction: flooring an inverse price would overvalue P.
    if (forward && delta < 0n && delta % window !== 0n) tick--;
    if (!forward && delta > 0n && delta % window !== 0n) tick++;
    requireThat(tick >= -887272n && tick <= 887272n);
    // Only the bounded int24 tick enters Number; all monetary/price/liquidity math stays bigint.
    const sqrt = getSqrtPriceAtTick(Number(tick));
    const seconds = BigInt.asUintN(160, secondsPerLiquidity[1] - secondsPerLiquidity[0]);
    requireThat(seconds > 0n && liquidity > 0n && liquidity < 1n << 128n);
    // OracleLibrary's conservative harmonic liquidity (including uint160 wrap).
    const harmonic = window * ((1n << 160n) - 1n) / (seconds << 32n);
    const depth = liquidity < harmonic ? liquidity : harmonic;
    requireThat(depth > 0n && depth < 1n << 128n);
    hops.push({ numerator: forward ? (sqrt - 1n) ** 2n : Q192,
      denominator: forward ? Q192 : sqrt ** 2n, fee: BigInt(fee),
      reserve: forward ? depth * Q96 / sqrt : depth * (sqrt - 1n) / Q96 });
    input = next;
  }
  requireThat(same(input, weth));
  for (const [i, hop] of hops.entries()) {
    let depthWei = hop.reserve;
    for (const hop of hops.slice(i)) depthWei = output(depthWei, hop);
    requireThat(depthWei >= TOKEN_INCOME_MIN_DEPTH_WEI);
  }
  return {
    route: [String(chainId), registry, String(id), q, pin.factory, pin.routeId, pin.routeVersion, ...pools, ...pin.path, ...pin.fees, weth].join(':').toLowerCase(),
    quote(amount) {
      requireThat(typeof amount === 'bigint' && amount >= 0n && amount <= U256);
      for (const hop of hops) {
        // Whole 24h income is checked too: splitting receipts cannot bypass this allowance.
        requireThat(amount <= hop.reserve / 100n);
        amount = output(amount, hop);
        requireThat(amount <= U256);
      }
      return amount;
    },
  };
}
