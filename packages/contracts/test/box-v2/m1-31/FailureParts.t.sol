// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FailureTestBase, IBoxCoordinatorV2, IBoxCoordinator, FailCause} from "./FailureTestBase.sol";
import {Vm} from "forge-std/Vm.sol";

contract FailurePartsTest is FailureTestBase {
    function test_deadlineAndGateCapExactBoundaries() public {
        vm.warp(box.deadline() - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.DeadlineNotReached.selector, box.deadline()));
        box.fail();
        vm.warp(box.deadline());
        box.fail();
        assertEq(uint256(box.failCause()), uint256(FailCause.Deadline));
        _box(p, true, false);
        uint256 end = box.openAt() + 14 days;
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.GateCapNotReached.selector, end));
        box.failClosed();
        vm.warp(end);
        box.failClosed();
        assertEq(uint256(box.failCause()), uint256(FailCause.ClosedPastCap));
    }

    function test_failClosedRefusesOpenGate() public {
        vm.expectRevert(IBoxCoordinatorV2.GateNotHolding.selector);
        box.failClosed();
    }

    function test_closeFirstThenSweepVaultAndReserveSplit() public {
        _give(ALICE, 100);
        _fund(p, address(hook), 1300);
        hook.configure(150, 150, 0);
        _tax(10);
        _expire();
        vm.recordLogs();
        box.fail();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 step = 2;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("Step(uint256)")) {
                assertEq(abi.decode(logs[i].data, (uint256)), step++);
            }
        }
        assertEq(step, 6);
        assertEq(receiver.feeInput(), 300);
        assertEq(receiver.fitOwed(), 40);
        assertEq(receiver.platformOwed(), 20);
        assertEq(_pot(), 1250);
        assertEq(_left(), 100);
        assertEq(box.reserve(), 0);
        assertEq(vault.windowEnds(), block.timestamp + 14 days);
        assertEq(_pot() + receiver.fitOwed() + receiver.platformOwed(), 1310);
    }

    function test_directFailuresRollbackEveryStepAndRetry() public {
        _give(ALICE, 100);
        _fund(p, address(hook), 100);
        _tax(10);
        _expire();
        receiver.setReject(true);
        vm.expectRevert();
        box.fail();
        assertFalse(box.failed());
        assertFalse(hook.failed());
        assertEq(vault.windowEnds(), 0);
        assertEq(_balance(address(router)), 10);
        assertEq(t.balanceOf(address(box)), SUPPLY - 100);
        receiver.setReject(false);
        box.fail();
        assertTrue(box.failed());
        assertEq(_pot(), 110);
        vm.expectRevert(IBoxCoordinatorV2.AlreadyFailed.selector);
        box.fail();
    }

    function test_closeAndVaultRefusalsAreAtomic() public {
        _expire();
        hook.setReject(true, false);
        vm.expectRevert();
        box.fail();
        assertFalse(box.failed());
        hook.setReject(false, false);
        vault.setReject(true);
        vm.expectRevert();
        box.fail();
        assertFalse(box.failed());
        assertFalse(hook.failed());
        vault.setReject(false);
        box.fail();
    }

    function test_refusedAndGasExhaustingSweepAreFailSafe() public {
        _give(ALICE, 100);
        _fund(p, address(hook), 100);
        _tax(10);
        router.configure(false, true);
        _expire();
        box.fail();
        assertEq(_pot(), 100);
        assertEq(_balance(address(router)), 10);
        router.configure(false, false);
        router.sweep();
        assertEq(_pot(), 110);
    }

    function test_lowGasRevertsWholeFailureThenRetries() public {
        _give(ALICE, 100);
        _fund(p, address(hook), 100);
        _expire();
        (bool ok,) = address(box).call{gas: 300_000}(abi.encodeCall(box.fail, ()));
        assertFalse(ok);
        assertFalse(box.failed());
        assertFalse(hook.failed());
        assertEq(pm.balanceOf(address(hook), uint256(uint160(p))), 100);
        box.fail();
        assertEq(_pot(), 100);
    }

    function test_failureUsesNamedStipendsWithoutLegacyFloor() public {
        _give(ALICE, 100);
        _fund(p, address(hook), 100);
        _expire();
        (bool ok,) = address(box).call{gas: 12_000_000}(abi.encodeCall(box.fail, ()));
        assertTrue(ok);
        assertEq(_left(), 100);
    }

    function test_foreignUnlockRefusesBeforeWriting() public {
        _expire();
        foreignCall = abi.encodeCall(box.fail, ());
        pm.unlock("");
        assertFalse(foreignOk);
        assertEq(foreignResult, abi.encodeWithSelector(IBoxCoordinatorV2.ForeignUnlock.selector));
        assertFalse(box.failed());
        box.fail();
    }

    function test_pausedPAndRefusedTipCannotBlockFailure() public {
        _give(ALICE, 100);
        _fund(p, address(hook), 100);
        hook.configure(0, 0, 5);
        _tax(10);
        _expire();
        priceToken.setPaused(true);
        box.fail();
        assertEq(_pot(), 100);
        assertEq(_left(), 100);
        assertEq(_balance(address(router)), 10);
        assertEq(_balance(address(this)), 0);
    }

    function test_tipLastCappedAndNoBuyerAmountExcludesPaidTip() public {
        priceToken.mint(address(this), 1); // existing recipient balance: successful tip within the frozen stipend
        _fund(p, address(hook), 101);
        hook.configure(0, 0, 5);
        _expire();
        box.fail();
        assertEq(_balance(address(this)), 6);
        assertEq(box.quoteClaim(0), 96);
        assertEq(_claim(CREATOR, 0, CREATOR), 96);
    }

    function test_noBuyerRefusedTipRemainsInFixedReturn() public {
        _fund(p, address(hook), 101);
        hook.configure(0, 0, 5);
        _expire();
        priceToken.setPaused(true);
        box.fail();
        assertEq(box.quoteClaim(0), 101);
        assertEq(_pot(), 101);
        priceToken.setPaused(false);
        assertEq(_claim(CREATOR, 0, CREATOR), 101);
    }

    function test_tokenOnlyFailureAndFullPotTip() public {
        _box(p, false, true);
        _give(ALICE, 1);
        _fund(p, address(hook), 3);
        hook.configure(0, 0, 5);
        _expire();
        box.fail();
        assertEq(_balance(address(this)), 3);
        assertEq(_pot(), 0);
        assertEq(_left(), 1);
    }
}
