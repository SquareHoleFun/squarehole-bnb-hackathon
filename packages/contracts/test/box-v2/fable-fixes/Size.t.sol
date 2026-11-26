// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

contract FableSizeTest is Test {
    function test_item8_coordinatorKeepsReleaseSizeReserve() public view {
        assertLe(vm.getDeployedCode("out/BoxCoordinatorV2.sol/BoxCoordinatorV2.json").length, 22_118);
    }
}
