// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {HolderKit, HostileLedger, BatchDriver} from "./HolderKit.sol";
import {IHolderLedgerV2} from "../../../../src/box-v2/interfaces/IHolderLedgerV2.sol";

interface IFundingResidueExit { function collectLate() external; }

contract HolderEdgesTest is HolderKit {
    function test_refusedCollectTipStaysWithItsSourceWithoutCallingLedger() public {
        _holderBox(6); _move(SYSTEM, ALICE, 1, true); _trade(true, 1, false, true);
        _receipt(1, 1500, 0, 1500); batches.close();
        // Funding is a claims transfer even while P is paused and every ledger entry would revert.
        vm.mockCallRevert(address(ledger), bytes(""), "ledger offline"); p.setPaused(true);
        funding.allocate(1, 75); sources.allocate(1, 0, false);
        assertEq(funding.holderBatchPaid(1), 1000); _assertSources();
        vm.clearMockedCalls(); model.close(1, 1000); _settle(1); _assertCredits(1, 1000, 0, 0);
        p.setPaused(false); _claim(1, ALICE);
    }
    function test_allReceiverLiabilitiesHaveSeparateExitsAndFailedResiduePaysFIT() public {
        _holderBox(6); _trade(true, 10, false, false); _receipt(1, 1501, 0, 1501);
        funding.bookDebt(17); sources.booked(17); batches.close(); funding.setFailed(); model.fail();
        _fund(1, 0); _settle(1); _assertCredits(1, 0, 0, 1000);
        assertEq(ledger.flushResidue(1), model.flush(1));
        IFundingResidueExit(address(funding)).collectLate(); assertEq(funding.fit(), 1201);
        p.setBlocked(FIT, true); vm.expectRevert(); funding.payFit(); assertEq(funding.fit(), 1201);
        funding.payPlatform(); assertEq(p.balanceOf(PLATFORM), 100);
        funding.flushPot(); assertEq(pm.balanceOf(SYSTEM, pId), 200);
        funding.payDebt(); assertEq(p.balanceOf(address(this)), 17);
        p.setBlocked(FIT, false); funding.payFit(); assertEq(p.balanceOf(FIT), 1201);
        assertEq(pm.balanceOf(address(funding), pId), 0); assertEq(pm.balanceOf(FIT, pId), 0);
        IFundingResidueExit(address(funding)).collectLate(); assertEq(funding.fit(), 0);
    }
    function test_snapshotPrecedesBuyReceiptAndLaterHoldersCannotBackdate() public {
        _holderBox(8); _trade(true, 10, false, true); _move(SYSTEM, ALICE, 10, true);
        _trade(true, 10, false, true); _move(SYSTEM, BOB, 100, true);
        _receipt(1, 1500, 0, 1500); batches.close(); _fund(1, 0); _settle(1);
        _assertCredits(1, 500, 0, 500);
    }
    function test_historyReadFailureRollsBackPageAndNeverUsesCurrentBalance() public {
        _holderBox(18); _move(SYSTEM, ALICE, 10, true); uint256 at = token.holderCheckpoint();
        _trade(true, 10, false, true); _move(ALICE, BOB, 10, false);
        _receipt(1, 1500, 0, 1500); batches.close(); _fund(1, 0);
        vm.mockCallRevert(address(token), abi.encodeCall(token.eligibleBalanceAt, (ALICE, at)), "history unavailable");
        vm.expectRevert(); ledger.settleBatch(1, 64); assertEq(ledger.claimable(1, ALICE), 0);
        (bool done, uint256 cursor,,) = ledger.batchState(1); assertFalse(done); assertEq(cursor, 0);
        vm.clearMockedCalls(); _settle(1); _assertCredits(1, 1000, 0, 0);
    }
    function test_pageBoundAndNoClaimsUntilEveryPairSettles() public {
        _holderBox(6); _move(SYSTEM, ALICE, 1, true);
        for (uint256 i; i < 65; ++i) _trade(true, 1, false, true);
        _receipt(1, 1500, 0, 1500); batches.close(); _fund(1, 0);
        vm.expectRevert(); ledger.settleBatch(1, 0); vm.expectRevert(); ledger.settleBatch(1, 65);
        assertFalse(ledger.settleBatch(1, 64)); assertEq(ledger.claimable(1, ALICE), 0);
        vm.prank(ALICE); vm.expectRevert(); ledger.claim(1, ALICE);
        vm.expectRevert(); ledger.flushResidue(1);
        _settle(1); _assertCredits(1, 1000, 0, 0); assertTrue(ledger.settleBatch(1, 1));
    }
    function test_transferFromMintBurnKeepHistoryEvenWhenLedgerConsumesItsCap() public {
        _holderBox(18); HostileLedger hostile = new HostileLedger(); hostile.setMode(2);
        token.setCallbackTarget(address(hostile)); token.mint(ALICE, 100);
        uint256 mintAt = token.holderCheckpoint(); assertEq(token.eligibleBalanceAt(ALICE, mintAt), 100);
        vm.prank(ALICE); token.approve(SYSTEM, 40);
        vm.prank(SYSTEM); token.transferFrom(ALICE, BOB, 40);
        uint256 movedAt = token.holderCheckpoint(); assertEq(token.eligibleBalanceAt(BOB, movedAt), 40);
        vm.prank(BOB); token.burn(10);
        assertEq(token.eligibleBalanceAt(BOB, token.holderCheckpoint()), 30);
        assertEq(token.eligibleBalanceAt(BOB, movedAt), 40);
        assertEq(token.eligibleSupplyAt(token.holderCheckpoint()), 90);
    }
    function test_codeChangeKeepsSelfClaimAnd7702CountsAtReceipt() public {
        _holderBox(6); vm.etch(ALICE, abi.encodePacked(hex"ef0100", address(0x123456)));
        _ready(1500); vm.etch(ALICE, hex"60006000fd");
        vm.expectRevert(); ledger.claim(1, ALICE); _assertCredits(1, 1000, 0, 0);
        _claim(1, ALICE); assertEq(p.balanceOf(ALICE), 1000);
    }
    function test_hostileHookNoticesKeepAllAuthoritativeUnits() public {
        BatchDriver driver = new BatchDriver(); HostileLedger hostile = new HostileLedger(); driver.wire(address(hostile));
        for (uint8 mode = 1; mode <= 3; ++mode) {
            hostile.setMode(mode); assertFalse(driver.trade(true, ALICE, 10, false, true));
        }
        assertEq(driver.tradeBatch(1).tradeUnits, 30); assertEq(hostile.calls(), 0);
        hostile.setMode(0); assertTrue(driver.trade(false, ALICE, 20, false, true));
        driver.trade(true, ALICE, 7, true, true); driver.close();
        assertEq(driver.tradeBatch(1).protocolUnits, 7); assertTrue(driver.tradeBatch(2).closed);
        assertEq(driver.tradeBatch(2).tradeUnits, 20); assertEq(hostile.calls(), 1);
    }
}
