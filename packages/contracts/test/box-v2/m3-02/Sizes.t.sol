// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";

contract M302SizesTest is Test {
    /// M302-SIZE: every current gate plus built parts awaiting the size-manifest owner.
    function test_currentPartsFitWithTheSeparateEip170Reserve() public {
        string memory manifest = vm.readFile("size-budget.v2.json");
        assertEq(vm.parseJsonUint(manifest, ".limitBytes"), 24_576);
        assertEq(vm.parseJsonUint(manifest, ".minReserveBytes"), 2_458);
        string[] memory names = vm.parseJsonKeys(manifest, ".gates");
        for (uint256 i; i < names.length; ++i) {
            string memory key = string.concat(".gates.", names[i]);
            assertEq(vm.parseJsonUint(manifest, string.concat(key, ".m1GateBytes")), 22_118);
            assertEq(vm.parseJsonUint(manifest, string.concat(key, ".reserveBytes")), 2_458);
            _size(vm.parseJsonString(manifest, string.concat(key, ".source")), names[i]);
        }
        _size("src/box-v2/StarterSetLoaderV2.sol", "StarterSetLoaderV2");
        _size("src/box-v2/libraries/ReceiverViews.sol", "ReceiverViews");
        _size("src/box-v2/ItemLedgerV2.sol", "ItemLedgerV2");
    }

    function _size(string memory source, string memory name) private {
        bytes memory code = vm.getDeployedCode(string.concat(source, ":", name));
        assertGt(code.length, 0, name);
        assertLe(code.length, 22_118, name);
        emit log_named_uint(name, code.length);
        emit log_named_uint("remaining below 22118", 22_118 - code.length);
    }
}
