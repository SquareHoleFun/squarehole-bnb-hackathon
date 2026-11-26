// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ItemClaimFixture, ItemOwner} from "./Fixture.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";

contract ItemClaimsTest is ItemClaimFixture {
    function test_ownerPaysChosenRecipientAndCannotClaimTwice() public {
        _funded(1000);
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), BOB), 1000);
        assertEq(BOB.balance, 1000);
        assertEq(ALICE.balance, 0);
        assertEq(pm.balanceOf(BOB, 0), 0);
        _debitModel(1, ALICE, 1000);
        vm.prank(ALICE);
        vm.expectRevert(INVALID_CLAIM);
        ledger.claim(_ids(1), ALICE);
        _conserved();
    }

    function test_transferKeepsBaseAndEarningsWithCurrentOwner() public {
        j.fund(1, 2, 0, 400);
        j.graduate();
        j.pick(1, ALICE);
        j.fund(1, 2, 0, 800);
        _sync();
        j.move(1, BOB);
        vm.prank(ALICE);
        vm.expectRevert(ItemLedgerV2.Unauthorized.selector);
        ledger.claim(_ids(1), ALICE);
        vm.prank(BOB);
        assertEq(ledger.claim(_ids(1), BOB), 300);
        _debitModel(1, BOB, 300);
        assertEq(BOB.balance, 300);
        _conserved();
    }

    function test_returnRetainsCreditUntilRepickAndResetsClaimCheckpoint() public {
        _funded(100);
        j.back(1);
        j.fund(1, 2, 0, 80);
        _sync();
        vm.prank(ALICE);
        vm.expectRevert(INVALID_CLAIM);
        ledger.claim(_ids(1), ALICE);
        assertEq(_credit(1), 120);
        j.pick(1, BOB);
        _sync();
        vm.prank(BOB);
        assertEq(ledger.claim(_ids(1), BOB), 120);
        _debitModel(1, BOB, 120);
        j.fund(2, 2, 0, 40);
        _sync();
        vm.prank(BOB);
        assertEq(ledger.claim(_ids(1), BOB), 10);
        _debitModel(1, BOB, 10);
        j.back(1);
        j.fund(1, 2, 0, 40);
        j.pick(1, ALICE);
        _sync();
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), ALICE), 10);
        _debitModel(1, ALICE, 10);
        _conserved();
    }

    function test_F127_removedPushCannotSpendCreditOrPayCaller() public {
        _funded(1000);
        j.move(1, BOB);
        bytes memory data = abi.encodeWithSignature("claimFor(uint256[])", _ids(1));
        address[3] memory callers = [KEEPER, ALICE, BOB];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            (bool ok,) = address(ledger).call(data);
            assertFalse(ok, "removed push must revert even for the owner");
            assertEq(_credit(1), 1000);
            assertEq(ALICE.balance + BOB.balance + KEEPER.balance, 0);
            _conserved();
        }
        vm.prank(KEEPER);
        vm.expectRevert(ItemLedgerV2.Unauthorized.selector);
        ledger.claim(_ids(1), BOB);
        vm.prank(BOB);
        assertEq(ledger.claim(_ids(1), BOB), 1000);
        _debitModel(1, BOB, 1000);
        _conserved();
    }

    function test_ownerClaimsOneRawUnitDespiteLegacyThresholds() public {
        _setup(address(0), type(uint256).max, type(uint256).max);
        _funded(1);
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), BOB), 1);
        assertEq(BOB.balance, 1);
        _debitModel(1, ALICE, 1);
        _conserved();
    }

    function test_ownerReceivesFullCreditWithoutTipOrExpiry() public {
        _funded(100);
        vm.warp(block.timestamp + 10 * 365 days);
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), ALICE), 100);
        assertEq(ALICE.balance, 100);
        assertEq(KEEPER.balance, 0);
        _debitModel(1, ALICE, 100);
        _conserved();
    }

    function test_invalidBatchIdsAndRecipientsPreserveMoney() public {
        _funded(100);
        uint256[] memory ids = new uint256[](0);
        vm.expectRevert(INVALID_CLAIM);
        ledger.claim(ids, ALICE);
        ids = new uint256[](2);
        ids[0] = 1;
        ids[1] = 1;
        vm.prank(ALICE);
        vm.expectRevert(INVALID_CLAIM);
        ledger.claim(ids, ALICE);
        ids[1] = 2;
        vm.prank(ALICE);
        vm.expectRevert(INVALID_CLAIM);
        ledger.claim(ids, ALICE);
        vm.expectRevert(ItemLedgerV2.InvalidItem.selector);
        ledger.claim(_ids(0), ALICE);
        vm.expectRevert(ItemLedgerV2.InvalidItem.selector);
        ledger.claim(_ids(5), ALICE);
        vm.prank(ALICE);
        vm.expectRevert(INVALID_CLAIM);
        ledger.claim(_ids(1), address(0));
        vm.prank(ALICE);
        vm.expectRevert(INVALID_CLAIM);
        ledger.claim(_ids(1), address(j));
        _conserved();
    }

    function test_ownVaultCannotClaimEvenIfOwnerOfReportsIt() public {
        _funded(100);
        j.move(1, address(j));
        vm.prank(address(j));
        vm.expectRevert(INVALID_CLAIM);
        ledger.claim(_ids(1), BOB);
        _conserved();
    }

    function test_BC257_ownerClaimsWalletsContractsAnd7702() public {
        _funded(100);
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), BOB), 100);
        _debitModel(1, ALICE, 100);
        ItemOwner owner = new ItemOwner();
        j.move(1, address(owner));
        j.fund(1, 2, 0, 400);
        _sync();
        assertEq(owner.claim(ledger, 1, BOB), 100);
        _debitModel(1, address(owner), 100);
        j.move(1, ALICE);
        j.fund(1, 2, 0, 400);
        _sync();
        vm.etch(ALICE, abi.encodePacked(hex"ef0100", address(owner)));
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), BOB), 100);
        _debitModel(1, ALICE, 100);
        assertEq(BOB.balance, 300);
        _conserved();
    }

    function test_ownerAuthorizationDoesNotClassifyCode() public {
        _funded(100);
        vm.etch(ALICE, hex"00");
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), BOB), 100);
        _debitModel(1, ALICE, 100);
        j.fund(1, 2, 0, 400);
        _sync();
        vm.etch(ALICE, abi.encodePacked(hex"600000", BOB));
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), BOB), 100);
        _debitModel(1, ALICE, 100);
        _conserved();
    }

    function test_eachJournalMustBeCaughtUpEvenWithoutNewFunding() public {
        _funded(100);
        j.fund(1, 2, 0, 40);
        bytes memory pending = abi.encodeWithSelector(IItemLedgerV2.ItemSyncPending.selector, 3, 1);
        vm.prank(ALICE);
        vm.expectRevert(pending);
        ledger.claim(_ids(1), ALICE);
        _sync();
        j.back(1);
        j.pick(1, BOB);
        pending = abi.encodeWithSelector(IItemLedgerV2.ItemSyncPending.selector, 4, 1);
        vm.prank(BOB);
        vm.expectRevert(pending);
        ledger.claim(_ids(1), BOB);
        _sync();
        vm.prank(BOB);
        assertEq(ledger.claim(_ids(1), BOB), 110);
        _debitModel(1, BOB, 110);
        _conserved();
    }

    function testFuzz_claimConservesEachItemAcrossDecimals(uint96 amount, uint8 d) public {
        _erc20(d % 3 == 0 ? 6 : d % 3 == 1 ? 8 : 18);
        uint256 gross = bound(uint256(amount), 1, type(uint96).max);
        _funded(gross);
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), ALICE), gross);
        assertEq(token.balanceOf(ALICE), gross);
        assertEq(token.balanceOf(KEEPER), 0);
        _debitModel(1, ALICE, gross);
        j.back(1);
        j.fund(1, 2, 0, 43);
        j.pick(1, BOB);
        _sync();
        vm.prank(BOB);
        assertEq(ledger.claim(_ids(1), BOB), 10);
        _debitModel(1, BOB, 10);
        assertEq(ledger.flushResidue(), model.flushResidue());
        _conserved();
    }
}
