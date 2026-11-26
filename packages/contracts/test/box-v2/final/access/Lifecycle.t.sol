// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../rc5-a/NoFailureSweep.sol";

import {FinalAccessFixture} from "./Fixture.sol";
import {FailCause} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxCoordinatorV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {PileVaultV2} from "../../../../src/box-v2/PileVaultV2.sol";
import {LifeForeignUnlock} from "../../kit/FactoryLife.sol";
import {VmSafe} from "forge-std/Vm.sol";

contract FinalLifecycleTest is FinalAccessFixture {
    function test_L05_failedGraduationForeignUnlockAndLowGasNeverConsumeTheHatch() public {
        for (uint256 family; family < 6; ++family) {
            uint256 snapshot = vm.snapshotState();
            _start(_family(family));
            _fill();
            uint256 fill = hook.closedAt();
            uint256 supply = token.totalSupply();
            vm.mockCallRevert(address(hook), abi.encodeWithSelector(IBoxHookV2.migrate.selector), "migration refused");
            vm.expectRevert(bytes("migration refused"));
            box.graduate();
            vm.clearMockedCalls();
            assertFalse(box.graduated());
            assertEq(hook.closedAt(), fill);
            vm.warp(fill + 7 days);
            LifeForeignUnlock foreign = new LifeForeignUnlock(pm);
            (bool ok, bytes memory reason) = foreign.attempt(address(box), abi.encodeCall(box.fail, ()));
            assertFalse(ok);
            assertEq(reason, abi.encodeWithSelector(IBoxCoordinatorV2.ForeignUnlock.selector));
            (ok,) = address(box).call{gas: 150_000}(abi.encodeCall(box.fail, ()));
            assertFalse(ok);
            assertFalse(box.failed());
            assertEq(box.failedAt(), 0);
            assertEq(token.totalSupply(), supply);
            assertEq(hook.closedAt(), fill);
            box.fail();
            assertEq(box.failedAt(), fill + 7 days);
            _claimBuyer();
            assertTrue(vm.revertToState(snapshot));
        }
    }

    function test_L06_hostileItemLedgerCannotBlockTradingFeesTransfersOrTheFailureExit() public {
        for (uint256 mode; mode < 4; ++mode) {
            uint256 snapshot = vm.snapshotState();
            _start(_family(mode < 2 ? 2 : 4));
            address ledger = box.roleAddress(16);
            // Fault injection only after successful production admission; no alternate release part.
            vm.etch(ledger, mode % 2 == 0 ? bytes(hex"60006000fd") : bytes(hex"5b600056"));
            vm.startStateDiffRecording();
            _buy(box.raise() / 5);
            uint256 held = token.balanceOf(address(buyer));
            buyer.swap(hook.poolKey(), false, held / 8, layout.sqrtPriceStartX96);
            vm.prank(address(buyer));
            token.transfer(CREATOR, 1);
            vm.prank(CREATOR);
            token.transfer(address(buyer), 1);
            _gift(address(receiver), 1500);
            receiver.collect(address(0));
            assertGt(receiver.itemsHeldP(), 0);
            _booked();
            vm.warp(box.deadline());
            box.fail();
            assertEq(receiver.itemsHeldP(), 0);
            assertEq(pm.balanceOf(ledger, 0), 0);
            _claimBuyer();
            VmSafe.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
            for (uint256 i; i < accesses.length; ++i) {
                if (accesses[i].kind == VmSafe.AccountAccessKind.Call) {
                    assertTrue(accesses[i].account != ledger, "mandatory money paths never call item ledger");
                }
            }
            assertTrue(vm.revertToState(snapshot));
        }
    }

    function test_L01_deadlineFailureAndWholePotExitAcrossAllSixFamilies() public {
        for (uint256 family; family < 6; ++family) {
            uint256 snapshot = vm.snapshotState();
            _start(_family(family));
            _buy(box.raise() / 5);
            receiver.collect(address(0));
            uint256 money = _money() + OUTSIDER.balance;
            uint256 deadline = box.deadline();
            vm.warp(deadline - 1);
            _refuse(address(box), OUTSIDER, abi.encodeCall(box.fail, ()));
            assertFalse(box.failed());
            vm.warp(deadline);
            vm.prank(OUTSIDER);
            box.fail();
            assertEq(uint256(box.failCause()), uint256(FailCause.Deadline));
            _claimBuyer();
            assertEq(_money() + OUTSIDER.balance, money, "P conserved including closer tip and final claim");
            _refuse(address(box), OUTSIDER, abi.encodeCall(box.graduate, ()));
            _refuse(address(box), OUTSIDER, abi.encodeCall(box.fail, ()));
            _booked();
            assertTrue(vm.revertToState(snapshot));
        }
    }

    function test_L02_firstFillHatchAndBothRaceOrdersAcrossAllSixFamilies() public {
        for (uint256 family; family < 6; ++family) {
            uint256 snapshot = vm.snapshotState();
            _start(_family(family));
            _fill();
            uint256 filled = hook.closedAt();
            vm.warp(filled + 7 days - 1);
            bytes memory err = _refuse(address(box), OUTSIDER, abi.encodeCall(box.fail, ()));
            assertEq(
                err, abi.encodeWithSelector(IBoxCoordinatorV2.GraduationEscapeNotReached.selector, filled + 7 days)
            );
            assertEq(hook.closedAt(), filled);
            vm.warp(filled + 7 days);
            uint256 race = vm.snapshotState();
            vm.prank(OUTSIDER);
            box.graduate();
            _refuse(address(box), CREATOR, abi.encodeCall(box.fail, ()));
            assertTrue(box.graduated());
            assertFalse(box.failed());
            assertTrue(vm.revertToState(race));
            vm.prank(OUTSIDER);
            box.fail();
            assertEq(uint256(box.failCause()), uint256(FailCause.GraduationTimedOut));
            assertLt(block.timestamp, box.deadline(), "hatch independent of original deadline");
            _refuse(address(box), CREATOR, abi.encodeCall(box.graduate, ()));
            _claimBuyer();
            assertTrue(vm.revertToState(snapshot));
        }
    }

    function test_L03_yearBoundaryPreservesPotButNeverRecountsCoinsAcrossAllSixFamilies() public {
        for (uint256 family; family < 6; ++family) {
            uint256 snapshot = vm.snapshotState();
            _start(_family(family));
            _buy(box.raise() / 5);
            vm.warp(box.deadline());
            box.fail();
            (uint256 pot, uint256 left) = box.claimState();
            assertGt(pot, 0);
            assertGt(left, 0);
            vm.prank(address(buyer));
            token.burn(1);
            (, uint256 stillLeft) = box.claimState();
            assertEq(stillLeft, left, "R40A freezes counted T despite later disposal");
            uint256 year = box.failedAt() + 365 days;
            vm.warp(year - 1);
            _refuse(address(box), OUTSIDER, abi.encodeWithSignature("sweepAfterLastClaim()"));
            assertGt(box.quoteClaim(left), 0);
            vm.warp(year);
            uint256 fit = receiver.fitOwed();
            vm.prank(OUTSIDER);
            NoFailureSweep.check(address(box));
            assertEq(receiver.fitOwed(), fit);
            (uint256 remaining, uint256 count) = box.claimState();
            assertEq(remaining, pot);
            assertEq(count, left);
            assertEq(box.quoteClaim(left), pot);
            _gift(address(box), 37);
            NoFailureSweep.check(address(box));
            assertEq(receiver.fitOwed(), fit);
            NoFailureSweep.check(address(box));
            _booked();
            assertTrue(vm.revertToState(snapshot));
        }
    }

    function test_L04_unloadedCollectionAndSeedGateCloseExactlyAtFourteenDays() public {
        for (uint256 family; family < 2; ++family) {
            uint256 snapshot = vm.snapshotState();
            box = _create(family == 0 ? _hiddenSpec() : _pile(address(0), 1 ether));
            assertFalse(box.gateOpen());
            uint256 end = box.openAt() + 14 days;
            vm.warp(end - 1);
            _refuse(address(box), OUTSIDER, abi.encodeCall(box.failClosed, ()));
            vm.warp(end);
            vm.prank(OUTSIDER);
            box.failClosed();
            assertEq(uint256(box.failCause()), uint256(FailCause.ClosedPastCap));
            assertEq(box.failedAt(), end);
            assertFalse(box.gateOpen());
            if (family == 1) {
                vm.prank(OUTSIDER);
                assertEq(PileVaultV2(payable(box.vault())).returnSeed(), 0);
            }
            assertTrue(vm.revertToState(snapshot));
        }
    }
}
