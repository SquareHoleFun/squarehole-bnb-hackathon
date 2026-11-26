// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PileVaultFactory} from "../src/PileVaultFactory.sol";
import {CurveLauncherFactory} from "../src/CurveLauncherFactory.sol";

/// @notice Deploys the pair (two transactions) and writes `deployments/<chainId>.json` (addresses, and `deployBlock`:
/// the block to read the factory's events from). The vault factory names, as its only launcher factory, the sender's
/// next CREATE address, where the second transaction puts the launcher factory (Flap's pre-audit R3); the launcher
/// factory's constructor refuses a vault factory that does not name it, so a pair that does not match cannot be made.
/// A stopped run is not resumed: a vault factory whose launcher factory never came is unpaired for good (it serves no
/// launch); deploy both again.
/// DEPLOYMENTS_FILE overrides the output path (a rehearsal on a local fork writes elsewhere).
/// Run (the sender comes from a keystore, never a key in a file):
///   forge script script/Deploy.s.sol --rpc-url bsc_testnet --account <keystore> --sender <address> --broadcast
contract Deploy is Script {
    address constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;
    /// @dev The Portal's anti-scam word list on chain 97 (src/IAntiScam.sol). It is a constant in Flap's launch facet,
    /// with no getter on the Portal, and differs per network (BNB Chain, measured on a fork at block 135830000:
    /// 0xfFb69d59f62454f3B8322Bc1a9FCE6E171a5264f), so a launcher factory is deployed per network with that network's
    /// module; this script is for chain 97 only.
    address constant ANTI_SCAM_97 = 0x5CfbE713d070e87F67D1bc84312B7eB8Fe4F2B5E;

    function run() external {
        require(block.chainid == 97, "chain 97 only");
        // The old resume inputs are refused before anything is simulated or sent: reusing a vault factory from a stopped
        // run is no longer possible (it names the launcher factory at its own next nonce), and a rerun deploys a new pair.
        require(
            bytes(vm.envOr("PILE_VAULT_FACTORY", string(""))).length == 0
                && bytes(vm.envOr("PILE_VAULT_FACTORY_NONCE", string(""))).length == 0,
            "PILE_VAULT_FACTORY and PILE_VAULT_FACTORY_NONCE are obsolete: unset them (a stopped run: forge --resume, or deploy both again)"
        );
        vm.startBroadcast();
        // the account that sends the two creations (the --sender of a real run): its next nonce makes the vault factory
        (, address sender,) = vm.readCallers();
        address paired = vm.computeCreateAddress(sender, vm.getNonce(sender) + 1);
        PileVaultFactory pvf = new PileVaultFactory(PORTAL, paired);
        CurveLauncherFactory clf = new CurveLauncherFactory(PORTAL, address(pvf), TOKEN_IMPL, ANTI_SCAM_97);
        vm.stopBroadcast();
        require(pvf.pairedLauncherFactory() == address(clf), "the pair does not match");

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
}
