// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Vm} from "forge-std/Vm.sol";
import {HolderFixture} from "test/box-v2/m2-30/HolderFixture.sol";

contract M263HolderEventsTest is HolderFixture {
    function test_ownerClaimEmitsExactZeroTipAndPauseRollsBack() public {
        _move(SYSTEM, ALICE, 100, false); _trade(1, 100, false, true); _close(1, 1);
        _settle(1, 16);
        assertEq(ledger.claimable(1, ALICE), 1, "no claim minimum");
        coord.fail(); p.setPaused(true);
        vm.prank(ALICE); vm.expectRevert(); ledger.claim(1, ALICE);
        assertEq(ledger.claimable(1, ALICE), 1);
        p.setPaused(false); vm.recordLogs();
        vm.prank(ALICE); assertEq(ledger.claim(1, ALICE), 1);
        Vm.Log[] memory logs = vm.getRecordedLogs(); uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(ledger)) continue;
            assertEq(logs[i].topics[0], keccak256("HolderPaid(uint256,address,address,uint256,uint256)"));
            assertEq(logs[i].topics[1], bytes32(uint256(1)));
            assertEq(logs[i].topics[2], bytes32(uint256(uint160(ALICE))));
            assertEq(logs[i].topics[3], bytes32(uint256(uint160(ALICE))));
            assertEq(logs[i].data, abi.encode(uint256(1), uint256(0))); ++count;
        }
        assertEq(count, 1); assertEq(p.balanceOf(ALICE), 1); assertEq(p.balanceOf(PUSHER), 0);
        assertEq(ledger.claimable(1, ALICE), 0);
        vm.prank(ALICE); vm.expectRevert(); ledger.claim(1, ALICE);
    }

    function test_skippedNoticeBecomesResidueAndNeitherBatchNorCallerBorrowsCredit() public {
        _move(SYSTEM, ALICE, 100, false);
        _trade(1, 100, false, true); _trade(1, 100, false, false); _close(1, 1000);
        _trade(2, 100, false, true); _close(2, 7);
        _settle(1, 16); _settle(2, 16);
        assertEq(ledger.claimable(1, ALICE), 500); assertEq(ledger.claimable(2, ALICE), 7);
        vm.prank(BOB); vm.expectRevert(); ledger.claim(1, BOB);
        (bool pushed,) = address(ledger).call(abi.encodeWithSignature("claimFor(uint256,address)", 1, ALICE));
        assertFalse(pushed); assertEq(ledger.claimable(1, ALICE), 500);
        coord.fail(); assertEq(ledger.flushResidue(1), 500);
        assertEq(pm.balanceOf(address(receiver), uint160(address(p))), 500);
        assertEq(ledger.flushResidue(1), 0);
        vm.prank(ALICE); assertEq(ledger.claim(1, ALICE), 500);
        assertEq(ledger.claimable(2, ALICE), 7);
        vm.prank(ALICE); assertEq(ledger.claim(2, ALICE), 7);
        assertEq(p.balanceOf(ALICE), 507);
    }
}
