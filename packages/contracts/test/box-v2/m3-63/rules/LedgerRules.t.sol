// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ItemAccountingBase} from "../../m3-20/Accounting.t.sol";
import {ItemBoundariesTest} from "../../m3-20/Boundaries.t.sol";
import {ItemClaimsTest} from "../../m3-21/Claims.t.sol";
import {HostileItemClaimsTest} from "../../m3-21/HostileClaims.t.sol";
import {ItemLedgerV2} from "../../../../src/box-v2/ItemLedgerV2.sol";
import {IItemLedgerCalls} from "../../../../src/box-v2/interfaces/ILedgerCalls.sol";

// Inherited assertions are executable regression checks, not new independent review findings.
contract RulesLedgerBoundariesTest is ItemBoundariesTest {}
contract RulesOwnerClaimsTest is ItemClaimsTest {}
contract RulesHostileClaimsTest is HostileItemClaimsTest {}

contract RulesLedgerAccessTest is ItemAccountingBase {
    function test_P01_everyNoticeRequiresFixedVaultAndLeavesReplayDeferred() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 1;
        bytes[5] memory calls = [
            abi.encodeCall(IItemLedgerCalls.onTicketsOpened, (1, 4)),
            abi.encodeCall(IItemLedgerCalls.onTicketsReleased, (ALICE, 1, 3, 1)),
            abi.encodeCall(IItemLedgerCalls.onWithdrawn, (ALICE, ids)),
            abi.encodeCall(IItemLedgerCalls.onReturned, (ALICE, ids)),
            abi.encodeCall(IItemLedgerCalls.onDelivered, (1, ALICE, uint64(1)))
        ];
        j.graduate();
        j.request(_key(1));
        j.fund(1, 2, 0, 40);
        uint256 backing = pm.balanceOf(address(ledger), 0);
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(BOB);
            (bool ok, bytes memory reason) = address(ledger).call(calls[i]);
            assertFalse(ok);
            assertEq(reason, abi.encodeWithSelector(ItemLedgerV2.Unauthorized.selector));
            assertTrue(j.notice(calls[i]));
        }
        assertEq(ledger.fundingCursor(), 0);
        assertEq(ledger.lifecycleCursor(), 0);
        assertEq(pm.balanceOf(address(ledger), 0), backing);
        _page(32);
    }

    function test_P02_initializeOnceEvenForAuthenticCoordinatorAndImplementationIsInert() public {
        vm.expectRevert(ItemLedgerV2.InvalidWiring.selector);
        c.initializeLedger();
        vm.expectRevert();
        implementation.initialize();
        vm.expectRevert(ItemLedgerV2.NotInitialized.selector);
        implementation.sync(1);
        vm.expectRevert(ItemLedgerV2.NotInitialized.selector);
        implementation.flushResidue();
        _compare();
    }

    function testFuzz_P03_syncBoundsBothJournalsAndIsIdempotent(uint8 rawPage) public {
        uint256 page = bound(rawPage, 1, 32);
        _setupCount(1, 2, 1, 64);
        j.graduate();
        for (uint256 i = 1; i <= 40; ++i) {
            j.request(_key(i));
            j.fund(1, 2, 0, 64);
        }
        for (uint256 i; i < 100 && ledger.lifecycleCursor() < 40; ++i) {
            uint256 f = ledger.fundingCursor();
            uint256 l = ledger.lifecycleCursor();
            vm.prank(BOB);
            ledger.sync(page);
            assertLe(ledger.fundingCursor() - f, page);
            assertLe(ledger.lifecycleCursor() - l, page);
            assertGt(ledger.fundingCursor() + ledger.lifecycleCursor(), f + l);
        }
        ledger.sync(32);
        assertEq(ledger.fundingCursor(), 42);
        assertEq(ledger.lifecycleCursor(), 40);
        uint256 backing = pm.balanceOf(address(ledger), 0);
        ledger.sync(32);
        assertEq(ledger.fundingCursor(), 42);
        assertEq(ledger.lifecycleCursor(), 40);
        assertEq(pm.balanceOf(address(ledger), 0), backing);
        vm.expectRevert(ItemLedgerV2.InvalidPage.selector);
        ledger.sync(0);
        vm.expectRevert(ItemLedgerV2.InvalidPage.selector);
        ledger.sync(33);
    }
}
