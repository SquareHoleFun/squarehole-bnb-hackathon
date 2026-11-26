// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FailureTestBase, IBoxCoordinatorV2, IBoxCoordinator, FailCause} from "../m1-31/FailureTestBase.sol";

contract HatchTest is FailureTestBase {
    function test_sevenDaysFromFirstFillBeforeDeadline() public {
        _give(ALICE, 100);
        _fund(p, address(hook), 100);
        hook.fill();
        uint256 end = hook.closedAt() + 7 days;
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.GraduationEscapeNotReached.selector, end));
        box.fail();
        vm.warp(end);
        vm.prank(BOB);
        box.fail();
        assertLt(block.timestamp, box.deadline());
        assertEq(uint256(box.failCause()), uint256(FailCause.GraduationTimedOut));
        assertEq(_pot(), 100);
        assertEq(_left(), 100);
        assertEq(vault.windowEnds(), end + 14 days);
    }

    function test_unfilledBeforeDeadlineCannotUseHatch() public {
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.DeadlineNotReached.selector, box.deadline()));
        box.fail();
    }

    function test_failedGraduationDoesNotRestartWaitAndHatchWinsRace() public {
        hook.fill();
        uint256 end = hook.closedAt() + 7 days;
        hook.setReject(false, true);
        vm.warp(end - 1);
        vm.expectRevert();
        box.graduate();
        assertFalse(box.graduated());
        hook.fill();
        assertEq(hook.closedAt() + 7 days, end);
        vm.warp(end);
        box.fail();
        vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
        box.graduate();
        vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
        box.fail();
    }

    function test_graduationWinsRaceAndDustBurnRefusalIsFailSafe() public {
        _give(ALICE, 100);
        vault.configure(SUPPLY, 0, false);
        hook.fill();
        vm.warp(hook.closedAt() + 7 days);
        box.graduate();
        assertTrue(box.graduated());
        assertTrue(vault.gate());
        assertEq(t.balanceOf(address(box)), SUPPLY - 100);
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        box.fail();
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        box.failClosed();
    }

    function test_hatchForeignUnlockAndLowGasRollbackRetry() public {
        _give(ALICE, 100);
        _fund(p, address(hook), 100);
        hook.fill();
        vm.warp(hook.closedAt() + 7 days);
        foreignCall = abi.encodeCall(box.fail, ());
        pm.unlock("");
        assertEq(foreignResult, abi.encodeWithSelector(IBoxCoordinatorV2.ForeignUnlock.selector));
        (bool ok,) = address(box).call{gas: 300_000}(abi.encodeCall(box.fail, ()));
        assertFalse(ok);
        assertFalse(box.failed());
        box.fail();
        assertEq(_pot(), 100);
    }

    function test_graduationCreditsOnlyReserveAndRejectsDuplicate() public {
        _fund(p, address(hook), 15);
        hook.configure(0, 15, 0);
        _fund(p, address(box), 9);
        hook.fill();
        assertEq(box.graduate(), 15);
        assertEq(box.rewardOf(address(this)), 15);
        assertEq(pm.balanceOf(address(receiver), uint256(uint160(p))), 9);
        assertEq(receiver.graduationCalls(), 1);
        assertEq(box.claimReward(BOB), 15);
        assertEq(_balance(BOB), 15);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        box.claimReward(BOB);
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        box.graduate();
    }

    function test_hatchAndDeadlineSameMoney() public {
        _give(ALICE, 100);
        _fund(p, address(hook), 1300);
        hook.configure(150, 150, 5);
        _tax(10);
        _expire();
        box.fail();
        uint256 pot = _pot();
        uint256 fit = receiver.fitOwed();
        uint256 platform = receiver.platformOwed();
        _box(p, true, true);
        _give(ALICE, 100);
        _fund(p, address(hook), 1300);
        hook.configure(150, 150, 5);
        _tax(10);
        hook.fill();
        vm.warp(hook.closedAt() + 7 days);
        box.fail();
        assertEq(_pot(), pot);
        assertEq(receiver.fitOwed(), fit);
        assertEq(receiver.platformOwed(), platform);
        assertEq(_left(), 100);
    }
}
