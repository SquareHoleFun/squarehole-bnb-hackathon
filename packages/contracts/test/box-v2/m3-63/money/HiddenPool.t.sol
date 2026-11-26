// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ItemClaimFixture} from "../../m3-21/Fixture.sol";

/// Real ledger and real PM; the frozen authenticated journal producer is an explicit double.
contract MoneyHiddenPoolTest is ItemClaimFixture {
    bytes32 private constant A = keccak256("A");
    bytes32 private constant B = keccak256("B");
    bytes32 private constant C = keccak256("C");
    bytes32 private constant D = keccak256("D");
    bytes32 private constant E = keccak256("E");

    function _check() private {
        _sync();
        _conserved();
    }

    function test_R43M3B_cancelRestoresOnlyItsStashAndFinalHiddenSlotGetsRemainder() public {
        j.fund(1, 2, 0, 23);
        _check();
        j.fund(2, 2, 0, 17);
        _check();
        j.graduate(); // Base = 5 each, residue = 3; pre-graduation Burn gives no item credit.
        _check();
        j.fund(1, 2, 0, 7);
        _check();
        j.request(A);
        _check();
        assertEq(ledger.ticketStash(A), 1);
        j.fund(1, 2, 0, 13);
        _check();
        j.request(B);
        _check();
        assertEq(ledger.ticketStash(B), 4);
        j.fund(2, 2, 0, 11);
        _check();
        j.fund(1, 2, 0, 4);
        _check();
        (, uint256 aCredit,) = ledger.ticketCredit(A);
        (, uint256 bCredit,) = ledger.ticketCredit(B);
        assertEq(aCredit, 6);
        assertEq(bCredit, 3);
        j.cancel(A);
        _check();
        (, bCredit,) = ledger.ticketCredit(B);
        assertEq(bCredit, 3, "cancelled earnings never enrich an open ticket");
        assertEq(ledger.ticketStash(B), 4);
        j.request(C);
        _check();
        assertEq(ledger.ticketStash(C), 3);
        j.request(D);
        _check();
        assertEq(ledger.ticketStash(D), 4);
        j.request(E);
        _check();
        assertEq(ledger.ticketStash(E), 4);
        // Arbitrary reverse assignment binds stashes to exact keys, never request/delivery rank.
        j.deliver(E, 2, BOB);
        _check();
        j.deliver(D, 4, ALICE);
        _check();
        j.deliver(C, 1, ALICE);
        _check();
        j.deliver(B, 3, ALICE);
        _check();
        assertEq(_credit(1), 8);
        assertEq(_credit(2), 9);
        assertEq(_credit(3), 12);
        assertEq(_credit(4), 9);
        uint256 residue = model.flushResidue();
        assertEq(residue, 16);
        assertEq(ledger.flushResidue(), residue);
        _conserved();
        for (uint256 id = 1; id <= 4; ++id) {
            address owner = id == 2 ? BOB : ALICE;
            uint256 gross = _credit(id);
            _debitModel(id, owner, gross);
            vm.prank(owner);
            assertEq(ledger.claim(_ids(id), owner), gross);
            _conserved();
        }
        assertEq(paid, 38);
        assertEq(pm.balanceOf(address(ledger), 0), 0);
        assertEq(j.history().ledgerTransferred(), 54);
        assertEq(j.history().buyBackP(), 21);
        assertEq(j.history().accounted(), 75);
    }

    function test_R43M3B_knownReturnNeverRejoinsHiddenPool() public {
        j.graduate();
        _check();
        j.pick(1, ALICE);
        _check();
        j.fund(1, 2, 0, 40);
        _check();
        j.back(1);
        _check();
        j.fund(1, 2, 0, 20);
        _check();
        (uint256 hidden, uint256 stash,,,,) = ledger.totals();
        assertEq(hidden, 3);
        assertEq(stash, 45);
        j.request(A);
        _check();
        assertEq(ledger.ticketStash(A), 15);
        vm.expectRevert(bytes("outside"));
        j.move(1, BOB);
        j.pick(1, BOB);
        _check();
        assertEq(_credit(1), 15, "known item keeps its own outside earnings and inside stash");
        assertEq(ledger.ticketStash(A), 15, "known re-pick cannot borrow the anonymous ticket stash");
        vm.prank(ALICE);
        vm.expectRevert();
        ledger.claim(_ids(1), ALICE);
        _debitModel(1, BOB, 15);
        vm.prank(BOB);
        assertEq(ledger.claim(_ids(1), BOB), 15);
        _conserved();
    }

    function testFuzz_R43M3A_perReceiptRoundingNeverBorrowsFromAnotherItem(uint96 x, uint96 y) public {
        j.graduate();
        _check();
        j.request(A);
        _check();
        j.fund(1, 2, 0, x);
        _check();
        j.fund(2, 2, 0, y);
        _check();
        (, uint256 earnings, bool open) = ledger.ticketCredit(A);
        assertTrue(open);
        assertEq(earnings, uint256(x) / 4 + uint256(y) / 4);
        assertEq(j.history().buyBackP(), 3 * (uint256(y) / 4));
        assertEq(model.residue(), uint256(x) % 4 + uint256(y) % 4);
        assertLt(model.residue(), 8, "less than N per receipt");
        j.deliver(A, 4, ALICE);
        _check();
        assertEq(_credit(4), earnings);
    }
}
