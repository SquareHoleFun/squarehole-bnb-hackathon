// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {SetReleaseBase} from "./SetReleaseBase.sol";
import {console} from "forge-std/console.sol";

/// @notice Phase 1 only. Use release.mjs with explicit config, RPC and founder sender/signer.
contract DeploySetParts is SetReleaseBase {
    function run(string calldata configJson, bytes32 mainnetAck) external {
        ReleaseConfig memory c = _config(configJson, mainnetAck);
        vm.startBroadcast(msg.sender);
        Parts memory p = _deployParts(c, keccak256(bytes(configJson)), msg.sender);
        vm.stopBroadcast();
        console.log(string.concat("SETRELEASE|slot|", vm.toString(p.slot)));
        console.log(string.concat("SETRELEASE|parts|", vm.toString(abi.encode(p))));
        _printLibraries();
    }
}
