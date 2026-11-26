// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";

contract SizeFreezeTest is Test {
    function test_mergedM2ContractsHaveMeasuredGates() public view {
        string memory json = vm.readFile("size-budget.v2.json");
        string[3] memory names = [string("HolderLedgerV2"), "BoxTokenV2Ledger", "ShopVaultV2"];
        for (uint256 i; i < names.length; ++i) {
            _measuredGate(json, names[i], string.concat("src/box-v2/", names[i], ".sol"));
        }
    }

    function test_sharedHelpersHaveSeparateMeasuredGates() public view {
        string memory json = vm.readFile("size-budget.v2.json");
        _measuredGate(json, "ShopTBurnerV2", "src/box-v2/ShopVaultV2.sol");
        _measuredGate(json, "CoordinatorViews", "src/box-v2/libraries/CoordinatorViews.sol");
        _measuredGate(json, "VaultViews", "src/box-v2/libraries/VaultViews.sol");
    }

    function test_starterSetLoaderAndReceiverViewsAreMeasured() public view {
        string memory json = vm.readFile("size-budget.v2.json");
        assertEq(vm.parseJsonKeys(json, ".m2PlannedGates").length, 0);
        _measuredGate(json, "StarterSetLoaderV2", "src/box-v2/StarterSetLoaderV2.sol");
        _measuredGate(json, "ReceiverViews", "src/box-v2/libraries/ReceiverViews.sol");
    }

    function test_allMeasuredPartsKeepTheOriginalCeilingAndReserve() public view {
        string memory json = vm.readFile("size-budget.v2.json");
        assertEq(vm.parseJsonUint(json, ".limitBytes"), 24576);
        assertEq(vm.parseJsonUint(json, ".minReserveBytes"), 2458);
        string[] memory existing = vm.parseJsonKeys(json, ".gates");
        assertEq(existing.length, 45); // RC6-INT part 2: the shared CoW handler is the 45th gate
        for (uint256 i; i < existing.length; ++i) {
            string memory key = string.concat(".gates.", existing[i]);
            assertEq(vm.parseJsonUint(json, string.concat(key, ".reserveBytes")), 2458);
            assertEq(vm.parseJsonUint(json, string.concat(key, ".m1GateBytes")), 22118);
        }
    }

    function _measuredGate(string memory json, string memory name, string memory source) private view {
        string memory key = string.concat(".gates.", name);
        assertEq(vm.parseJsonUint(json, string.concat(key, ".m1GateBytes")), 22118);
        assertEq(vm.parseJsonUint(json, string.concat(key, ".reserveBytes")), 2458);
        assertEq(vm.parseJsonString(json, string.concat(key, ".source")), source);
        assertFalse(vm.keyExistsJson(json, string.concat(".m2PlannedGates.", name)));
    }
}
