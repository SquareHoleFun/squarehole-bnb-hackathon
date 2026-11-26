/**
 * SH-255: the box page's picture shows what IS and what HAPPENED. Two figures are computed here from fields, each
 * tested against the six live boxes (core/v2/picture/live-picture.test.ts):
 *
 * - a side's 15 parts: the rule's parts of that side's collected fees (`fees.buyersP`, `fees.sellersP`), 10, 2 and 3
 *   fifteenths of the total, rounded down (ReceiverBooksV21.sol `_splitSource`, the same rule as fee-split.ts
 *   `splitFifteenths`). The receiver applies the rule fee by fee. On an ordinary box it carries each remainder into the
 *   next fee, and the parts of the total equal its parts exactly. On a box with an item rule, a holders choice or a
 *   seller shop it returns each remainder instead, and the parts of the total can exceed its parts by at most
 *   `m × floor((N × 14) / 15)` smallest units for a part of weight `m` over `N` split inputs (`overstatementBound`): a
 *   written limit until the index carries the receiver's parts per side (finding N26 on the line).
 * - the coins in the pool: the box's own position is the pool's whole liquidity; its amounts follow from its
 *   liquidity, its own two ends (ticks) and the pool's square-root price, as Uniswap v4 computes them, rounded down.
 *
 * Pure bigint arithmetic; the short form below never rounds up.
 */
import { getAmount0Delta, getAmount1Delta, getSqrtPriceAtTick } from '@squarehole/indexer/client';
import { formatTokenShort } from '../fit-pair/fit-format';
import { PICK_PARTS, POOL_PARTS, PARTS, SQUARE_HOLE_PARTS, splitFifteenths } from './fee-split';

/** A side's whole fee in its three parts: 10 to the side's pick, 2 to the box's pool, 3 to Square Hole. */
export interface FeeParts {
  readonly pick: bigint;
  readonly pool: bigint;
  readonly squareHole: bigint;
}

export function partsOfFee(fee: bigint): FeeParts {
  const split = splitFifteenths(fee, 0n);
  return { pick: split.pick, pool: split.pool, squareHole: split.fit + split.platform };
}

/** The parts the receiver books over `fees` split one by one, carrying each remainder into the next (an ordinary box). */
export function bookedWithCarry(fees: readonly bigint[]): FeeParts {
  let carry = 0n; let pick = 0n; let pool = 0n; let squareHole = 0n;
  for (const fee of fees) {
    const split = splitFifteenths(fee, carry);
    carry = split.carry; pick += split.pick; pool += split.pool; squareHole += split.fit + split.platform;
  }
  return { pick, pool, squareHole };
}

/** The same, each remainder returned instead of carried (a box with an item rule, a holders choice or a seller shop). */
export function bookedReturningRemainders(fees: readonly bigint[]): FeeParts {
  return fees.reduce<FeeParts>((sum, fee) => { const p = partsOfFee(fee); return { pick: sum.pick + p.pick, pool: sum.pool + p.pool, squareHole: sum.squareHole + p.squareHole }; }, { pick: 0n, pool: 0n, squareHole: 0n });
}

/** The most the parts of the total can exceed the booked parts of weight `parts`, over `inputs` split inputs. */
export const overstatementBound = (parts: bigint, inputs: bigint): bigint => parts * ((inputs * (PARTS - 1n)) / PARTS);
export const WEIGHTS = Object.freeze({ pick: PICK_PARTS, pool: POOL_PARTS, squareHole: SQUARE_HOLE_PARTS });

/** A position: its liquidity and its two ends. */
export interface PositionInput { readonly liquidity: bigint; readonly tickLower: number; readonly tickUpper: number }

/**
 * The coins a position holds at the pool's square-root price `sqrtPriceX96`, as the price coin's and the box token's
 * amounts; null without liquidity or price (a pool not open yet). Below its lower end it holds currency0 only, above
 * its upper end currency1 only (Uniswap v4's `getAmount0Delta` / `getAmount1Delta`, rounded down).
 */
export function poolCoinsOf(position: PositionInput | null | undefined, sqrtPriceX96: bigint | null | undefined, priceCoin: string, token: string): { readonly price: bigint; readonly token: bigint } | null {
  if (!position || !sqrtPriceX96 || position.liquidity <= 0n || sqrtPriceX96 <= 0n) return null;
  const a = getSqrtPriceAtTick(position.tickLower);
  const b = getSqrtPriceAtTick(position.tickUpper);
  const s = sqrtPriceX96;
  const l = position.liquidity;
  let amount0 = 0n; let amount1 = 0n;
  if (s <= a) amount0 = getAmount0Delta(a, b, l, false);
  else if (s >= b) amount1 = getAmount1Delta(a, b, l, false);
  else { amount0 = getAmount0Delta(s, b, l, false); amount1 = getAmount1Delta(a, s, l, false); }
  return order(priceCoin) < order(token) ? { price: amount0, token: amount1 } : { price: amount1, token: amount0 };
}
/** A currency's order in a v4 pool: the native coin (address 0) first, then by address. */
const order = (address: string): bigint => (/^0x0{40}$/i.test(address) ? 0n : BigInt(address));

/** What the two Safes were paid in one coin (`safePaid.fit` and `.platform`, keyed by lower-case address). */
export function squareHolePaidOf(paid: { readonly fit: Readonly<Record<string, bigint>>; readonly platform: Readonly<Record<string, bigint>> } | null | undefined, coin: string): bigint | null {
  if (!paid) return null;
  const key = coin.toLowerCase();
  return (paid.fit[key] ?? 0n) + (paid.platform[key] ?? 0n);
}

/** The longest figure the drawing prints in full; a longer one prints short ("1.23M"), its exact digits in the sheet. */
export const DRAWING_CHARS = 12;
/** `raw` short, the site's way for large amounts (K, M, B, T; formatTokenShort), rounded down, at any decimals. */
export function shortAmount(raw: bigint, decimals: number): string {
  const at18 = decimals <= 18 ? raw * 10n ** BigInt(18 - decimals) : raw / 10n ** BigInt(decimals - 18);
  return formatTokenShort(at18, '').trim();
}
