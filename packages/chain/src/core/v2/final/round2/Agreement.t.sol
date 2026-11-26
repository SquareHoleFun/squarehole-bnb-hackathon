// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "test/box-v2/rc5-a/NoFailureSweep.sol";

import {FinalCreatorAgreementTest, FinalShopAgreementTest} from "../Agreement.t.sol";
import {RoyaltyDestination} from "src/box/interfaces/BoxTypes.sol";
import {SweepFixture} from "test/box-v2/r40a/SweepFixture.sol";
import {CoreV2GasRules} from "script/sepolia-v2/CoreV2GasRules.sol";
import {Test} from "forge-std/Test.sol";

// Re-execute production receiver/PoolManager and shop fixtures on both EVMs.
contract Round2CreatorTest is FinalCreatorAgreementTest {
    function testFuzz_boundedLazyPaymentsConservePrincipalAtReaderGas(uint256 seed) public {
        uint256 amount = bound(seed, 1, CAP + 101);
        r = _receiver(1, 1, uint8(RoyaltyDestination.Creator), address(p), true);
        _royalty(address(p), amount);
        coord.setGraduated();
        (uint256 stored,) = r.creatorOwed(address(p));
        assertEq(stored, 0);
        vm.prank(PAYEE);
        (bool ok, bytes memory result) = address(r).call{gas: 5_000_000}(
            abi.encodeCall(r.claimCreator, (address(p), PAYEE))
        );
        assertTrue(ok, "the named RPC simulation allowance covers this production payout");
        uint256 paid = amount > CAP ? CAP : amount;
        assertEq(abi.decode(result, (uint256)), paid);
        assertEq(p.balanceOf(PAYEE), paid);
        assertEq(_balance(address(r)), amount - paid);
        vm.prank(PAYEE);
        assertEq(r.claimCreator(address(p), PAYEE), amount - paid);
        assertEq(p.balanceOf(PAYEE), amount);
        assertEq(_balance(address(r)), 0);
    }
}
contract Round2ShopTest is FinalShopAgreementTest {}

contract Round2SweepAgreementTest is SweepFixture {
    function test_noBuyerQuoteNeverExpiresAndLateMoneyCannotEnlargeIt() public {
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

    function test_refusingReceiverCannotBlockCreatorClaimBeyondYear() public {
        _fail(101, 0); vm.warp(box.failedAt() + 365 days);
        vm.mockCallRevert(address(fees), abi.encodeWithSelector(fees.collect.selector), bytes("refuse booking"));
        NoFailureSweep.check(address(box));
        assertEq(box.quoteClaim(0), 101);
        assertEq(_claim(CREATOR, 0, BOB), 101);
        assertEq(_balance(BOB), 101);
        assertEq(fees.fitOwed(), 0);
    }
}

contract Round2GasProbe is CoreV2GasRules {
    function check(uint256 gas_, uint256 stateGas, bool amsterdam, bool viaCall, uint256 blockLimit) external pure {
        _checkGasStep(GasStep("round2", gas_, stateGas, viaCall), amsterdam, blockLimit);
    }
}

contract Round2ScriptGasTest is Test {
    function test_executionCapIsDistinctFromAmsterdamStateReservoir() public {
        Round2GasProbe probe = new Round2GasProbe();
        uint256 boundary = probe.TX_GAS_CAP() * 100 / probe.GAS_ESTIMATE_MULTIPLIER() - 500_000;
        probe.check(boundary, 0, false, false, 60_000_000);
        vm.expectPartialRevert(CoreV2GasRules.StepGasTooHigh.selector);
        probe.check(boundary + 1, 0, false, false, 60_000_000);
        // Above 16,777,216 TOTAL gas is valid after EIP-8037, with execution and block room checked separately.
        probe.check(45_000_000, 40_000_000, true, false, 54_500_000);
        vm.expectPartialRevert(CoreV2GasRules.StepTooBigForBlock.selector);
        probe.check(45_000_001, 40_000_000, true, false, 54_500_000);
        vm.expectPartialRevert(CoreV2GasRules.StepTooBigForBlock.selector);
        probe.check(45_000_000, 40_000_000, true, true, 54_500_000);
    }
}
