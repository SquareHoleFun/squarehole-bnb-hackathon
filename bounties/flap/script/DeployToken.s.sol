// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {TokenPileVaultFactory} from "../src/TokenPileVaultFactory.sol";
import {TokenCurveLauncherFactory} from "../src/TokenCurveLauncherFactory.sol";

/// @notice Deploys the two token-quote factories for one ERC-20 quote (default: Flap's test USDT on chain 97) and
/// writes `deployments/<chainId>-usdt.json` (addresses, the quote, and `deployBlock`). Both constructors refuse a
/// quote the Portal has not enabled. DEPLOYMENTS_FILE overrides the output path; QUOTE overrides the quote.
/// Resuming a stopped run: PILE_VAULT_FACTORY=<address> and PILE_VAULT_FACTORY_NONCE=<the nonce of its creation
/// transaction> reuse a TokenPileVaultFactory the sender already deployed (checked: the sender's CREATE address at that
/// nonce, and this build's code for this Portal and quote) and send only the second.
///   forge script script/DeployToken.s.sol --rpc-url <endpoint> --account <keystore> --sender <address> --broadcast
contract DeployToken is Script {
    address constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;
    address constant TEST_USDT_97 = 0x190C989D5665a0e404B444b53CAE9AbCfb600157;

    function run() external {
        require(block.chainid == 97, "chain 97 only");
        address quote = vm.envOr("QUOTE", TEST_USDT_97);
        TokenPileVaultFactory pvf = TokenPileVaultFactory(vm.envOr("PILE_VAULT_FACTORY", address(0)));
        if (address(pvf) != address(0)) _verifyResumed(address(pvf), quote);
        vm.startBroadcast();
        if (address(pvf) == address(0)) pvf = new TokenPileVaultFactory(PORTAL, quote);
        TokenCurveLauncherFactory clf = new TokenCurveLauncherFactory(PORTAL, address(pvf), TOKEN_IMPL);
        vm.stopBroadcast();

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

    function _verifyResumed(address pvf, address quote) internal {
        uint256 nonce = vm.envUint("PILE_VAULT_FACTORY_NONCE");
        require(pvf == vm.computeCreateAddress(msg.sender, nonce), "PILE_VAULT_FACTORY is not the sender's at that nonce");
        address ref = address(new TokenPileVaultFactory(PORTAL, quote)); // simulated only, never broadcast
        require(keccak256(pvf.code) == keccak256(ref.code), "PILE_VAULT_FACTORY's code is not this build's");
    }
}
