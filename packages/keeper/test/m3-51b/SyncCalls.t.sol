// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {KeeperItemCallsTest} from "../solidity/M3Calls.t.sol";
import {IItemLedgerV2} from "src/box-v2/interfaces/IItemLedgerV2.sol";

/// @notice Real ledger/PM proof for the keeper's 32-entry page; inherited S2/S3 producers are doubles.
contract KeeperSync32Test is KeeperItemCallsTest {
    function test_sync32BothJournalsPreservesPendingCreditAndOwnerExit() public {
        j.graduate();
        j.pick(1, ALICE);
        ledger.sync(32);
        uint256 funding = ledger.fundingCursor();
        uint256 lifecycle = ledger.lifecycleCursor();
        // Receipts and custody interleave, leaving two entries per journal for the second page.
        for (uint256 i; i < 34; ++i) {
            if (i % 2 == 0) j.back(1);
            else j.pick(1, ALICE);
            j.fund(1, 2, 0, 7);
        }
        vm.expectRevert(abi.encodeWithSelector(IItemLedgerV2.ItemSyncPending.selector, funding, lifecycle));
        vm.prank(ALICE);
        ledger.claim(_ids(1), ALICE);
        vm.cool(address(ledger));
        vm.cool(address(j));
        vm.cool(address(j.history()));
        vm.cool(address(pm));
        uint256 start = gasleft();
        vm.prank(KEEPER);
        // The keeper uses a pending estimate plus headroom when it exceeds the 3M floor.
        ledger.sync{gas: 6_000_000}(32);
        emit log_named_uint("32 interleaved receipts and operations call gas", start - gasleft());
        assertEq(ledger.fundingCursor(), funding + 32);
        assertEq(ledger.lifecycleCursor(), lifecycle + 32);
        assertEq(ledger.flushResidue(), 96);
        assertEq(pm.balanceOf(address(ledger), 0), 142, "credits, stashes and two unprocessed receipts");
        vm.expectRevert(abi.encodeWithSelector(IItemLedgerV2.ItemSyncPending.selector, funding + 32, lifecycle + 32));
        vm.prank(ALICE);
        ledger.claim(_ids(1), ALICE);
        vm.prank(KEEPER);
        ledger.sync(32);
        assertEq(ledger.fundingCursor(), j.itemFundingCount());
        assertEq(ledger.lifecycleCursor(), j.itemLifecycleCount());
        assertEq(ledger.flushResidue(), 6);
        vm.expectRevert();
        vm.prank(KEEPER);
        ledger.claim(_ids(1), KEEPER);
        // Even a contract owner uses the same owner-only exit after replay; sync never pays it.
        vm.etch(ALICE, hex"00");
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), ALICE), 34);
        assertEq(KEEPER.balance, 0);
        assertEq(ALICE.balance, 34);
        assertEq(pm.balanceOf(address(ledger), 0), 102, "hidden Keep stashes remain backed");
        assertEq(pm.balanceOf(address(ledger), 0) + pm.balanceOf(DEPTH, 0) + ALICE.balance, 238);
        ledger.sync(32);
        assertEq(ledger.flushResidue(), 0);
    }

    function test_sync32LifecycleOnlyRetainsTheFundingCursor() public {
        j.graduate();
        ledger.sync(32);
        uint256 funding = ledger.fundingCursor();
        for (uint256 i; i < 17; ++i) {
            j.pick(1, ALICE);
            j.back(1);
        }
        vm.cool(address(ledger));
        vm.cool(address(j));
        vm.cool(address(j.history()));
        uint256 start = gasleft();
        vm.prank(KEEPER);
        ledger.sync{gas: 6_000_000}(32);
        emit log_named_uint("32 lifecycle-only records call gas", start - gasleft());
        assertEq(ledger.fundingCursor(), funding);
        assertEq(ledger.lifecycleCursor(), 32);
        ledger.sync(32);
        assertEq(ledger.lifecycleCursor(), 34);
        assertEq(pm.balanceOf(address(ledger), 0), 0);
    }
}
