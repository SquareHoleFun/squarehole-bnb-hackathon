// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxHook} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxLaunchRouter} from "../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {BoxPhase, FeeBatch} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxS45Base} from "./BoxS45Base.sol";
import {BoxForcer} from "./BoxS45Mocks.sol";
import {OpenTime} from "../utils/OpenTime.sol";

/// @notice S4: close on fill (D1; BC-025, BC-096), the P0 floor, the graduated layout (L7; BC-067), forcing (BC-029)
/// and the D6 reserve.
contract BoxHookCurveTest is BoxS45Base {
    using StateLibrary for IPoolManager;

    bytes32 internal constant MIGRATED_TOPIC =
        keccak256("Migrated(bytes32,uint256,uint256,uint128,uint128,uint128,uint256,uint256)");

    function setUp() public {
        _setUpWorld();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Filling the curve to a chosen share of the raise (by ETH held)

    /// @dev Buys until the curve holds `fillPpm` / 10^6 of the raise (its principal Q).
    function _fillTo(Box memory b, uint256 fillPpm) internal {
        uint256 target = b.raise * fillPpm / 1e6;
        uint256 held = _curveQ(b);
        if (target <= held) return;
        uint160 limit = SqrtPriceMath.getNextSqrtPriceFromInput(_sqrtP(b), b.curve.liquidity, target - held, true);
        _buy(b, alice, 2 * b.raise, limit);
    }

    /// @dev The T left on the curve between P1 and the price.
    function _curveTLeft(Box memory b) internal view returns (uint256) {
        return SqrtPriceMath.getAmount1Delta(b.curve.sqrtPriceLowerX96, _sqrtP(b), b.curve.liquidity, false);
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-025: the closing buy closes the curve

    function test_BC025_closesExactlyAtP1_fill21() public {
        _closeCase(210_000, 0);
    }

    function test_BC025_closesExactlyAtP1_fill70() public {
        _closeCase(700_000, 0);
    }

    function test_BC025_closesExactlyAtP1_fill98() public {
        _closeCase(980_000, 0);
    }

    function test_BC025_exactInputOvershoot_fill21() public {
        _closeCase(210_000, 1);
    }

    function test_BC025_exactInputOvershoot_fill70() public {
        _closeCase(700_000, 1);
    }

    function test_BC025_exactInputOvershoot_fill98() public {
        _closeCase(980_000, 1);
    }

    function test_BC025_exactOutput_fill21() public {
        _closeCase(210_000, 2);
    }

    function test_BC025_exactOutput_fill70() public {
        _closeCase(700_000, 2);
    }

    function test_BC025_exactOutput_fill98() public {
        _closeCase(980_000, 2);
    }

    /// @param kind 0: exact input with P1 as the limit; 1: exact input with the extreme limit (the Universal Router's
    /// exact-input close: it runs past P1 across empty ticks and pays only for the T it got); 2: exact output for
    /// more T than the curve has left, limited at P1.
    function _closeCase(uint256 fillPpm, uint256 kind) internal {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _fillTo(b, fillPpm);
        uint256 qBefore = _curveQ(b);
        uint256 tLeft = _curveTLeft(b);
        vm.deal(bob, 10 * b.raise);
        uint256 e0 = bob.balance;
        vm.recordLogs();
        uint256 g = gasleft();
        vm.prank(bob);
        if (kind == 0) {
            swapper.swap{value: 2 * b.raise}(b.key, true, -int256(2 * b.raise), b.curve.sqrtPriceLowerX96);
        } else if (kind == 1) {
            swapper.swap{value: 2 * b.raise}(b.key, true, -int256(2 * b.raise), 0);
        } else {
            swapper.swap{value: 2 * b.raise}(b.key, true, int256(tLeft + 1e18), b.curve.sqrtPriceLowerX96);
        }
        g -= gasleft();
        uint256 paid = e0 - bob.balance;
        assertTrue(b.hook.closed(), "the filling swap closed the curve");
        assertEq(b.hook.closedAtBlock(), block.number);
        assertEq(uint256(b.hook.phase()), uint256(BoxPhase.Closed));
        _assertCurveClosedLogged(b);
        // It paid only for the T it got: the curve's remaining Q (its principal) plus the 1% fee on the input.
        uint256 principal = b.raise - qBefore;
        assertApproxEqAbs(paid * 99 / 100, principal, principal / 100 + 10, "paid ~ principal / 0.99");
        assertApproxEqAbs(b.t.balanceOf(bob), tLeft, 1, "got the T the curve had left");
        if (kind == 1) assertLt(_sqrtP(b), b.curve.sqrtPriceLowerX96, "ran past P1 across empty ticks");
        else assertEq(_sqrtP(b), b.curve.sqrtPriceLowerX96, "stopped at P1");
        _assertEverySwapReverts(b);
        uint256 gg = gasleft();
        b.coord.graduate();
        gg -= gasleft();
        assertEq(_sqrtP(b), b.curve.sqrtPriceLowerX96, "graduate() returned the price to exactly P1");
        emit log_named_uint("close gas (swapper call)", g);
        emit log_named_uint("graduate gas", gg);
        // From graduation every route trades again.
        (uint256 got,) = _buy(b, alice, 0.1 ether, 0);
        assertGt(got, 0);
    }

    function _assertCurveClosedLogged(Box memory b) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("CurveClosed(bytes32,uint256,uint160)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(b.hook) && logs[i].topics[0] == topic) return;
        }
        revert("no CurveClosed");
    }

    /// Every swap reverts until graduate(): buys and sells, direct and through the router.
    function _assertEverySwapReverts(Box memory b) internal {
        bytes memory closedErr = _wrapped(
            address(b.hook),
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, block.number)
        );
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        vm.expectRevert(closedErr);
        swapper.swap{value: 0.01 ether}(b.key, true, -0.01 ether, 0);
        uint256 held = b.t.balanceOf(bob);
        vm.startPrank(bob);
        b.t.approve(address(swapper), type(uint256).max);
        vm.expectRevert(closedErr);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap(b.key, false, -int256(held / 2), 0);
        vm.stopPrank();
        _roll(1);
        closedErr = _wrapped(
            address(b.hook),
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, block.number - 1)
        );
        vm.prank(carol);
        vm.expectRevert(closedErr);
        swapper.swap{value: 0.01 ether}(b.key, true, -0.01 ether, 0);
    }

    /// A buy to P1 and a sell back inside one transaction (one unlock) is impossible: the sell reverts.
    function test_BC025_buyToP1AndSellBackInOneUnlockIsImpossible() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _fillTo(b, 500_000);
        BoxForcer f = new BoxForcer(pm, b.key, b.curve.sqrtPriceLowerX96);
        vm.deal(address(f), 10 ether);
        vm.expectRevert(
            _wrapped(
                address(b.hook),
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, block.number)
            )
        );
        f.roundTripInOneUnlock();
        assertFalse(b.hook.closed());
    }

    function test_curve_P0Floor() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        (uint256 bought,) = _buy(b, alice, 0.2 ether, 0);
        // More T than the curve has sold: the sell would end beyond P0, where the curve holds no Q.
        deal(address(b.t), bob, 3 * bought);
        vm.startPrank(bob);
        b.t.approve(address(swapper), type(uint256).max);
        vm.expectRevert(
            _wrapped(
                address(b.hook),
                IHooks.afterSwap.selector,
                abi.encodeWithSelector(IBoxHook.BelowCurveFloor.selector, TickMath.MAX_SQRT_PRICE - 1)
            )
        );
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap(b.key, false, -int256(3 * bought), 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-096: the curve closes inside the sniper window

    function test_BC096_closesInTheWindow_offset0() public {
        _windowClose(0);
    }

    function test_BC096_closesInTheWindow_offset16() public {
        _windowClose(16);
    }

    function test_BC096_closesInTheWindow_offset31() public {
        _windowClose(31);
    }

    function _windowClose(uint256 offset) internal {
        Box memory b = _buildAndLaunch(_box0Params());
        OpenTime.toStep(b.hook.openAt(), offset);
        uint256 pips = b.router.taxPips(offset);
        // The swap input that reaches P1, plus 0.5 ETH beyond it (net of tax), grossed up for the block's tax.
        uint256 needed = (b.raise - _curveQ(b)) * 100 / 99 + 1e15;
        uint256 swapIn = needed + 0.5 ether;
        uint256 qIn = swapIn * 1e6 / (1e6 - pips) + 1;
        vm.deal(bob, qIn);
        vm.recordLogs();
        vm.prank(bob);
        uint256 out = b.router.buy{value: qIn}(qIn, 0, bob, block.timestamp);
        assertTrue(b.hook.closed(), "closed in the window");
        (uint256 tax, uint256 refund) = _taxedBuyLog(b);
        uint256 spent = qIn - tax - refund;
        assertEq(tax, (spent * pips + (1e6 - pips) - 1) / (1e6 - pips), "tax only on the input that entered the curve");
        assertEq(bob.balance, refund, "the unspent input and its tax refunded in the same call");
        assertGt(refund, 0.5 ether, "at least the overshoot came back");
        assertEq(address(b.router).balance, tax, "the router holds only the tax");
        assertEq(b.t.balanceOf(bob), out);
        // The router-only gate ends at the close: graduate in the same block, then any route at the 1% alone.
        b.coord.graduate();
        (uint256 got,) = _buy(b, carol, 0.1 ether, 0);
        assertGt(got, 0, "a direct buy in the closing block after graduate()");
        _roll(1);
        (got,) = _buy(b, carol, 0.1 ether, 0);
        assertGt(got, 0, "and in the next block");
        vm.prank(carol);
        vm.deal(carol, 1 ether);
        if (offset < 31) vm.expectRevert(IBoxLaunchRouter.CurveIsClosed.selector);
        else vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.WindowClosed.selector, b.hook.windowEndsAt()));
        b.router.buy{value: 0.1 ether}(0.1 ether, 0, carol, block.timestamp);
    }

    function _taxedBuyLog(Box memory b) internal returns (uint256 tax, uint256 refund) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("TaxedBuy(address,address,uint256,uint256,uint256,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(b.router) && logs[i].topics[0] == topic) {
                (,, tax,, refund) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256));
                return (tax, refund);
            }
        }
        revert("no TaxedBuy");
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-067: the graduated layout is exact

    function test_BC067_layoutExact_box0_exactClose() public {
        _layoutCase(BOX0_RAISE, 0, 0);
    }

    function test_BC067_layoutExact_box0_overshoot() public {
        _layoutCase(BOX0_RAISE, 1, 0);
    }

    function test_BC067_layoutExact_1eth_afterSells() public {
        _layoutCase(1 ether, 0, 1);
    }

    function test_BC067_layoutExact_10eth() public {
        _layoutCase(10 ether, 1, 1);
    }

    function testFuzz_BC067_layoutExact(uint256 raiseSeed, uint256 overshoot) public {
        uint256[4] memory raises = [uint256(0.5 ether), 1 ether, BOX0_RAISE, 25 ether];
        _layoutCase(raises[raiseSeed % 4], overshoot % 2, overshoot % 3);
    }

    struct Mig {
        uint256 q;
        uint256 t;
        uint128 ask;
        uint128 bid;
        uint128 sentinel;
        uint256 pulled;
        uint256 dust;
    }

    function _layoutCase(uint256 raise_, uint256 overshoot, uint256 sells) internal {
        Params memory p = _box0Params();
        p.raise = raise_;
        Box memory b = _buildAndLaunch(p);
        _skipWindow(b);
        for (uint256 i; i < sells; ++i) {
            (uint256 t,) = _buy(b, alice, raise_ / 4, 0);
            _sell(b, alice, t / 3);
        }
        _buy(b, bob, 3 * raise_, overshoot == 1 ? 0 : b.curve.sqrtPriceLowerX96);
        assertTrue(b.hook.closed());
        uint256 poolShare = b.t.balanceOf(address(b.coord));
        vm.recordLogs();
        b.coord.graduate();
        Mig memory m = _migratedLog(b);
        assertEq(m.q, raise_, "the fully crossed curve held exactly the raise");
        BoxLayoutV1.Graduated memory g =
            BoxLayoutV1.graduated(b.curve, BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL, m.q, poolShare + m.t);
        assertEq(m.ask, g.ask.liquidity, "ask");
        assertEq(m.bid, g.bid.liquidity, "full-range bid");
        assertEq(m.sentinel, g.sentinel.liquidity, "bid sentinel");
        assertEq(m.dust, g.qDust, "Q dust");
        assertEq(m.pulled + m.t, g.ask.amount, "the ask took the curve's T and the pool share");
        _assertLayoutState(b, m);
    }

    function _assertLayoutState(Box memory b, Mig memory m) internal view {
        (uint128 a2, uint128 b2, uint128 s2) = b.hook.graduatedLayout();
        assertEq(a2, m.ask);
        assertEq(b2, m.bid);
        assertEq(s2, m.sentinel);
        assertEq(m.bid, m.ask, "the bid runs at the ask's liquidity (the raise funds it)");
        assertEq(_sqrtP(b), b.curve.sqrtPriceLowerX96, "exactly P1");
        // The pool's Q equals what the curve held: every position's Q plus the dust minted as fees.
        uint160 maxS = TickMath.getSqrtPriceAtTick(BoxSpecV1.MAX_USABLE_TICK);
        uint256 poolQ = SqrtPriceMath.getAmount0Delta(b.curve.sqrtPriceLowerX96, maxS, m.bid, true)
            + SqrtPriceMath.getAmount0Delta(b.curve.sqrtPriceUpperX96, maxS, m.sentinel, true);
        assertEq(poolQ + m.dust, m.q, "the pool holds all of R");
        assertEq(address(b.hook).balance, 0, "hook holds no ETH");
        assertEq(b.t.balanceOf(address(b.hook)), 0, "hook holds no T");
        assertEq(b.t.balanceOf(address(b.coord)), 0, "the pool share left the coordinator only into the pool");
        assertEq(b.hook.pairedLiquidity(), 0);
        (,, uint128 curveL) = b.hook.curve();
        assertEq(curveL, 0, "the curve is gone");
    }

    function _migratedLog(Box memory b) internal returns (Mig memory m) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(b.hook) && logs[i].topics[0] == MIGRATED_TOPIC) {
                (m.q, m.t, m.ask, m.bid, m.sentinel, m.pulled, m.dust) =
                    abi.decode(logs[i].data, (uint256, uint256, uint128, uint128, uint128, uint256, uint256));
                return m;
            }
        }
        revert("no Migrated");
    }

    function test_migrate_onlyCoordinatorOnlyClosedOnce() public {
        Box memory b = _buildAndLaunch(_box0Params());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IBoxHook.NotCoordinator.selector, alice));
        b.hook.migrate(1);
        vm.prank(address(b.coord));
        vm.expectRevert(IBoxHook.NotClosed.selector);
        b.hook.migrate(1);
        _skipWindow(b);
        _closeAndGraduate(b);
        vm.prank(address(b.coord));
        vm.expectRevert(IBoxHook.AlreadyMigrated.selector);
        b.hook.migrate(1);
    }

    // ------------------------------------------------------------------------------------------------------------
    // BC-029: forcing graduation is expensive (L7)

    function test_BC029_forcingCost_fill207() public {
        // Plan § 3.4's table: pool 1.507 ETH after, the curve 0.870 ETH before (the case's +0.637 is their rounded
        // difference); the model's three decimals are the tolerance of the margin.
        _forcing(207_000, 0.67 ether, 0.636 ether);
    }

    function test_BC029_forcingCost_fill701() public {
        _forcing(701_000, 0.121 ether, 0.108 ether);
    }

    function test_BC029_forcingCost_fill981() public {
        _forcing(981_000, 0.0019 ether, 0.0011 ether);
    }

    function _forcing(uint256 fillPpm, uint256 minCost, uint256 minMargin) internal {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _fillTo(b, fillPpm);
        uint256 qBefore = _curveQ(b);
        BoxForcer f = new BoxForcer(pm, b.key, b.curve.sqrtPriceLowerX96);
        vm.deal(address(f), 10 ether);
        (uint256 paid, uint256 received,) = f.force(b.coord);
        uint256 cost = paid - received;
        (uint128 ask, uint128 bid, uint128 sentinel) = b.hook.graduatedLayout();
        uint160 s = _sqrtP(b);
        uint160 maxS = TickMath.getSqrtPriceAtTick(BoxSpecV1.MAX_USABLE_TICK);
        uint256 poolQ = _q0Above(s, b.curve.sqrtPriceLowerX96, maxS, bid)
            + _q0Above(s, b.curve.sqrtPriceUpperX96, maxS, sentinel)
            + _q0Above(s, TickMath.getSqrtPriceAtTick(BoxSpecV1.MIN_USABLE_TICK), b.curve.sqrtPriceLowerX96, ask);
        emit log_named_decimal_uint("fill by ETH (of R)", qBefore * 1e18 / b.raise, 18);
        emit log_named_decimal_uint("round-trip cost (ETH)", cost, 18);
        emit log_named_decimal_uint("pool Q after - curve Q before (ETH)", poolQ - qBefore, 18);
        emit log_named_decimal_uint("D6 reward credited to the forcer (ETH)", b.coord.rewardOf(address(f)), 18);
        assertGe(cost + 1e12, minCost, "the round trip costs at least the model's figure");
        assertGe(poolQ, qBefore, "the pool keeps at least what the curve held");
        assertGe(poolQ - qBefore, minMargin, "by the model's margin (to its three decimals)");
    }

    function _q0Above(uint160 s, uint160 lo, uint160 hi, uint128 l) internal pure returns (uint256) {
        if (s >= hi) return 0;
        return SqrtPriceMath.getAmount0Delta(s > lo ? s : lo, hi, l, false);
    }

    // ------------------------------------------------------------------------------------------------------------
    // D6: the reserve sits in the coordinator; a collect before graduate() cannot empty the reward (BC-027's part)

    function test_D6_reserveFirstThenTheCallerGetsIt() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        (uint256 t,) = _buy(b, alice, 2 ether, 0);
        _sell(b, alice, t / 2);
        FeeBatch memory fb = b.receiver.collect(keeper);
        assertEq(fb.qToReserve, b.hook.reserveCap(), "the first batch tops up the reserve to the cap");
        assertEq(b.hook.reserveMinted(), b.hook.reserveCap());
        assertEq(b.coord.reserve(), b.hook.reserveCap(), "held by the coordinator, not the receiver");
        assertEq(b.hook.reserveCap(), BOX0_RAISE * 10 / 10_000, "0.1% of R");
        _buy(b, bob, 1 ether, 0);
        fb = b.receiver.collect(keeper);
        assertEq(fb.qToReserve, 0, "full: nothing more");
        _close(b, carol);
        vm.prank(keeper);
        b.coord.graduate();
        assertEq(b.coord.rewardOf(keeper), b.hook.reserveCap(), "the whole reserve to the graduation caller");
    }

    function test_D6_reserveTopsUpInMigrateWhenNoCollectRan() public {
        Box memory b = _buildAndLaunch(_box0Params());
        _skipWindow(b);
        _close(b, carol);
        vm.prank(keeper);
        b.coord.graduate();
        assertEq(b.coord.rewardOf(keeper), b.hook.reserveCap(), "migrate's last harvest topped it up");
        assertLe(b.hook.reserveMinted(), b.hook.reserveCap());
    }
}
