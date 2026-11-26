// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {CreateSale} from "../script/CreateSale.s.sol";
import {Sale} from "../script/Sale.s.sol";
import {PileVaultFactory} from "../src/PileVaultFactory.sol";
import {MockAntiScam} from "./CurveLauncher.t.sol";
import {DeployToken} from "../script/DeployToken.s.sol";
import {CreateTokenSale} from "../script/CreateTokenSale.s.sol";
import {TokenSale} from "../script/TokenSale.s.sol";

/// @notice The real-run scripts refuse every chain but the BNB test network before they resolve anything, and refuse
/// a setting that would not fit its field.
contract ScriptsTest is Test {
    function test_deploy_refusesOtherChains() public {
        Deploy d = new Deploy();
        uint64[3] memory ids = [uint64(56), 1, 31337];
        for (uint256 i; i < 3; ++i) {
            vm.chainId(ids[i]);
            vm.expectRevert(bytes("chain 97 only"));
            d.run();
        }
    }

    function test_createSale_refusesOtherChains() public {
        CreateSale c = new CreateSale();
        vm.chainId(56);
        vm.expectRevert(bytes("chain 97 only"));
        c.run();
    }

    function test_sale_refusesOtherChains() public {
        Sale s = new Sale();
        vm.chainId(56);
        vm.expectRevert(bytes("chain 97 only"));
        s.run();
    }

    function test_createSale_refusesASettingThatDoesNotFit() public {
        CreateSale c = new CreateSale();
        vm.chainId(97);
        vm.setEnv("TRADE_FEE_BPS", "65536");
        vm.expectRevert(bytes("TRADE_FEE_BPS does not fit its field"));
        c.run();
        vm.setEnv("TRADE_FEE_BPS", "100");
        // the environment is shared by tests running side by side, so the route check runs in this same test
        vm.setEnv("VIA_PORTAL", "2");
        vm.expectRevert(bytes("VIA_PORTAL must be 0 or 1"));
        c.run();
        vm.setEnv("VIA_PORTAL", "1");
    }

    /// The old resume inputs are refused before anything is simulated or sent (a stopped run is resumed with forge's
    /// --resume or deployed again; reusing a vault factory would spend its paired nonce).
    function test_deploy_refusesTheObsoleteResumeInputs() public {
        vm.chainId(97);
        // never today's deployment files, even if the refusal were missing
        vm.setEnv("DEPLOYMENTS_FILE", "deployments/anvil-scripts-test.json");
        // the folder may be missing in a copy without deployment files (the ZIP for Flap)
        vm.createDir(string.concat(vm.projectRoot(), "/deployments"), true);
        vm.etch(0x5CfbE713d070e87F67D1bc84312B7eB8Fe4F2B5E, address(new MockAntiScam()).code);
        Deploy d = new Deploy();
        DeployToken t = new DeployToken();
        vm.setEnv("PILE_VAULT_FACTORY", "0x000000000000000000000000000000000000bEEF");
        vm.expectRevert(bytes("PILE_VAULT_FACTORY and PILE_VAULT_FACTORY_NONCE are obsolete: unset them (a stopped run: forge --resume, or deploy both again)"));
        d.run();
        vm.expectRevert(bytes("PILE_VAULT_FACTORY and PILE_VAULT_FACTORY_NONCE are obsolete: unset them (a stopped run: forge --resume, or deploy both again)"));
        t.run();
        vm.setEnv("PILE_VAULT_FACTORY", "");
        vm.setEnv("PILE_VAULT_FACTORY_NONCE", "3");
        vm.expectRevert(bytes("PILE_VAULT_FACTORY and PILE_VAULT_FACTORY_NONCE are obsolete: unset them (a stopped run: forge --resume, or deploy both again)"));
        d.run();
        vm.setEnv("PILE_VAULT_FACTORY_NONCE", "");
    }

    /// The deploy makes a matching pair: the vault factory names, as its only launcher factory, the one the script
    /// deploys right after it (Flap's pre-audit R3).
    function test_deploy_makesAMatchingPair() public {
        vm.chainId(97);
        vm.setEnv("DEPLOYMENTS_FILE", "deployments/anvil-scripts-test.json");
        // the folder may be missing in a copy without deployment files (the ZIP for Flap)
        vm.createDir(string.concat(vm.projectRoot(), "/deployments"), true);
        // the chain-97 anti-scam module, stood in for by a mock (the constructor requires code there)
        vm.etch(0x5CfbE713d070e87F67D1bc84312B7eB8Fe4F2B5E, address(new MockAntiScam()).code);
        Deploy d = new Deploy();
        d.run();
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/anvil-scripts-test.json"));
        PileVaultFactory pvf = PileVaultFactory(vm.parseJsonAddress(json, ".pileVaultFactory"));
        assertEq(pvf.pairedLauncherFactory(), vm.parseJsonAddress(json, ".curveLauncherFactory"));
        assertGt(pvf.beacon().code.length, 0, "the vault factory's beacon");
    }

    function test_tokenScripts_refuseOtherChains() public {
        DeployToken d = new DeployToken();
        CreateTokenSale c = new CreateTokenSale();
        TokenSale t = new TokenSale();
        uint64[3] memory ids = [uint64(56), 1, 31337];
        for (uint256 i; i < 3; ++i) {
            vm.chainId(ids[i]);
            vm.expectRevert(bytes("chain 97 only"));
            d.run();
            vm.expectRevert(bytes("chain 97 only"));
            c.run();
            vm.expectRevert(bytes("chain 97 only"));
            t.run();
        }
    }
}
