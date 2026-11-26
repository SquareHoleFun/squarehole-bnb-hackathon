// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "test/box-v2/rc5-a/NoFailureSweep.sol";

import {FailureTestBase, IBoxCoordinatorV2, IBoxCoordinator, FailCause}
    from "test/box-v2/m1-31/FailureTestBase.sol";

/// @notice Keeper-facing calls against merged CQ11-C and the real PoolManager; other box parts use C's kit.
contract KeeperCallsTest is FailureTestBase {
    address internal constant KEEPER = address(0x99);
    uint256 internal constant KEEPER_FAILURE_GAS = 3_500_000;

    function test_hatchPermissionGasAndAtomicRetry() public {
        _give(ALICE, 100);
        _fund(p, address(hook), 100);
        hook.fill();
        uint256 end = hook.closedAt() + 7 days;
        vm.warp(end - 1);
        vm.prank(KEEPER);
        (bool early,) = address(box).call{gas: KEEPER_FAILURE_GAS}(abi.encodeCall(box.fail, ()));
        assertFalse(early);
        vm.warp(end);
        vm.prank(KEEPER);
        (bool low,) = address(box).call{gas: 300_000}(abi.encodeCall(box.fail, ()));
        assertFalse(low);
        assertFalse(box.failed());
        vm.prank(KEEPER);
        (bool ok,) = address(box).call{gas: KEEPER_FAILURE_GAS}(abi.encodeCall(box.fail, ()));
        assertTrue(ok);
        assertEq(uint256(box.failCause()), uint256(FailCause.GraduationTimedOut));
        assertEq(_pot(), 100);
        assertEq(_left(), 100);
    }

    function test_rewardIsOnlyTheKeepersOwnGraduation() public {
        _fund(p, address(hook), 15);
        hook.configure(0, 15, 0);
        hook.fill();
        vm.prank(KEEPER);
        assertEq(box.graduate(), 15);
        assertEq(box.rewardOf(KEEPER), 15);
        vm.prank(ALICE);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        box.claimReward(ALICE);
        vm.prank(KEEPER);
        assertEq(box.claimReward(KEEPER), 15);
        assertEq(_balance(KEEPER), 15);
        assertEq(box.rewardOf(KEEPER), 0);
    }

    function test_lateSweepCannotSpendOutstandingClaims() public {
        _give(ALICE, 100);
        _fund(p, address(hook), 100);
        _expire();
        vm.prank(KEEPER);
        box.fail();
        vm.prank(KEEPER);
        NoFailureSweep.check(address(box));
        assertEq(_claim(ALICE, 100, ALICE), 100);
        _fund(p, address(box), 37);
        vm.prank(KEEPER);
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), 0);
        assertEq(_pot(), 37);
    }

    function test_failClosedIsTheFourteenDayGate() public {
        _box(p, false, false);
        vm.warp(box.openAt() + 14 days);
        vm.prank(KEEPER);
        (bool ok,) = address(box).call{gas: KEEPER_FAILURE_GAS}(abi.encodeCall(box.failClosed, ()));
        assertTrue(ok);
        assertEq(uint256(box.failCause()), uint256(FailCause.ClosedPastCap));
    }

    /// @notice FABLE item 2: off-chain batching must never introduce a minimum for holder exits.
    function test_oneRawUnitHolderClaimStillExits() public {
        _give(ALICE, 1);
        _fund(p, address(hook), 1);
        _expire();
        vm.prank(KEEPER);
        box.fail();
        assertEq(_left(), 1);
        assertEq(_claim(ALICE, 1, ALICE), 1);
        assertEq(_left(), 0);
        assertEq(_pot(), 0);
    }
}
