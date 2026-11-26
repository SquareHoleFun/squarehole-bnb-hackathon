// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {CQ11ARealFixture} from "../cq11-a/RealFixture.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {BoxSwapBoundsV2 as Bounds} from "../../../src/box-v2/libraries/BoxSwapBoundsV2.sol";

contract LargeFeeSaleTest is CQ11ARealFixture {
    using StateLibrary for IPoolManager;
    function test_waitingFeesRemainConvertibleAfterLargeBuys() public {
        {
            _make(LARGE);
            _graduate();
            trader.trade(key, false, -int256(t.balanceOf(address(trader)) / 4), TickMath.MAX_SQRT_PRICE - 1);
            receiver.collect(address(0));
            uint256 pending = hook.tFeesPending();
            assertGt(pending, 0);
            uint256 step = uint256(uint128(type(int128).max));
            p.mint(address(trader), step * 500);
            for (uint256 i; i < 500; ++i) {
                trader.trade(key, true, -int256(step), TickMath.MIN_SQRT_PRICE + 1);
            }
            (uint160 spot,,,) = pm.getSlot0(hook.poolId());
            uint160 limit = Bounds.roomLimit(false, spot, 49);
            uint256 outputAtLimit = SqrtPriceMath.getAmount0Delta(spot, limit, hook.pairedLiquidity(), false);
            assertGt(outputAtLimit, step);
            assertGt(Bounds.tInQAtSqrt(pending, spot), outputAtLimit);
            emit log_named_uint("pending T", pending);
            emit log_named_uint("49-tick output P", outputAtLimit);
            emit log_named_uint("max int128 P", step);
        }
        uint256 step = uint256(uint128(type(int128).max));
        receiver.collect(address(0)); // P checkpoints from all setup buys remain backed.
        uint256 receiverBefore = _claims(address(receiver));
        uint256 depthBefore = hook.depthBudget();
        uint256 tipBalanceBefore = p.balanceOf(address(this));
        uint256 totalOut; uint256 totalTip; uint256 calls;
        for (; calls < 2000; ++calls) {
            vm.roll(block.number + 1);
            uint256 beforeT = hook.tFeesPending();
            (ProtocolSkip skip, uint256 used, uint256 out, uint256 tip) = hook.sellFees();
            if (skip == ProtocolSkip.BelowMinimum) break;
            assertEq(uint8(skip), uint8(ProtocolSkip.None));
            assertGt(used, 0); assertGt(out, 0);
            assertLe(used, step); assertLe(out, step);
            assertLt(hook.tFeesPending(), beforeT, "every call progresses after its own fee");
            assertEq(pm.balanceOf(address(hook), uint160(address(t))), hook.tFeesPending());
            totalOut += out; totalTip += tip;
            assertEq(_claims(address(receiver)), receiverBefore + totalOut - totalTip);
            assertEq(hook.depthBudget(), depthBefore, "other claims are intact");
        }
        assertGt(calls, 1); assertLt(calls, 2000);
        (uint160 finalSpot,,,) = pm.getSlot0(hook.poolId());
        assertLt(Bounds.tInQAtSqrt(hook.tFeesPending(), finalSpot), LARGE / 100000);
        assertEq(hook.saleFeesPending(), totalOut - totalTip);
        assertEq(p.balanceOf(address(this)), tipBalanceBefore + totalTip);
        emit log_named_uint("conversion calls", calls);
        emit log_named_uint("converted P", totalOut);
        emit log_named_uint("remaining T", hook.tFeesPending());
    }
}
