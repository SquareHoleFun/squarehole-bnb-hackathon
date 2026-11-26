// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {SourceModel} from "./SourceModel.sol";
contract SourceModelTest is Test {
    SourceModel m;
    function setUp() public { m = new SourceModel(); }
    function test_sourcesCarryOnlyWithinTheirOwnIdAndBookExactSplit() public {
        m.receipt(1, 20, 6, 14); m.receipt(1, 1, 0, 1); m.allocate(1, 0, false);
        assertEq(m.funding(1), 10); assertEq(m.fit(), 2); assertEq(m.platform(), 1); assertEq(m.depth(), 2);
        assertEq(m.balance(), 5); // ledger transfer removed 10; debts stay backed
        m.receipt(2, 14, 0, 14); m.receipt(3, 1, 0, 1);
        m.allocate(2, 0, false); m.allocate(3, 0, false);
        assertEq(m.funding(2), 0); assertEq(m.funding(3), 0); assertEq(m.depth(), 17);
    }
    function test_shortfallCannotSpendDebtOrLaterSourceAndCannotTopUp() public {
        m.booked(500); m.receipt(1, 150, 0, 0); m.receipt(2, 150, 0, 150);
        vm.expectRevert(); m.allocate(2, 0, false);
        m.allocate(1, 0, false); assertTrue(m.finalFunding(1)); assertEq(m.funding(1), 0);
        m.allocate(2, 0, false); assertEq(m.funding(2), 100); assertEq(m.debt(), 500);
        assertEq(m.balance(), m.debt() + m.fit() + m.platform() + m.depth());
        vm.expectRevert(); m.receipt(1, 150, 0, 150);
    }
    function test_paidAndRefusedTipsAndNontradeMoneyKeepAttribution() public {
        m.receipt(1, 110, 10, 100); m.allocate(1, 5, false); assertEq(m.funding(1), 60);
        m.receipt(2, 110, 10, 100); m.allocate(2, 0, false); assertEq(m.funding(2), 60);
        assertEq(m.tips(), 5); assertEq(m.depth(), 39); // 12+12 pool +5+10 terminal dust
        m.royalty(150, false); assertEq(m.depth(), 159); // 20 pool +100 holder-choice to pool
        m.royalty(50, true); assertEq(m.fit(), 94); // 12+12+20 FIT, plus late 50
        assertEq(m.balance(), m.fit() + m.platform() + m.depth());
    }
    function test_failureBasePoolShareIsPotAndLateRoyaltyIsFit() public {
        m.receipt(1, 45, 15, 30); m.allocate(1, 0, true);
        assertEq(m.funding(1), 20); assertEq(m.pot(), 4); assertEq(m.depth(), 0);
        assertEq(m.fit(), 4); assertEq(m.platform(), 2);
        m.royalty(15, true); assertEq(m.fit(), 19); assertEq(m.funding(1), 20);
    }
    function testFuzz_sourceConservation(uint96 amount, uint96 tipInput, bool failed) public {
        uint256 tip = uint256(tipInput) % (uint256(amount) / 20 + 1);
        m.receipt(1, amount, 0, amount); m.allocate(1, tip, failed);
        assertEq(m.fit() + m.platform() + m.depth() + m.pot() + m.funding(1) + m.tips(), amount);
        assertEq(m.balance() + m.funding(1) + m.tips(), amount);
    }
}
