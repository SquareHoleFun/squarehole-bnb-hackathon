// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {SetReleaseBase, SetFactorySlot} from "./SetReleaseBase.sol";
import {console} from "forge-std/console.sol";

/// @notice Phase 2 is a fresh process after the final phase-1 receipt and an additional block.
contract DeploySetFactory is SetReleaseBase {
    function run(string calldata configJson, bytes32 mainnetAck, bytes calldata parts) external {
        ReleaseConfig memory c = _config(configJson, mainnetAck);
        Parts memory p = abi.decode(parts, (Parts));
        if (SetFactorySlot(p.slot).sender() != msg.sender) revert HandoffMismatch();
        vm.startBroadcast(msg.sender);
        address factory = _deployFactory(c, p, keccak256(bytes(configJson)));
        vm.stopBroadcast();
        console.log(string.concat("SETRELEASE|factory|", vm.toString(factory)));
    }
}
