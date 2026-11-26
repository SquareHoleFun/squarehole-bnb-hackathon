// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";

/// @title AuditU9FableLayout
/// @notice SH-AUDIT-B0-U9 (Fable 5.1), lenses L1 (P9.1), L6 (P9.6) and L7: `BoxLayoutV1` raises exactly R in any
/// token decimals and currency order, with the rounding on the box's side; the graduated layout uses exactly the pool
/// share; its ticks and liquidity agree with the pinned v4 maths at every tick it produces; the feasible raise band.
/// The rehearsal build's raise (R / 10, F78) is laid out here on the default build's library: the library reads no
/// build constant (only BoxSpecV1's fixed values), so the two builds compute the same curve for the same raise.
/// @dev Sources: BC-002, BC-003 (`BoxLayoutV1.sol:10-36`), F78 (build profiles), BC-067 (ASK_FULL_BID_SENTINEL).
contract AuditU9FableLayoutTest is Test {
    uint256 internal constant R = 4_206_980_085_000_000_000;
    uint256 internal constant R_REHEARSAL = 420_698_008_500_000_000;
    /// @dev Below it, 8e26 x 2^192 / raise does not fit 256 bits (T as currency1): FullMath refuses.
    uint256 internal constant SMALLEST_RAISE_T_IS_C1 = 43_368_087;

    function curveExt(uint256 raise, bool tIsC0) external pure returns (BoxLayoutV1.Curve memory) {
        return BoxLayoutV1.curve(raise, tIsC0);
    }

    // ================================================================================================ L1: exactly R

    /// F78 / BC-002: the rehearsal build's raise (R / 10) and mainnet's lay out exactly in both orders; the rehearsal
    /// curve is a different curve (another centre) that still holds its raise to the wei.
    function testProperty_AUDIT_U9_rehearsalAndMainnetRaisesLayOutExactly() public pure {
        BoxLayoutV1.Curve memory m = BoxLayoutV1.curve(R, false);
        BoxLayoutV1.Curve memory r = BoxLayoutV1.curve(R_REHEARSAL, false);
        _exact(m, R, false);
        _exact(r, R_REHEARSAL, false);
        _exact(BoxLayoutV1.curve(R, true), R, true);
        _exact(BoxLayoutV1.curve(R_REHEARSAL, true), R_REHEARSAL, true);
        assertEq(m.tickLower, 177_180);
        assertEq(m.tickUpper, 204_060);
        assertEq(r.tickLower, 200_220, "the rehearsal's centre is 23,040 ticks higher (10x the T per Q)");
        assertEq(r.tickUpper, 227_100);
        assertTrue(r.liquidity != m.liquidity);
        assertApproxEqRel(r.curveT, m.curveT, 0.01e18, "about the same 80 % of T on the curve");
    }

    /// BC-003: any raise from 1e8 raw units (a 6-decimal Q below 100 units, an 18-decimal Q of a tenth of a gwei) to
    /// 1e26 (100 million 18-decimal units), in both orders, is raised exactly with the smallest liquidity; a full
    /// crossing charges at least the raise (rounded up against the swapper), the removal pays exactly it (rounded
    /// down), the curve T charged at creation is rounded up; the split sums to the issuance; the start is the T-only
    /// edge.
    function testFuzz_AUDIT_U9_anyDecimalsAndOrderRaiseExactly(uint256 raise, bool tIsC0) public pure {
        raise = bound(raise, 1e8, 1e26);
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(raise, tIsC0);
        _exact(c, raise, tIsC0);
    }

    function _exact(BoxLayoutV1.Curve memory c, uint256 raise, bool tIsC0) internal pure {
        assertEq(c.tIsCurrency0, tIsC0);
        assertEq(c.raise, raise);
        assertEq(c.tickUpper - c.tickLower, BoxSpecV1.CURVE_SPAN_TICKS);
        assertEq(c.tickLower % 60, 0);
        assertGe(c.tickLower, BoxSpecV1.MIN_USABLE_TICK);
        assertLe(c.tickUpper, BoxSpecV1.MAX_USABLE_TICK);
        assertEq(c.curveT + c.poolShare, BoxSpecV1.ISSUANCE);
        assertLt(c.curveT, BoxSpecV1.ISSUANCE);
        assertEq(_q(c, c.liquidity, false), raise, "the removal pays exactly the raise");
        assertLt(_q(c, c.liquidity - 1, false), raise, "the smallest liquidity");
        assertGe(_q(c, c.liquidity, true), raise, "a full crossing pays at least the raise");
        assertLe(_q(c, c.liquidity, true) - raise, 1, "by at most a wei");
        assertEq(c.curveT, _t(c, c.liquidity, true), "curve T is the add's charge, rounded up");
        assertLe(c.curveT - _t(c, c.liquidity, false), 1);
        assertEq(c.tickStart, tIsC0 ? c.tickLower : c.tickUpper, "the start holds T only");
        assertEq(c.tickEnd, tIsC0 ? c.tickUpper : c.tickLower);
        assertEq(c.sqrtPriceStartX96, tIsC0 ? c.sqrtPriceLowerX96 : c.sqrtPriceUpperX96);
        assertEq(c.sqrtPriceEndX96, tIsC0 ? c.sqrtPriceUpperX96 : c.sqrtPriceLowerX96);
        // The start edge holds no Q and the end edge no T: the whole raise sits between the two edges.
        assertEq(c.sqrtPriceLowerX96, TickMath.getSqrtPriceAtTick(c.tickLower));
        assertEq(c.sqrtPriceUpperX96, TickMath.getSqrtPriceAtTick(c.tickUpper));
    }

    function _q(BoxLayoutV1.Curve memory c, uint128 l, bool roundUp) internal pure returns (uint256) {
        return c.tIsCurrency0
            ? SqrtPriceMath.getAmount1Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, roundUp)
            : SqrtPriceMath.getAmount0Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, roundUp);
    }

    function _t(BoxLayoutV1.Curve memory c, uint128 l, bool roundUp) internal pure returns (uint256) {
        return c.tIsCurrency0
            ? SqrtPriceMath.getAmount0Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, roundUp)
            : SqrtPriceMath.getAmount1Delta(c.sqrtPriceLowerX96, c.sqrtPriceUpperX96, l, roundUp);
    }

    /// The decimals enter only through the raw raise: 4,206.98 units of a 6-decimal, an 8-decimal, a 12-decimal, an
    /// 18-decimal and a 20-decimal Q are five different curves, each exact in both orders. Outside the band the
    /// library refuses rather than rounds: 4,206.98 units of a 2-decimal Q (420,698 raw) overflow the 80 % ratio with T
    /// as currency1 (it lays out with T as currency0), and 4,206.98 units of a 30-decimal Q (4.2e33 raw) have no exact
    /// liquidity in either order.
    function testProperty_AUDIT_U9_anyTokenDecimals() public {
        uint256[5] memory raises = [uint256(4_206_980_085), 420_698_008_500, 4_206_980_085e6, R, 4_206_980_085e11];
        for (uint256 i; i < 5; ++i) {
            _exact(BoxLayoutV1.curve(raises[i], false), raises[i], false);
            _exact(BoxLayoutV1.curve(raises[i], true), raises[i], true);
        }
        vm.expectRevert();
        this.curveExt(420_698, false);
        _exact(BoxLayoutV1.curve(420_698, true), 420_698, true);
        vm.expectRevert(abi.encodeWithSelector(BoxLayoutV1.NoExactLiquidity.selector, uint256(4_206_980_085e24)));
        this.curveExt(4_206_980_085e24, false);
        vm.expectRevert(abi.encodeWithSelector(BoxLayoutV1.NoExactLiquidity.selector, uint256(4_206_980_085e24)));
        this.curveExt(4_206_980_085e24, true);
    }

    /// The feasible band: with T as currency1 the smallest raise is 43,368,087 raw units (below it FullMath refuses
    /// 8e26 x 2^192 / raise); with T as currency0 a raise of 1 raw unit lays out; 1e40 has no exact liquidity in either
    /// order; 2^255 and 2^256 - 1 are refused (CentreOutOfRange or FullMath). None of these is on any version's menu
    /// (BC-127): the pins document the maths, not a reachable state.
    function testProperty_AUDIT_U9_feasibleRaiseBand() public {
        vm.expectRevert();
        this.curveExt(SMALLEST_RAISE_T_IS_C1 - 1, false);
        _exact(BoxLayoutV1.curve(SMALLEST_RAISE_T_IS_C1, false), SMALLEST_RAISE_T_IS_C1, false);
        _exact(BoxLayoutV1.curve(1, true), 1, true);
        _exact(BoxLayoutV1.curve(2, true), 2, true);
        vm.expectRevert(abi.encodeWithSelector(BoxLayoutV1.NoExactLiquidity.selector, uint256(1e40)));
        this.curveExt(1e40, false);
        vm.expectRevert(abi.encodeWithSelector(BoxLayoutV1.NoExactLiquidity.selector, uint256(1e40)));
        this.curveExt(1e40, true);
        vm.expectRevert(abi.encodeWithSelector(BoxLayoutV1.CentreOutOfRange.selector, uint256(9313)));
        this.curveExt(1 << 255, false);
        vm.expectRevert();
        this.curveExt(1 << 255, true);
        vm.expectRevert(abi.encodeWithSelector(BoxLayoutV1.CentreOutOfRange.selector, uint256(6585)));
        this.curveExt(type(uint256).max, false);
        vm.expectRevert();
        this.curveExt(type(uint256).max, true);
        vm.expectRevert(BoxLayoutV1.RaiseIsZero.selector);
        this.curveExt(0, true);
        // The smallest raise's cause is the ratio's size: 8e26 x 2^192 / 43,368,086 overflows, / 43,368,087 fits.
        assertGe(FullMath.mulDiv(BoxSpecV1.CURVE_SHARE_TARGET, 1 << 192, SMALLEST_RAISE_T_IS_C1), 1 << 255);
        vm.expectRevert();
        this.mulDivExt(BoxSpecV1.CURVE_SHARE_TARGET, 1 << 192, SMALLEST_RAISE_T_IS_C1 - 1);
    }

    function mulDivExt(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return FullMath.mulDiv(a, b, d);
    }

    // ================================================================================================ L1: graduated

    /// BC-067 / L7: for any raise in the band, both orders, a curve holding any Q between half and all of the raise
    /// and any T from the pool share up to the pool share plus the curve's T (sells back): the ask takes exactly the
    /// pool share less a dust below one liquidity unit's T (its liquidity is the largest the T funds: one more unit
    /// would need more T), the Q positions take all of qHeld less a dust below one liquidity unit's Q of each
    /// position, nothing is taken twice, and ASK_FULL_BID_SENTINEL's bid never exceeds the ask's liquidity.
    function testFuzz_AUDIT_U9_graduatedUsesExactlyThePoolShare(uint256 raise, bool tIsC0, uint256 qSeed, uint256 tSeed)
        public
        pure
    {
        raise = bound(raise, 1e8, 1e26);
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(raise, tIsC0);
        uint256 qHeld = bound(qSeed, raise / 2, raise);
        uint256 tAvail = c.poolShare + bound(tSeed, 0, c.curveT);
        for (uint8 layout = 1; layout <= 2; ++layout) {
            BoxLayoutV1.Graduated memory g = BoxLayoutV1.graduated(c, layout, qHeld, tAvail);
            assertEq(g.gradLayout, layout);
            assertEq(g.bid.amount + g.sentinel.amount + g.qDust, qHeld, "all of qHeld has a place");
            assertEq(g.ask.amount + g.tDust, tAvail, "all of the T has a place");
            _checkAsk(c, g, tAvail);
            _checkQPositions(c, g, layout, qHeld);
        }
    }

    /// @dev The ask: the largest liquidity the T funds, from P1 to the T-side edge; dust below one unit's T.
    function _checkAsk(BoxLayoutV1.Curve memory c, BoxLayoutV1.Graduated memory g, uint256 tAvail) internal pure {
        bool tIsC0 = c.tIsCurrency0;
        int24 tEdge = tIsC0 ? BoxSpecV1.MAX_USABLE_TICK : BoxSpecV1.MIN_USABLE_TICK;
        uint160 sqrtTEdge = TickMath.getSqrtPriceAtTick(tEdge);
        uint128 askL = tIsC0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtTEdge, c.sqrtPriceEndX96, tAvail)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtTEdge, c.sqrtPriceEndX96, tAvail);
        assertEq(g.ask.liquidity, askL);
        assertEq(g.ask.tickLower, c.tickEnd < tEdge ? c.tickEnd : tEdge);
        assertEq(g.ask.tickUpper, c.tickEnd < tEdge ? tEdge : c.tickEnd);
        assertGt(_tAt(sqrtTEdge, c.sqrtPriceEndX96, askL + 1, tIsC0), tAvail, "one more unit needs more T");
        assertLe(g.tDust, _tAt(sqrtTEdge, c.sqrtPriceEndX96, 1, tIsC0) + 1, "dust below one unit's T");
        if (g.gradLayout == 2) assertLe(g.bid.liquidity, askL, "the bid at most the ask's liquidity");
    }

    /// @dev The Q positions: their ranges, liquidity funded by their budgets, dust below one unit's Q of each.
    function _checkQPositions(BoxLayoutV1.Curve memory c, BoxLayoutV1.Graduated memory g, uint8 layout, uint256 qHeld)
        internal
        pure
    {
        bool tIsC0 = c.tIsCurrency0;
        int24 qEdge = tIsC0 ? BoxSpecV1.MIN_USABLE_TICK : BoxSpecV1.MAX_USABLE_TICK;
        uint160 sqrtQEdge = TickMath.getSqrtPriceAtTick(qEdge);
        uint256 unitBid = layout == 1
            ? _qAt(c.sqrtPriceEndX96, c.sqrtPriceStartX96, 1, tIsC0)
            : _qAt(c.sqrtPriceEndX96, sqrtQEdge, 1, tIsC0);
        uint256 unitSentinel = _qAt(c.sqrtPriceStartX96, sqrtQEdge, 1, tIsC0);
        assertLe(g.qDust, unitBid + unitSentinel + 2, "dust below one unit's Q per position");
        if (layout == 2) {
            assertEq(g.bid.tickLower, c.tickEnd < qEdge ? c.tickEnd : qEdge);
            assertEq(g.bid.tickUpper, c.tickEnd < qEdge ? qEdge : c.tickEnd);
        } else {
            assertEq(g.bid.tickLower, c.tickLower, "b' bids on the curve's range");
            assertEq(g.bid.tickUpper, c.tickUpper);
            assertLe(g.bid.amount, qHeld * 99 / 100, "99 % of the Q at most");
        }
        assertEq(g.sentinel.tickLower, c.tickStart < qEdge ? c.tickStart : qEdge);
        assertEq(g.sentinel.tickUpper, c.tickStart < qEdge ? qEdge : c.tickStart);
        assertLe(g.sentinel.amount, qHeld - g.bid.amount);
    }

    function _tAt(uint160 a, uint160 b, uint128 l, bool tIsC0) internal pure returns (uint256) {
        return tIsC0 ? SqrtPriceMath.getAmount0Delta(a, b, l, true) : SqrtPriceMath.getAmount1Delta(a, b, l, true);
    }

    function _qAt(uint160 a, uint160 b, uint128 l, bool tIsC0) internal pure returns (uint256) {
        return tIsC0 ? SqrtPriceMath.getAmount1Delta(a, b, l, true) : SqrtPriceMath.getAmount0Delta(a, b, l, true);
    }

    /// Box 0's own graduated layout of the fully crossed curve holds all of R with no Q dust and 985 raw T of dust
    /// (the existing tests' figures, pinned here with the library's own sums).
    function testProperty_AUDIT_U9_box0GraduatedHoldsAllOfR() public pure {
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(R, false);
        BoxLayoutV1.Graduated memory g =
            BoxLayoutV1.graduated(c, BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL, R, c.poolShare);
        assertEq(g.bid.amount + g.sentinel.amount + g.qDust, R);
        assertEq(g.qDust, 0);
        assertEq(g.tDust, 985);
        assertEq(g.ask.amount + 985, c.poolShare);
    }

    // ================================================================================================ L6: v4 maths

    /// P9.6: every tick the library produces round-trips through TickMath (the greatest tick whose price is at most
    /// the edge's price is the edge's tick; the edge's price is the tick's price), sits on the hook's spacing inside
    /// the usable range TickMath defines for spacing 60, and the centre is the nearest multiple of 60 (ties up) of the
    /// tick of the 80 % price; `floorSqrt` is the floor square root.
    function testFuzz_AUDIT_U9_ticksAgreeWithTickMath(uint256 raise, bool tIsC0) public pure {
        raise = bound(raise, 1e8, 1e26);
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(raise, tIsC0);
        assertEq(TickMath.getTickAtSqrtPrice(c.sqrtPriceLowerX96), c.tickLower);
        assertEq(TickMath.getTickAtSqrtPrice(c.sqrtPriceUpperX96), c.tickUpper);
        assertEq(TickMath.getTickAtSqrtPrice(c.sqrtPriceLowerX96 - 1), c.tickLower - 1);
        assertEq(TickMath.getTickAtSqrtPrice(c.sqrtPriceUpperX96 - 1), c.tickUpper - 1);
        assertEq(TickMath.minUsableTick(BoxSpecV1.TICK_SPACING), BoxSpecV1.MIN_USABLE_TICK);
        assertEq(TickMath.maxUsableTick(BoxSpecV1.TICK_SPACING), BoxSpecV1.MAX_USABLE_TICK);
        // The centre, recomputed.
        uint256 ratio = tIsC0
            ? FullMath.mulDiv(raise, 1 << 192, BoxSpecV1.CURVE_SHARE_TARGET)
            : FullMath.mulDiv(BoxSpecV1.CURVE_SHARE_TARGET, 1 << 192, raise);
        uint256 sqrtP = BoxLayoutV1.floorSqrt(ratio);
        assertLe(sqrtP * sqrtP, ratio);
        assertGt((sqrtP + 1) * (sqrtP + 1), ratio);
        int24 tick = TickMath.getTickAtSqrtPrice(uint160(sqrtP));
        int24 rem = tick % 60;
        if (rem < 0) rem += 60;
        int24 centre = rem >= 30 ? tick - rem + 60 : tick - rem;
        assertEq(BoxLayoutV1.centreTick(raise, tIsC0), centre);
        assertEq(c.tickLower, centre - 13_440);
        assertEq(c.tickUpper, centre + 13_440);
        assertLe(
            int256(centre) - int256(tick) < 0 ? int256(tick) - int256(centre) : int256(centre) - int256(tick),
            30,
            "nearest multiple"
        );
    }

    /// Execution gas of the layout for box 0's raise stays a creation-time cost far below the EIP-7825 cap (the
    /// bisection runs 128 steps of SqrtPriceMath).
    function testProperty_AUDIT_U9_layoutGas() public {
        uint256 g0 = gasleft();
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(R, false);
        uint256 curveGas = g0 - gasleft();
        g0 = gasleft();
        BoxLayoutV1.graduated(c, BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL, R, c.poolShare);
        uint256 gradGas = g0 - gasleft();
        emit log_named_uint("curve(R) gas", curveGas);
        emit log_named_uint("graduated(ASK_FULL_BID_SENTINEL) gas", gradGas);
        assertLt(curveGas, 600_000);
        assertLt(gradGas, 100_000);
    }
}
