// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11AHookMatrixBase} from "../../cq11-a/Hook.t.sol";
import {CQ11ARealFixture} from "../../cq11-a/RealFixture.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxHookV2, ProtocolSkip} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {FeeBatchV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";

contract M163SwapMatrixTest is CQ11AHookMatrixBase {
    /// Existing real-manager oracle, now exercised by one review-owned matrix: 72 allowed/rejected cases.
    function test_M163_fourKindsThreePhasesThreeSendersAndPartialFills() public {
        for (uint8 phase; phase < 3; ++phase) {
            for (uint8 who; who < 3; ++who) {
                for (uint8 kind; kind < 4; ++kind) {
                    for (uint8 part; part < 2; ++part) {
                        uint256 saved = vm.snapshotState();
                        _case(phase, who, kind, part == 1);
                        assertTrue(vm.revertToState(saved));
                    }
                }
            }
        }
    }

    function test_M163_deadlineClosedAndFailedGatesAreAtomic() public {
        _open();
        _buy(RAISE / 10);
        Before memory b = _before(address(trader));
        vm.warp(box.deadline());
        _reject(
            address(trader),
            SwapParams(true, -1e9, layout.sqrtPriceEndX96),
            b,
            abi.encodeWithSelector(IBoxHookV2.FailurePending.selector, box.deadline()),
            false
        );
        _reject(
            address(trader),
            SwapParams(false, -1e9, layout.sqrtPriceStartX96),
            b,
            abi.encodeWithSelector(IBoxHookV2.FailurePending.selector, box.deadline()),
            false
        );
        box.fail();
        b = _before(address(trader));
        _reject(
            address(trader),
            SwapParams(true, -1e9, layout.sqrtPriceEndX96),
            b,
            abi.encodeWithSelector(IBoxHookV2.BoxFailed.selector),
            false
        );
        _reject(
            address(trader),
            SwapParams(false, -1e9, layout.sqrtPriceStartX96),
            b,
            abi.encodeWithSelector(IBoxHookV2.BoxFailed.selector),
            false
        );
        assertFalse(hook.closed());
        vm.expectRevert(IBoxHookV2.BoxFailed.selector);
        hook.deepen(address(0));
    }

    function test_M163_firstFillIsStableUntilGraduation() public {
        _fill();
        uint256 filled = hook.closedAt();
        Before memory b = _before(address(trader));
        _reject(
            address(trader),
            SwapParams(false, -1e9, layout.sqrtPriceStartX96),
            b,
            abi.encodeWithSelector(IBoxHookV2.CurveIsClosed.selector, hook.closedAtBlock()),
            false
        );
        vm.warp(filled + 100);
        assertEq(hook.closedAt(), filled);
        box.graduate();
        assertEq(hook.closedAt(), filled);
        vm.expectRevert();
        box.fail();
        assertTrue(box.graduated());
        assertFalse(hook.failed());
    }
}

