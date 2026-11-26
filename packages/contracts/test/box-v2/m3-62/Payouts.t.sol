// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ItemClaimFixture} from "../m3-21/Fixture.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";

contract M362Payouts is ItemClaimFixture {
    function test_lifecycleOnlyBacklogPreservesCreditUntilSync() public {
        _funded(100);
        uint256 funding = ledger.fundingCursor();
        uint256 lifecycle = ledger.lifecycleCursor();
        j.back(1);
        j.pick(1, BOB);
        assertEq(j.itemFundingCount(), funding, "no funding backlog can mask this check");
        assertGt(j.itemLifecycleCount(), lifecycle);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(IItemLedgerV2.ItemSyncPending.selector, funding, lifecycle));
        ledger.claim(_ids(1), BOB);
        assertEq(_credit(1), 100);
        assertEq(BOB.balance, 0);
        _sync();
        vm.prank(BOB);
        assertEq(ledger.claim(_ids(1), BOB), 100);
        _debitModel(1, BOB, 100);
        _conserved();
    }

    function test_sameSecondReverseDeliveryPaysEachOwnerExactAmount() public {
        bytes32 a = keccak256("request A");
        bytes32 b = keccak256("request B");
        j.fund(1, 2, 0, 400); // Four separate 100 P base stashes.
        j.graduate();
        j.request(a);
        j.fund(2, 2, 0, 40); // A alone earns 10; 30 stays in receiver burn money.
        j.request(b);
        j.fund(1, 2, 0, 80); // Each ticket earns 20; each hidden slot keeps 20.
        j.deliver(b, 3, BOB);
        j.deliver(a, 1, ALICE);
        _sync();
        (uint256 startA, uint256 creditA, bool openA) = ledger.ticketCredit(a);
        (uint256 startB, uint256 creditB, bool openB) = ledger.ticketCredit(b);
        assertEq(startA, 0);
        assertEq(startB, 10);
        assertEq(creditA + creditB, 0);
        assertFalse(openA || openB);
        assertEq(_credit(1), 130, "A's base and its own request interval");
        assertEq(_credit(3), 120, "B cannot inherit A's earlier interval");
        vm.prank(BOB);
        assertEq(ledger.claim(_ids(3), BOB), 120);
        _debitModel(3, BOB, 120);
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), ALICE), 130);
        _debitModel(1, ALICE, 130);
        assertEq(ALICE.balance, 130, "correct total cannot excuse the wrong recipient");
        assertEq(BOB.balance, 120);
        assertEq(pm.balanceOf(address(ledger), 0), 240, "two hidden 120 P stashes remain backed");
        _conserved();
    }
}
