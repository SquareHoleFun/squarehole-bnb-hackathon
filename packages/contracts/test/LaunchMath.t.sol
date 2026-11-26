// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LaunchMath} from "../src/libraries/LaunchMath.sol";

/// @notice External wrapper so reverts can be asserted.
contract LaunchMathCaller {
    function launchPosition(uint256 supply, uint256 fdv, int24 range, int24 spacing, bool tIs0)
        external
        pure
        returns (LaunchMath.LaunchPosition memory)
    {
        return LaunchMath.launchPosition(supply, fdv, range, spacing, tIs0);
    }

    function sqrtPriceX96(uint256 num, uint256 den) external pure returns (uint160) {
        return LaunchMath.sqrtPriceX96(num, den);
    }
}

contract LaunchMathTest is Test {
    LaunchMathCaller internal c = new LaunchMathCaller();

    function testFuzz_sqrt_isFloorSqrt(uint256 x) public pure {
        uint256 z = LaunchMath.sqrt(x);
        assertLe(z * z, x);
        if (z < type(uint128).max) assertGt((z + 1) * (z + 1), x);
    }

    function test_sqrt_edges() public pure {
        assertEq(LaunchMath.sqrt(0), 0);
        assertEq(LaunchMath.sqrt(1), 1);
        assertEq(LaunchMath.sqrt(3), 1);
        assertEq(LaunchMath.sqrt(4), 2);
        assertEq(LaunchMath.sqrt(type(uint256).max), type(uint128).max);
        assertEq(LaunchMath.sqrt(uint256(1) << 254), uint256(1) << 127);
    }

    /// The computed start price agrees with TickMath: price(tick) ≤ ratio < price(tick + 1).
    function testFuzz_sqrtPriceX96_matchesTickMath(uint256 num, uint256 den) public view {
        num = bound(num, 1, 1e40);
        den = bound(den, 1, 1e40);
        uint256 ratioQ96 = FullMath.mulDiv(num, 1 << 96, den);
        vm.assume(ratioQ96 > 1 << 20 && ratioQ96 < uint256(1) << 200); // inside v4's price range with margin
        uint160 s = c.sqrtPriceX96(num, den);
        // s = floor(sqrt(num/den) × 2^96): s^2 matches the ratio to ~1e-9 relative (plus floor effects of a few
        // units), far below one tick (1e-4 in price).
        uint256 sq = FullMath.mulDiv(uint256(s), uint256(s), 1 << 96); // ≈ ratio × 2^96
        assertApproxEqAbs(sq, ratioQ96, ratioQ96 / 1e9 + 4, "s^2 ~ ratio");
        assertLe(sq, ratioQ96, "floor: never above the ratio");
        int24 tick = TickMath.getTickAtSqrtPrice(s);
        assertLe(TickMath.getSqrtPriceAtTick(tick), s);
    }

    function test_launchPosition_bothOrders_startFdvAndSupply() public view {
        uint256 supply = 1_000_000e18;
        uint256 fdv = 5_000e6; // 5,000 USDC-like
        for (uint256 i; i < 2; ++i) {
            bool tIs0 = i == 0;
            LaunchMath.LaunchPosition memory p = c.launchPosition(supply, fdv, 69_060, 60, tIs0);
            assertEq(p.tickUpper - p.tickLower, 69_060);
            assertEq(p.tickLower % 60, 0);
            assertEq(p.tickUpper % 60, 0);
            uint160 sqrtL = TickMath.getSqrtPriceAtTick(p.tickLower);
            uint160 sqrtU = TickMath.getSqrtPriceAtTick(p.tickUpper);
            // Single-sided: at the start price the position holds only T, at most `supply`.
            uint256 tAmount = tIs0
                ? SqrtPriceMath.getAmount0Delta(sqrtL, sqrtU, p.liquidity, true)
                : SqrtPriceMath.getAmount1Delta(sqrtL, sqrtU, p.liquidity, true);
            assertLe(tAmount, supply);
            assertApproxEqRel(tAmount, supply, 1e6, "the whole supply, minus rounding");
            assertEq(p.sqrtPriceX96, tIs0 ? sqrtL : sqrtU, "starts at the T-only end");
            // Start FDV (Q per T × supply) is at most the template's and within one tick spacing (0.6%) below it.
            uint256 priceQ96 = tIs0
                ? FullMath.mulDiv(uint256(p.sqrtPriceX96), uint256(p.sqrtPriceX96), 1 << 96)
                : FullMath.mulDiv(
                    1 << 96, 1 << 96, FullMath.mulDiv(uint256(p.sqrtPriceX96), uint256(p.sqrtPriceX96), 1 << 96)
                );
            uint256 startFdv = FullMath.mulDiv(priceQ96, supply, 1 << 96);
            assertLe(startFdv, fdv + 1);
            assertGe(startFdv, fdv * 994 / 1000);
        }
    }

    /// Every supply a template must accept (1 … 1e9 whole tokens) fits the tick range for sensible templates.
    function testFuzz_launchPosition_allSupplies(uint256 wholeSupply, bool tIs0) public view {
        wholeSupply = bound(wholeSupply, 1, 1e9);
        LaunchMath.LaunchPosition memory p = c.launchPosition(wholeSupply * 1e18, 1e18, 69_060, 60, tIs0);
        assertGt(p.liquidity, 0);
        assertGe(p.tickLower, TickMath.minUsableTick(60));
        assertLe(p.tickUpper, TickMath.maxUsableTick(60));
    }

    function test_launchPosition_rejectsBadTemplates() public {
        vm.expectRevert(LaunchMath.InvalidTemplate.selector);
        c.launchPosition(1e18, 1e18, 61, 60, true); // width not a multiple of the spacing
        vm.expectRevert(LaunchMath.InvalidTemplate.selector);
        c.launchPosition(0, 1e18, 60, 60, true);
        vm.expectRevert(LaunchMath.InvalidTemplate.selector);
        c.launchPosition(1e18, 0, 60, 60, true);
        vm.expectRevert(LaunchMath.InvalidTemplate.selector);
        c.launchPosition(1e18, 1e18, 60, 0, true);
        // A range that leaves the usable tick range.
        vm.expectRevert(LaunchMath.PriceOutOfRange.selector);
        c.launchPosition(1e18, 1e30, 887_220, 60, true);
    }

    function test_floorToSpacing() public pure {
        assertEq(LaunchMath.floorToSpacing(0, 60), 0);
        assertEq(LaunchMath.floorToSpacing(59, 60), 0);
        assertEq(LaunchMath.floorToSpacing(60, 60), 60);
        assertEq(LaunchMath.floorToSpacing(-1, 60), -60);
        assertEq(LaunchMath.floorToSpacing(-60, 60), -60);
        assertEq(LaunchMath.floorToSpacing(-61, 60), -120);
    }
}
