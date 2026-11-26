// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";

/// M260-SIZE: every merged runtime is measured; no M2 implementation remains a planned exemption.
contract M260MeasuredGatesTest is Test {
    function test_allMergedPartsHaveMeasuredGates() public view {
        string memory manifest = vm.readFile("size-budget.v2.json");
        string[6] memory names = [string("HolderLedgerV2"), "BoxTokenV2Ledger", "ShopVaultV2",
            "StarterSetLoaderV2", "ReceiverViews", "BoxHookV2"];
        for (uint256 i; i < names.length; ++i) {
            string memory key = string.concat(".gates.", names[i]);
            assertTrue(vm.keyExistsJson(manifest, key), names[i]);
            assertEq(vm.parseJsonUint(manifest, string.concat(key, ".m1GateBytes")), 22118);
            assertEq(vm.parseJsonUint(manifest, string.concat(key, ".reserveBytes")), 2458);
        }
        assertEq(vm.parseJsonKeys(manifest, ".m2PlannedGates").length, 0);
        assertEq(vm.parseJsonKeys(manifest, ".gates").length, 45);
    }
}
