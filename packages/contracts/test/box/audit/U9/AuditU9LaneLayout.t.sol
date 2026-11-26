// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU9LaneBase} from "./AuditU9LaneBase.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxLayoutV1 as Layout} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";

/// @notice BC-002/003/067, F61 L7, F74 U5, F78. Q decimals are metadata; the layout consumes raw R.
contract AuditU9LaneLayout is AuditU9LaneBase {
    function _amount(Layout.Curve memory c, uint128 l, bool q, bool up) internal pure returns (uint256) {
        return q == c.tIsCurrency0
            ? SqrtPriceMath.getAmount1Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, up)
            : SqrtPriceMath.getAmount0Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, up);
    }

    function _tick(int24 t) internal pure returns (uint160 p) {
        assertEq(t % 60, 0);
        assertGe(t, TickMath.minUsableTick(60));
        assertLe(t, TickMath.maxUsableTick(60));
        p = TickMath.getSqrtPriceAtTick(t);
        assertEq(TickMath.getTickAtSqrtPrice(p), t);
    }

    function _position(Layout.Position memory p, bool amount0, uint256 budget, uint128 cap) internal pure {
        uint160 lo = _tick(p.tickLower);
        uint160 hi = _tick(p.tickUpper);
        uint128 affordable = amount0
            ? LiquidityAmounts.getLiquidityForAmount0(lo, hi, budget)
            : LiquidityAmounts.getLiquidityForAmount1(lo, hi, budget);
        assertEq(p.liquidity, affordable < cap ? affordable : cap);
        assertEq(
            p.amount,
            amount0
                ? SqrtPriceMath.getAmount0Delta(lo, hi, p.liquidity, true)
                : SqrtPriceMath.getAmount1Delta(lo, hi, p.liquidity, true)
        );
        assertLe(p.amount, budget, "rounding cannot spend beyond the box budget");
    }

    function _check(uint256 r, bool order) internal pure {
        Layout.Curve memory c = Layout.curve(r, order);
        assertEq(c.sqrtPriceLowerX96, _tick(c.tickLower));
        assertEq(c.sqrtPriceUpperX96, _tick(c.tickUpper));
        assertEq(c.sqrtPriceStartX96, _tick(c.tickStart));
        assertEq(c.sqrtPriceEndX96, _tick(c.tickEnd));
        assertEq(c.tickUpper - c.tickLower, 26_880);
        assertEq(c.tickStart, order ? c.tickLower : c.tickUpper);
        assertEq(c.tickEnd, order ? c.tickUpper : c.tickLower);
        assertEq(_amount(c, c.liquidity, true, false), r, "exact removable Q");
        assertLt(_amount(c, c.liquidity - 1, true, false), r, "bisection is minimal");
        assertGe(_amount(c, c.liquidity, true, true), r, "incoming Q rounds toward box");
        assertLe(_amount(c, c.liquidity, true, true) - r, 1);
        assertEq(c.curveT, _amount(c, c.liquidity, false, true));
        assertLe(c.curveT - _amount(c, c.liquidity, false, false), 1);
        assertEq(c.curveT + c.poolShare, BoxSpecV1.ISSUANCE);
        for (uint8 kind = 1; kind <= 2; ++kind) {
            Layout.Graduated memory g = Layout.graduated(c, kind, r, c.poolShare);
            _position(g.ask, order, c.poolShare, type(uint128).max);
            _position(g.bid, !order, kind == 1 ? r * 99 / 100 : r, kind == 1 ? type(uint128).max : g.ask.liquidity);
            _position(g.sentinel, !order, r - g.bid.amount, type(uint128).max);
            assertEq(g.bid.amount + g.sentinel.amount + g.qDust, r);
            assertEq(g.ask.amount + g.tDust, c.poolShare, "pool share includes retained dust");
            // At these raw raises the inverse-liquidity truncation loses less than 1e-8 of either budget.
            assertLe(g.qDust, r / 1e8 + 1);
            assertLe(g.tDust, c.poolShare / 1e8 + 1);
        }
    }

    function testProperty_AUDIT_U9_allDecimalMetadataAndBothOrders() public pure {
        BoxSpecV1.BoxSpec memory s = _spec();
        BoxSpecV1.VersionContext memory ctx = BoxSpecV1.contextV1();
        for (uint256 decimals; decimals <= 255; ++decimals) {
            ctx.qList[0].decimals = uint8(decimals);
            (uint16 r, uint16 f) = BoxSpecV1.validate(s, ctx);
            assertEq(r, 0);
            assertEq(f, 0);
        }
        _check(BoxBuildV1.RAISE, false);
        _check(BoxBuildV1.RAISE, true);
        assertFalse(Layout.tIsCurrency0(address(1), address(0)));
        assertTrue(Layout.tIsCurrency0(address(1), address(2)));
    }

    function testFuzz_AUDIT_U9_rawRaiseAndAllProducedTicks(uint256 r, bool order) public pure {
        _check(bound(r, 1e9, 1e26), order);
    }

    function testProperty_AUDIT_U9_decimalScalesAndProfileDust() public {
        for (uint256 decimals = 9; decimals <= 26; ++decimals) {
            _check(10 ** decimals, false);
            _check(10 ** decimals, true);
        }
        for (uint256 order; order < 2; ++order) {
            Layout.Curve memory c = Layout.curve(BoxBuildV1.RAISE, order != 0);
            Layout.Graduated memory g = Layout.graduated(c, 2, c.raise, c.poolShare);
            assertEq(g.qDust, 0);
            assertLe(g.tDust, 50_000, "raw T bound for the two build profiles");
            emit log_named_uint("T is currency0", order);
            emit log_named_uint("profile R", c.raise);
            emit log_named_uint("graduation raw T dust", g.tDust);
        }
    }
}
