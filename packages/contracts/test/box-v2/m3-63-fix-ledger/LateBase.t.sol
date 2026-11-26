// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ItemAccountingBase} from "../m3-20/Accounting.t.sol";
import {ItemFundingV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ItemLifecycleV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";

/// Explicit journal double explores two independently published base receipts with custody/payment between them.
contract LedgerLateBaseTest is ItemAccountingBase {
    function testFuzz_R04_laterSideBaseSurvivesEarlierClaimAndTransfer(uint128 buyerP, uint128 sellerP) public {
        _setup(1, 1, 1);
        uint256 first = bound(buyerP, 4, 1e24);
        uint256 second = bound(sellerP, 4, 1e24);
        j.fund(1, 2, 0, first);
        j.fund(2, 2, 0, second);
        bytes32 key = _key(1);
        j.request(key);
        j.graduate();
        j.deliver(key, 1, ALICE);
        ItemLifecycleV2 memory op = h.itemLifecycle(2);
        op.fundingCursor = 1;
        j.corruptOperation(2, op);
        ItemFundingV2 memory r = h.itemFunding(2);
        r.lifecycleCursor = 2;
        j.corrupt(2, r);
        // The double's PM balance already includes both transfers; publishing only the first cannot
        // manufacture credit from the unpublished second transfer, or flush it as residue.
        vm.mockCall(address(j), abi.encodeWithSignature("itemFundingCount()"), abi.encode(uint256(1)));
        ledger.sync(32);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        vm.prank(ALICE);
        assertEq(ledger.claim(ids, ALICE), first / 4);
        assertEq(ledger.flushResidue(), first % 4);
        j.move(1, BOB);
        vm.clearMockedCalls();
        ledger.sync(1);
        (uint256 outsideP, uint256 stash) = ledger.itemCredit(1);
        assertEq(outsideP, 0);
        assertEq(stash, second / 4);
        vm.prank(BOB);
        assertEq(ledger.claim(ids, BOB), second / 4);
        assertEq(ledger.flushResidue(), second % 4);
        (outsideP, stash) = ledger.itemCredit(1);
        assertEq(outsideP + stash, 0);
        assertEq(pm.balanceOf(address(ledger), 0), 3 * (first / 4 + second / 4));
        assertEq(
            ALICE.balance + BOB.balance + pm.balanceOf(DEPTH, 0) + pm.balanceOf(address(ledger), 0), first + second
        );
    }
}
