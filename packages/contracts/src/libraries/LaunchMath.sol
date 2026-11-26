// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Uniswap v4-core @ 46c68346 and v4-periphery @ 9969eec4, MIT files only (see DEPENDENCIES.md).
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

/// @title LaunchMath
/// @notice Turns a protocol launch template (starting fully diluted value in raw Q, range width in ticks, tick
/// spacing) and a launch's supply into the pool's initial price, the protocol-owned position's tick range and its
/// liquidity (ADR-0011 "Launch templates"). Creators choose only the supply (N and r); price and shape are
/// template constants, so every launch on a template starts at the same fully diluted value.
/// @dev Orientation: v4 prices are currency1 per currency0. With T = currency0 the position lies above the start
/// price and buyers (Q → T, oneForZero) push the price up through it; with T = currency1 it lies below and buyers
/// (zeroForOne) push the price down through it. In both cases the start price is rounded to the tick grid in the
/// direction that makes T cheaper (a start FDV at most one tick spacing below the template's), never dearer.
library LaunchMath {
    error PriceOutOfRange();
    error InvalidTemplate();

    struct LaunchPosition {
        int24 tickLower;
        int24 tickUpper;
        uint160 sqrtPriceX96; // initial pool price = the T-only end of the range
        uint128 liquidity; // for exactly `supply` T (rounded down; ≤ supply is deposited)
    }

    /// @notice The launch position for `supply` raw T against a template.
    /// @param supply raw T units in the position (the whole initial supply)
    /// @param startFdvQ raw Q units the whole supply is worth at the start price
    /// @param rangeTicks width of the position in ticks (a positive multiple of `tickSpacing`)
    /// @param tickSpacing the pool's tick spacing
    /// @param tIsCurrency0 whether T sorts before Q
    function launchPosition(uint256 supply, uint256 startFdvQ, int24 rangeTicks, int24 tickSpacing, bool tIsCurrency0)
        internal
        pure
        returns (LaunchPosition memory p)
    {
        if (
            supply == 0 || startFdvQ == 0 || tickSpacing <= 0 || tickSpacing > TickMath.MAX_TICK_SPACING
                || rangeTicks <= 0 || rangeTicks % tickSpacing != 0
        ) revert InvalidTemplate();
        if (tIsCurrency0) {
            // price = Q per T = startFdvQ / supply; the range starts at (≤) that price and extends upwards.
            int24 tick = TickMath.getTickAtSqrtPrice(sqrtPriceX96(startFdvQ, supply));
            p.tickLower = floorToSpacing(tick, tickSpacing);
            p.tickUpper = p.tickLower + rangeTicks;
        } else {
            // price = T per Q = supply / startFdvQ; the range ends at (≥) that price and extends downwards.
            int24 tick = TickMath.getTickAtSqrtPrice(sqrtPriceX96(supply, startFdvQ));
            p.tickUpper = floorToSpacing(tick, tickSpacing) + tickSpacing;
            p.tickLower = p.tickUpper - rangeTicks;
        }
        if (p.tickLower < TickMath.minUsableTick(tickSpacing) || p.tickUpper > TickMath.maxUsableTick(tickSpacing)) {
            revert PriceOutOfRange();
        }
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(p.tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(p.tickUpper);
        if (tIsCurrency0) {
            p.sqrtPriceX96 = sqrtLower;
            p.liquidity = LiquidityAmounts.getLiquidityForAmount0(sqrtLower, sqrtUpper, supply);
        } else {
            p.sqrtPriceX96 = sqrtUpper;
            p.liquidity = LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, supply);
        }
        if (p.liquidity == 0) revert PriceOutOfRange();
    }

    /// @notice ⌊√(num / den) × 2^96⌋ for any num/den whose square root fits the v4 price range.
    /// @dev Below 2^64 the ratio is scaled by 2^192 (the result is Q96 directly, ~96+ bits of precision); otherwise
    /// by 2^128 and the Q64 root is shifted left by 32 (the ratio then has ≥ 64 integer bits, so precision stays far
    /// below one tick). Ratios ≥ 2^128 are outside every v4 price.
    function sqrtPriceX96(uint256 num, uint256 den) internal pure returns (uint160) {
        if (den == 0) revert PriceOutOfRange();
        uint256 root;
        if (num / den < (1 << 64)) {
            root = sqrt(FullMath.mulDiv(num, 1 << 192, den));
        } else {
            if (num / den >= (1 << 128)) revert PriceOutOfRange();
            root = sqrt(FullMath.mulDiv(num, 1 << 128, den)) << 32;
        }
        if (root < TickMath.MIN_SQRT_PRICE || root >= TickMath.MAX_SQRT_PRICE) revert PriceOutOfRange();
        // casting to 'uint160' is safe because root < MAX_SQRT_PRICE < 2^160
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(root);
    }

    /// @notice v4's per-tick liquidity cap for `tickSpacing`: type(uint128).max / the number of usable ticks. Same
    /// formula as v4-core `Pool.tickSpacingToMaxLiquidityPerTick` (reimplemented: Pool.sol is BUSL-1.1; equality is
    /// tested against it).
    function maxLiquidityPerTick(int24 tickSpacing) internal pure returns (uint128) {
        if (tickSpacing <= 0) revert InvalidTemplate();
        int24 minTick = TickMath.MIN_TICK / tickSpacing;
        if (TickMath.MIN_TICK % tickSpacing != 0) minTick -= 1;
        int24 maxTick = TickMath.MAX_TICK / tickSpacing;
        // casting to 'uint256' is safe because maxTick ≥ 0 > minTick
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 numTicks = uint256(int256(maxTick) - int256(minTick)) + 1;
        // casting to 'uint128' is safe because the quotient of a uint128 value is a uint128 value
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(type(uint128).max / numTicks);
    }

    /// @notice Largest multiple of `spacing` that is ≤ `tick` (rounds towards −∞).
    function floorToSpacing(int24 tick, int24 spacing) internal pure returns (int24 floored) {
        floored = tick / spacing * spacing; // truncates towards zero
        if (tick < 0 && tick % spacing != 0) floored -= spacing;
    }

    /// @notice ⌊√x⌋.
    /// @dev Newton's method from a power-of-two estimate within a factor of √2 of the root; seven iterations
    /// converge for any 256-bit input, and the final min() removes the possible +1 overshoot.
    function sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        uint256 xx = x;
        uint256 r = 1;
        if (xx >= 1 << 128) {
            xx >>= 128;
            r <<= 64;
        }
        if (xx >= 1 << 64) {
            xx >>= 64;
            r <<= 32;
        }
        if (xx >= 1 << 32) {
            xx >>= 32;
            r <<= 16;
        }
        if (xx >= 1 << 16) {
            xx >>= 16;
            r <<= 8;
        }
        if (xx >= 1 << 8) {
            xx >>= 8;
            r <<= 4;
        }
        if (xx >= 1 << 4) {
            xx >>= 4;
            r <<= 2;
        }
        if (xx >= 1 << 3) r <<= 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        r = (r + x / r) >> 1;
        uint256 r1 = x / r;
        z = r < r1 ? r : r1;
    }
}
