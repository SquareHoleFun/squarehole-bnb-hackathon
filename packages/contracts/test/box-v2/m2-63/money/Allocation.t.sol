// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HolderFixture} from "../../m2-30/HolderFixture.sol";
import {ReceiverFixture, ReceiverArgs, ReceiverHook} from "../../cq11-b/ReceiverFixture.sol";
import {BatchHookFixture} from "../../m2-30/HolderFixture.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// Direct arithmetic oracle: both prescribed floors, not a copy of ledger settlement cursors.
contract M263AllocationTest is HolderFixture {
    function testFuzz_twoFloorsSkippedWeightAndClaimOrderConserveEachBatch(
        uint64 entropy, uint8 decimalChoice, bool reverse, bool failed
    ) public {
        uint256 a = uint256(entropy) % 997 + 1;
        uint256 b = uint256(keccak256(abi.encode(entropy))) % 991 + 1;
        uint256 u = a + 7;
        uint256 v = b + 11;
        uint256 missed = uint256(entropy) % 17;
        uint256 protocol = uint256(entropy) % 13;
        uint256 funding = (a + b) * 10 ** (decimalChoice % 3 == 0 ? 6 : decimalChoice % 3 == 1 ? 8 : 18) + 1;
        _move(SYSTEM, ALICE, a, false);
        _move(SYSTEM, BOB, b, false);
        _trade(1, u, false, true);
        _move(ALICE, BOB, a / 2, false);
        _trade(1, v, false, true);
        _trade(1, missed, false, false);
        _trade(1, protocol, true, false);
        _move(BOB, ALICE, a / 2, false); // current balances cannot reconstruct trade two
        _close(1, funding);
        uint256 denominator = u + v + missed + protocol;
        uint256 aliceUnits = u * a / (a + b) + v * (a - a / 2) / (a + b);
        uint256 bobUnits = u * b / (a + b) + v * (b + a / 2) / (a + b);
        uint256 aliceP = funding * aliceUnits / denominator;
        uint256 bobP = funding * bobUnits / denominator;
        uint256 residue = funding - aliceP - bobP;
        for (uint256 i; i < 3; ++i) {
            assertFalse(ledger.settleBatch(1, 1));
            assertEq(ledger.claimable(1, ALICE), 0);
            assertEq(ledger.claimable(1, BOB), 0);
        }
        assertTrue(ledger.settleBatch(1, 1));
        assertEq(ledger.claimable(1, ALICE), aliceP);
        assertEq(ledger.claimable(1, BOB), bobP);
        // Each notice loses less than one unit per holder; each final payout loses less than one raw P.
        assertLe(u + v - aliceUnits - bobUnits, 2);
        assertLt(funding * aliceUnits - aliceP * denominator, denominator);
        assertLt(funding * bobUnits - bobP * denominator, denominator);
        _close(3, 37); // all residue: no notices; must not repair batch one's skipped weights
        assertTrue(ledger.settleBatch(3, 64));
        if (failed) coord.fail();
        vm.warp(block.timestamp + 730 days); // both earned P and the coordinator pot remain claimable
        _claims(reverse, failed, aliceP, bobP, residue, funding);
    }

    function _claims(bool reverse, bool failed, uint256 aliceP, uint256 bobP, uint256 residue, uint256 funding) private {
        address first = reverse ? BOB : ALICE;
        address second = reverse ? ALICE : BOB;
        uint256 firstP = reverse ? bobP : aliceP;
        uint256 secondP = reverse ? aliceP : bobP;
        p.setBlocked(first, true);
        vm.prank(first); vm.expectRevert(); ledger.claim(1, first);
        assertEq(ledger.claimable(1, first), firstP);
        if (secondP != 0) { vm.prank(second); assertEq(ledger.claim(1, second), secondP); }
        assertEq(ledger.flushResidue(1), residue);
        assertEq(ledger.flushResidue(1), 0);
        assertEq(ledger.flushResidue(3), 37);
        p.setBlocked(first, false);
        if (firstP != 0) { vm.prank(first); assertEq(ledger.claim(1, first), firstP); }
        vm.prank(first); vm.expectRevert(); ledger.claim(1, first);
        address destination = failed ? address(receiver) : address(hook);
        assertEq(p.balanceOf(ALICE) + p.balanceOf(BOB) + pm.balanceOf(destination, uint160(address(p))), funding + 37);
        assertEq(pm.balanceOf(address(ledger), uint160(address(p))), 0);
    }
}

contract M263SourceDustTest is ReceiverFixture {
    BatchHookFixture private batches;
    address private constant LEDGER = address(0x1717);

    function setUp() public override {
        super.setUp();
        batches = new BatchHookFixture(); hook = ReceiverHook(address(batches));
        ReceiverArgs memory a = _args(4, 4, 1, address(p)); a.holderLedger = LEDGER;
        r = _clone(a); coord.initialize(r);
    }

    function _fund(uint256 id, uint256 n) private {
        batches.receipt(id, n, false);
        driver.mintClaims(Currency.wrap(address(p)), address(r), n);
        r.collect(address(0));
        assertTrue(r.holderBatchClosed(id));
    }

    function test_R43_M2B_fifteenTinySourcesCannotLendDustToOneLaterSource() public {
        for (uint256 i; i < 15; ++i) {
            _fund(2 * i + 1, 1);
            assertEq(r.holderBatchPaid(2 * i + 1), 0);
            assertEq(_balance(address(hook)), i + 1);
            assertEq(r.fitOwed() + r.platformOwed() + _balance(LEDGER), 0);
        }
        _fund(31, 15);
        assertEq(r.fitOwed(), 2); assertEq(r.platformOwed(), 1);
        assertEq(r.poolHeldP(), 2); assertEq(r.holderBatchPaid(31), 10);
        assertEq(_balance(address(hook)), 15);
        assertEq(_balance(address(r)) + _balance(LEDGER) + _balance(address(hook)), 30);
        _booked();
    }

    function test_failureDustAndNonTradeChoiceJoinPotWithoutChangingFinalFunding() public {
        batches.receipt(1, 14, false);
        driver.mintClaims(Currency.wrap(address(p)), address(r), 14 + 31);
        coord.failure(r);
        assertTrue(r.holderBatchClosed(1)); assertEq(r.holderBatchPaid(1), 0);
        assertEq(r.fitOwed(), 4); // only the earned 2/15 fee share
        assertEq(r.platformOwed(), 2); assertEq(_balance(address(coord)), 39);
        assertEq(_balance(address(r)) + _balance(address(coord)), 45);
        driver.mintClaims(Currency.wrap(address(p)), address(r), 15);
        r.collect(address(0));
        assertEq(r.fitOwed(), 4); assertEq(_balance(address(coord)), 54); assertEq(r.holderBatchPaid(1), 0);
        assertEq(_balance(LEDGER), 0); _booked();
    }
}
