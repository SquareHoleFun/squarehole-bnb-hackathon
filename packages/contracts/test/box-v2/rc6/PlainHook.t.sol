// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CQ11ARealFixture} from "../cq11-a/RealFixture.sol";
import {CQATrader} from "../cq11-a/Fixture.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";

contract PlainHookTest is CQ11ARealFixture {
    using StateLibrary for IPoolManager;
    function test_gasBuyAndSale() public {
        _open();
        uint256 gasBefore = gasleft();
        _buy(RAISE / 10);
        emit log_named_uint("buy gas", gasBefore - gasleft());
        uint256 sold = t.balanceOf(address(trader)) / 2;
        gasBefore = gasleft();
        trader.trade(key, false, -int256(sold), layout.sqrtPriceStartX96);
        emit log_named_uint("sale gas", gasBefore - gasleft());
    }
    function test_plainKeyAndStoredFee() public view {
        assertEq(key.fee, 10_000);
        assertEq(hook.REQUIRED_FLAGS(), 0x2ae0);
        (,,, uint24 fee) = pm.getSlot0(hook.poolId());
        assertEq(fee, 10_000);
    }
    function test_saleAccruesTInsteadOfReceiverP() public {
        _open(); _buy(RAISE / 10);
        uint256 beforeP = _claims(address(receiver));
        uint256 sold = t.balanceOf(address(trader)) / 2;
        BalanceDelta d = trader.trade(key, false, -int256(sold), layout.sqrtPriceStartX96);
        assertEq(uint256(-int256(d.amount1())), sold);
        (, uint256 growth) = pm.getFeeGrowthGlobals(hook.poolId());
        assertGt(growth, 0, "sale pays normal T LP fee");
        assertEq(_claims(address(receiver)), beforeP);
        assertEq(hook.saleFeesPending(), 0);
    }
    function test_curveFeesBurnAtGraduation() public {
        _open(); _buy(RAISE / 10);
        trader.trade(key, false, -int256(t.balanceOf(address(trader)) / 2), layout.sqrtPriceStartX96);
        receiver.collect(address(0));
        uint256 claims = pm.balanceOf(address(hook), uint160(address(t)));
        assertGt(claims, 0, "poke retains T fees as claims");
        _graduate();
        assertEq(pm.balanceOf(address(hook), uint160(address(t))), 0, "migration burns curve T fees");
    }
    function test_failureWithTFeesEveryHolderIncludingLastClaimsExactPot() public {
        _open(); _buy(RAISE / 10);
        trader.trade(key, false, -int256(t.balanceOf(address(trader)) / 2), layout.sqrtPriceStartX96);
        (, uint256 growth) = pm.getFeeGrowthGlobals(hook.poolId());
        assertGt(growth, 0, "failure fixture must contain T fees");
        address second = address(0xB0B);
        uint256 held = t.balanceOf(address(trader));
        vm.prank(address(trader)); t.transfer(second, held / 3);
        vm.warp(box.deadline()); box.fail();
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, held, "T fees excluded exactly once");
        uint256 first = t.balanceOf(address(trader));
        vm.startPrank(address(trader)); t.approve(address(box), first);
        assertEq(box.claim(first, address(trader)), pot * first / held); vm.stopPrank();
        uint256 remaining = pot - pot * first / held;
        vm.startPrank(second); t.approve(address(box), held - first);
        assertEq(box.claim(held - first, second), remaining); vm.stopPrank();
        (pot, left) = box.claimState(); assertEq(pot, 0); assertEq(left, 0);
        assertGt(receiver.fitOwed(), 0); assertGt(receiver.platformOwed(), 0);
    }
}
