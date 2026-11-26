// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverFixture} from "./ReceiverFixture.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

contract ReceiverBuyBackTest is ReceiverFixture {
    using PoolIdLibrary for PoolKey;

    function _ready(uint256 amount) private returns (PoolKey memory key) {
        r = _receiver(2, 2, 1, address(p), true);
        key = _pool();
        _fees(amount, 0);
        r.collect(address(0));
        coord.graduation(r);
    }

    function test_buyBackRequiresGraduationAndSkipsDustOrTakenBlock() public {
        vm.expectRevert(IBoxReceiverV2.NotGraduated.selector);
        r.buyBack(TIP);
        coord.graduation(r);
        (ProtocolSkip skip,,,) = r.buyBack(TIP);
        assertEq(uint256(skip), uint256(ProtocolSkip.BelowMinimum));
        hook.mark();
        (skip,,,) = r.buyBack(TIP);
        assertEq(uint256(skip), uint256(ProtocolSkip.StepTaken));
    }

    function test_buyBackPartialFillWithin49TicksWithRealFeeAndConservation() public {
        PoolKey memory key = _ready(3e12);
        uint256 budget = r.buyBackP();
        uint256 supply = t.totalSupply();
        (ProtocolSkip skip, uint256 spent, uint256 bought, uint256 tip) = r.buyBack(TIP);
        assertEq(uint256(skip), 0);
        assertGt(spent, 0);
        assertGt(bought, 0);
        assertLt(spent, budget - 100);
        assertEq(budget - r.buyBackP(), spent + tip);
        assertEq(tip, 100);
        assertEq(supply - t.totalSupply(), bought);
        assertEq(t.balanceOf(address(r)), 0);
        assertEq(r.tBurnPending(), 0);
        assertEq(hook.lastProtocolBlock(), block.number);
        (uint160 price,,,) = StateLibrary.getSlot0(pm, key.toId());
        assertGe(price, TickMath.getSqrtPriceAtTick(-49));
        // A 1% fee is charged even though stored LP fee is zero.
        assertLt(bought, spent * 99 / 100);
        _booked();
    }

    function test_pausedPDoesNotBlockBuyBackAndUnpaidTipStaysInBudget() public {
        _ready(15000);
        uint256 budget = r.buyBackP();
        p.setPaused(true);
        (, uint256 spent, uint256 bought, uint256 tip) = r.buyBack(TIP);
        assertGt(bought, 0);
        assertEq(tip, 0);
        assertEq(budget - r.buyBackP(), spent);
        _booked();
    }

    function test_refusedFakeAndGasBurnsStayPendingThenRetryExactly() public {
        for (uint8 mode = 1; mode <= 3; mode++) {
            vm.roll(block.number + 1);
            _ready(15000);
            t.mode(mode);
            uint256 supply = t.totalSupply();
            (,, uint256 bought,) = r.buyBack(address(0));
            assertEq(r.tBurnPending(), bought);
            assertEq(t.balanceOf(address(r)), bought);
            assertEq(t.totalSupply(), supply);
            assertEq(r.burnPending(), 0);
            t.mode(0);
            assertEq(r.burnPending(), bought);
            assertEq(r.tBurnPending(), 0);
            assertEq(r.burnPending(), 0);
            assertEq(t.totalSupply(), supply - bought);
            _booked();
            // The next fixture pool uses the existing real pool; reset its initialization by using a fresh manager in setUp.
            setUp();
        }
    }

    function test_fractionalTickStepNeverExceeds49TicksFromLivePrice() public {
        r = _receiver(2, 2, 1, address(p), true);
        uint160 spot = uint160((uint256(1) << 96) * 100003 / 100000);
        PoolKey memory key = _poolAt(spot);
        _fees(3e12, 0);
        r.collect(address(0));
        coord.graduation(r);
        r.buyBack(address(0));
        (uint160 afterPrice,,,) = StateLibrary.getSlot0(pm, key.toId());
        uint256 exactLimit = (uint256(spot) * TickMath.getSqrtPriceAtTick(-49) + (1 << 96) - 1) / (1 << 96);
        assertGe(afterPrice, exactLimit);
    }

    function test_buyBackMinimumIncludesProtocolFeeAndOnePercentOverride() public {
        PoolKey memory key = _ready(15000);
        pm.setProtocolFeeController(address(this));
        pm.setProtocolFee(key, 1000);
        (, uint256 spent, uint256 bought,) = r.buyBack(address(0));
        assertGt(spent, 0);
        assertGt(bought, 0);
        assertGt(pm.protocolFeesAccrued(key.currency0), 0);
        _booked();
    }

    function test_giftedTIsNotSoldOrCreditedAsFees() public {
        _ready(15000);
        t.mint(address(r), 123);
        r.buyBack(address(0));
        assertEq(t.balanceOf(address(r)), 123);
        assertEq(r.tBurnPending(), 0);
        _booked();
    }
}
