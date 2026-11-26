// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FailureTestBase} from "./FailureTestBase.sol";

contract FailureLibrariesTest is FailureTestBase {
    function test_escrowClipsToVaultBalanceAndHeldTExcludedExactly() public {
        _give(ALICE, 100);
        _give(address(hook), 20);
        _give(address(receiver), 30);
        _give(address(this), 40);
        vm.prank(address(this));
        t.approve(address(vault), 40);
        vm.prank(address(vault));
        t.transferFrom(address(this), address(vault), 40);
        _fundT(address(hook), 7);
        _fundT(address(receiver), 11);
        _fundT(address(box), 13);
        vault.configure(SUPPLY, 90, false);
        _fund(p, address(hook), 100);
        _expire();
        vm.expectEmit(false, false, false, true, address(box));
        emit IClip.EscrowSurplusClipped(90, 40);
        box.fail();
        assertEq(_left(), 100);
        assertEq(t.totalSupply(), SUPPLY); // refused burns: holdings, not burned supply, are excluded
        assertEq(_claim(ALICE, 100, ALICE), 100);
        assertEq(_left(), 0);
    }

    function test_revertingEscrowViewExcludesZero() public {
        _give(ALICE, 100);
        _give(address(this), 40);
        vm.prank(address(this));
        t.approve(address(vault), 40);
        vm.prank(address(vault));
        t.transferFrom(address(this), address(vault), 40);
        vault.configure(0, 40, true);
        _expire();
        box.fail();
        assertEq(_left(), 140);
    }

    function test_namespacedFailureDoesNotOverwriteGateOrWiring() public {
        address oldT = box.token();
        uint256 open = box.openAt();
        uint256 deadline = box.deadline();
        _fail(100, 100);
        assertEq(box.token(), oldT);
        assertEq(box.openAt(), open);
        assertEq(box.deadline(), deadline);
        assertEq(box.failedAt(), block.timestamp);
        assertTrue(box.failed());
    }
}

interface IClip {
    event EscrowSurplusClipped(uint256 k, uint256 kPrime);
}
