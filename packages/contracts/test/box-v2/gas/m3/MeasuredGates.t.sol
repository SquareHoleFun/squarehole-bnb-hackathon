// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

contract M360MeasuredGatesTest is Test {
    function test_M360_allDeployedM3PartsHaveReleaseGates() public view {
        string memory manifest = vm.readFile("size-budget.v2.json");
        string[2] memory additions = [string("ItemLedgerV2"), "FactoryChecksCurve"];
        for (uint256 i; i < additions.length; ++i) {
            string memory key = string.concat(".gates.", additions[i]);
            assertTrue(vm.keyExistsJson(manifest, key), additions[i]);
            assertEq(vm.parseJsonUint(manifest, string.concat(key, ".m1GateBytes")), 22118);
            assertEq(vm.parseJsonUint(manifest, string.concat(key, ".reserveBytes")), 2458);
        }
        assertEq(vm.parseJsonKeys(manifest, ".gates").length, 45);
        assertEq(vm.parseJsonKeys(manifest, ".m2PlannedGates").length, 0);
    }
}
