// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {SweepFixture, IBoxCoordinatorV2} from "./SweepFixture.sol";
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

contract YearSweepTest is SweepFixture {
    function test_yearBoundaryNeverClosesHolderRights() public {
        _fail(101, 100);
        vm.warp(box.failedAt() + 365 days - 1);
        assertEq(_claim(ALICE, 33, BOB), 33);
        _retainedAtYear(68);
        assertEq(_claim(ALICE, 67, ALICE), 68);
        assertEq(_pot(), 0);
        assertEq(_balance(FIT), 0);
    }
    function test_pausedPriceAndRefusedRouterPreserveRetryBeyondYear() public {
        _fail(100, 100); _tax(7);
        router.configure(false, true); priceToken.setPaused(true);
        _retainedAtYear(100);
        vm.expectRevert(); vm.prank(ALICE); box.claim(100, BOB);
        assertEq(_left(), 100); assertEq(_pot(), 100);
        priceToken.setPaused(false); router.configure(false, false);
        assertEq(_claim(ALICE, 100, BOB), 107);
        assertEq(fees.payFit(), 0);
    }
    function test_nativePotAndLateHookMoneyReachHolderBeyondYear() public {
        _realBox(1, 2, 1, false, address(0));
        _fail(100, 100); _fund(p, address(hook), 11);
        _retainedAtYear(100);
        assertEq(_claim(ALICE, 100, BOB), 111);
        assertEq(_balance(FIT), 0);
    }
    function test_emptyPotStaysClaimableAndNewMoneyIsProRata() public {
        _fail(0, 100); _retainedAtYear(0);
        assertEq(_claim(ALICE, 40, BOB), 0);
        _fund(p, address(box), 7);
        assertEq(_claim(ALICE, 60, BOB), 7);
    }
    function test_refusingSafeAndReceiverDoNotBlockCreatorAfterYear() public {
        _fail(101, 0); _fund(p, address(box), 19);
        vm.warp(box.failedAt() + 1000 days);
        priceToken.setBlocked(FIT, true);
        vm.mockCallRevert(address(fees), abi.encodeWithSelector(fees.collect.selector), bytes("refused"));
        NoFailureSweep.check(address(box));
        assertEq(box.quoteClaim(0), 101);
        assertEq(_claim(CREATOR, 0, BOB), 101);
        assertEq(_pot(), 19);
    }
    function test_foreignUnlockCannotClaimAndRemovedSelectorRefuses() public {
        _fail(100, 100); vm.warp(box.failedAt() + 1000 days);
        foreignCall = abi.encodeCall(box.claim, (100, ALICE)); pm.unlock("");
        assertFalse(foreignOk);
        assertEq(foreignResult, abi.encodeWithSelector(IBoxCoordinatorV2.ForeignUnlock.selector));
        NoFailureSweep.check(address(box));
        assertEq(_claim(ALICE, 100, ALICE), 100);
    }
}
