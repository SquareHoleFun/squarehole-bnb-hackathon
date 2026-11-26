// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverFixture, ReceiverArgs, ReceiverHook} from "../../cq11-b/ReceiverFixture.sol";
import {BatchHookFixture} from "../../m2-30/HolderFixture.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// F130: anyone may choose payout timing; the immutable Safe receives the whole payout.
contract M263SafeClaimsTest is ReceiverFixture {
    function setUp() public override {
        super.setUp();
        BatchHookFixture batches = new BatchHookFixture();
        hook = ReceiverHook(address(batches));
        ReceiverArgs memory a = _args(4, 4, 1, address(p));
        a.holderLedger = address(0x1717);
        r = _clone(a);
        coord.initialize(r);
        batches.receipt(1, 1500, false);
        driver.mintClaims(Currency.wrap(address(p)), address(r), 1500);
        r.collect(address(0));
        assertEq(r.fitOwed(), 200);
        assertEq(r.platformOwed(), 100);
    }

    function test_F130_anyCallerTriggersWholeFitPayoutOnlyToFixedSafe() public {
        _safePayout(true, address(0xBAD));
    }

    function test_F130_anyCallerTriggersWholePlatformPayoutOnlyToFixedSafe() public {
        _safePayout(false, address(0xBAD));
    }

    function testFuzz_F130_triggerCannotRedirectOrTakeATip(address caller, bool fit) public {
        vm.assume(caller != address(0) && caller != FIT && caller != PLATFORM);
        _safePayout(fit, caller);
    }

    function _safePayout(bool fit, address caller) private {
        address safe = fit ? FIT : PLATFORM;
        uint256 owed = fit ? r.fitOwed() : r.platformOwed();
        uint256 otherOwed = fit ? r.platformOwed() : r.fitOwed();
        uint256 backing = _balance(address(r));
        uint256 booked = r.booked(address(p));
        uint256 callerP = p.balanceOf(caller);
        assertEq(fit ? r.FIT_SAFE() : r.PLATFORM_SAFE(), safe);
        assertGt(owed, 0);
        vm.prank(caller);
        assertEq(fit ? r.payFit() : r.payPlatform(), owed);
        assertEq(p.balanceOf(safe), owed, "whole payout goes to the fixed Safe");
        assertEq(p.balanceOf(caller), callerP, "trigger receives no payout or tip");
        assertEq(p.balanceOf(fit ? PLATFORM : FIT), 0);
        assertEq(fit ? r.fitOwed() : r.platformOwed(), 0);
        assertEq(fit ? r.platformOwed() : r.fitOwed(), otherOwed);
        assertEq(_balance(address(r)) + owed, backing);
        assertEq(r.booked(address(p)) + owed, booked);
        vm.prank(address(0xBEEF));
        assertEq(fit ? r.payFit() : r.payPlatform(), 0, "no duplicate payout");
        assertEq(p.balanceOf(safe), owed);
        assertEq(_balance(address(r)) + owed, backing);
        _booked();
    }

    function test_F130_refusedFitRetainsCreditAndAnyoneCanRetry() public { _retry(true); }
    function test_F130_refusedPlatformRetainsCreditAndAnyoneCanRetry() public { _retry(false); }

    function _retry(bool fit) private {
        address safe = fit ? FIT : PLATFORM;
        address other = fit ? PLATFORM : FIT;
        uint256 owed = fit ? r.fitOwed() : r.platformOwed();
        uint256 otherOwed = fit ? r.platformOwed() : r.fitOwed();
        uint256 backing = _balance(address(r));
        uint256 booked = r.booked(address(p));
        p.setBlocked(safe, true);
        vm.prank(address(0xBAD));
        assertEq(fit ? r.payFit() : r.payPlatform(), 0);
        assertEq(fit ? r.fitOwed() : r.platformOwed(), owed);
        assertEq(_balance(address(r)), backing);
        assertEq(r.booked(address(p)), booked);
        assertEq(p.balanceOf(safe), 0);
        vm.prank(address(0xBEEF));
        assertEq(fit ? r.payPlatform() : r.payFit(), otherOwed);
        assertEq(p.balanceOf(other), otherOwed);
        assertEq(fit ? r.platformOwed() : r.fitOwed(), 0);
        assertEq(fit ? r.fitOwed() : r.platformOwed(), owed);
        p.setBlocked(safe, false);
        vm.prank(address(0xBEEF));
        assertEq(fit ? r.payFit() : r.payPlatform(), owed);
        assertEq(p.balanceOf(safe), owed);
        assertEq(fit ? r.fitOwed() : r.platformOwed(), 0);
        assertEq(_balance(address(r)) + p.balanceOf(FIT) + p.balanceOf(PLATFORM), backing);
        assertEq(p.balanceOf(address(0xBAD)) + p.balanceOf(address(0xBEEF)), 0);
        vm.prank(address(0xBAD));
        assertEq(fit ? r.payFit() : r.payPlatform(), 0);
        assertEq(_balance(address(r)) + p.balanceOf(FIT) + p.balanceOf(PLATFORM), backing);
        _booked();
    }
}
