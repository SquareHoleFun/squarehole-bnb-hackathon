// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {HolderFixture} from "./HolderFixture.sol";

/// @notice F127: even a funded wallet cannot be paid by another caller.
contract HolderClaimOnlyTest is HolderFixture {
    function test_F127_removedPushCannotSpendOrTip() public {
        _move(SYSTEM, ALICE, 60, false); _move(SYSTEM, BOB, 40, false);
        _trade(1, 100, false, true); _close(1, 1000); _settle(1, 64);
        vm.prank(PUSHER);
        (bool ok,) = address(ledger).call(abi.encodeWithSignature("claimFor(uint256,address)", 1, ALICE));
        assertFalse(ok, "F127 removes pushed payouts");
        assertEq(ledger.claimable(1, ALICE), 600); assertEq(ledger.claimable(1, BOB), 400);
        assertEq(p.balanceOf(ALICE), 0); assertEq(p.balanceOf(PUSHER), 0);
        vm.prank(ALICE); assertEq(ledger.claim(1, PUSHER), 600);
        assertEq(ledger.claimable(1, BOB), 400); assertEq(p.balanceOf(PUSHER), 600);
    }
}
