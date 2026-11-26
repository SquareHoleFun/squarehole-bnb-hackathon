// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {IVmFrameGasV2} from "../../../script/lib/CoreV2GasMeter.sol";
import {CoreV2GasRules} from "../../../script/sepolia-v2/CoreV2GasRules.sol";

contract NoopGas {
    function ping() external pure {}
}

contract RulesProbe is CoreV2GasRules {
    function check(uint256 used, uint256 stateGas, bool amsterdam, uint256 blockLimit) external pure {
        _checkGasStep(GasStep("sample", used, stateGas, false), amsterdam, blockLimit);
    }
}

contract GasBudgetRulesTest is Test {
    function test_callMeterNeedsExplicitTransactionOverhead() public {
        NoopGas n = new NoopGas();
        vm.cool(address(n));
        uint256 before_ = gasleft();
        n.ping();
        uint256 used = before_ - gasleft();
        IVmFrameGasV2.Gas memory frame = IVmFrameGasV2(address(vm)).lastFrameGas();
        emit log_named_uint("empty call caller delta", used);
        emit log_named_uint("empty call frame gas", frame.gasTotalUsed);
        assertGe(used, frame.gasTotalUsed);
        assertLt(used, 21_000, "call meter excludes transaction intrinsic gas");
    }

    function test_budgetBoundaryAndExecutionCap() public {
        RulesProbe p = new RulesProbe();
        p.check(45_000_000, 40_000_000, true, 54_500_000);
        vm.expectRevert();
        p.check(45_000_001, 40_000_000, true, 54_500_000);
        vm.expectRevert();
        p.check(16_777_216, 0, false, 54_500_000);
        p.check(10_000_000, 0, false, 54_500_000);
    }
}
