// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";

/// @notice SIZE-C1: M3 uses the recovered space while preserving the release reserve.
contract FactorySizeRecoveryTest is Test {
    function test_factoryChecksKeepsReleaseReserveAfterM3() public view {
        assertLe(vm.getDeployedCode("BoxFactoryV2Checks.sol:BoxFactoryV2Checks").length, 22_118);
    }

    function test_exactProductionSizesAndHelperGate() public view {
        assertEq(vm.getDeployedCode("BoxFactoryV2Checks.sol:BoxFactoryV2Checks").length, 22061);
        uint256 helperSize = vm.getDeployedCode("FactoryChecksCurve.sol:FactoryChecksCurve").length;
        assertEq(helperSize, 4_407);
        assertLe(helperSize, 22_118);
    }
}
