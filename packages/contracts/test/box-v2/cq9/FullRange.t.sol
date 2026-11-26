// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullRangeVectors} from "./FullRangeVectors.sol";
import {Test} from "forge-std/Test.sol";
import {BoxLayoutV2 as Layout} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {BoxSpecV1 as K} from "../../../src/box/BoxSpecV1.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// @notice CQ11-0 / BC-003/067: differential vectors and the every-admitted-raise property.
contract FullRangeTest is Test {
    function test_cq11_BC003_sharedThreeLanguageVectors() public pure {
        uint256[44] memory raises = FullRangeVectors.raises();
        bytes32 digest;
        for (uint256 i; i < raises.length; ++i) {
            Layout.Curve memory c = Layout.curve(raises[i], i >= raises.length / 2);
            for (uint256 mode; mode < 7; ++mode) {
                (uint256 q, uint256 t) = _budgets(c, mode);
                Layout.FullRange memory g = Layout.fullRange(c, q, t);
                // Struct fields are static ABI words, identical to the shared vector digest.
                digest = sha256(abi.encode(digest, c.raise, c.tIsCurrency0, q, t, g));
                _funded(c, q, t);
            }
        }
        assertEq(digest, FullRangeVectors.DIGEST, "all shared inputs and full-range outputs");
    }

    function _budgets(Layout.Curve memory c, uint256 mode) private pure returns (uint256, uint256) {
        if (mode == 0) return (c.raise, c.poolShare);
        if (mode == 1) return (c.raise / 10, K.ISSUANCE);
        if (mode == 2) return (c.raise, c.poolShare / 10);
        if (mode == 3) return (type(uint128).max, K.ISSUANCE);
        if (mode == 4) return (0, c.poolShare);
        if (mode == 5) return (c.raise, 0);
        return (1, 1);
    }

    function testFuzz_cq11_BC067_everyAdmittedRaise(uint128 seed, bool order) public view {
        _admitted(bound(uint256(seed), 1e6, type(uint128).max), order);
    }

    function testFuzz_cq11_BC067_everyRaiseScale(uint128 seed, uint8 scale, bool order) public view {
        uint256 r = 1e6 + uint256(seed) % ((uint256(1) << (20 + uint256(scale) % 109)) - 1e6);
        _admitted(r, order);
    }

    function testFuzz_cq11_BC067_curveProceedsAndTokenBudget(uint128 seed, uint8 scale, bool order) public pure {
        uint256 r = 1e6 + uint256(seed) % ((uint256(1) << (20 + uint256(scale) % 109)) - 1e6);
        // Construct a representable neighbour from the curve's removal amounts. This
        // also exercises high raises where uniform random raw raises rarely admit.
        int24 centre = Layout.centreTick(r, order);
        uint160 a = TickMath.getSqrtPriceAtTick(centre - K.CURVE_SPAN_TICKS / 2);
        uint160 b = TickMath.getSqrtPriceAtTick(centre + K.CURVE_SPAN_TICKS / 2);
        uint256 l =
            order ? FullMath.mulDiv(r, 1 << 96, b - a) : FullMath.mulDiv(r, FullMath.mulDiv(a, b, 1 << 96), b - a);
        // Bound by r <= uint128.max and the admitted centre range (L < 2^112).
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 held = order
            ? SqrtPriceMath.getAmount1Delta(a, b, uint128(l), false)
            : SqrtPriceMath.getAmount0Delta(a, b, uint128(l), false);
        Layout.Curve memory c = Layout.curve(held, order);
        _funded(c, held, c.poolShare);
        _funded(c, type(uint128).max, K.ISSUANCE);
        _funded(c, held / 10, K.ISSUANCE);
        _funded(c, held, uint256(seed) % (K.ISSUANCE + 1));
        _funded(c, 0, c.poolShare);
        _funded(c, held, 0);
    }

    function _admitted(uint256 r, bool order) private view {
        try this.curve(r, order) returns (Layout.Curve memory c) {
            // Deliberately outside the try expression: a graduation failure must fail
            // the property, never be mistaken for a refused raise.
            _funded(c, r, c.poolShare);
            _funded(c, type(uint128).max, K.ISSUANCE);
        } catch (bytes memory reason) {
            assertEq(reason, abi.encodeWithSelector(Layout.NoExactLiquidity.selector, r));
        }
    }

    function curve(uint256 r, bool order) external pure returns (Layout.Curve memory) {
        return Layout.curve(r, order);
    }

    function _funded(Layout.Curve memory c, uint256 q, uint256 t) private pure {
        Layout.FullRange memory g = Layout.fullRange(c, q, t);
        assertEq(g.tickLower, K.MIN_USABLE_TICK);
        assertEq(g.tickUpper, K.MAX_USABLE_TICK);
        uint160 a = TickMath.getSqrtPriceAtTick(g.tickLower);
        uint160 b = TickMath.getSqrtPriceAtTick(g.tickUpper);
        uint256 x = SqrtPriceMath.getAmount0Delta(c.sqrtPriceEndX96, b, g.liquidity, true);
        uint256 y = SqrtPriceMath.getAmount1Delta(a, c.sqrtPriceEndX96, g.liquidity, true);
        assertEq(g.qAmount, c.tIsCurrency0 ? y : x);
        assertEq(g.tAmount, c.tIsCurrency0 ? x : y);
        assertLe(g.qAmount, q);
        assertLe(g.tAmount, t);
        assertEq(g.qAmount + g.qDust, q);
        assertEq(g.tAmount + g.tDust, t);
        if (q >= c.raise && t >= c.poolShare) assertGt(g.liquidity, 0);
    }
}
