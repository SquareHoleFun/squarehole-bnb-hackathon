// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// @notice Offline permission probe. Deliberately imports none of the bootstrap's artifact dependencies.
contract AlphaArtifactRead is Script {
    function run(string[] memory paths) external view {
        require(vm.isContext(VmSafe.ForgeContext.ScriptDryRun), "dry run only");
        for (uint256 i; i < paths.length; ++i) {
            require(bytes(vm.readFile(paths[i])).length != 0, "empty artifact");
        }
    }
}
