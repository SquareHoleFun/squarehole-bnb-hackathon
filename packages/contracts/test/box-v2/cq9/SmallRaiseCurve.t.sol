// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// @notice CQ9-4 / F114 R28E; BC-002/003/067/215. Case names for the integrator, no coverage-map edits.
contract SmallRaiseCurveTest is Test {
    uint256 private constant LIMIT = 43_368_086;

    function test_cq9_BC215_wbtcMainnetAndRehearsalBuild() public pure {
        _build(15_100_000, 454_200);
        _build(1_510_000, 477_240);
        _build(10_000, 527_400);
        // Exact Python/TypeScript vector in cases.v2.json (all amounts in raw units).
        BoxLayoutV2.Curve memory c = BoxLayoutV2.curve(15_100_000, false);
        assertEq(c.liquidity, 75_985_160_057_668_497);
        assertEq(c.curveT, 801_025_051_064_647_328_531_947_263);
        BoxLayoutV2.Graduated memory g = BoxLayoutV2.graduated(c, 2, c.raise, c.poolShare);
        assertEq(g.bid.amount, 14_381_092);
        assertEq(g.sentinel.amount, 718_908);
        assertEq(g.ask.amount, 198_974_948_935_352_668_895_355_043);
        assertEq(g.tDust, 2_572_697_694);
    }

    function test_cq9_BC003_bothSidesOfOverflowBoundary() public pure {
        for (uint256 r = LIMIT - 2; r <= LIMIT + 2; ++r) {
            _build(r, 443_640);
        }
    }

    function test_cq9_BC003_v1StillRejectsSmallRaise() public {
        vm.expectRevert();
        this.legacy(15_100_000, false);
    }

    function test_cq9_BC003_zeroStillRejected() public {
        vm.expectRevert(BoxLayoutV2.RaiseIsZero.selector);
        this.current(0, false);
    }

    function testFuzz_cq9_BC003_previouslyBuildableCurvesAreIdentical(uint256 seed, bool order) public view {
        // A dense set of successful layouts in both orders, including every decimal scale.
        uint256 r = LIMIT + 1 + seed % (10 ** (8 + seed % 22));
        _same(r, order);
        // Also cover the full uint256 domain (including matching rejection at large raises).
        _same(seed, order);
    }

    function _same(uint256 r, bool order) private view {
        try this.legacy(r, order) returns (bytes memory old) {
            assertEq(this.current(r, order), old, "curve and both graduated layouts identical");
        } catch (bytes memory oldError) {
            if (order || r > LIMIT || r == 0) {
                try this.current(r, order) {
                    revert("changed a legacy rejection outside the small-raise branch");
                } catch (bytes memory newError) {
                    assertEq(newError, oldError);
                }
            }
        }
    }

    function testFuzz_cq9_BC003_smallRaiseCentreBound(uint256 seed) public pure {
        uint256 r = 1 + seed % LIMIT;
        // If a = floor(sqrt(floor(A*2^128/r))), the exact Q96 root is in
        // [a*2^32, (a+1)*2^32). The proof and tick-spacing bound are in the evidence.
        uint256 a = BoxLayoutV1.floorSqrt((BoxSpecV1.CURVE_SHARE_TARGET << 128) / r);
        int24 low = _centre(uint160(a << 32));
        int24 high = _centre(uint160(((a + 1) << 32) - 1));
        int24 actual = BoxLayoutV2.centreTick(r, false);
        assertEq(actual, low);
        assertGe(high, actual);
        assertLe(high - actual, 60);
        _build(r, actual);
    }

    function _centre(uint160 price) private pure returns (int24) {
        int24 tick = TickMath.getTickAtSqrtPrice(price);
        return ((tick + 30) / 60) * 60; // only positive ticks in the affected range
    }

    function _build(uint256 r, int24 expectedCentre) private pure {
        BoxLayoutV2.Curve memory c = BoxLayoutV2.curve(r, false);
        assertEq((c.tickLower + c.tickUpper) / 2, expectedCentre);
        assertEq(c.tickUpper - c.tickLower, 26_880);
        assertEq(c.curveT + c.poolShare, BoxSpecV1.ISSUANCE);
        assertEq(SqrtPriceMath.getAmount0Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, c.liquidity, false), r);
        assertLt(SqrtPriceMath.getAmount0Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, c.liquidity - 1, false), r);
        for (uint8 layout = 1; layout <= 2; ++layout) {
            BoxLayoutV2.Graduated memory g = BoxLayoutV2.graduated(c, layout, r, c.poolShare);
            assertEq(g.bid.amount + g.sentinel.amount + g.qDust, r);
            assertEq(g.ask.amount + g.tDust, c.poolShare);
        }
    }

    function legacy(uint256 r, bool order) external pure returns (bytes memory) {
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(r, order);
        return abi.encode(c, BoxLayoutV1.graduated(c, 1, r, c.poolShare), BoxLayoutV1.graduated(c, 2, r, c.poolShare));
    }

    function current(uint256 r, bool order) external pure returns (bytes memory) {
        BoxLayoutV2.Curve memory c = BoxLayoutV2.curve(r, order);
        return abi.encode(c, BoxLayoutV2.graduated(c, 1, r, c.poolShare), BoxLayoutV2.graduated(c, 2, r, c.poolShare));
    }
}