contract M163SwapPropertiesTest is CQ11ARealFixture {
    using StateLibrary for IPoolManager;
    address internal constant TIP_TO = address(0xCE11);

    struct DepthWitness {
        uint256 fees;
        uint256 claims;
        uint256 budget;
        uint160 spot;
        uint256 used;
        uint256 tUsed;
        uint256 tip;
        uint128 paired;
        uint256 left;
    }

    function _price() internal view returns (uint160 s) {
        (s,,,) = pm.getSlot0(hook.poolId());
    }

    function _limit(uint160 s) internal pure returns (uint256) {
        return FullMath.mulDivRoundingUp(s, TickMath.getSqrtPriceAtTick(-49), 1 << 96);
    }

    function _owedFees() internal view returns (uint256) {
        (uint128 l, uint256 last,) = pm.getPositionInfo(
            hook.poolId(), address(hook), BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK, bytes32(uint256(3))
        );
        (uint256 growth,) = pm.getFeeGrowthInside(hook.poolId(), BoxSpecV1.MIN_USABLE_TICK, BoxSpecV1.MAX_USABLE_TICK);
        return FullMath.mulDiv(growth - last, l, 1 << 128);
    }

    function testFuzz_M163_saleFeeWithProtocolFeeIsTOnly(uint64 seed, bool exactOut, uint16 protocol) public {
        _graduate();
        receiver.collect(address(0));
        protocol = uint16(bound(protocol, 0, 1000));
        pm.setProtocolFeeController(address(this));
        pm.setProtocolFee(key, uint24(protocol) << 12);
        uint256 beforeP = _claims(address(receiver));
        uint256 beforeT = pm.protocolFeesAccrued(key.currency1);
        uint256 amount = exactOut ? bound(seed, 1, RAISE / 10000) : bound(seed, 1e12, 1e18);
        BalanceDelta d =
            trader.trade(key, false, exactOut ? int256(amount) : -int256(amount), TickMath.MAX_SQRT_PRICE - 1);
        uint256 fee = hook.saleFeesPending();
        uint256 net = uint256(int256(d.amount0()));
        assertEq(fee, 0);
        if (exactOut) assertEq(net, amount);
        assertEq(_claims(address(receiver)) - beforeP, fee);
        assertGe(pm.protocolFeesAccrued(key.currency1), beforeT);
        (, uint256 tGrowth) = pm.getFeeGrowthGlobals(hook.poolId());
        assertGt(tGrowth, 0, "sales accrue T LP fees");
        FeeBatchV2 memory batch = receiver.collect(address(0));
        assertEq(batch.sellersP, fee);
        assertEq(hook.saleFeesPending(), 0);
        batch = receiver.collect(address(0));
        assertEq(batch.buyersP + batch.sellersP + batch.qToReserve, 0);
    }

    function test_M163_checkpointFeesAreBookedAndReportedOnce() public {
        _make(LARGE);
        _open();
        uint256 sales;
        for (uint256 i; i < 110; ++i) {
            BalanceDelta buy = _buy(LARGE / 4);
            uint256 beforeP = _claims(address(receiver));
            trader.trade(key, false, -int256(buy.amount1()), layout.sqrtPriceStartX96);
            sales += _claims(address(receiver)) - beforeP;
        }
        assertGt(_claims(address(receiver)), sales, "buyer checkpoint occurred before harvest");
        FeeBatchV2 memory batch = receiver.collect(address(0));
        assertEq(batch.sellersP, sales);
        assertEq(batch.qToReserve, LARGE / 1000);
        assertEq(_claims(address(receiver)), batch.buyersP + batch.sellersP);
        assertEq(receiver.booked(address(p)), _claims(address(receiver)));
        uint256 balance = _claims(address(receiver));
        batch = receiver.collect(address(0));
        assertEq(batch.buyersP + batch.sellersP + batch.qToReserve, 0);
        assertEq(_claims(address(receiver)), balance);
    }

    function test_M163_graduationBoundsAndGiftsAcrossRawScales() public {
        uint256[5] memory raises = [uint256(1e6), uint256(1e8), uint256(1e18), RAISE, LARGE];
        for (uint256 i; i < raises.length; ++i) {
            uint256 saved = vm.snapshotState();
            _make(raises[i]);
            _fill();
            uint256 gift = t.balanceOf(address(trader)) / 100;
            trader.gift(address(t), address(hook), gift);
            trader.gift(address(p), address(hook), 123);
            uint256 beforeSupply = t.totalSupply();
            uint256 beforeCoordinatorT = t.balanceOf(address(box));
            box.graduate();
            assertTrue(box.graduated());
            assertEq(_price(), layout.sqrtPriceEndX96);
            assertGt(hook.pairedLiquidity(), 0);
            assertEq(pm.getLiquidity(hook.poolId()), hook.pairedLiquidity());
            assertEq(
                pm.getPositionLiquidity(
                    hook.poolId(),
                    keccak256(abi.encodePacked(address(hook), layout.tickLower, layout.tickUpper, bytes32(0)))
                ),
                0
            );
            assertEq(t.balanceOf(address(box)), 0);
            assertLe(beforeSupply - t.totalSupply(), beforeCoordinatorT + gift);
            assertEq(pm.balanceOf(address(hook), uint160(address(t))), 0);
            assertGe(hook.depthBudget(), 123);
            assertLe(hook.reserveMinted(), raises[i] / 1000);
            assertTrue(vm.revertToState(saved));
        }
    }

    function test_M163_deepenSeparatesFeesAndIgnoresGiftedT() public {
        _graduate();
        receiver.collect(address(0));
        trader.trade(key, true, -int256(RAISE / 10), TickMath.MIN_SQRT_PRICE + 1);
        DepthWitness memory w;
        w.fees = _owedFees();
        w.claims = _claims(address(receiver));
        w.budget = hook.depthBudget();
        w.spot = _price();
        uint256 saved = vm.snapshotState();
        ProtocolSkip skip;
        (skip, w.used, w.tUsed, w.tip) = hook.deepen(TIP_TO);
        assertEq(uint8(skip), 0);
        w.paired = hook.pairedLiquidity();
        w.left = hook.depthBudget();
        assertGe(_price(), _limit(w.spot));
        assertGt(_claims(address(receiver)) - w.claims, w.fees, "deepen also pays the positions in P");
        w.fees = _claims(address(receiver)) - w.claims;
        assertEq(w.tip, (w.budget - w.left - w.tip) / 20);
        assertEq(p.balanceOf(TIP_TO), w.tip);
        assertTrue(vm.revertToState(saved));
        uint256 gift = t.balanceOf(address(trader)) / 10;
        trader.gift(address(t), address(hook), gift);
        (, uint256 usedGift, uint256 tUsedGift, uint256 tipGift) = hook.deepen(TIP_TO);
        assertEq(usedGift, w.used);
        assertEq(tUsedGift, w.tUsed);
        assertEq(tipGift, w.tip);
        assertEq(hook.pairedLiquidity(), w.paired);
        assertEq(hook.depthBudget(), w.left);
        assertEq(pm.balanceOf(address(hook), uint160(address(t))), gift);
        FeeBatchV2 memory batch = receiver.collect(address(0));
        assertEq(batch.buyersP, w.fees);
        batch = receiver.collect(address(0));
        assertEq(batch.buyersP + batch.sellersP, 0);
    }

    function test_M163_protocolFeeAndRefusedBurnDoNotLoseBuyBackFunds() public {
        choice = 2;
        _make(RAISE);
        _graduate();
        receiver.collect(address(0));
        pm.setProtocolFeeController(address(this));
        pm.setProtocolFee(key, 1000);
        uint256 budget = receiver.buyBackP();
        uint160 spot = _price();
        uint256 supply = t.totalSupply();
        vm.mockCallRevert(address(t), abi.encodeWithSignature("burn(uint256)"), "refused");
        vm.mockCallRevert(address(p), abi.encodeWithSignature("transfer(address,uint256)"), "paused");
        (, uint256 spent, uint256 bought, uint256 tip) = receiver.buyBack(TIP_TO);
        assertGt(spent, 0);
        assertEq(tip, 0);
        assertEq(receiver.buyBackP(), budget - spent);
        assertEq(receiver.tBurnPending(), bought);
        assertEq(t.balanceOf(address(receiver)), bought);
        assertEq(t.totalSupply(), supply);
        assertGe(_price(), _limit(spot));
        assertGt(pm.protocolFeesAccrued(key.currency0), 0);
        (ProtocolSkip skip,,,) = hook.deepen(TIP_TO);
        assertEq(uint8(skip), uint8(ProtocolSkip.StepTaken));
        vm.clearMockedCalls();
        assertEq(receiver.burnPending(), bought);
        assertEq(receiver.burnPending(), 0);
        assertEq(t.totalSupply(), supply - bought);
        vm.roll(block.number + 1);
        (skip,,,) = hook.deepen(TIP_TO);
        assertEq(uint8(skip), 0);
        (skip,,,) = receiver.buyBack(TIP_TO);
        assertEq(uint8(skip), uint8(ProtocolSkip.StepTaken));
    }

    function test_M163_publicWindowTaxPartialFillRefundAndSweep() public {
        vm.warp(box.effectiveOpenAt());
        p.mint(address(this), RAISE * 20);
        p.approve(address(router), type(uint256).max);
        uint256 beforeP = p.balanceOf(address(this));
        uint256 beforeManagerP = p.balanceOf(address(pm));
        router.buy(RAISE * 20, 1, address(this), block.timestamp);
        assertTrue(hook.closed());
        uint256 spent = p.balanceOf(address(pm)) - beforeManagerP;
        uint256 tax = router.totalTaxCollected();
        assertEq(tax, (spent * 931974 + 68025) / 68026);
        assertEq(beforeP - p.balanceOf(address(this)), spent + tax);
        assertLt(spent + tax, RAISE * 20, "closing fill refunds unfilled P and its tax");
        box.graduate();
        uint256 depth = hook.depthBudget();
        assertEq(router.sweep(), tax);
        assertEq(hook.depthBudget(), depth + tax);
    }
}
