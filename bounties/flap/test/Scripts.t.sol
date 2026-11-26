// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {CreateSale} from "../script/CreateSale.s.sol";
import {Sale} from "../script/Sale.s.sol";
import {PileVaultFactory} from "../src/PileVaultFactory.sol";
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

    /// A resumed deploy accepts only the sender's own PileVaultFactory of this build, at the nonce it was made.
    function test_deploy_resume_verifiesTheFirstFactory() public {
        address portal = 0x000042108465206185A077Edc3F3fd2b49060000;
        vm.chainId(97);
        vm.setEnv("DEPLOYMENTS_FILE", "deployments/anvil-scripts-test.json");
        Deploy d = new Deploy();
        // the script's msg.sender is this test; its next nonce makes the reference factory
        uint64 n = vm.getNonce(address(this));
        PileVaultFactory mine = new PileVaultFactory(portal);
        vm.setEnv("PILE_VAULT_FACTORY", vm.toString(address(mine)));

        vm.setEnv("PILE_VAULT_FACTORY_NONCE", vm.toString(uint256(n) + 1)); // wrong nonce
        vm.expectRevert(bytes("PILE_VAULT_FACTORY is not the sender's at that nonce"));
        d.run();

        uint64 m = vm.getNonce(address(this));
        PileVaultFactory other = new PileVaultFactory(address(0xBEEF)); // the sender's, but not for this Portal
        vm.setEnv("PILE_VAULT_FACTORY", vm.toString(address(other)));
        vm.setEnv("PILE_VAULT_FACTORY_NONCE", vm.toString(uint256(m)));
        vm.expectRevert(bytes("PILE_VAULT_FACTORY's code is not this build's"));
        d.run();

        vm.setEnv("PILE_VAULT_FACTORY", vm.toString(address(mine)));
        vm.setEnv("PILE_VAULT_FACTORY_NONCE", vm.toString(uint256(n)));
        d.run(); // accepted: only the launcher factory is deployed
        vm.setEnv("PILE_VAULT_FACTORY", "0x0000000000000000000000000000000000000000");
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
