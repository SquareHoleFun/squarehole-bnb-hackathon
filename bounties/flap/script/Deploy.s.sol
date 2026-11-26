// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PileVaultFactory} from "../src/PileVaultFactory.sol";
import {CurveLauncherFactory} from "../src/CurveLauncherFactory.sol";

/// @notice Deploys the two factories (two transactions) and writes `deployments/<chainId>.json` (addresses, and
/// `deployBlock`: the block to read the factory's events from).
/// DEPLOYMENTS_FILE overrides the output path (a rehearsal on a local fork writes elsewhere).
/// Resuming a stopped run: PILE_VAULT_FACTORY=<address> and PILE_VAULT_FACTORY_NONCE=<the nonce of its creation
/// transaction, from its receipt> reuse a PileVaultFactory the sender already deployed and send only the second. The
/// address must be the sender's CREATE address at that nonce (so the sender made it) and its code must equal this
/// build's code for this Portal (so it is this factory); anything else is refused.
/// Run (the sender comes from a keystore, never a key in a file):
///   forge script script/Deploy.s.sol --rpc-url bsc_testnet --account <keystore> --sender <address> --broadcast
contract Deploy is Script {
    address constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;

    function run() external {
        require(block.chainid == 97, "chain 97 only");
        PileVaultFactory pvf = PileVaultFactory(vm.envOr("PILE_VAULT_FACTORY", address(0)));
        if (address(pvf) != address(0)) _verifyResumed(address(pvf));
        vm.startBroadcast();
        if (address(pvf) == address(0)) pvf = new PileVaultFactory(PORTAL);
        CurveLauncherFactory clf = new CurveLauncherFactory(PORTAL, address(pvf), TOKEN_IMPL);
        vm.stopBroadcast();

        console.log(string.concat("PileVaultFactory ", vm.toString(address(pvf))));
        console.log(string.concat("CurveLauncherFactory ", vm.toString(address(clf))));
        console.log(string.concat("CurveLauncher (code) ", vm.toString(clf.implementation())));

        string memory k = "deploy";
        vm.serializeUint(k, "chainId", block.chainid);
        // The block the script ran against: the factories are deployed in it or a later one, so a page that reads
        // CurveLauncherCreated from here on misses nothing.
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeAddress(k, "portal", PORTAL);
        vm.serializeAddress(k, "tokenImpl", TOKEN_IMPL);
        vm.serializeAddress(k, "pileVaultFactory", address(pvf));
        vm.serializeAddress(k, "curveLauncherImplementation", clf.implementation());
        string memory json = vm.serializeAddress(k, "curveLauncherFactory", address(clf));
        string memory file = vm.envOr(
            "DEPLOYMENTS_FILE", string.concat("deployments/", vm.toString(block.chainid), ".json")
        );
        vm.writeJson(json, string.concat(vm.projectRoot(), "/", file));
        console.log(string.concat("written ", file));
    }

    function _verifyResumed(address pvf) internal {
        uint256 nonce = vm.envUint("PILE_VAULT_FACTORY_NONCE");
        require(pvf == vm.computeCreateAddress(msg.sender, nonce), "PILE_VAULT_FACTORY is not the sender's at that nonce");
        // a reference copy, simulated only (never broadcast): same build, same Portal
        address ref = address(new PileVaultFactory(PORTAL));
        require(keccak256(pvf.code) == keccak256(ref.code), "PILE_VAULT_FACTORY's code is not this build's");
        console.log(string.concat("resuming with the verified PileVaultFactory ", vm.toString(pvf)));
    }
}
