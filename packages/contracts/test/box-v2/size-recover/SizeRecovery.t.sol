// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @notice SIZE-1: M3 uses the reserved tickets/vault room while retaining the 22,118-byte release gate.
contract SizeRecoveryTest is Test {
    // The coordinator with fixed-count, non-expiring failure claims must fit the unchanged release ceiling.
    function test_coordinatorFitsReleaseGateAfterR40A() public view {
        assertLe(vm.getDeployedCode("BoxCoordinatorV2.sol:BoxCoordinatorV2").length, 22_118);
    }

    function test_ticketsWithM3FitsReleaseGate() public view {
        assertLe(vm.getDeployedCode("BoxTicketsV2.sol:BoxTicketsV2").length, 22_118);
    }

    function test_vaultWithM3FitsReleaseGate() public view {
        assertLe(vm.getDeployedCode("BoxVaultV2.sol:BoxVaultV2").length, 22_118);
    }

    function test_ticketViewsFitsReleaseGate() public view {
        assertLe(vm.getDeployedCode("BoxTicketsV2Views.sol:BoxTicketsV2Views").length, 22_118);
    }

    function test_measuredProductionSizes() public view {
        assertEq(vm.getDeployedCode("BoxCoordinatorV2.sol:BoxCoordinatorV2").length, 22_064);
        assertEq(vm.getDeployedCode("BoxTicketsV2.sol:BoxTicketsV2").length, 21_295);
        assertEq(vm.getDeployedCode("BoxVaultV2.sol:BoxVaultV2").length, 21_163);
        assertEq(vm.getDeployedCode("BoxTicketsV2Views.sol:BoxTicketsV2Views").length, 5_975);
        assertEq(vm.getDeployedCode("CoordinatorViews.sol:CoordinatorViews").length, 1_183);
        assertEq(vm.getDeployedCode("VaultViews.sol:VaultViews").length, 1_555);
    }

    function test_newPartsFitReleaseGate() public view {
        assertLe(vm.getDeployedCode("CoordinatorViews.sol:CoordinatorViews").length, 22_118);
        assertLe(vm.getDeployedCode("VaultViews.sol:VaultViews").length, 22_118);
    }

    function test_newPartsAreFixedByImplementationConstructors() public {
        address coordinator = deployCode(
            "BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(address(0x1234), address(0x5678))
        );
        address vault = deployCode("BoxVaultV2.sol:BoxVaultV2", abi.encode(coordinator));
        address coordinatorViews = vm.computeCreateAddress(coordinator, 1);
        address vaultViews = vm.computeCreateAddress(vault, 1);
        assertEq(coordinatorViews.codehash, keccak256(vm.getDeployedCode("CoordinatorViews.sol:CoordinatorViews")));
        assertEq(vaultViews.codehash, keccak256(vm.getDeployedCode("VaultViews.sol:VaultViews")));
        assertLe(coordinator.code.length, 22_118);
        assertLe(vault.code.length, 22_118);
    }
}
