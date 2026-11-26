// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {PileDeployer, RulesVaultDeployer} from "../src/RulesDeployers.sol";
import {RulesCurveLauncherFactory} from "../src/RulesCurveLauncherFactory.sol";
import {RulesTokenCurveLauncherFactory} from "../src/RulesTokenCurveLauncherFactory.sol";

/// @notice Deploys one rules pair: a RulesVaultFactory and the text-only copy of the launcher factory that names it
/// (VARIANT=usdt, the default: Flap's test dollar with RulesTokenCurveLauncherFactory; VARIANT=native: BNB with
/// RulesCurveLauncherFactory; script/rules-launchers.py proves the copies differ only in names, strings, comments). Writes `deployments/<chainId>-rules-<variant>.json` (addresses, quote, router,
/// deployBlock). Four transactions: the two stateless deployers, the vault factory, the launcher factory. Chain 97 only.
///   forge script script/DeployRules.s.sol --rpc-url <endpoint> --account <keystore> --sender <address> --broadcast
contract DeployRules is Script {
    address constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;
    address constant TEST_USDT_97 = 0x190C989D5665a0e404B444b53CAE9AbCfb600157;
    address constant ROUTER_97 = 0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3;

    function run() external {
        require(block.chainid == 97, "chain 97 only");
        string memory variant = vm.envOr("VARIANT", string("usdt"));
        bool usd = keccak256(bytes(variant)) == keccak256("usdt");
        require(usd || keccak256(bytes(variant)) == keccak256("native"), "VARIANT must be usdt or native");
        address quote = usd ? TEST_USDT_97 : address(0);

        vm.startBroadcast();
        PileDeployer pd = new PileDeployer();
        RulesVaultDeployer rd = new RulesVaultDeployer();
        RulesVaultFactory rvf = new RulesVaultFactory(PORTAL, quote, ROUTER_97, pd, rd);
        address lf = usd
            ? address(new RulesTokenCurveLauncherFactory(PORTAL, address(rvf), TOKEN_IMPL))
            : address(new RulesCurveLauncherFactory(PORTAL, address(rvf), TOKEN_IMPL));
        vm.stopBroadcast();

        console.log(string.concat("RulesVaultFactory ", vm.toString(address(rvf))));
        console.log(string.concat("launcher factory ", vm.toString(lf)));
        string memory k = "rules";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number); // the factories land in this block or later
        vm.serializeString(k, "variant", variant);
        vm.serializeAddress(k, "portal", PORTAL);
        vm.serializeAddress(k, "quote", quote);
        vm.serializeAddress(k, "router", ROUTER_97);
        vm.serializeAddress(k, "pileDeployer", address(pd));
        vm.serializeAddress(k, "rulesVaultDeployer", address(rd));
        vm.serializeAddress(k, "rulesVaultFactory", address(rvf));
        string memory json = vm.serializeAddress(k, "launcherFactory", lf);
        string memory file = vm.envOr(
            "DEPLOYMENTS_FILE", string.concat("deployments/", vm.toString(block.chainid), "-rules-", variant, ".json")
        );
        vm.writeJson(json, string.concat(vm.projectRoot(), "/", file));
        console.log(string.concat("written ", file));
    }
}
