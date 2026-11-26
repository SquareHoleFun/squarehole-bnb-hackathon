// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../rc5-a/NoFailureSweep.sol";

import {SweepFixture} from "../../r40a/SweepFixture.sol";
import {CoreV2GasRules} from "../../../../script/sepolia-v2/CoreV2GasRules.sol";
import {Test} from "forge-std/Test.sol";

// Preserve the three round-2 off-chain sweep/destination witnesses in normal v2 discovery.
// The external chain-package Solidity file is not part of the default Foundry source graph.
contract Round3SweepAgreementTest is SweepFixture {
    function test_noBuyerQuoteNeverExpiresAndLateMoneyStaysLocked() public {
        _fail(101, 0); _fund(p, address(box), 19);
        vm.warp(box.failedAt() + 1000 days);
        NoFailureSweep.check(address(box));
        assertEq(box.quoteClaim(0), 101);
        _fund(p, address(box), 127);
        assertEq(box.quoteClaim(0), 101);
        assertEq(_claim(CREATOR, 0, BOB), 101);
        assertEq(_pot(), 146);
        assertEq(fees.payFit(), 0);
        assertEq(_balance(BOB), 101);
        vm.expectRevert(); box.quoteClaim(0);
    }

    function test_refusingReceiverPreservesClaimAndItsQuote() public {
        _fail(101, 0); vm.warp(box.failedAt() + 365 days);
        vm.mockCallRevert(address(fees), abi.encodeWithSelector(fees.collect.selector), bytes("refuse booking"));
        NoFailureSweep.check(address(box));
        assertEq(box.quoteClaim(0), 101);
        assertEq(_claim(CREATOR, 0, BOB), 101);
        assertEq(_balance(BOB), 101);
        assertEq(fees.fitOwed(), 0);
    }
}

contract Round3GasProbe is CoreV2GasRules {
    function check(uint256 gas_, uint256 stateGas, bool amsterdam, bool viaCall, uint256 blockLimit) external pure {
        _checkGasStep(GasStep("round3", gas_, stateGas, viaCall), amsterdam, blockLimit);
    }
}

contract Round3DestinationAgreementTest is Test {
    function test_executionCapIsDistinctFromAmsterdamStateReservoir() public {
        Round3GasProbe probe = new Round3GasProbe();
        uint256 boundary = probe.TX_GAS_CAP() * 100 / probe.GAS_ESTIMATE_MULTIPLIER() - 500_000;
        probe.check(boundary, 0, false, false, 60_000_000);
        vm.expectPartialRevert(CoreV2GasRules.StepGasTooHigh.selector);
        probe.check(boundary + 1, 0, false, false, 60_000_000);
        probe.check(45_000_000, 40_000_000, true, false, 54_500_000);
        vm.expectPartialRevert(CoreV2GasRules.StepTooBigForBlock.selector);
        probe.check(45_000_001, 40_000_000, true, false, 54_500_000);
        vm.expectPartialRevert(CoreV2GasRules.StepTooBigForBlock.selector);
        probe.check(45_000_000, 40_000_000, true, true, 54_500_000);
    }
}
