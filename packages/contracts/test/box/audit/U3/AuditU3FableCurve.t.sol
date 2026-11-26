// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {AuditRouterSwapper} from "../common/AuditActors.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU3FableBase} from "./AuditU3FableBase.sol";

/// @notice SH-AUDIT-B0 U3 (Fable): the curve's close and the migration (L1: P3.2, P3.3; L3: P3.9; L5: P3.12; L7:
/// P3.15) on the factory's box 0 (mainnet build). Sources: `BoxHook.sol:204-228` (afterSwap: the P0 floor and the
/// close on fill), `BoxHookExtension.sol:169-223` (migrate), BC-025, BC-029, BC-067; `docs/design/launch-pipeline-v1.md:198-206`.
/// forge-config: default.evm_version = "osaka"
contract AuditU3FableCurveTest is AuditU3FableBase {
    using StateLibrary for IPoolManager;

    // ================================================================================================ P3.15 / P3.9

    /// P3.15, P3.9 (BC-025): from any fill of the curve, every closing shape (an exact-input buy limited at √P1, an
    /// exact-input overshoot to any limit below √P1, an exact output of more T than the curve has left at any limit at
    /// or below √P1, and a buy that stops one unit above √P1 followed by one that reaches it) sets `closedAtBlock` in
    /// its own afterSwap with exactly one `CurveClosed`, leaves the price at or below √P1, refuses every later swap
    /// until `graduate()`, which returns the price to exactly √P1 and leaves `closedAtBlock` unchanged.
    function testFuzz_AUDIT_U3_everyClosingShapeClosesOnceInItsOwnAfterSwap(uint256 fillPpm, uint8 shape, uint256 seed)
        public
    {
        fillPpm = bound(fillPpm, 0, 995_000);
        shape = uint8(bound(shape, 0, 3));
        _toWindow();
        _warpTo(hook.windowEndsAt());
        _fillTo(fillPpm);
        assertFalse(hook.closed(), "fill below 100% leaves the curve open");
        uint256 tLeft = _curveTLeft();
        vm.recordLogs();
        _closeByShape(shape, seed, tLeft);
        _checkClosedThenGraduate(tLeft);
    }

    /// @dev The closing swap of one shape (see the fuzz test).
    function _closeByShape(uint8 shape, uint256 seed, uint256 tLeft) internal {
        uint160 p1 = curve.sqrtPriceLowerX96;
        if (shape == 0) {
            _buyTo(eoa[2], 2 * raise, p1);
            assertEq(_sqrtP(), p1, "stopped exactly at P1");
        } else if (shape == 1) {
            uint160 limit = uint160(bound(seed, TickMath.MIN_SQRT_PRICE + 1, p1 - 1));
            _buyTo(eoa[2], 2 * raise, limit);
            assertLt(_sqrtP(), p1, "ran past P1 across empty ticks to its own limit");
            assertEq(_sqrtP(), limit, "the overshoot ends at the caller's limit");
        } else if (shape == 2) {
            uint160 limit = uint160(bound(seed, TickMath.MIN_SQRT_PRICE + 1, p1));
            uint256 extra = bound(seed >> 128, 0, 1e24);
            _swap(eoa[2], _buyOutParams(tLeft + extra, limit), 2 * raise);
            assertLe(_sqrtP(), p1);
        } else {
            _buyTo(eoa[2], 2 * raise, p1 + 1);
            assertFalse(hook.closed(), "one sqrtprice unit above P1 is not a close");
            assertEq(_countTopic(vm.getRecordedLogs(), a.hook, IBoxHook.CurveClosed.selector), 0);
            vm.recordLogs();
            _buyTo(eoa[2], 2 * raise, p1);
            assertEq(_sqrtP(), p1);
        }
    }

    /// @dev After the closing swap: closed once in its own block, refused every shape until `graduate()`, which
    /// returns the price to exactly √P1 and keeps the close block; then the layout at P1 per the closing shape.
    function _checkClosedThenGraduate(uint256 tLeft) internal {
        uint160 p1 = curve.sqrtPriceLowerX96;
        assertEq(_countTopic(vm.getRecordedLogs(), a.hook, IBoxHook.CurveClosed.selector), 1, "exactly one CurveClosed");
        assertTrue(hook.closed());
        bool endedAtP1 = _sqrtP() == p1;
        uint256 closedAt = hook.closedAtBlock();
        assertEq(closedAt, vm.getBlockNumber(), "closed in its own block");
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Closed));
        assertEq(uint8(coordinator.phase()), uint8(BoxPhase.Closed), "the coordinator agrees");
        assertApproxEqAbs(token.balanceOf(eoa[2]), tLeft, 2, "the closer got the T the curve had left");
        bytes memory closedReason = abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, closedAt);
        _everyShapeReverts(eoa[2], closedReason);
        _advance(1);
        _everyShapeReverts(eoa[0], closedReason);
        assertEq(hook.closedAtBlock(), closedAt, "a block later the close block is the same");
        _warpTo(_requestTimeFor(r0));
        _graduate(keeper);
        assertEq(_sqrtP(), p1, "graduate() returned the price to exactly P1");
        assertTrue(hook.closed());
        assertEq(hook.closedAtBlock(), closedAt, "graduation keeps closedAtBlock");
        assertEq(hook.migratedAtBlock(), vm.getBlockNumber());
        assertEq(uint8(hook.phase()), uint8(BoxPhase.Graduated));
        _assertLayoutAtP1(endedAtP1);
        assertGt(_buy(eoa[3], 0.01 ether), 0, "every route trades after graduation");
        _sell(eoa[2], token.balanceOf(eoa[2]) / 2);
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    /// @dev A v4 fact the layout at P1 inherits from the closing shape (no value effect; observation for the evidence):
    /// a close that ended exactly on √P1 crossed the curve's lower tick moving down, so slot0's tick is tickLower − 1
    /// and the ask [MIN, tickLower] is the active liquidity; a close below √P1 is walked back up to √P1 by `migrate`
    /// with no tick to cross, so slot0's tick is tickLower and the bid [tickLower, MAX] is active. The √price (and
    /// `_spotTick()`) is P1's either way, and the next swap in either direction crosses tickLower at zero cost.
    function _assertLayoutAtP1(bool endedAtP1) internal view {
        (uint128 ask, uint128 bid,) = hook.graduatedLayout();
        uint128 active = pm.getLiquidity(poolId);
        assertEq(_spotTick(), curve.tickLower, "the price is P1's tick");
        if (endedAtP1) {
            assertEq(_tick(), curve.tickLower - 1, "ended on P1: slot0's tick is one below (v4 crossed tickLower)");
            assertEq(active, ask, "ended on P1: the ask is active");
        } else {
            assertEq(_tick(), curve.tickLower, "walked up to P1: slot0's tick is tickLower");
            assertEq(active, bid, "walked up to P1: the bid is active");
        }
    }

    /// P3.9 (BC-025, launch-pipeline § 3.3 "nobody can buy to P1 and sell back in one transaction"): a router-like
    /// caller that buys to P1 and sells back inside one unlock is refused at its second swap (`CurveIsClosed` of this
    /// block, written by the first swap's afterSwap), whatever the second swap's shape, and the whole unlock reverts
    /// leaving the curve open; a sell followed by the closing buy in one unlock closes.
    function testProperty_AUDIT_U3_twoSwapsInOneUnlockCannotCrossP1AndReturn() public {
        _toBonding();
        _fillTo(500_000);
        uint160 p1 = curve.sqrtPriceLowerX96;
        bytes memory closedNow =
            _hookRevert(IHooks.beforeSwap.selector, abi.encodeWithSelector(IBoxHook.CurveIsClosed.selector, vm.getBlockNumber()));
        AuditRouterSwapper.Call[] memory calls = new AuditRouterSwapper.Call[](2);
        // Exact-in to P1, then an exact-in sell back.
        calls[0] = _call(_buyParams(2 * raise, p1));
        calls[1] = _call(_sellParams(1e18, TickMath.MAX_SQRT_PRICE - 1));
        _twoSwapsRevert(calls, closedNow);
        // Overshoot, then an exact-out sell back.
        calls[0] = _call(_buyParams(2 * raise, TickMath.MIN_SQRT_PRICE + 1));
        calls[1] = _call(_sellOutParams(1, TickMath.MAX_SQRT_PRICE - 1));
        _twoSwapsRevert(calls, closedNow);
        // Exact-out past the curve's T, then another buy.
        calls[0] = _call(_buyOutParams(_curveTLeft() + 1e18, p1));
        calls[1] = _call(_buyParams(1, TickMath.MIN_SQRT_PRICE + 1));
        _twoSwapsRevert(calls, closedNow);
        // Three swaps: the second already fails.
        AuditRouterSwapper.Call[] memory three = new AuditRouterSwapper.Call[](3);
        three[0] = _call(_buyParams(2 * raise, p1));
        three[1] = _call(_sellParams(1, TickMath.MAX_SQRT_PRICE - 1));
        three[2] = _call(_buyParams(1, TickMath.MIN_SQRT_PRICE + 1));
        _twoSwapsRevert(three, closedNow);
        assertFalse(hook.closed(), "every refused unlock left the curve open");
        assertEq(hook.closedAtBlock(), 0);
        // A sell then the closing buy in one unlock: the close is the last swap, so it stands.
        uint256 sellT = token.balanceOf(eoa[0]) / 4;
        calls[0] = _call(_sellParams(sellT, TickMath.MAX_SQRT_PRICE - 1));
        calls[1] = _call(_buyParams(2 * raise, p1));
        _fund(eoa[0], 2 * raise);
        uint256 e0 = eoa[0].balance;
        uint256 t0 = token.balanceOf(eoa[0]);
        vm.prank(eoa[0]);
        token.approve(address(routerSwapper), type(uint256).max);
        vm.prank(eoa[0]);
        routerSwapper.swap{value: 2 * raise}(calls, eoa[0]);
        _noteEthChange(e0, eoa[0].balance, EthIn.SwapIn, EthOut.SwapOut);
        _noteTChange(t0, token.balanceOf(eoa[0]), TIn.Sell, TOut.Buy);
        assertTrue(hook.closed(), "the last swap of the unlock closed the curve");
        assertEq(hook.closedAtBlock(), vm.getBlockNumber());
        assertEq(_sqrtP(), p1);
        _assertGhostLedger();
    }

    function _call(SwapParams memory p) internal view returns (AuditRouterSwapper.Call memory) {
        return AuditRouterSwapper.Call({key: poolKey, params: p, hookData: ""});
    }

    function _twoSwapsRevert(AuditRouterSwapper.Call[] memory calls, bytes memory reason) internal {
        _fund(eoa[0], 2 * raise);
        vm.prank(eoa[0]);
        token.approve(address(routerSwapper), type(uint256).max);
        vm.prank(eoa[0]);
        vm.expectRevert(reason);
        routerSwapper.swap{value: 2 * raise}(calls, eoa[0]);
    }

    /// P3.15 (`BoxHook.sol:221`, FitPoolHook's P0 floor): in the window and on the curve a sell that would end above
    /// √P0 (an exact input larger than the curve's Q at any limit above √P0, or an exact output of more Q than the
    /// curve holds) reverts `BelowCurveFloor` with the price it would have reached; a sell limited at exactly √P0
    /// passes and ends there; after graduation the floor is gone.
    function testProperty_AUDIT_U3_priceNeverAboveP0BeforeMigration() public {
        _toWindow();
        uint160 p0 = curve.sqrtPriceUpperX96;
        bytes memory floorAtMax =
            _hookRevert(IHooks.afterSwap.selector, abi.encodeWithSelector(IBoxHook.BelowCurveFloor.selector, TickMath.MAX_SQRT_PRICE - 1));
        // Honest holders cannot pass P0 with an exact input (they hold at most what the curve sold, and the fee keeps
        // a sell-back below P0), but an exact output of more Q than the curve holds runs past P0 across empty ticks:
        // the floor refuses it.
        assertGt(_curveQ(), 0);
        _swapExpect(eoa[0], _sellOutParams(_curveQ() + 1, TickMath.MAX_SQRT_PRICE - 1), 0, floorAtMax);
        _toBonding();
        _swapExpect(eoa[0], _sellOutParams(_curveQ() + 1 ether, TickMath.MAX_SQRT_PRICE - 1), 0, floorAtMax);
        // With T from outside the curve's sales (dealt, in a snapshot that is reverted: no honest path yields it
        // before graduation), an exact input larger than the curve's Q at any limit above P0 is refused with the
        // price it would have reached; limited at exactly P0 it passes, ends at P0, the curve holds no Q, and from
        // there any further sell is refused by the floor.
        uint256 snap = vm.snapshotState();
        uint256 big = 3 * (token.balanceOf(eoa[0]) + token.balanceOf(eoa[1]) + token.balanceOf(eoa[2]));
        deal(a.token, eoa[0], big);
        assertGt(_tInQ(big, _sqrtP()), _curveQ(), "fixture: more T than the curve's Q can buy");
        uint160 above = p0 + 1;
        _swapExpect(
            eoa[0], _sellParams(big, above), 0,
            _hookRevert(IHooks.afterSwap.selector, abi.encodeWithSelector(IBoxHook.BelowCurveFloor.selector, above))
        );
        _swapExpect(eoa[0], _sellParams(big, TickMath.MAX_SQRT_PRICE - 1), 0, floorAtMax);
        vm.prank(eoa[0]);
        token.approve(address(routerSwapper), type(uint256).max);
        vm.prank(eoa[0]);
        routerSwapper.swapOne(poolKey, _sellParams(big, p0), "", eoa[0]);
        assertEq(_sqrtP(), p0, "a sell limited at P0 ends at P0");
        assertEq(_curveQ(), 0);
        assertFalse(hook.closed());
        _swapExpect(eoa[0], _sellParams(1e18, TickMath.MAX_SQRT_PRICE - 1), 0, floorAtMax);
        vm.revertToState(snap);
        _buy(eoa[4], 0.5 ether);
        _assertGhostLedger();
        _toGraduated();
        // After migration a sell may end above P0: the bid sentinel [P0, MAX] holds Q there.
        _sell(eoa[2], token.balanceOf(eoa[2]) / 2);
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    /// P3.15 (L7 extremes): 1-wei swaps of every shape pass in the window (sells), on the curve and after graduation
    /// without closing the curve or moving the price above √P0.
    function testProperty_AUDIT_U3_oneWeiSwapsInEveryOpenPhase() public {
        _toWindow();
        _sell(eoa[0], 1);
        _sellExactOut(eoa[0], 1);
        _toBonding();
        uint160 before = _sqrtP();
        _buy(eoa[0], 1);
        _buyExactOut(eoa[0], 1, 1 ether);
        _sell(eoa[0], 1);
        _sellExactOut(eoa[0], 1);
        assertFalse(hook.closed());
        assertLe(_sqrtP(), curve.sqrtPriceUpperX96);
        assertApproxEqRel(uint256(_sqrtP()), uint256(before), 1e6, "a wei barely moves the price (1e-12)");
        _toGraduated();
        _buy(eoa[0], 1);
        _buyExactOut(eoa[0], 1, 1 ether);
        _sell(eoa[0], 1);
        _sellExactOut(eoa[0], 1);
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    // ================================================================================================ P3.3 / P3.2

    /// P3.3 (BC-067, `BoxHookExtension.sol:169-223`): `migrate` removes exactly R of Q from the crossed curve, pokes
    /// its last fees (reserve first, BC-027), seeds exactly BoxLayoutV1's ask, full-range bid and sentinel at salt 1,
    /// pulls exactly the ask's T beyond the curve's from the coordinator, mints the Q dust to the receiver, and leaves
    /// the hook with no T and no ETH; its claims after graduation are exactly what the receiver's settlement moved
    /// (X09): the held depth parts first, then the depth part of the final batch (the curve's last fees and the dust,
    /// split with the graduated rule), each a `DepthFunded`.
    struct MigrationFacts {
        uint256 heldQ;
        uint256 heldT;
        uint256 share;
        uint256 recvQ0;
        uint256 coordQ0;
        uint256 minted0;
        uint256 curveFeeQ;
        uint256 qFromCurve;
        uint256 tFromCurve;
        uint128 askL;
        uint128 bidL;
        uint128 sentL;
        uint256 pulled;
        uint256 dust;
    }

    function testProperty_AUDIT_U3_migrateIsExactAndLeavesTheHookWithNoT() public {
        _toClosed();
        MigrationFacts memory m;
        (m.heldQ, m.heldT) = receiver.depthHeld();
        m.share = token.balanceOf(a.coordinator);
        m.recvQ0 = pm.balanceOf(a.receiver, 0);
        m.coordQ0 = pm.balanceOf(a.coordinator, 0);
        m.minted0 = hook.reserveMinted();
        (m.curveFeeQ,) = _uncollected(curve.tickLower, curve.tickUpper, SALT_CURVE);
        _assertNoHookClaims();
        _warpTo(_requestTimeFor(r0));
        vm.recordLogs();
        vm.prank(keeper);
        graduationReward = coordinator.graduate();
        reached = AuditPhase.Graduated;
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        _migrated(logs, m);
        _checkLayout(m);
        _checkReserveAndClaims(m, logs);
        assertEq(token.balanceOf(a.hook), 0, "the hook holds no T after migration");
        assertEq(a.hook.balance, 0);
        assertEq(token.balanceOf(a.coordinator), 0, "the coordinator burned its dust T");
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    function _checkLayout(MigrationFacts memory m) internal view {
        assertEq(m.qFromCurve, raise, "the fully crossed curve pays exactly R (BoxLayoutV1's exact liquidity)");
        assertLe(m.tFromCurve, 1, "at most a rounding unit of T left on the curve");
        BoxLayoutV1.Graduated memory g = BoxLayoutV1.graduated(
            curve, BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL, m.qFromCurve, m.share + m.tFromCurve
        );
        assertEq(m.askL, g.ask.liquidity, "ask == the library's");
        assertEq(m.bidL, g.bid.liquidity, "bid == the library's");
        assertEq(m.sentL, g.sentinel.liquidity, "sentinel == the library's");
        assertEq(m.dust, g.qDust, "reported Q dust == the library's");
        assertEq(m.pulled, g.ask.amount - m.tFromCurve, "pulled exactly the ask's T beyond the curve's");
        uint128[5] memory l = _positions();
        assertEq(l[0], 0, "the curve is gone");
        assertEq(l[1], m.askL);
        assertEq(l[2], m.bidL);
        assertEq(l[3], m.sentL);
        assertEq(l[4], 0, "no pair at graduation");
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        assertEq(ask, m.askL);
        assertEq(bid, m.bidL);
        assertEq(sentinel, m.sentL);
        // The pool holds R (bid + sentinel principal) less the dust, exactly; the price is P1.
        (uint256 bidQ,) = _principal(curve.tickLower, MAX_T, m.bidL);
        (uint256 sentQ,) = _principal(curve.tickUpper, MAX_T, m.sentL);
        assertEq(g.bid.amount + g.sentinel.amount + g.qDust, m.qFromCurve, "the library splits R exactly");
        assertLe(bidQ + sentQ + m.dust, raise, "a removal never pays more than the adds took");
        assertGe(bidQ + sentQ + m.dust + 2, raise, "v4 rounding: at most 1 wei per Q position (L7)");
        assertEq(_sqrtP(), curve.sqrtPriceLowerX96);
    }

    function _checkReserveAndClaims(MigrationFacts memory m, VmSafe.Log[] memory logs) internal view {
        _checkReserve(m);
        _checkClaims(m, logs);
    }

    function _checkReserve(MigrationFacts memory m) internal view {
        uint256 topUp = hook.reserveMinted() - m.minted0;
        assertLe(hook.reserveMinted(), hook.reserveCap(), "reserveMinted <= cap");
        assertEq(topUp, _min(hook.reserveCap() - m.minted0, m.curveFeeQ), "the top-up is min(cap - minted, Q fees)");
        assertEq(graduationReward, _min(hook.reserveMinted(), hook.reserveCap()), "the reward is the minted reserve, capped");
        assertEq(pm.balanceOf(a.coordinator, 0), graduationReward, "the coordinator keeps exactly the reward as claims");
        assertGe(m.coordQ0 + topUp, graduationReward, "the reward came from the reserve the hook minted");
    }

    /// @dev The settlement moved the held depth parts to the hook, then the final batch's depth part (the curve's last
    /// fees and the dust, split under the graduated rule): the hook's claims are exactly the DepthFunded sum, no other
    /// path lands claims on it at graduation (X09, P3.1); nothing came back as a conversion note (none yet). The
    /// receiver's Q claims, exactly: what it had, plus the curve's last fees less the reserve top-up, the dust, and the
    /// coordinator's claims above the reward (forwarded as the next batch's fees), less everything the settlement moved
    /// to the hook (the held parts were among its claims). Nothing else leaves at graduation (the FIT and platform
    /// parts stay as its claims until payFit / payPlatform; the settlement pays no tip).
    function _checkClaims(MigrationFacts memory m, VmSafe.Log[] memory logs) internal view {
        (uint256 hq1, uint256 ht1) = _hookClaims();
        (uint256 fundedQ, uint256 fundedT) = _depthFunded(logs);
        assertEq(_hookBack(logs), 0, "no conversion note before graduation");
        assertEq(hq1, fundedQ, "the hook's Q claims == every DepthFunded of the graduation");
        assertEq(ht1, fundedT, "the hook's T claims == every DepthFunded of the graduation");
        assertGe(ht1, m.heldT, "at least the held depth T moved");
        assertGt(hq1, m.heldQ, "the held depth Q moved, and the closing buy's fees (the final batch) funded depth too");
        uint256 topUp = hook.reserveMinted() - m.minted0;
        uint256 expected = m.recvQ0 + m.curveFeeQ - topUp + m.dust + (m.coordQ0 + topUp - graduationReward) - hq1;
        assertEq(pm.balanceOf(a.receiver, 0), expected, "the receiver's Q claims after graduation, to the wei");
    }

    /// P3.2 (BC-027, `BoxHookBase.sol:199-215`): every harvest before graduation mints exactly the Q and T it poked:
    /// first min(Q fees, cap − minted) to the coordinator, the rest of Q and all of T to the receiver; `reserveMinted`
    /// never passes the cap; after the cap is full every later harvest mints nothing to the coordinator; after
    /// graduation nothing ever goes to the coordinator and at most four positions are poked.
    function testProperty_AUDIT_U3_harvestMintsExactlyWhatItPokedReserveFirst() public {
        _toWindow();
        _warpTo(hook.windowEndsAt());
        uint256 cap = hook.reserveCap();
        for (uint256 i; i < 6; ++i) {
            _buy(eoa[i % 4], 0.3 ether);
            _sell(eoa[i % 4], token.balanceOf(eoa[i % 4]) / 3);
            _harvestAndCheck(true, cap);
        }
        assertEq(hook.reserveMinted(), cap, "six batches of 0.3 ETH fill the 0.1% reserve");
        _toClosed();
        // Closed, not migrated: the curve is still the one position; its closing buy's fees are harvestable, the cap
        // is full, so the coordinator gets nothing more.
        _harvestAndCheck(true, cap);
        _toGraduated();
        _buy(eoa[2], 0.4 ether);
        _sell(eoa[2], token.balanceOf(eoa[2]) / 2);
        _harvestAndCheck(false, cap);
        assertEq(hook.reserveMinted(), cap, "graduation never raises the reserve past the cap");
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    function _harvestAndCheck(bool beforeGraduation, uint256 cap) internal {
        uint256 minted0 = hook.reserveMinted();
        uint256 coordQ0 = pm.balanceOf(a.coordinator, 0);
        uint256 recvQ0 = pm.balanceOf(a.receiver, 0);
        uint256 recvT0 = pm.balanceOf(a.receiver, uint256(uint160(a.token)));
        (uint256 expQ, uint256 expT) = _allUncollected();
        vm.recordLogs();
        vm.prank(a.receiver);
        (uint256 fq, uint256 ft, uint256 toReserve) = hook.harvest();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        assertEq(fq, expQ, "Q poked == fee growth owed");
        assertEq(ft, expT, "T poked == fee growth owed");
        uint256 want = beforeGraduation ? _min(cap - minted0, fq) : 0;
        assertEq(toReserve, want, "reserve: min(cap - minted, Q fees) before graduation, 0 after");
        assertEq(hook.reserveMinted(), minted0 + toReserve);
        assertLe(hook.reserveMinted(), cap);
        assertEq(pm.balanceOf(a.coordinator, 0), coordQ0 + toReserve, "the coordinator got exactly the top-up");
        assertEq(pm.balanceOf(a.receiver, 0), recvQ0 + fq - toReserve, "the receiver got the rest of Q");
        assertEq(pm.balanceOf(a.receiver, uint256(uint160(a.token))), recvT0 + ft, "the receiver got all of T");
        uint256 pokes = _countTopic(logs, address(pm), keccak256("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"));
        assertLe(pokes, beforeGraduation ? 1 : 4, "BC-122: one poke before graduation, at most four after");
        (uint256 leftQ, uint256 leftT) = _allUncollected();
        assertEq(leftQ | leftT, 0, "nothing left uncollected");
    }

    // ================================================================================================ P3.12

    /// P3.12 (BC-029, launch-pipeline § 3.4 table): on the mainnet build, buying to P1, calling `graduate()` and
    /// selling the T back costs at least 0.670, 0.121 and 0.0019 ETH at 20.7%, 70.1% and 98.1% fill by ETH, and the
    /// pool keeps at least the Q the curve held.
    function testProperty_AUDIT_U3_forcingGraduationCosts_fill207() public {
        _forcing(207_000, 0.670 ether);
    }

    function testProperty_AUDIT_U3_forcingGraduationCosts_fill701() public {
        _forcing(701_000, 0.121 ether);
    }

    function testProperty_AUDIT_U3_forcingGraduationCosts_fill981() public {
        _forcing(981_000, 0.0019 ether);
    }

    function _forcing(uint256 fillPpm, uint256 minCost) internal {
        _toWindow();
        _warpTo(hook.windowEndsAt());
        _fillTo(fillPpm);
        uint256 qBefore = _curveQ();
        address forcer = makeAddr("u3.forcer");
        _ghostAddOutside(forcer);
        uint256 e0 = forcer.balance;
        uint256 tBought = _buyTo(forcer, 2 * raise, curve.sqrtPriceLowerX96);
        uint256 paid = e0 + 2 * raise - forcer.balance;
        _warpTo(_requestTimeFor(r0));
        (uint256 reward,) = _graduate(forcer);
        uint256 received = _sell(forcer, tBought);
        uint256 cost = paid - received;
        uint128[5] memory l = _positions();
        uint160 s = _sqrtP();
        uint160 maxS = TickMath.getSqrtPriceAtTick(MAX_T);
        uint256 poolQ = _q0Above(s, curve.sqrtPriceLowerX96, maxS, l[2]) + _q0Above(s, curve.sqrtPriceUpperX96, maxS, l[3])
            + _q0Above(s, TickMath.getSqrtPriceAtTick(MIN_T), curve.sqrtPriceLowerX96, l[1]);
        emit log_named_decimal_uint("U3F|fill by ETH (of R)", qBefore * 1e18 / raise, 18);
        emit log_named_decimal_uint("U3F|round-trip cost (ETH)", cost, 18);
        emit log_named_decimal_uint("U3F|D6 reward credited to the forcer (ETH)", reward, 18);
        emit log_named_decimal_uint("U3F|pool Q after - curve Q before (ETH)", poolQ - qBefore, 18);
        assertGe(cost + 1e12, minCost, "forcing costs at least BC-029's figure (to three decimals)");
        assertGe(poolQ, qBefore, "the pool keeps at least what the curve held");
        if (reward > cost) emit log_named_decimal_uint("U3F|NET GAIN for the forcer: reward - cost (ETH)", reward - cost, 18);
        else emit log_named_decimal_uint("U3F|net loss for the forcer: cost - reward (ETH)", cost - reward, 18);
        _assertHookHoldsOnlyClaims();
        _assertGhostLedger();
    }

    /// The fill from which a forced graduation pays (the D6 reward of 0.1% of R, BC-027, against BC-029's round-trip
    /// cost): measured on the mainnet build over fills of 90% to 99.5% (a question for the founder, not a finding:
    /// both figures are documented, nothing states their sum's sign).
    function testProperty_AUDIT_U3_forcingBreakEvenFillMeasured() public {
        _toWindow();
        _warpTo(hook.windowEndsAt());
        uint256 base = vm.snapshotState();
        uint256[8] memory fills = [uint256(900_000), 950_000, 960_000, 970_000, 975_000, 980_000, 990_000, 995_000];
        uint256 breakEven;
        for (uint256 i; i < fills.length; ++i) {
            vm.revertToState(base);
            _fillTo(fills[i]);
            address forcer = makeAddr("u3.forcer");
            uint256 e0 = forcer.balance;
            uint256 tBought = _buyTo(forcer, 2 * raise, curve.sqrtPriceLowerX96);
            uint256 paid = e0 + 2 * raise - forcer.balance;
            _warpTo(_requestTimeFor(r0));
            vm.prank(forcer);
            uint256 reward = coordinator.graduate();
            reached = AuditPhase.Graduated;
            uint256 received = _sell(forcer, tBought);
            uint256 cost = paid - received;
            emit log_named_uint("U3F|break-even sweep: fill (ppm of R)", fills[i]);
            emit log_named_decimal_uint("U3F|break-even sweep: round-trip cost (ETH)", cost, 18);
            emit log_named_decimal_uint("U3F|break-even sweep: reward (ETH)", reward, 18);
            if (breakEven == 0 && reward >= cost) breakEven = fills[i];
        }
        emit log_named_uint("U3F|first swept fill where the reward covers the forcing (ppm)", breakEven);
        assertGt(breakEven, 950_000, "below 95% fill forcing never pays");
        assertLe(breakEven, 980_000, "from at most 98% fill the reward covers the round trip (measured)");
    }

    function _q0Above(uint160 s, uint160 lo, uint160 hi, uint128 l) internal pure returns (uint256) {
        if (s >= hi || l == 0) return 0;
        return SqrtPriceMath.getAmount0Delta(s > lo ? s : lo, hi, l, false);
    }

    // ================================================================================================ helpers

    function _assertNoHookClaims() internal view {
        (uint256 hq0, uint256 ht0) = _hookClaims();
        assertEq(hq0 | ht0, 0, "no depth claims on the hook before graduation");
    }

    /// @dev Fills `m` from the hook's `Migrated` event in `logs`.
    function _migrated(VmSafe.Log[] memory logs, MigrationFacts memory m) internal view {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.hook && logs[i].topics[0] == IBoxHook.Migrated.selector) {
                (m.qFromCurve, m.tFromCurve, m.askL, m.bidL, m.sentL, m.pulled, m.dust) =
                    abi.decode(logs[i].data, (uint256, uint256, uint128, uint128, uint128, uint256, uint256));
                return;
            }
        }
        revert("Migrated not emitted");
    }

    function _min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }
}
