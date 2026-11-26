// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {RulesVault} from "../src/RulesVault.sol";
import {PileDeployer, RulesVaultDeployer} from "../src/RulesDeployers.sol";
import {PileVault} from "../src/PileVault.sol";
import {TokenPileVaultFactory} from "../src/TokenPileVaultFactory.sol";
import {RulesTokenCurveLauncherFactory} from "../src/RulesTokenCurveLauncherFactory.sol";
import {TokenCurveLauncherFactory} from "../src/TokenCurveLauncherFactory.sol";
import {DirectLaunchVaultFactoryBase} from "src/flap/DirectLaunchVaultFactoryBase.sol";
import {MockToken20} from "./CurveLauncher.t.sol";
import {MockHubT} from "./TokenCurveLauncher.t.sol";

contract WethRouter {
    address public WETH;

    constructor(address w) {
        WETH = w;
    }
}

/// @notice The rules factory, vault and deployers without a chain: who may call, pairing, router checks, the
/// record before a launch, the vault's description.
contract RulesVaultTest is Test {
    address constant TOKEN_IMPL = address(0x7777c57ff7dc441c1715b2e36fa581c48B782222);
    MockToken20 usd;
    MockHubT hub;
    WethRouter router;
    PileDeployer pd;
    RulesVaultDeployer rd;
    RulesVaultFactory rvf;
    RulesTokenCurveLauncherFactory lf;

    function setUp() public {
        usd = new MockToken20();
        hub = new MockHubT(address(usd));
        router = new WethRouter(address(0xBB));
        pd = new PileDeployer();
        rd = new RulesVaultDeployer();
        rvf = new RulesVaultFactory(address(hub), address(usd), address(router), pd, rd);
        lf = new RulesTokenCurveLauncherFactory(address(hub), address(rvf), TOKEN_IMPL);
    }

    function _rules() internal pure returns (IRuleSplitter.Rule[] memory r) {
        r = new IRuleSplitter.Rule[](3);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 2000, target: address(0xC0FFEE)});
        r[1] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.PILE, bps: 5000, target: address(0)});
        r[2] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.BUY_BURN, bps: 3000, target: address(0)});
    }

    function test_newVault_onlyTheHub() public {
        vm.expectRevert(abi.encodeWithSelector(DirectLaunchVaultFactoryBase.NotHub.selector, address(this)));
        rvf.newVault(address(0x7777), address(this), 0, "");
    }

    function test_setRules_unpairedLauncherFactory_refused() public {
        TokenPileVaultFactory other = new TokenPileVaultFactory(address(hub), address(usd));
        TokenCurveLauncherFactory oldPair = new TokenCurveLauncherFactory(address(hub), address(other), TOKEN_IMPL);
        vm.expectRevert(abi.encodeWithSelector(RulesVaultFactory.NotPaired.selector, address(oldPair)));
        rvf.setRules(address(oldPair), bytes32(uint256(1)), _rules());
        // the paired factory is accepted, keyed to the Launcher it will give this caller
        address l = rvf.setRules(address(lf), bytes32(uint256(1)), _rules());
        assertEq(l, lf.predictLauncher(address(this), bytes32(uint256(1))));
        assertEq(rvf.rulesOf(l).length, 3);
    }

    function test_setRules_buyAndBurnMustBeLast() public {
        IRuleSplitter.Rule[] memory r = _rules(); // creator, pile, buy and burn
        (r[1], r[2]) = (r[2], r[1]); // the buy and burn before the pile
        vm.expectRevert(abi.encodeWithSelector(RulesVaultFactory.InvalidRules.selector, "the buy and burn goes last"));
        rvf.setRules(address(lf), bytes32(uint256(2)), r);
        rvf.setRules(address(lf), bytes32(uint256(2)), _rules()); // last: accepted
    }

    function test_constructor_refusesARouterThatCannotBuy() public {
        try new RulesVaultFactory(address(hub), address(usd), address(0x1234), pd, rd) returns (RulesVaultFactory) {
            revert("a router without code was accepted");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(DirectLaunchVaultFactoryBase.ZeroAddress.selector));
        }
        MockHubT nativeHub = new MockHubT(address(0));
        WethRouter noWeth = new WethRouter(address(0));
        try new RulesVaultFactory(address(nativeHub), address(0), address(noWeth), pd, rd) returns (RulesVaultFactory) {
            revert("a native router without WETH was accepted");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(DirectLaunchVaultFactoryBase.ZeroAddress.selector));
        }
        // and a native router with WETH is accepted
        new RulesVaultFactory(address(nativeHub), address(0), address(router), pd, rd);
    }

    function test_predictVault_beforeTheLaunch_isZero() public view {
        assertEq(rvf.predictVault(address(0x7777)), address(0));
        assertEq(rvf.predictVault(address(0x7777), address(0)), address(0));
        assertEq(rvf.pileOf(address(0x7777)), address(0));
        IRuleSplitter.Rule[] memory d = rvf.rulesOf(address(0xABCD));
        assertEq(d.length, 1, "no rules set: PILE 100%");
        assertTrue(d[0].kind == IRuleSplitter.Kind.PILE && d[0].bps == 10_000);
    }

    function test_vaultDescription_namesEveryRule() public {
        MockToken20 tok = new MockToken20();
        address pile = pd.deploy(address(tok), address(usd));
        IRuleSplitter.Rule[] memory r = _rules();
        r[1].target = pile;
        r[2].target = address(router);
        RulesVault v = RulesVault(payable(rd.deploy(address(tok), address(usd), r)));
        assertEq(v.factory(), address(this), "the vault records who asked for it");
        string memory d = v.description();
        assertTrue(_contains(d, "2000 bps to creator"));
        assertTrue(_contains(d, "5000 bps to pile"));
        assertTrue(_contains(d, "3000 bps to buy and burn"));
        assertEq(PileVault(payable(pile)).token(), address(tok));
    }

    function _contains(string memory h, string memory n) internal pure returns (bool) {
        bytes memory hb = bytes(h);
        bytes memory nb = bytes(n);
        if (nb.length > hb.length) return false;
        for (uint256 i; i <= hb.length - nb.length; ++i) {
            bool m = true;
            for (uint256 j; j < nb.length && m; ++j) {
                if (hb[i + j] != nb[j]) m = false;
            }
            if (m) return true;
        }
        return false;
    }
}
