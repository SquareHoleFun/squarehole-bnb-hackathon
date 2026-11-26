// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Retain the dependency oracle unchanged; these owned entries run the reviewed properties at this pin.
import {HolderAdversarialTest} from "../../m2-30/HolderAdversarial.t.sol";
import {HolderLedgerTest} from "../../m2-30/HolderLedger.t.sol";
import {HolderFixture} from "../../m2-30/HolderFixture.sol";
contract M263HolderAdversarialTest is HolderAdversarialTest {}
contract M263HolderLedgerTest is HolderLedgerTest {}

contract M263TinyHolderClaimTest is HolderFixture {
    function test_P12_oneRawUnitHasNoMinimumTipOrExpiry() public {
        _move(SYSTEM, ALICE, 1, false); _trade(1, 1, false, true); _close(1, 1); _settle(1, 64);
        assertEq(ledger.claimable(1, ALICE), 1);
        vm.warp(vm.getBlockTimestamp() + 366 days);
        uint256 beforeP = p.balanceOf(ALICE); uint256 beforeTip = p.balanceOf(PUSHER);
        vm.prank(ALICE); assertEq(ledger.claim(1, ALICE), 1);
        assertEq(p.balanceOf(ALICE) - beforeP, 1); assertEq(p.balanceOf(PUSHER), beforeTip);
        assertEq(ledger.claimable(1, ALICE), 0);
    }
}
