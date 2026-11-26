// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {HolderFixture, ContractHolderFixture} from "./HolderFixture.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";

contract HolderLedgerTest is HolderFixture {
    function test_historyOutAndBackSkippedNoticesAndProtocolMatchModel() public {
        _move(SYSTEM, ALICE, 100, true); _trade(1, 120, false, true);
        _move(ALICE, BOB, 80, false); _trade(1, 90, false, true);
        _move(BOB, ALICE, 80, false); _trade(1, 30, false, false); _trade(1, 60, true, false);
        _close(1, 3000);
        assertFalse(_settle(1, 1)); vm.expectRevert(); ledger.flushResidue(1);
        assertFalse(_settle(1, 1)); assertFalse(_settle(1, 1)); assertTrue(_settle(1, 1));
        assertEq(ledger.claimable(1, ALICE), 1380); assertEq(ledger.claimable(1, BOB), 720);
        assertTrue(_settle(1, 64));
        vm.prank(ALICE); assertEq(ledger.claim(1, ALICE), 1380);
        vm.expectRevert(); vm.prank(ALICE); ledger.claim(1, ALICE);
        assertEq(p.balanceOf(ALICE), 1380); assertEq(ledger.flushResidue(1), 900);
        assertEq(pm.balanceOf(address(hook), uint160(address(p))), 900);
        assertEq(ledger.flushResidue(1), 0);
    }
    function test_tradeBeforeReceiptDoesNotCreditBuyerAndLaterHoldersCannotGrief() public {
        _trade(1, 100, false, true); _move(SYSTEM, ALICE, 100, false);
        _close(1, 1000); assertTrue(_settle(1, 1)); assertEq(ledger.claimable(1, ALICE), 0);
        assertEq(ledger.flushResidue(1), 1000);
    }
    function test_zeroFundingClosedSeparatelyAndCannotUseNextBatch() public {
        _move(SYSTEM, ALICE, 100, false); _trade(1, 100, false, true);
        hook.receipt(1, 100, true); vm.expectRevert(); ledger.settleBatch(1, 1);
        _close(1, 0); assertTrue(_settle(1, 1));
        _trade(3, 100, false, true); _close(3, 2000); assertTrue(_settle(3, 64));
        vm.expectRevert(); vm.prank(ALICE); ledger.claim(1, ALICE);
        assertEq(ledger.claimable(3, ALICE), 2000);
    }
    function test_historyReadFailureRollsBackPageWithoutCurrentBalanceFallback() public {
        _move(SYSTEM, ALICE, 100, false); _trade(1, 100, false, true); _close(1, 1000);
        t.broken(true); vm.expectRevert(); ledger.settleBatch(1, 64);
        (bool done, uint256 hc, uint256 nc,) = ledger.batchState(1);
        assertFalse(done); assertEq(hc + nc, 0); t.broken(false); assertTrue(_settle(1, 64));
    }
    function test_pausedPFailureAndNoExpiryPreserveCredits() public {
        _move(SYSTEM, ALICE, 100, false); _trade(1, 100, false, true); _trade(1, 100, false, false);
        _close(1, 1000); _settle(1, 64); p.setPaused(true);
        vm.expectRevert(); vm.prank(ALICE); ledger.claim(1, ALICE); assertEq(ledger.claimable(1, ALICE), 500);
        coord.fail(); model.fail(); vm.warp(block.timestamp + 3650 days); p.setPaused(false);
        vm.prank(ALICE); ledger.claim(1, BOB); assertEq(p.balanceOf(BOB), 500);
        assertEq(ledger.flushResidue(1), 500); assertEq(pm.balanceOf(address(receiver), uint160(address(p))), 500);
    }
    function test_selfClaimHasNoMinimumOrTipAndContractRegisters() public {
        address c = address(new ContractHolderFixture());
        _move(SYSTEM, c, 100, false); _trade(1, 100, false, true);
        vm.prank(c); ledger.register(); vm.prank(c); model.register();
        _trade(1, 100, false, true); _close(1, 1000); _settle(1, 64);
        assertEq(ledger.claimable(1, c), 500);
        vm.expectRevert(); ledger.claim(1, c);
        vm.prank(c); ledger.claim(1, c); assertEq(p.balanceOf(c), 500);
        _move(SYSTEM, ALICE, 100, false); _trade(3, 100, false, true); _close(3, 2000); _settle(3, 64);
        vm.prank(ALICE); assertEq(ledger.claim(3, ALICE), 1000);
        assertEq(p.balanceOf(ALICE), 1000); assertEq(p.balanceOf(PUSHER), 0);
        _trade(5, 100, false, true); _close(5, 100); _settle(5, 64);
        vm.prank(ALICE); assertEq(ledger.claim(5, ALICE), 50);
    }
    function test_authenticationAndPageBounds() public {
        vm.expectRevert(); ledger.onTradeFeeBatch(1, ALICE, true, 100);
        vm.expectRevert(); ledger.onTokenCheckpoint(1, ALICE, BOB);
        vm.expectRevert(); ledger.settleBatch(1, 0); vm.expectRevert(); ledger.settleBatch(1, 65);
        vm.expectRevert(); ledger.settleBatch(0, 1);
        _move(SYSTEM, ALICE, 100, false); _trade(1, 100, false, true); _close(1, 1000); _settle(1, 64);
        vm.expectRevert(); vm.prank(ALICE); ledger.claim(1, address(0));
        vm.expectRevert(); ledger.claim(1, BOB);
    }
    function testFuzz_exactParityAtSixEightEighteenDecimals(uint128 seed, uint8 decimalSeed) public {
        uint256 scale = 10 ** (decimalSeed % 3 == 0 ? 6 : decimalSeed % 3 == 1 ? 8 : 18);
        uint256 n = bound(seed, 1, 1e12) * scale;
        _move(SYSTEM, ALICE, n, false); _move(SYSTEM, BOB, n / 3, true);
        _trade(1, n / 7 + 1, false, true); _move(ALICE, BOB, n / 2, false);
        _trade(1, n / 11 + 1, false, true); _trade(1, n / 17 + 1, false, false);
        _trade(1, n / 23 + 1, true, false); _close(1, n);
        _settle(1, 1); _settle(1, 3);
        (, , , uint256 residue) = ledger.batchState(1);
        assertEq(ledger.claimable(1, ALICE) + ledger.claimable(1, BOB) + residue, n);
    }
}
