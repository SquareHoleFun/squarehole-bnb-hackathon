// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Slot0} from "v4-core/src/types/Slot0.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapBounds} from "../../../src/box/libraries/BoxSwapBounds.sol";
import {BoxTestToken, CurveDriver} from "../BoxLayoutV1Swaps.t.sol";
import {SettablePriceAverage} from "./BoxS45Mocks.sol";

/// @notice TEST ONLY: exposes the library's internal functions (they are inlined into each caller).
contract BoundsHarness {
    function referenceTick(bool buy, int24 a, int24 s) external pure returns (int24) {
        return BoxSwapBounds.referenceTick(buy, a, s);
    }

    function stepLimit(bool buy, uint160 sqrtSpot, int24 refTick) external pure returns (uint160) {
        return BoxSwapBounds.stepLimit(buy, sqrtSpot, refTick);
    }

    function bandSqrtPrice(bool buy, int24 refTick) external pure returns (uint160) {
        return BoxSwapBounds.bandSqrtPrice(buy, refTick);
    }

    function minOut(bool buy, uint256 amountIn, uint160 limit, uint24 fee) external pure returns (uint256) {
        return BoxSwapBounds.minOut(buy, amountIn, limit, fee);
    }

    function fees(uint24 lpFee, uint24 protocolFee, bool zeroForOne) external pure returns (uint24, uint24) {
        Slot0 s = Slot0.wrap(bytes32(0)).setLpFee(lpFee).setProtocolFee(protocolFee);
        return BoxSwapBounds.fees(s, zeroForOne);
    }

    function feeNote(uint256 amountIn, uint24 lpShare) external pure returns (uint256) {
        return BoxSwapBounds.feeNote(amountIn, lpShare);
    }

    function tipOf(uint256 q) external pure returns (uint256) {
        return BoxSwapBounds.tipOf(q);
    }

    function tInQ(uint256 t, int24 tick) external pure returns (uint256) {
        return BoxSwapBounds.tInQ(t, tick);
    }

    function stepDue(uint256 lastBlock) external view returns (bool) {
        return BoxSwapBounds.stepDue(lastBlock);
    }

    function readAverage(address avg) external returns (bool, int24, int24) {
        return BoxSwapBounds.readAverage(SettablePriceAverage(avg));
    }

    function stepInput(IPoolManager pm, bytes32 stateSlot, Slot0 s0, bool buy, uint160 limit, uint24 swapFee)
        external
        view
        returns (uint256)
    {
        return buy
            ? BoxSwapBounds.buyInput(pm, stateSlot, s0, limit, swapFee)
            : BoxSwapBounds.sellInput(pm, stateSlot, s0, limit, swapFee);
    }
}

