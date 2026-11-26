// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {TokenPileVaultFactory} from "../src/TokenPileVaultFactory.sol";
import {TokenCurveLauncherFactory} from "../src/TokenCurveLauncherFactory.sol";

/// @notice Deploys the two token-quote factories for one ERC-20 quote (default: Flap's test USDT on chain 97) and
/// writes `deployments/<chainId>-usdt.json` (addresses, the quote, and `deployBlock`). Both constructors refuse a
/// quote the Portal has not enabled. DEPLOYMENTS_FILE overrides the output path; QUOTE overrides the quote.
/// The vault factory names the sender's next CREATE address, where the second transaction puts the launcher factory
/// (Flap's pre-audit R3); a stopped run is not resumed (deploy both again).
///   forge script script/DeployToken.s.sol --rpc-url <endpoint> --account <keystore> --sender <address> --broadcast
contract DeployToken is Script {
    address constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;
    /// @dev The Portal's anti-scam word list on chain 97 (src/IAntiScam.sol). It is a constant in Flap's launch facet,
    /// with no getter on the Portal, and differs per network (BNB Chain, measured on a fork at block 135830000:
    /// 0xfFb69d59f62454f3B8322Bc1a9FCE6E171a5264f), so a launcher factory is deployed per network with that network's
    /// module; this script is for chain 97 only.
    address constant ANTI_SCAM_97 = 0x5CfbE713d070e87F67D1bc84312B7eB8Fe4F2B5E;
    address constant TEST_USDT_97 = 0x190C989D5665a0e404B444b53CAE9AbCfb600157;

    function run() external {
        require(block.chainid == 97, "chain 97 only");
        address quote = vm.envOr("QUOTE", TEST_USDT_97);
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
        TokenPileVaultFactory pvf = new TokenPileVaultFactory(PORTAL, quote, paired);
        TokenCurveLauncherFactory clf = new TokenCurveLauncherFactory(PORTAL, address(pvf), TOKEN_IMPL, ANTI_SCAM_97);
        vm.stopBroadcast();
        require(pvf.pairedLauncherFactory() == address(clf), "the pair does not match");

        console.log(string.concat("TokenPileVaultFactory ", vm.toString(address(pvf))));
        console.log(string.concat("TokenCurveLauncherFactory ", vm.toString(address(clf))));
        console.log(string.concat("TokenCurveLauncher (code) ", vm.toString(clf.implementation())));
        console.log(string.concat("quote ", vm.toString(quote)));

        string memory k = "deployUsdt";
        vm.serializeUint(k, "chainId", block.chainid);
        // the block the script ran against: the factories land in it or later
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeAddress(k, "portal", PORTAL);
        vm.serializeAddress(k, "tokenImpl", TOKEN_IMPL);
        vm.serializeAddress(k, "quote", quote);
        vm.serializeAddress(k, "tokenPileVaultFactory", address(pvf));
        vm.serializeAddress(k, "tokenCurveLauncherImplementation", clf.implementation());
        string memory json = vm.serializeAddress(k, "tokenCurveLauncherFactory", address(clf));
        string memory file =
            vm.envOr("DEPLOYMENTS_FILE", string.concat("deployments/", vm.toString(block.chainid), "-usdt.json"));
        vm.writeJson(json, string.concat(vm.projectRoot(), "/", file));
        console.log(string.concat("written ", file));
    }
}
