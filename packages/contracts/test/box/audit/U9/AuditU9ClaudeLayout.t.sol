// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {SwapMath} from "v4-core/src/libraries/SwapMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";

/// @notice TEST ONLY: the library behind an external call, so a revert can be caught.
contract AuditU9ClaudeLayoutHarness {
    function curve(uint256 raise, bool tIsC0) external pure returns (BoxLayoutV1.Curve memory) {
        return BoxLayoutV1.curve(raise, tIsC0);
    }
}

/// @title AuditU9ClaudeLayoutTest (SH-AUDIT-B0-U9, Claude; P9.1, P9.6; lenses L1, L6, L7)
/// @notice BoxLayoutV1 (BoxLayoutV1.sol:10-36): the curve raises exactly R in any decimals and token order, on the
/// mainnet raise and the rehearsal build's (R / 10, BoxBuildV1 rehearsal); the bisection's error and every rounding
/// fall on the box's side (a full cross pays at least R, a removal returns exactly R, the deposit covers what a buyer
/// takes); the graduated layout places the pool share less a dust below one unit of liquidity; the ticks and
/// liquidity agree with the pinned v4 TickMath, SqrtPriceMath, SwapMath and LiquidityAmounts at every tick the library
/// produces (BC-002, BC-003, BC-067; v4-core 46c68346, v4-periphery 9969eec4).
contract AuditU9ClaudeLayoutTest is Test {
    uint256 internal constant R = 4_206_980_085_000_000_000;
    uint24 internal constant FEE = 10_000;

    AuditU9ClaudeLayoutHarness internal harness;

    function setUp() public {
        harness = new AuditU9ClaudeLayoutHarness();
    }

    // ================================================================================================ helpers

    function _qAmount(BoxLayoutV1.Curve memory c, uint128 l, bool up) internal pure returns (uint256) {
        return c.tIsCurrency0
            ? SqrtPriceMath.getAmount1Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, up)
            : SqrtPriceMath.getAmount0Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, up);
    }

    function _tAmount(BoxLayoutV1.Curve memory c, uint128 l, bool up) internal pure returns (uint256) {
        return c.tIsCurrency0
            ? SqrtPriceMath.getAmount0Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, up)
            : SqrtPriceMath.getAmount1Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, up);
    }

    /// @dev The nearest multiple of 60 to `tick`, ties up, written independently of the library (floor division).
    function _nearest60(int24 tick) internal pure returns (int24) {
        int256 t = int256(tick) + 30;
        int256 q = t / 60;
        if (t % 60 != 0 && t < 0) --q;
        // casting to 'int24' is safe because |q × 60| ≤ 887,280
        // forge-lint: disable-next-line(unsafe-typecast)
        return int24(q * 60);
    }

    /// @dev Every BC-003 / P9.1 property of one curve; returns the Q a full cross in one step pays above the raise.
    function _checkCurve(BoxLayoutV1.Curve memory c, uint256 raise) internal pure returns (uint256 overpay) {
        // Ticks: multiples of 60, span 26,880, inside the usable range; P0 the T-only edge, P1 the other.
        assertEq(c.tickLower % 60, 0);
        assertEq(c.tickUpper - c.tickLower, BoxSpecV1.CURVE_SPAN_TICKS);
        assertGe(c.tickLower, TickMath.minUsableTick(60));
        assertLe(c.tickUpper, TickMath.maxUsableTick(60));
        assertEq(c.tickStart, c.tIsCurrency0 ? c.tickLower : c.tickUpper);
        assertEq(c.tickEnd, c.tIsCurrency0 ? c.tickUpper : c.tickLower);
        // v4 agreement at every tick produced: TickMath's √price, and its tick back.
        assertEq(c.sqrtPriceLowerX96, TickMath.getSqrtPriceAtTick(c.tickLower));
        assertEq(c.sqrtPriceUpperX96, TickMath.getSqrtPriceAtTick(c.tickUpper));
        assertEq(TickMath.getTickAtSqrtPrice(c.sqrtPriceLowerX96), c.tickLower);
        assertEq(TickMath.getTickAtSqrtPrice(c.sqrtPriceUpperX96), c.tickUpper);
        // The centre: the nearest multiple of 60, ties up, to TickMath's tick of ⌊√price · 2^96⌋ (the library notes).
        uint256 ratioX192 = c.tIsCurrency0
            ? FullMath.mulDiv(raise, uint256(1) << 192, BoxSpecV1.CURVE_SHARE_TARGET)
            : FullMath.mulDiv(BoxSpecV1.CURVE_SHARE_TARGET, uint256(1) << 192, raise);
        // casting to 'uint160' is safe because the library accepted this √price (below MAX_SQRT_PRICE)
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 tick = TickMath.getTickAtSqrtPrice(uint160(BoxLayoutV1.floorSqrt(ratioX192)));
        assertEq(c.tickLower + BoxSpecV1.CURVE_SPAN_TICKS / 2, _nearest60(tick), "the centre");
        // T: issuance split exactly; about 80% on the curve.
        assertEq(c.curveT + c.poolShare, BoxSpecV1.ISSUANCE);
        assertApproxEqRel(
            c.curveT, BoxSpecV1.CURVE_SHARE_TARGET, 0.005e18, "about 80% (the centre is rounded to 60 ticks)"
        );
        // Q: the fully crossed curve returns exactly the raise when removed (rounded down), from the least such L.
        assertEq(_qAmount(c, c.liquidity, false), raise, "a removal pays exactly R");
        assertLt(_qAmount(c, c.liquidity - 1, false), raise, "the least such liquidity");
        // Box's side: a full cross in one step pays at least R (v4's SwapMath rounds the input up), at most R + 1.
        (uint160 next, uint256 qIn, uint256 tOut,) = SwapMath.computeSwapStep(
            c.sqrtPriceStartX96, c.sqrtPriceEndX96, c.liquidity, -int256(raise * 2 + 1e18), FEE
        );
        assertEq(next, c.sqrtPriceEndX96, "the cross reaches P1");
        assertGe(qIn, raise, "a full cross pays at least R");
        assertLe(qIn, raise + 1);
        assertLe(tOut, c.curveT, "never more T than the deposit");
        assertGe(tOut + 1, c.curveT, "and at most a raw unit less");
        // The deposit is what an add charges: curveT = T rounded up, so the curve holds what a removal at P0 pays.
        assertEq(c.curveT, _tAmount(c, c.liquidity, true));
        assertGe(c.curveT, _tAmount(c, c.liquidity, false));
        // LiquidityAmounts gives the same L to one unit.
        uint128 la = c.tIsCurrency0
            ? LiquidityAmounts.getLiquidityForAmount1(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, raise)
            : LiquidityAmounts.getLiquidityForAmount0(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, raise);
        assertLe(c.liquidity > la ? c.liquidity - la : la - c.liquidity, 2, "LiquidityAmounts within 2 units");
        overpay = qIn - raise;
    }

    /// @dev A full cross in `chunks` exact-input steps of v4's SwapMath (no tick crossed inside: one range).
    function _crossInChunks(BoxLayoutV1.Curve memory c, uint256 raise, uint256 chunks)
        internal
        pure
        returns (uint256 qIn, uint256 tOut)
    {
        uint160 p = c.sqrtPriceStartX96;
        for (uint256 i; i < chunks && p != c.sqrtPriceEndX96; ++i) {
            uint256 gross = i + 1 == chunks ? raise * 2 + 1e18 : raise / chunks + 1;
            (uint160 next, uint256 a, uint256 b,) =
                SwapMath.computeSwapStep(p, c.sqrtPriceEndX96, c.liquidity, -int256(gross), FEE);
            p = next;
            qIn += a;
            tOut += b;
        }
        assertEq(p, c.sqrtPriceEndX96);
    }

    // ================================================================================================ P9.1

    /// P9.1 / BC-002: box 0's curve on the mainnet raise (native ETH as currency0) and on the rehearsal build's raise
    /// (R / 10): every property, and a cross in 1, 8 and 64 steps pays at least the raise.
    function testProperty_AUDIT_U9_box0CurveBothBuilds() public pure {
        uint256[2] memory raises = [R, R / 10];
        for (uint256 i; i < 2; ++i) {
            BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(raises[i], false);
            _checkCurve(c, raises[i]);
            uint256[3] memory steps = [uint256(1), 8, 64];
            for (uint256 k; k < 3; ++k) {
                (uint256 qIn, uint256 tOut) = _crossInChunks(c, raises[i], steps[k]);
                assertGe(qIn, raises[i], "any number of steps pays at least the raise");
                assertLe(tOut, c.curveT);
            }
        }
        // The build this suite runs on uses one of them.
        assertTrue(BoxBuildV1.RAISE == R || BoxBuildV1.RAISE == R / 10);
        BoxLayoutV1.Curve memory r = BoxLayoutV1.curve(R / 10, false);
        assertEq(r.tickUpper - r.tickLower, 26_880);
        assertEq(r.tickLower, 200_220, "the rehearsal curve: ticks 200,220 to 227,100");
    }

    /// P9.1 / BC-003 in any decimals and order: a raise anywhere from 10^8 raw units (100 units of a 6-decimal Q) to
    /// 8 × 10^26 (the curve share), both token orders: laid out with every property, or refused with a named error
    /// (never a wrong curve).
    function testFuzz_AUDIT_U9_curveRaisesExactlyR(uint256 raise, bool tIsC0) public view {
        raise = bound(raise, 1e8, 8e26);
        try harness.curve(raise, tIsC0) returns (BoxLayoutV1.Curve memory c) {
            _checkCurve(c, raise);
            (uint256 qIn, uint256 tOut) = _crossInChunks(c, raise, 1 + raise % 13);
            assertGe(qIn, raise);
            assertLe(tOut, c.curveT);
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            assertTrue(
                sel == BoxLayoutV1.NoExactLiquidity.selector || sel == BoxLayoutV1.CurveTooLarge.selector
                    || sel == BoxLayoutV1.CurveOutOfRange.selector || sel == BoxLayoutV1.CentreOutOfRange.selector,
                "a named refusal"
            );
        }
    }

    /// The feasible range in each order, pinned: 6-decimal raises (10^9 to 10^11 raw units) and 18-decimal raises
    /// (10^15 to 10^26) lay out in both orders; the refusals start only far outside the version's raises.
    function testProperty_AUDIT_U9_feasibleRaises() public {
        uint256[10] memory ok = [uint256(1e8), 1e9, 2.5e9, 1e10, 1e11, 1e15, 1e18, R, 1e24, 1e26];
        for (uint256 i; i < ok.length; ++i) {
            _checkCurve(harness.curve(ok[i], false), ok[i]);
            _checkCurve(harness.curve(ok[i], true), ok[i]);
        }
        // Q as currency1 at 1e40 raw: one unit of liquidity holds more than one raw Q (no exact L); tiny raises
        // overflow the price ratio (FullMath) in the Q-currency0 order.
        vm.expectRevert(abi.encodeWithSelector(BoxLayoutV1.NoExactLiquidity.selector, uint256(1e40)));
        harness.curve(1e40, false);
        vm.expectRevert();
        harness.curve(1, false);
    }

    // ============================================================================================ the graduated layout

    /// P9.1 / BC-067: both graduated layouts for any held Q and available T at P1: every unit is in a position or in
    /// the dust; the dust is below one unit of liquidity's worth of each side (+1 raw unit); the full-range bid of
    /// ASK_FULL_BID_SENTINEL never exceeds the ask's liquidity; every position's ticks are on the spacing and its
    /// liquidity is what LiquidityAmounts gives for its budget (capped).
    function testFuzz_AUDIT_U9_graduatedLayoutUsesThePoolShare(uint256 raise, bool tIsC0, uint256 qHeld, uint256 tAvail)
        public
        view
    {
        raise = bound(raise, 1e15, 1e26);
        BoxLayoutV1.Curve memory c = harness.curve(raise, tIsC0);
        qHeld = bound(qHeld, 0, raise * 2);
        tAvail = bound(tAvail, 0, BoxSpecV1.ISSUANCE);
        for (uint8 layout = 1; layout <= 2; ++layout) {
            BoxLayoutV1.Graduated memory g = BoxLayoutV1.graduated(c, layout, qHeld, tAvail);
            assertEq(g.bid.amount + g.sentinel.amount + g.qDust, qHeld, "every Q unit placed or dust");
            assertEq(g.ask.amount + g.tDust, tAvail, "every T unit placed or dust");
            _checkDust(c, g, tIsC0);
            if (layout == BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL) {
                assertLe(g.bid.liquidity, g.ask.liquidity, "the full-range bid at most the ask's liquidity");
            }
            _checkTicks(g.bid);
            _checkTicks(g.sentinel);
            _checkTicks(g.ask);
        }
    }

    function _checkTicks(BoxLayoutV1.Position memory p) internal pure {
        assertEq(p.tickLower % 60, 0);
        assertEq(p.tickUpper % 60, 0);
        assertLt(p.tickLower, p.tickUpper);
        assertGe(p.tickLower, BoxSpecV1.MIN_USABLE_TICK);
        assertLe(p.tickUpper, BoxSpecV1.MAX_USABLE_TICK);
    }

    function _checkDust(BoxLayoutV1.Curve memory c, BoxLayoutV1.Graduated memory g, bool tIsC0) internal pure {
        // One unit of ask liquidity's T, rounded up: what the ask cannot take is less than it (+1).
        uint160 sqrtTEdge = TickMath.getSqrtPriceAtTick(tIsC0 ? BoxSpecV1.MAX_USABLE_TICK : BoxSpecV1.MIN_USABLE_TICK);
        uint256 tUnit = tIsC0
            ? SqrtPriceMath.getAmount0Delta(sqrtTEdge, c.sqrtPriceEndX96, 1, true)
            : SqrtPriceMath.getAmount1Delta(sqrtTEdge, c.sqrtPriceEndX96, 1, true);
        assertLe(g.tDust, tUnit + 1, "T dust below one unit of the ask");
        // Q: the sentinel takes what the bid left; its own unit bounds the Q dust (the bid's rounding goes to it).
        uint160 sqrtQEdge = TickMath.getSqrtPriceAtTick(tIsC0 ? BoxSpecV1.MIN_USABLE_TICK : BoxSpecV1.MAX_USABLE_TICK);
        uint256 qUnit = tIsC0
            ? SqrtPriceMath.getAmount1Delta(c.sqrtPriceStartX96, sqrtQEdge, 1, true)
            : SqrtPriceMath.getAmount0Delta(c.sqrtPriceStartX96, sqrtQEdge, 1, true);
        assertLe(g.qDust, qUnit + 1, "Q dust below one unit of the sentinel");
    }

    /// Box 0's own graduation inputs: the curve's R and the pool share: ASK_FULL_BID_SENTINEL places all of R (dust at
    /// most 1 wei) and all of the pool share but a dust the coordinator burns (BoxCoordinator.sol:256-257), measured
    /// here for both builds.
    function testProperty_AUDIT_U9_box0GraduatedDust() public pure {
        uint256[2] memory raises = [R, R / 10];
        for (uint256 i; i < 2; ++i) {
            BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(raises[i], false);
            BoxLayoutV1.Graduated memory g =
                BoxLayoutV1.graduated(c, BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL, raises[i], c.poolShare);
            assertLe(g.qDust, 1);
            _checkDust(c, g, false);
            assertLt(g.tDust, 25_000, "T dust: below 25,000 raw units of 1e27 (985 at R, 21,280 at R / 10)");
            console.log("raise", raises[i]);
            console.log("  ask liquidity", g.ask.liquidity);
            console.log("  bid liquidity", g.bid.liquidity);
            console.log("  sentinel liquidity", g.sentinel.liquidity);
            console.log("  qDust", g.qDust);
            console.log("  tDust", g.tDust);
        }
    }

    /// floorSqrt (the centre's √, BoxLayoutV1.sol:105-116, written here instead of imported) equals the exact integer
    /// square root on every shape of input: around squares, powers of two and the type's maximum.
    function testFuzz_AUDIT_U9_floorSqrtExact(uint128 r, uint8 delta) public pure {
        uint256 sq = uint256(r) * uint256(r);
        assertEq(BoxLayoutV1.floorSqrt(sq), r);
        // Just below a square: r - 1 for any distance up to 2r - 1 (the gap to the square before).
        if (delta > 0 && uint256(delta) <= 2 * uint256(r) - (r == 0 ? 0 : 1)) {
            assertEq(BoxLayoutV1.floorSqrt(sq - delta), r - 1);
        }
        // Just below the next square: still r.
        if (r < type(uint128).max) assertEq(BoxLayoutV1.floorSqrt((uint256(r) + 1) * (uint256(r) + 1) - 1), r);
    }
}