/// @notice S5.M2's shared bounds library (BoxSwapBounds), checked against TickMath and FitBuybackExecutor's formulas:
/// the reference choice, the 49-tick impact, the 99-tick band, the minimum output, the fee report, the tip and the
/// cadence (BC-129, BC-135).
contract BoxSwapBoundsTest is Test {
    BoundsHarness internal h;
    uint256 internal constant Q96 = 1 << 96;

    function setUp() public {
        h = new BoundsHarness();
    }

    function test_BC129_constantsAreTheExecutorsReviewedBounds() public pure {
        assertEq(BoxSwapBounds.SQRT_IMPACT_DOWN_X96, TickMath.getSqrtPriceAtTick(-49), "1.0001^(-49/2) in Q96");
        assertEq(BoxSwapBounds.SQRT_IMPACT_UP_X96, TickMath.getSqrtPriceAtTick(49), "1.0001^(+49/2) in Q96");
        assertEq(BoxSwapBounds.MAX_IMPACT_TICKS, BoxSpecV1.EXECUTOR_MAX_IMPACT_TICKS);
        assertEq(BoxSwapBounds.BAND_TICKS, BoxSpecV1.EXECUTOR_TWAP_BAND_TICKS);
        assertEq(BoxSwapBounds.SLACK, 4, "FitBuybackExecutor's _maxSwapSteps: 49 / 60 + 4");
    }

    function test_BC129_theReferenceOnlyTightens() public view {
        // Buys: the higher tick (cheaper T); sells: the lower (dearer T).
        assertEq(h.referenceTick(true, 100, 50), 100);
        assertEq(h.referenceTick(true, 50, 100), 100);
        assertEq(h.referenceTick(false, 100, 50), 50);
        assertEq(h.referenceTick(false, 50, 100), 50);
    }

    function testFuzz_BC129_theLimitIsTheNearerOfImpactAndBand(int24 spotTick, int24 offset, bool buy) public view {
        spotTick = int24(bound(spotTick, -800_000, 800_000));
        offset = int24(bound(offset, -300, 300));
        int24 refTick = spotTick + offset;
        uint160 sqrtSpot = TickMath.getSqrtPriceAtTick(spotTick);
        uint160 limit = h.stepLimit(buy, sqrtSpot, refTick);
        uint256 impact = buy
            ? FullMath.mulDivRoundingUp(sqrtSpot, TickMath.getSqrtPriceAtTick(-49), Q96)
            : FullMath.mulDiv(sqrtSpot, TickMath.getSqrtPriceAtTick(49), Q96);
        uint256 band = TickMath.getSqrtPriceAtTick(buy ? refTick - 99 : refTick + 99);
        uint256 want = buy ? (impact > band ? impact : band) : (impact < band ? impact : band);
        if (buy ? want >= sqrtSpot : want <= sqrtSpot) {
            assertEq(limit, 0, "no room: at the band");
        } else {
            assertEq(limit, want, "the nearer of the two to spot");
            if (buy) {
                assertLt(limit, sqrtSpot);
                assertGe(limit, impact, "never more than 49 ticks");
                assertGe(limit, band, "never beyond the band");
            } else {
                assertGt(limit, sqrtSpot);
                assertLe(limit, impact);
                assertLe(limit, band);
            }
        }
    }

    function test_BC129_theBandIsClampedToValidPrices() public view {
        assertEq(h.bandSqrtPrice(true, TickMath.MIN_TICK + 10), BoxSpecV1.EXECUTOR_MIN_SQRT_PRICE_X96);
        assertEq(h.bandSqrtPrice(false, TickMath.MAX_TICK - 10), TickMath.MAX_SQRT_PRICE - 1);
        assertEq(h.bandSqrtPrice(true, 1_000), TickMath.getSqrtPriceAtTick(901));
        assertEq(h.bandSqrtPrice(false, 1_000), TickMath.getSqrtPriceAtTick(1_099));
    }

    /// FitBuybackExecutor `_minFitOut` for buys, mirrored for sells.
    function testFuzz_BC129_minimumOutput(uint128 amountIn, int24 limitTick, bool buy) public view {
        limitTick = int24(bound(limitTick, -700_000, 700_000));
        uint160 limit = TickMath.getSqrtPriceAtTick(limitTick);
        uint256 net = FullMath.mulDiv(amountIn, 990_000, 1_000_000);
        uint256 want;
        if (net > 8) {
            uint256 out = buy
                ? FullMath.mulDiv(FullMath.mulDiv(net - 8, limit, Q96), limit, Q96)
                : FullMath.mulDiv(FullMath.mulDiv(net - 8, Q96, limit), Q96, limit);
            want = out > 4 ? out - 4 : 0;
        }
        assertEq(h.minOut(buy, amountIn, limit, 10_000), want);
    }

    function test_fees_protocolShareExcludedPerDirection() public view {
        (uint24 swapFee, uint24 lp) = h.fees(10_000, 0, true);
        assertEq(swapFee, 10_000);
        assertEq(lp, 10_000);
        // A protocol fee of 500 pips on zeroForOne (low 12 bits) and 300 on oneForZero (high 12 bits).
        uint24 pf = 500 | (300 << 12);
        (swapFee, lp) = h.fees(10_000, pf, true);
        assertEq(swapFee, 500 + 10_000 - 500 * 10_000 / 1_000_000);
        assertEq(lp, swapFee - 500);
        (swapFee, lp) = h.fees(10_000, pf, false);
        assertEq(swapFee, 300 + 10_000 - 300 * 10_000 / 1_000_000);
        assertEq(lp, swapFee - 300);
    }

    function test_feeNote_lessTwoUnitsPerPossibleSwapStep() public view {
        assertEq(h.feeNote(1 ether, 10_000), 0.01 ether - 8);
        assertEq(h.feeNote(800, 10_000), 0, "never negative");
    }

    function test_BC135_tipIsFivePercentCapped() public view {
        assertEq(h.tipOf(0.005 ether), 0.00025 ether);
        assertEq(h.tipOf(0.01 ether), 0.0005 ether);
        assertEq(h.tipOf(1 ether), 0.0005 ether, "FEE_BATCH_TIP_MAX_ETH");
        assertEq(h.tipOf(0), 0);
    }

    function test_tInQ_valuesTAtTheTick() public view {
        assertEq(h.tInQ(1 ether, 0), 1 ether, "tick 0: 1 T per Q");
        // 1.0001^177180 T per Q (graduation's P1 for the one raise): 0.005 ETH is about 248,000 T.
        uint256 q = h.tInQ(248_000e18, 177_180);
        assertApproxEqRel(q, 0.005 ether, 0.01e18);
    }

    function test_BC129_oneStepPerBlock() public {
        vm.roll(100);
        assertTrue(h.stepDue(0), "never stepped");
        assertTrue(h.stepDue(99));
        assertFalse(h.stepDue(100), "this block's step is used");
    }

    function test_readAverage_aFailingSourceReadsAsNotReady() public {
        SettablePriceAverage a = new SettablePriceAverage();
        a.set(true, 7, 9);
        (bool ready, int24 t, int24 s) = h.readAverage(address(a));
        assertTrue(ready);
        assertEq(t, 7);
        assertEq(s, 9);
        assertEq(a.pokes(), 1, "poked first");
        a.setRevert(true);
        (ready,,) = h.readAverage(address(a));
        assertFalse(ready, "a reverting poke");
        a.setRevert(false);
        a.set(false, 7, 9);
        (ready,,) = h.readAverage(address(a));
        assertFalse(ready, "no full window");
    }

    // ------------------------------------------------------------------------------------------------------------
    // S5 review (findings 1 and 2): the room one step can spend before its limit, on a plain pool whose liquidity
    // changes at several ticks (a box's own layout changes it only at P0 and the usable range's ends)

    /// `buyInput` and `sellInput` are what a real exact-input swap to the same limit spends, never more and short by at
    /// most a few raw units of rounding: spot landed exactly on any tick in [-700, 700] from either side (so a step
    /// from a tick v4 has or has not crossed yet), then a step of 1-49 ticks either way, across ticks whose
    /// liquidityNet is positive, negative or zero.
    function testFuzz_BC129_stepInputCrossesTicksAsV4Does(int256 target, int256 via, uint256 ticks, bool buy) public {
        Plain memory p = _plainPool();
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 to = int24(bound(target, -700, 700));
        // forge-lint: disable-next-line(unsafe-typecast)
        _land(p, to + int24(bound(via, -60, 60)));
        _land(p, to);
        Slot0 s0 = Slot0.wrap(p.pm.extsload(p.slot));
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 d = int24(int256(bound(ticks, 1, 49)));
        int24 spot = TickMath.getTickAtSqrtPrice(s0.sqrtPriceX96());
        uint160 limit = TickMath.getSqrtPriceAtTick(buy ? spot - d : spot + d);
        uint256 est = h.stepInput(p.pm, p.slot, s0, buy, limit, 10_000);
        BalanceDelta delta = p.driver.swap(p.key, SwapParams(buy, -1e27, limit));
        assertEq(Slot0.wrap(p.pm.extsload(p.slot)).sqrtPriceX96(), limit, "fixture: the swap reached its limit");
        uint256 real = uint256(uint128(-(buy ? delta.amount0() : delta.amount1())));
        assertLe(est, real, "never more than the swap spends");
        assertLe(real - est, 6, "short of it by rounding only");
    }

    struct Plain {
        IPoolManager pm;
        CurveDriver driver;
        PoolKey key;
        bytes32 slot;
    }

    /// ETH against a plain token at 1% and spacing 60, no hook, at tick 0, with liquidity starting or ending at -1200,
    /// -480, -240, -120, 60, 600 and 1200.
    function _plainPool() internal returns (Plain memory p) {
        p.pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        p.driver = new CurveDriver(p.pm);
        BoxTestToken t = new BoxTestToken(18);
        p.key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(t)), 10_000, 60, IHooks(address(0)));
        p.pm.initialize(p.key, TickMath.getSqrtPriceAtTick(0));
        p.slot = StateLibrary._getPoolStateSlot(p.key.toId());
        vm.deal(address(p.driver), 1e30);
        t.mint(address(p.driver), 1e30);
        p.driver.modify(p.key, -1200, 1200, 1e21);
        p.driver.modify(p.key, -120, 60, 6e20);
        p.driver.modify(p.key, 60, 600, 2.5e20);
        p.driver.modify(p.key, -480, -240, 4e20);
    }

    /// Spot moved to exactly `tick`'s √price, by a buy from above or a sell from below.
    function _land(Plain memory p, int24 tick) internal {
        uint160 s = TickMath.getSqrtPriceAtTick(tick);
        uint160 cur = Slot0.wrap(p.pm.extsload(p.slot)).sqrtPriceX96();
        if (s != cur) p.driver.swap(p.key, SwapParams(s < cur, -1e27, s));
    }
}
