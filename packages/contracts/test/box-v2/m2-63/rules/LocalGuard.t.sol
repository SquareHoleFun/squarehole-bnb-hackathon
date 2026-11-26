// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M263SafeCallerProperties} from "./Findings.t.sol";
import {LifeCustody} from "../../kit/FactoryLife.sol";

/// F130 supersedes this file's former Safe-only guard; exercise unchanged production code.
contract M263SafePayoutRetryTest is M263SafeCallerProperties {
    function test_R01_F130_anyCallerKeepsSafePayoutsIndependentAndRetryable() public {
        _createShop(0, 40 ether, false, true);
        _trade(); receiver.collect(address(0));
        uint256 owed = receiver.fitOwed();
        uint256 platformOwed = receiver.platformOwed();
        uint256 backing = _pClaims(address(receiver));
        uint256 fitBefore = fitSafe.balance;
        uint256 platformBefore = address(this).balance;
        uint256 callerBefore = ALICE.balance;
        assertGt(owed, 0);
        assertGt(platformOwed, 0);
        LifeCustody(payable(fitSafe)).setRefusing(true);
        vm.prank(ALICE); assertEq(receiver.payFit(), 0);
        assertEq(receiver.fitOwed(), owed);
        assertEq(_pClaims(address(receiver)), backing);
        assertEq(fitSafe.balance, fitBefore);
        vm.prank(ALICE); assertEq(receiver.payPlatform(), platformOwed);
        assertEq(receiver.platformOwed(), 0);
        assertEq(receiver.fitOwed(), owed);
        assertEq(address(this).balance - platformBefore, platformOwed);
        LifeCustody(payable(fitSafe)).setRefusing(false);
        vm.prank(ALICE); assertEq(receiver.payFit(), owed);
        assertEq(receiver.fitOwed(), 0);
        assertEq(fitSafe.balance - fitBefore, owed);
        assertEq(ALICE.balance, callerBefore, "trigger receives no payout or tip");
        assertEq(_pClaims(address(receiver)) + owed + platformOwed, backing);
        vm.prank(ALICE); assertEq(receiver.payFit(), 0);
        assertEq(fitSafe.balance - fitBefore, owed);
        assertEq(_pClaims(address(receiver)) + owed + platformOwed, backing);
    }
}
