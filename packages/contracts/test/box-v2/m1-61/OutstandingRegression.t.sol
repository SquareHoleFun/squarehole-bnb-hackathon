// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {SweepFixture} from "../r40a/SweepFixture.sol";

/// @notice R40A fixes CQ11-F / C15.14's denominator; F136 retains the pot and open claims after a year.
contract OutstandingRegressionTest is SweepFixture {
    function test_holderBurnKeepsFixedCountAndRemainderStaysAtYear() public {
        _fail(100, 100);
        vm.prank(ALICE);
        t.burn(40);
        assertEq(_left(), 100);
        assertEq(box.quoteClaim(60), 60);
        assertEq(_claim(ALICE, 60, ALICE), 60);
        assertEq(_left(), 40);
        _retainedAtYear(40);
        _assertClaimsOpen(ALICE, 1);
    }

    function test_holderGiftKeepsFixedCountAndRemainderStaysAtYear() public {
        _fail(100, 100);
        vm.prank(ALICE);
        t.transfer(address(box), 40);
        assertEq(_left(), 100);
        assertEq(_claim(ALICE, 60, ALICE), 60);
        assertEq(_left(), 40);
        _retainedAtYear(40);
        _assertClaimsOpen(ALICE, 1);
    }
}

/// @dev These are permitted token actions, not simulated storage corruption. Keep the counterexample in the
/// campaign as well as the short deterministic reproductions above; do not assume holders only call claim().
contract OutstandingDisposalHandler is SweepFixture {
    uint256 internal claimedT;
    uint256 internal receivedP = 100;
    function setUp() public override {
        super.setUp();
        _fail(100, 100);
    }

    function dispose(uint96 seed, bool burn) external {
        uint256 balance = t.balanceOf(ALICE);
        if (balance == 0) return;
        uint256 amount = bound(seed, 1, balance);
        vm.prank(ALICE);
        if (burn) t.burn(amount);
        else t.transfer(address(box), amount);
    }

    function claimRemaining() external {
        uint256 balance = t.balanceOf(ALICE);
        if (balance != 0) {
            claimedT += balance;
            _claim(ALICE, balance, ALICE);
        }
    }

    function giftP(uint96 amount) external {
        receivedP += amount;
        _fund(p, address(box), amount);
    }

    function assertEveryPotUnitStaysWithHolders() external {
        assertEq(_left(), 100 - claimedT, "only claims change the fixed count");
        assertEq(_pot() + _balance(ALICE), receivedP, "claims plus retained P conserve every unit");
        uint256 snapshot = vm.snapshotState();
        vm.warp(box.failedAt() + 1000 days);
        NoFailureSweep.check(address(box));
        assertEq(_pot() + _balance(ALICE), receivedP);
        assertEq(fees.fitOwed(), 0);
        if (_left() != 0) assertEq(box.quoteClaim(_left()), _pot());
        assertTrue(vm.revertToState(snapshot));
    }
}

contract OutstandingDisposalInvariantTest is StdInvariant, Test {
    OutstandingDisposalHandler internal handler;

    function setUp() public {
        handler = new OutstandingDisposalHandler();
        handler.setUp();
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = handler.dispose.selector;
        selectors[1] = handler.claimRemaining.selector;
        selectors[2] = handler.giftP.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariant_everyPotUnitStaysWithHolders() public {
        handler.assertEveryPotUnitStaysWithHolders();
    }
}
