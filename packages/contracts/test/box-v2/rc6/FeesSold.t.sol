// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CQ11AFixture} from "../cq11-a/Fixture.sol";
import {NoticeProbe} from "../m2-seam/BatchIdentity.t.sol";
import {ProtocolSkip, TradeBatchV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxSwapBoundsV2 as Bounds} from "../../../src/box-v2/libraries/BoxSwapBoundsV2.sol";
interface PlainFees {
    function sellFees() external returns (ProtocolSkip skip, uint256 tIn, uint256 pOut, uint256 tip);
    function tFeesPending() external view returns (uint256);
}
contract FeesSoldTest is CQ11AFixture {
    using StateLibrary for IPoolManager;
    function _sell(uint256 tIn) internal { trader.trade(key, false, -int256(tIn), TickMath.MAX_SQRT_PRICE - 1); }
    function _fees() internal view returns (PlainFees) { return PlainFees(address(hook)); }
    function test_addDepthAcceptsTFees() public {
        _migrate(); _sell(t.balanceOf(address(trader)) / 4);
        uint256 beforeT = pm.balanceOf(address(hook), uint160(address(t)));
        hook.deepen(address(0));
        assertGt(pm.balanceOf(address(hook), uint160(address(t))), beforeT, "add collects T fees as claims");
        assertGt(_fees().tFeesPending(), 0);
    }
    function test_deepenFeeHasProtocolUnits() public {
        NoticeProbe notice = new NoticeProbe();
        vm.etch(address(hook), bytes.concat(address(hook).code, abi.encodePacked(address(notice))));
        _migrate(); uint256 id = hook.currentTradeBatch(true);
        trader.trade(key, true, -int256(RAISE / 1000), TickMath.MIN_SQRT_PRICE + 1); // mixed batch
        hook.deepen(address(0));
        TradeBatchV2 memory b = hook.tradeBatch(id);
        assertGt(b.tradeUnits, 0); assertGt(b.protocolUnits, 0, "self-buy P is not user funding");
        assertGt(b.netP, 0);
    }
    function test_curveFeesAndGiftsNeverJoinWaitingCounter() public {
        _open(); _buy(RAISE / 10);
        _sell(t.balanceOf(address(trader)) / 2);
        receiver.harvest(hook);
        assertGt(pm.balanceOf(address(hook), uint160(address(t))), 0);
        assertEq(_fees().tFeesPending(), 0);
        t.setRefuseBurn(true); _migrate();
        uint256 refused = pm.balanceOf(address(hook), uint160(address(t)));
        assertGt(refused, 0); assertEq(_fees().tFeesPending(), 0);
        trader.gift(address(t), address(hook), 1e18);
        assertEq(_fees().tFeesPending(), 0);
        _sell(t.balanceOf(address(trader)) / 10); receiver.harvest(hook);
        assertEq(_fees().tFeesPending(), pm.balanceOf(address(hook), uint160(address(t))) - refused - 1e18);
    }
    function testFuzz_saleBoundAndTip(uint96 seed) public {
        _migrate();
        uint256 sold = bound(seed, t.balanceOf(address(trader)) / 100, t.balanceOf(address(trader)) / 2);
        _sell(sold); receiver.harvest(hook);
        uint256 waiting = _fees().tFeesPending(); assertGt(waiting, 0);
        (uint160 beforePrice,,,) = pm.getSlot0(hook.poolId());
        uint256 receiverBefore = _claims(address(receiver));
        (ProtocolSkip skip, uint256 used, uint256 out, uint256 tip) = _fees().sellFees();
        assertEq(uint8(skip), uint8(ProtocolSkip.None));
        (uint160 afterPrice,,,) = pm.getSlot0(hook.poolId());
        assertLe(afterPrice, Bounds.roomLimit(false, beforePrice, 49));
        assertGe(afterPrice, beforePrice);
        assertLe(TickMath.getTickAtSqrtPrice(afterPrice) - TickMath.getTickAtSqrtPrice(beforePrice), 49);
        assertGt(used, 0); assertLe(used, waiting); assertGt(out, 0);
        assertLe(tip, out / 20); assertLe(tip, hook.deepenTipCap());
        assertEq(p.balanceOf(address(this)), tip);
        assertEq(_claims(address(receiver)) - receiverBefore, out - tip);
        assertEq(hook.saleFeesPending(), out - tip);
        assertEq(hook.lastProtocolBlock(), block.number);
        (skip,,,) = _fees().sellFees(); assertEq(uint8(skip), uint8(ProtocolSkip.StepTaken));
        (skip,,,) = hook.deepen(address(0)); assertEq(uint8(skip), uint8(ProtocolSkip.StepTaken));
    }
    function test_repeatedSalesDrainToStepMinimum() public {
        _migrate(); _sell(t.balanceOf(address(trader)) / 2); receiver.harvest(hook);
        uint256 first = _fees().tFeesPending(); uint256 iterations;
        while (iterations++ < 100) {
            vm.roll(block.number + 1);
            (ProtocolSkip skip,,,) = _fees().sellFees();
            if (skip == ProtocolSkip.BelowMinimum) break;
        }
        assertLt(iterations, 100); assertLt(_fees().tFeesPending(), first / 100);
        (uint160 price,,,) = pm.getSlot0(hook.poolId());
        assertLt(Bounds.tInQAtSqrt(_fees().tFeesPending(), price), RAISE / 100000);
    }
    function test_migrationPokeDoesNotCountCurveFees() public {
        _open(); _buy(RAISE / 10); _sell(t.balanceOf(address(trader)) / 2);
        t.setRefuseBurn(true); _migrate();
        assertGt(pm.balanceOf(address(hook), uint160(address(t))), 0);
        assertEq(_fees().tFeesPending(), 0);
    }
    function test_belowMinimumDoesNotTakeStepOrMoveClaims() public {
        _migrate();
        uint256 beforeP = hook.depthBudget();
        (ProtocolSkip skip, uint256 used, uint256 out, uint256 tip) = _fees().sellFees();
        assertEq(uint8(skip), uint8(ProtocolSkip.BelowMinimum));
        assertEq(used + out + tip, 0); assertEq(hook.lastProtocolBlock(), 0);
        assertEq(hook.depthBudget(), beforeP);
        hook.deepen(address(0));
        assertEq(hook.lastProtocolBlock(), block.number);
    }
    function test_tipCapBindsAndDepthBudgetIsNotSpent() public {
        _migrate(); _sell(t.balanceOf(address(trader)) / 2);
        bytes memory code = address(hook).code;
        // Clone header 45 + TIP_MAX_Q at immutable offset 179, uint128 big endian.
        for (uint256 i; i < 16; ++i) code[45 + 179 + i] = i == 15 ? bytes1(uint8(1)) : bytes1(0);
        vm.etch(address(hook), code);
        uint256 beforeP = hook.depthBudget();
        (,, uint256 out, uint256 tip) = _fees().sellFees();
        assertGt(out / 20, 1); assertEq(tip, 1);
        assertEq(hook.depthBudget(), beforeP, "tip comes only from sold fees");
    }
    function test_refusedTipStaysInSellersProceeds() public {
        _migrate(); _sell(t.balanceOf(address(trader)) / 2); receiver.harvest(hook);
        uint256 beforeP = hook.depthBudget(); uint256 beforeReceiver = _claims(address(receiver));
        vm.mockCallRevert(address(p), abi.encodeWithSignature("transfer(address,uint256)", address(this)), "refused");
        (,, uint256 out, uint256 tip) = _fees().sellFees();
        assertGt(out, 0); assertEq(tip, 0);
        assertEq(hook.saleFeesPending(), out);
        assertEq(_claims(address(receiver)), beforeReceiver + out);
        assertEq(hook.depthBudget(), beforeP);
    }
    function test_soldPUsesSellersBatch() public {
        NoticeProbe notice = new NoticeProbe();
        vm.etch(address(hook), bytes.concat(address(hook).code, abi.encodePacked(address(notice))));
        _migrate(); _sell(t.balanceOf(address(trader)) / 4);
        uint256 sellers = hook.currentTradeBatch(false);
        uint256 buyers = hook.currentTradeBatch(true);
        uint256 buyP = hook.tradeBatch(buyers).netP;
        (, , uint256 out, uint256 tip) = _fees().sellFees();
        assertGt(out, 0); assertEq(hook.tradeBatch(sellers).netP, out - tip);
        assertEq(hook.tradeBatch(buyers).netP, buyP);
        assertGt(hook.tradeBatch(sellers).tradeUnits, 0);
    }
}
