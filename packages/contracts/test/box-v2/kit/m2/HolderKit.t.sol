// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {HolderKit, LedgerTokenMock, BatchDriver, NetFundingMock, HolderLedgerDouble, HostileLedger} from "./HolderKit.sol";
import {IHolderLedgerV2} from "../../../../src/box-v2/interfaces/IHolderLedgerV2.sol";

contract HolderKitTest is HolderKit {
    function test_allocationsAtEveryStepAndDecimals() public {
        uint8[3] memory decimals = [uint8(6), 8, 18];
        for (uint256 d; d < 3; ++d) {
            _holderBox(decimals[d]);
            uint256 scale = 10 ** decimals[d];
            _move(SYSTEM, ALICE, 75, true); _move(SYSTEM, BOB, 25, true);
            _trade(true, 100, false, true); _assertCredits(1, 0, 0, 0);
            _move(ALICE, BOB, 50, false);
            _trade(true, 100, false, true); _assertCredits(1, 0, 0, 0);
            _trade(true, 100, false, false); _trade(true, 100, true, false);
            _receipt(1, 600 * scale, 0, 600 * scale);
            batches.close(); _fund(1, 0);
            ledger.settleBatch(1, 1); assertEq(ledger.claimable(1, ALICE), 0);
            _settle(1); _assertCredits(1, 100 * scale, 100 * scale, 200 * scale);
            _claim(1, ALICE); _assertCredits(1, 0, 100 * scale, 200 * scale);
            _claim(1, BOB); _assertCredits(1, 0, 0, 200 * scale);
            assertEq(ledger.flushResidue(1), model.flush(1));
            assertEq(pm.balanceOf(address(batches), pId), 200 * scale);
            assertEq(pm.balanceOf(address(ledger), pId), 0);
        }
    }
    function test_twoSidesFinalZeroAndNoLaterSubsidy() public {
        _holderBox(6); _move(SYSTEM, ALICE, 10, true);
        _trade(true, 10, false, true); _trade(false, 10, false, true);
        _receipt(1, 1500, 0, 0); _receipt(2, 3000, 0, 3000);
        batches.close(); _fund(1, 0); _settle(1); _assertCredits(1, 0, 0, 0);
        _fund(2, 0); _settle(2); _assertCredits(2, 2000, 0, 0);
        vm.expectRevert(); funding.allocate(1, 0);
        assertEq(funding.holderBatchPaid(1), 0); assertTrue(funding.holderBatchClosed(1));
        assertEq(batches.currentTradeBatch(true), 3); assertEq(batches.currentTradeBatch(false), 4);
    }
    function test_sourceD6TipCarryDebtAndNonTradeStaySeparate() public {
        _holderBox(8); _move(SYSTEM, ALICE, 1, true); _trade(true, 20, false, true);
        funding.bookDebt(77); sources.booked(77);
        _receipt(1, 1601, 100, 1501); _receipt(1, 14, 0, 14);
        _receipt(2, 1000, 0, 30); batches.close();
        _fund(1, 15); _settle(1); _assertCredits(1, 1000, 0, 0);
        _fund(2, 0); _settle(2); _assertCredits(2, 0, 0, 20);
        funding.royalty(151, false); sources.royalty(151, false); _assertSources();
        funding.setFailed(); model.fail();
        funding.royalty(11, true); sources.royalty(11, true); _assertSources();
        assertEq(ledger.flushResidue(2), model.flush(2));
        _claim(1, ALICE); assertEq(p.balanceOf(ALICE), 1000);
    }
    function test_pausedPAndReentryRollbackThenRetryAfterFailure() public {
        _holderBox(18); _ready(1500);
        p.setPaused(true); vm.prank(ALICE); vm.expectRevert(); ledger.claim(1, ALICE);
        _assertCredits(1, 1000, 0, 0);
        p.setPaused(false);
        p.armReentry(address(ledger), abi.encodeCall(IHolderLedgerV2.claim, (1, ALICE)));
        vm.prank(ALICE); vm.expectRevert(); ledger.claim(1, ALICE);
        _assertCredits(1, 1000, 0, 0);
        p.armReentry(address(0), ""); funding.setFailed(); model.fail();
        vm.warp(block.timestamp + 60 days); _claim(1, ALICE);
        vm.prank(ALICE); vm.expectRevert(); ledger.claim(1, ALICE);
        assertEq(p.balanceOf(ALICE), 1000); assertEq(pm.balanceOf(ALICE, pId), 0);
    }
    function test_F127_noPushAndContractSelfClaimOnly() public {
        _holderBox(6); _ready(1500);
        (bool ok,) = address(ledger).call(abi.encodeWithSignature("claimFor(uint256,address)", 1, ALICE));
        assertFalse(ok); _assertCredits(1, 1000, 0, 0);
        _claim(1, ALICE); assertEq(p.balanceOf(ALICE), 1000);
        _holderBox(6); _move(SYSTEM, address(this), 10, true);
        ledger.register(); model.register(); _trade(true, 10, false, true);
        _receipt(1, 1500, 0, 1500); batches.close(); _fund(1, 0); _settle(1);
        vm.expectRevert(); vm.prank(ALICE); ledger.claim(1, BOB);
        assertEq(ledger.claim(1, BOB), model.claim(1, BOB)); assertEq(p.balanceOf(BOB), 1000);
    }
    function test_hostileCallbacksCannotLoseOutAndBackHistory() public {
        _holderBox(18); _move(SYSTEM, ALICE, 100, true);
        uint256 beforeMoves = token.holderCheckpoint();
        HostileLedger hostile = new HostileLedger();
        for (uint8 mode = 1; mode <= 3; ++mode) {
            hostile.setMode(mode); token.setCallbackTarget(address(hostile));
            _move(ALICE, BOB, 100, false); _trade(true, 100, false, true);
            _move(BOB, ALICE, 100, false);
        }
        _receipt(1, 4500, 0, 4500); batches.close(); _fund(1, 0); _settle(1);
        _assertCredits(1, 0, 3000, 0);
        assertEq(token.eligibleBalanceAt(BOB, beforeMoves + 1), 100);
        assertEq(token.eligibleBalanceAt(BOB, token.holderCheckpoint()), 0);
    }
    function test_authenticationFutureReadsAndNoopMutations() public {
        _holderBox(8); _move(SYSTEM, ALICE, 10, true);
        uint256 at = token.holderCheckpoint();
        vm.prank(ALICE); token.transfer(ALICE, 4); vm.prank(ALICE); token.transfer(BOB, 0);
        assertEq(token.holderCheckpoint(), at);
        vm.expectRevert(); token.eligibleBalanceAt(ALICE, at + 1);
        vm.expectRevert(); token.registerHolder(ALICE);
        vm.expectRevert(); ledger.onTradeFeeBatch(1, ALICE, true, 10);
        vm.expectRevert(); ledger.onTokenCheckpoint(at, ALICE, BOB);
        vm.expectRevert(); ledger.settleBatch(1, 64);
        vm.expectRevert(); ledger.flushResidue(1);
        vm.expectRevert(); funding.allocate(1, 0);
        vm.prank(SYSTEM); vm.expectRevert(); ledger.register();
    }
    function testFuzz_perHolderFloors(uint96 raw, uint8 ratio) public {
        _holderBox(6); uint256 amount = uint256(raw) + 1; uint256 a = uint256(ratio) + 1;
        _move(SYSTEM, ALICE, a, true); _move(SYSTEM, BOB, 257 - a, true);
        _trade(true, 257, false, true); _receipt(1, amount, 0, amount); batches.close();
        _fund(1, 0); _settle(1);
        uint256 f = (amount / 15) * 10;
        _assertCredits(1, f * a / 257, f * (257 - a) / 257, f - f * a / 257 - f * (257 - a) / 257);
    }
}
