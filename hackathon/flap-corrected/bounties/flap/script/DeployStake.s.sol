// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {RailStakeFactory} from "fee-rules/RailStakeFactory.sol";

/// @notice Deploys the RailStakeFactory (one transaction, no settings, no owner) and writes
/// `deployments/<chainId>-stake.json` (STAKE_FILE overrides): factory, chainId, deployBlock. The launch page's
/// `addresses.json` takes the factory as `"railStake": { "factory": "0x..." }`.
///   forge script script/DeployStake.s.sol --rpc-url <endpoint> --account <keystore> --sender <address> --broadcast
contract DeployStake is Script {
    function run() external {
        vm.startBroadcast();
        RailStakeFactory f = new RailStakeFactory();
        vm.stopBroadcast();
        console.log(string.concat("railStake factory ", vm.toString(address(f))));
        string memory k = "stake";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        string memory json = vm.serializeAddress(k, "factory", address(f));
        string memory file =
            vm.envOr("STAKE_FILE", string.concat("deployments/", vm.toString(block.chainid), "-stake.json"));
        vm.writeJson(json, string.concat(vm.projectRoot(), "/", file));
    }
}
