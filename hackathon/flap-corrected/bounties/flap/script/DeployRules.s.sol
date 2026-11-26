// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {RulesCurveLauncherFactory} from "../src/RulesCurveLauncherFactory.sol";
import {RulesTokenCurveLauncherFactory} from "../src/RulesTokenCurveLauncherFactory.sol";

/// @notice Deploys one rules pair: a RulesVaultFactory and the text-only copy of the launcher factory that names it
/// (VARIANT=usdt, the default: Flap's test dollar with RulesTokenCurveLauncherFactory; VARIANT=native: BNB with
/// RulesCurveLauncherFactory; script/rules-launchers.py proves the copies differ only in names, strings, comments). Writes `deployments/<chainId>-rules-<variant>.json` (addresses, quote, router,
/// deployBlock). Two transactions: the vault factory (it names the sender's next CREATE address as its only launcher
/// factory, Flap's pre-audit R3; it creates its two Guardian-only beacons itself), then the launcher factory there.
/// Chain 97 only.
///   forge script script/DeployRules.s.sol --rpc-url <endpoint> --account <keystore> --sender <address> --broadcast
contract DeployRules is Script {
    address constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;
    /// @dev The Portal's anti-scam word list on chain 97 (src/IAntiScam.sol). It is a constant in Flap's launch facet,
    /// with no getter on the Portal, and differs per network (BNB Chain, measured on a fork at block 135830000:
    /// 0xfFb69d59f62454f3B8322Bc1a9FCE6E171a5264f), so a launcher factory is deployed per network with that network's
    /// module; this script is for chain 97 only.
    address constant ANTI_SCAM_97 = 0x5CfbE713d070e87F67D1bc84312B7eB8Fe4F2B5E;
    address constant TEST_USDT_97 = 0x190C989D5665a0e404B444b53CAE9AbCfb600157;
    address constant ROUTER_97 = 0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3;

    function run() external {
        require(block.chainid == 97, "chain 97 only");
        string memory variant = vm.envOr("VARIANT", string("usdt"));
        bool usd = keccak256(bytes(variant)) == keccak256("usdt");
        require(usd || keccak256(bytes(variant)) == keccak256("native"), "VARIANT must be usdt or native");
        address quote = usd ? TEST_USDT_97 : address(0);

        vm.startBroadcast();
        // the account that sends the two creations (the --sender of a real run): its next nonce makes the vault factory
        (, address sender,) = vm.readCallers();
        address paired = vm.computeCreateAddress(sender, vm.getNonce(sender) + 1);
        RulesVaultFactory rvf = new RulesVaultFactory(PORTAL, quote, ROUTER_97, paired);
        address lf = usd
            ? address(new RulesTokenCurveLauncherFactory(PORTAL, address(rvf), TOKEN_IMPL, ANTI_SCAM_97))
            : address(new RulesCurveLauncherFactory(PORTAL, address(rvf), TOKEN_IMPL, ANTI_SCAM_97));
        vm.stopBroadcast();
        require(rvf.pairedLauncherFactory() == lf, "the pair does not match");

        console.log(string.concat("RulesVaultFactory ", vm.toString(address(rvf))));
        console.log(string.concat("launcher factory ", vm.toString(lf)));
        string memory k = "rules";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number); // the factories land in this block or later
        vm.serializeString(k, "variant", variant);
        vm.serializeAddress(k, "portal", PORTAL);
        vm.serializeAddress(k, "quote", quote);
        vm.serializeAddress(k, "router", ROUTER_97);
        vm.serializeAddress(k, "beacon", rvf.beacon());
        vm.serializeAddress(k, "pileBeacon", rvf.pileBeacon());
        vm.serializeAddress(k, "rulesVaultFactory", address(rvf));
        string memory json = vm.serializeAddress(k, "launcherFactory", lf);
        string memory file = vm.envOr(
            "DEPLOYMENTS_FILE", string.concat("deployments/", vm.toString(block.chainid), "-rules-", variant, ".json")
        );
        vm.writeJson(json, string.concat(vm.projectRoot(), "/", file));
        console.log(string.concat("written ", file));
    }
}
