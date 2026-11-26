// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {BoxSpecV1} from "../../box/BoxSpecV1.sol";

/// @title BoxLayoutV2
/// @notice The launch layout of core v2 boxes (CQ9-4 / F114 R28E); v1 remains pinned. The layout (launch pipeline v1 § 1, layout `CURVE_V1`, slice S1): the bonding curve's
/// ticks, prices, liquidity, curve T and pool share from the raise and the token order, and the graduated layout as a
/// parameter (`gradLayout`, L7 pending). For box 0's inputs (raise 4,206,980,085,000,000,000 wei, native ETH as
/// currency0) it returns exactly `FitLaunchShape`'s constants (BC-002). Mirrors: packages/box-spec/src/layout-v2.ts and
/// packages/contracts/script-py/launch_shape.py (shared vectors packages/box-spec/vectors/cases.v2.json, BC-003).
///
/// For previously overflowing P-first raises only, the centre uses a bounded lower Q96 root (see `centreTick`).
/// **The curve.** T has 1e27 raw units (`ISSUANCE`); about 80% go on the curve (`CURVE_SHARE_TARGET`), the rest is the
/// pool share. The curve spans `CURVE_SPAN_TICKS` (26,880 ticks, k = 1.0001^26,880 ≈ 14.70) at spacing 60, centred on
/// the price at which 80% of T buys exactly the raise: the centre is TickMath.getTickAtSqrtPrice(⌊√(price) · 2^96⌋)
/// rounded to the nearest multiple of 60 (ties up), where price = T per Q when Q is currency0 and Q per T when T is
/// currency0, in raw units (so Q's decimals enter only through the raw raise). For box 0: tick 190,643 → centre
/// 190,620 → ticks 177,180 … 204,060. The liquidity is the smallest L whose fully crossed range holds exactly the raise
/// in Q (rounded down, as a removal pays it), found by bisection; the curve T is what that position takes (rounded up,
/// as an add charges it). The curve starts at its cheapest-T edge, holding T only: the upper tick when Q is currency0
/// (a buy moves the tick down), the lower tick when T is currency0 (a buy moves it up). P1, the graduation price, is
/// the other edge.
///
/// **CQ11 graduation** uses `fullRange`: one position at P1 between the usable tick bounds (F119, C6).
/// The legacy `graduated` entry point stays only until CQ11-A replaces the hook callers below.
/// **The legacy graduated layout** for a curve holding `qHeld` Q and `tAvailable` T (the pool share plus any T the curve
/// still holds), at exactly P1:
/// - `B_PRIME` (today's layout b′, F40 L1; V FitPoolHook.sol:431-458): the bid, floor(qHeld × 99 / 100) on the curve's
///   range; the bid sentinel, the rest of qHeld, from P0 to the Q-side edge; the ask, tAvailable from P1 to the T-side
///   edge.
/// - `ASK_FULL_BID_SENTINEL` (question 1, BC-067): the same ask; the bid, from P1 to the Q-side edge at the ask's
///   liquidity (less if qHeld cannot fund it); the bid sentinel, the rest of qHeld, from P0 to the Q-side edge.
/// Liquidities come from LiquidityAmounts (rounded down) in the order the hook adds them; amounts are what each add
/// takes (rounded up); `qDust` and `tDust` are what the positions cannot take.
library BoxLayoutV2 {
    error FullRangeLiquidityOverflow(uint256 liquidity);
    error RaiseIsZero();
    error CentreOutOfRange(uint256 sqrtPriceX96);
    error CurveOutOfRange(int24 tickLower, int24 tickUpper);
    error NoExactLiquidity(uint256 raise);
    error CurveTooLarge(uint256 curveT);
    error UnknownGradLayout(uint8 gradLayout);

    struct Curve {
        bool tIsCurrency0;
        uint256 raise;
        int24 tickLower;
        int24 tickUpper;
        /// The cheapest-T edge, where the curve starts (P0).
        int24 tickStart;
        /// The graduation edge (P1).
        int24 tickEnd;
        uint160 sqrtPriceLowerX96;
        uint160 sqrtPriceUpperX96;
        uint160 sqrtPriceStartX96;
        uint160 sqrtPriceEndX96;
        uint128 liquidity;
        uint256 curveT;
        uint256 poolShare;
    }

    /// @notice One protocol position: its ticks, liquidity and what adding it takes (Q for bids, T for the ask).
    struct Position {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 amount;
    }

    struct Graduated {
        uint8 gradLayout;
        Position bid;
        Position sentinel;
        Position ask;
        uint256 qDust;
        uint256 tDust;
    }

    /// @notice CQ11 / F119: one full-range position at P1. Amounts are add debits (rounded up).
    struct FullRange {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 qAmount;
        uint256 tAmount;
        uint256 qDust;
        uint256 tDust;
    }

    /// @notice Pool order: T is currency0 when its address sorts below Q's (native ETH, address(0), is always currency0).
    function tIsCurrency0(address t, address q) internal pure returns (bool) {
        return t < q;
    }

    /// @notice The centre tick of the curve for `raise` (see the library notes).
    function centreTick(uint256 raise, bool tIsC0) internal pure returns (int24) {
        uint256 sqrtPriceX96;
        if (!tIsC0 && raise <= BoxSpecV1.CURVE_SHARE_TARGET >> 64) {
            if (raise == 0) revert RaiseIsZero();
            // A*2^128 fits in 218 bits. The exact Q96 root is in [s, s + 2^32),
            // with s >= 2^128 here: at most one raw tick / 60 spacing ticks below it.
            // All formerly buildable raises take the unchanged full-precision branch below.
            // Proof and transition checks: docs/evidence/SH-V2-CQ9-SMALL-RAISE.md.
            sqrtPriceX96 = floorSqrt((BoxSpecV1.CURVE_SHARE_TARGET << 128) / raise) << 32;
        } else {
            uint256 ratioX192 = tIsC0
                ? FullMath.mulDiv(raise, uint256(1) << 192, BoxSpecV1.CURVE_SHARE_TARGET)
                : FullMath.mulDiv(BoxSpecV1.CURVE_SHARE_TARGET, uint256(1) << 192, raise);
            sqrtPriceX96 = floorSqrt(ratioX192);
        }
        if (sqrtPriceX96 < TickMath.MIN_SQRT_PRICE || sqrtPriceX96 >= TickMath.MAX_SQRT_PRICE) {
            revert CentreOutOfRange(sqrtPriceX96);
        }
        // casting to 'uint160' is safe because sqrtPriceX96 < MAX_SQRT_PRICE < 2^160 (checked above)
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 tick = TickMath.getTickAtSqrtPrice(uint160(sqrtPriceX96));
        // Round to the nearest multiple of the spacing, ties up: the remainder of a floor division, in [0, spacing).
        int24 spacing = BoxSpecV1.TICK_SPACING;
        int24 remainder = tick % spacing;
        if (remainder < 0) remainder += spacing;
        int24 below = tick - remainder;
        return remainder >= spacing / 2 ? below + spacing : below;
    }

    /// @notice ⌊√x⌋ by Newton's method from ⌈x / 2⌉ (no overflow for any x). Written here rather than imported so
    /// src/ keeps to MIT code (script-py/check_src_licences.py); the mirrors use Python's math.isqrt and the same
    /// Newton iteration in TypeScript.
    function floorSqrt(uint256 x) internal pure returns (uint256 z) {
        if (x < 2) return x;
        z = x;
        uint256 y = (x >> 1) + (x & 1);
        while (y < z) {
            z = y;
            y = (x / y + y) >> 1;
        }
    }

    /// @notice The curve for `raise` (Q raw units) and the pool order.
    function curve(uint256 raise, bool tIsC0) internal pure returns (Curve memory c) {
        if (raise == 0) revert RaiseIsZero();
        int24 centre = centreTick(raise, tIsC0);
        int24 half = BoxSpecV1.CURVE_SPAN_TICKS / 2;
        c.tIsCurrency0 = tIsC0;
        c.raise = raise;
        c.tickLower = centre - half;
        c.tickUpper = centre + half;
        if (c.tickLower < BoxSpecV1.MIN_USABLE_TICK || c.tickUpper > BoxSpecV1.MAX_USABLE_TICK) {
            revert CurveOutOfRange(c.tickLower, c.tickUpper);
        }
        c.sqrtPriceLowerX96 = TickMath.getSqrtPriceAtTick(c.tickLower);
        c.sqrtPriceUpperX96 = TickMath.getSqrtPriceAtTick(c.tickUpper);
        c.liquidity = _smallestLiquidity(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, raise, tIsC0);
        c.curveT = _tAmount(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, c.liquidity, true, tIsC0);
        if (c.curveT >= BoxSpecV1.ISSUANCE) revert CurveTooLarge(c.curveT);
        c.poolShare = BoxSpecV1.ISSUANCE - c.curveT;
        if (tIsC0) {
            (c.tickStart, c.tickEnd) = (c.tickLower, c.tickUpper);
            (c.sqrtPriceStartX96, c.sqrtPriceEndX96) = (c.sqrtPriceLowerX96, c.sqrtPriceUpperX96);
        } else {
            (c.tickStart, c.tickEnd) = (c.tickUpper, c.tickLower);
            (c.sqrtPriceStartX96, c.sqrtPriceEndX96) = (c.sqrtPriceUpperX96, c.sqrtPriceLowerX96);
        }
    }

    /// @notice Amendment 3 C6: floor the liquidity funded by qHeld P and tAvailable T at the curve's P1.
    /// @dev c must be a curve() result (or the hook's validated curve arguments). tAvailable includes any
    /// T removed from the curve plus the coordinator's token budget; qHeld is what the curve paid in P.
    /// Both sides use LiquidityAmounts' floors, but take their minimum BEFORE narrowing to uint128:
    /// a large P gift can overflow the non-limiting side even though T funds a representable position.
    /// The admitted domain is raise in [1e6, 2^128-1] with exact curve liquidity, P <= 2^128-1 and T <= ISSUANCE.
    /// Zero budgets yield zero liquidity. The returned debits round up exactly as PoolManager adds do.
    function fullRange(Curve memory c, uint256 qHeld, uint256 tAvailable) internal pure returns (FullRange memory g) {
        g.tickLower = BoxSpecV1.MIN_USABLE_TICK;
        g.tickUpper = BoxSpecV1.MAX_USABLE_TICK;
        uint160 a = TickMath.getSqrtPriceAtTick(g.tickLower);
        uint160 b = TickMath.getSqrtPriceAtTick(g.tickUpper);
        uint160 p = c.sqrtPriceEndX96;
        (uint256 x, uint256 y) = c.tIsCurrency0 ? (tAvailable, qHeld) : (qHeld, tAvailable);
        uint256 l0 = FullMath.mulDiv(x, FullMath.mulDiv(p, b, 1 << 96), b - p);
        uint256 l1 = FullMath.mulDiv(y, 1 << 96, p - a);
        uint256 l = l0 < l1 ? l0 : l1;
        if (l > type(uint128).max) revert FullRangeLiquidityOverflow(l);
        // forge-lint: disable-next-line(unsafe-typecast)
        g.liquidity = uint128(l);
        x = SqrtPriceMath.getAmount0Delta(p, b, g.liquidity, true);
        y = SqrtPriceMath.getAmount1Delta(a, p, g.liquidity, true);
        (g.qAmount, g.tAmount) = c.tIsCurrency0 ? (y, x) : (x, y);
        g.qDust = qHeld - g.qAmount;
        g.tDust = tAvailable - g.tAmount;
    }

    /// @notice The graduated layout at exactly P1 for a curve holding `qHeld` Q and `tAvailable` T.
    function graduated(Curve memory c, uint8 gradLayout, uint256 qHeld, uint256 tAvailable)
        internal
        pure
        returns (Graduated memory g)
    {
        bool tIsC0 = c.tIsCurrency0;
        int24 qEdge = tIsC0 ? BoxSpecV1.MIN_USABLE_TICK : BoxSpecV1.MAX_USABLE_TICK;
        int24 tEdge = tIsC0 ? BoxSpecV1.MAX_USABLE_TICK : BoxSpecV1.MIN_USABLE_TICK;
        uint160 sqrtQEdge = TickMath.getSqrtPriceAtTick(qEdge);
        uint160 sqrtTEdge = TickMath.getSqrtPriceAtTick(tEdge);
        g.gradLayout = gradLayout;

        if (gradLayout == BoxSpecV1.GRAD_LAYOUT_B_PRIME) {
            g.bid = _qPosition(
                c.tickEnd,
                c.tickStart,
                c.sqrtPriceEndX96,
                c.sqrtPriceStartX96,
                tIsC0,
                qHeld * BoxSpecV1.BID_SHARE_PERCENT / 100,
                type(uint128).max
            );
        } else if (gradLayout == BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL) {
            uint128 askLiquidity = _tLiquidity(sqrtTEdge, c.sqrtPriceEndX96, tAvailable, tIsC0);
            g.bid = _qPosition(c.tickEnd, qEdge, c.sqrtPriceEndX96, sqrtQEdge, tIsC0, qHeld, askLiquidity);
        } else {
            revert UnknownGradLayout(gradLayout);
        }
        g.sentinel = _qPosition(
            c.tickStart, qEdge, c.sqrtPriceStartX96, sqrtQEdge, tIsC0, qHeld - g.bid.amount, type(uint128).max
        );
        g.ask.liquidity = _tLiquidity(sqrtTEdge, c.sqrtPriceEndX96, tAvailable, tIsC0);
        g.ask.amount = _tAmount(sqrtTEdge, c.sqrtPriceEndX96, g.ask.liquidity, true, tIsC0);
        (g.ask.tickLower, g.ask.tickUpper) = _ordered(c.tickEnd, tEdge);
        g.qDust = qHeld - g.bid.amount - g.sentinel.amount;
        g.tDust = tAvailable - g.ask.amount;
    }

    /// @dev A Q-side position between two ticks: the liquidity `budget` funds (capped at `maxLiquidity`) and what it takes.
    function _qPosition(
        int24 tickA,
        int24 tickB,
        uint160 sqrtA,
        uint160 sqrtB,
        bool tIsC0,
        uint256 budget,
        uint128 maxLiquidity
    ) private pure returns (Position memory p) {
        (p.tickLower, p.tickUpper) = _ordered(tickA, tickB);
        uint128 l = tIsC0
            ? LiquidityAmounts.getLiquidityForAmount1(sqrtA, sqrtB, budget)
            : LiquidityAmounts.getLiquidityForAmount0(sqrtA, sqrtB, budget);
        p.liquidity = l < maxLiquidity ? l : maxLiquidity;
        p.amount = _qAmount(sqrtA, sqrtB, p.liquidity, true, tIsC0);
    }

    /// @dev The least liquidity whose range [sqrtA, sqrtB] holds exactly `raise` Q when fully crossed (rounded down).
    function _smallestLiquidity(uint160 sqrtA, uint160 sqrtB, uint256 raise, bool tIsC0)
        private
        pure
        returns (uint128)
    {
        uint256 lo = 0;
        uint256 hi = uint256(1) << 128;
        while (lo < hi) {
            uint256 mid = (lo + hi) >> 1;
            // casting to 'uint128' is safe because mid < hi <= 2^128
            // forge-lint: disable-next-line(unsafe-typecast)
            if (_qAmount(sqrtA, sqrtB, uint128(mid), false, tIsC0) >= raise) hi = mid;
            else lo = mid + 1;
        }
        // casting to 'uint128' is safe because lo < 2^128 is checked first
        // forge-lint: disable-next-line(unsafe-typecast)
        if (lo >> 128 != 0 || _qAmount(sqrtA, sqrtB, uint128(lo), false, tIsC0) != raise) {
            revert NoExactLiquidity(raise);
        }
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(lo);
    }

    function _qAmount(uint160 sqrtA, uint160 sqrtB, uint128 liquidity, bool roundUp, bool tIsC0)
        private
        pure
        returns (uint256)
    {
        return tIsC0
            ? SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, liquidity, roundUp)
            : SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, liquidity, roundUp);
    }

    function _tAmount(uint160 sqrtA, uint160 sqrtB, uint128 liquidity, bool roundUp, bool tIsC0)
        private
        pure
        returns (uint256)
    {
        return tIsC0
            ? SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, liquidity, roundUp)
            : SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, liquidity, roundUp);
    }

    function _tLiquidity(uint160 sqrtA, uint160 sqrtB, uint256 amount, bool tIsC0) private pure returns (uint128) {
        return tIsC0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtA, sqrtB, amount)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtA, sqrtB, amount);
    }

    function _ordered(int24 a, int24 b) private pure returns (int24, int24) {
        return a < b ? (a, b) : (b, a);
    }
}
