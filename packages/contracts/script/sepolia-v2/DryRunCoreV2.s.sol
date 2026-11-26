// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {SepoliaAllRehearsal} from "./SepoliaAllRehearsal.sol";
import {Script} from "forge-std/Script.sol";

contract OfflineCoreV2 is SepoliaAllRehearsal {
    /// @notice Anyone may run the complete local chronology. Time travel is simulation evidence only.
    function run() external {
        setUp();
        _rehearse();
    }
}

/// @notice No RPC, signing or broadcast. The fixture has a regular local address, not an ephemeral script address.
contract DryRunCoreV2 is Script {
    function run() external {
        require(keccak256(type(OfflineCoreV2).creationCode) != bytes32(0));
        OfflineCoreV2(vm.deployCode("DryRunCoreV2.s.sol:OfflineCoreV2")).run();
    }
}
