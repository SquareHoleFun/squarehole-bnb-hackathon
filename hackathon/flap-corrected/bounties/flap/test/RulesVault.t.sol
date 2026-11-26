// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {RulesVault} from "../src/RulesVault.sol";
import {PileVault} from "../src/PileVault.sol";
import {TokenPileVaultFactory} from "../src/TokenPileVaultFactory.sol";
import {RulesTokenCurveLauncherFactory} from "../src/RulesTokenCurveLauncherFactory.sol";
import {TokenCurveLauncherFactory} from "../src/TokenCurveLauncherFactory.sol";
import {DirectLaunchVaultFactoryBase} from "src/flap/DirectLaunchVaultFactoryBase.sol";
import {IPortalTypes} from "src/flap/IPortal.sol";
import {Distribution} from "src/flap/Distribution.sol";
import {MockToken20, MockAntiScam} from "./CurveLauncher.t.sol";
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
    RulesVaultFactory rvf;
    RulesTokenCurveLauncherFactory lf;

    MockAntiScam scam;

    function setUp() public {
        scam = new MockAntiScam();
        usd = new MockToken20();
        hub = new MockHubT(address(usd));
        router = new WethRouter(address(0xBB));
        rvf = new RulesVaultFactory(address(hub), address(usd), address(router), _nextAfterThis());
        lf = new RulesTokenCurveLauncherFactory(address(hub), address(rvf), TOKEN_IMPL, address(scam));
        assertEq(rvf.pairedLauncherFactory(), address(lf));
    }

    /// The CREATE address of this test's contract after the next one.
    function _nextAfterThis() internal view returns (address) {
        return vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
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
        TokenPileVaultFactory other = new TokenPileVaultFactory(address(hub), address(usd), _nextAfterThis());
        TokenCurveLauncherFactory oldPair = new TokenCurveLauncherFactory(address(hub), address(other), TOKEN_IMPL, address(scam));
        vm.expectRevert(abi.encodeWithSelector(RulesVaultFactory.NotPaired.selector, address(oldPair)));
        rvf.setRules(address(oldPair), bytes32(uint256(1)), _rules());
        // the paired factory is accepted, keyed to the Launcher it will give this caller
        address l = rvf.setRules(address(lf), bytes32(uint256(1)), _rules());
        assertEq(l, lf.predictLauncher(address(this), bytes32(uint256(1))));
        assertEq(rvf.rulesOf(l).length, 3);
    }

    /// R3: newVault refuses a launch whose caller the Portal did not record for the paired launcher factory.
    function test_newVault_refusesALauncherOfAnotherFactory() public {
        hub.setRecordedFactory(address(0xF0F0));
        bytes memory params = _launchParams();
        vm.prank(address(hub));
        vm.expectRevert(abi.encodeWithSelector(RulesVaultFactory.NotPaired.selector, address(0x1A)));
        rvf.newVault(address(0x7777), address(0x1A), 0, params);
        hub.setRecordedFactory(address(lf)); // the paired factory's Launcher: served
        vm.prank(address(hub));
        address v = rvf.newVault(address(0x7777), address(0x1A), 0, params);
        assertEq(rvf.vaultOf(address(0x7777)), v);
    }

    function _launchParams() internal view returns (bytes memory) {
        IPortalTypes.CreateTaxTokenParams memory p;
        p.quoteToken = address(usd);
        p.feeConfigs = new IPortalTypes.FeeConfig[](1);
        p.feeConfigs[0] = IPortalTypes.FeeConfig({
            feeType: IPortalTypes.FeeSlotType.VAULT,
            bps: 10_000,
            configData: abi.encode(IPortalTypes.FeeConfigVault({vaultFactory: address(rvf), vaultData: ""}))
        });
        p.exemptAddrs = new address[](0);
        Distribution memory d;
        return abi.encode(p, d);
    }

    function test_setRules_buyAndBurnMustBeLast() public {
        IRuleSplitter.Rule[] memory r = _rules(); // creator, pile, buy and burn
        (r[1], r[2]) = (r[2], r[1]); // the buy and burn before the pile
        vm.expectRevert(abi.encodeWithSelector(RulesVaultFactory.InvalidRules.selector, "the buy and burn goes last"));
        rvf.setRules(address(lf), bytes32(uint256(2)), r);
        rvf.setRules(address(lf), bytes32(uint256(2)), _rules()); // last: accepted
    }

    function test_constructor_refusesARouterThatCannotBuy() public {
        try new RulesVaultFactory(address(hub), address(usd), address(0x1234), address(this)) returns (RulesVaultFactory) {
            revert("a router without code was accepted");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(DirectLaunchVaultFactoryBase.ZeroAddress.selector));
        }
        MockHubT nativeHub = new MockHubT(address(0));
        WethRouter noWeth = new WethRouter(address(0));
        try new RulesVaultFactory(address(nativeHub), address(0), address(noWeth), address(this)) returns (RulesVaultFactory) {
            revert("a native router without WETH was accepted");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(DirectLaunchVaultFactoryBase.ZeroAddress.selector));
        }
        // and a native router with WETH is accepted
        new RulesVaultFactory(address(nativeHub), address(0), address(router), address(this));
        // and none without a paired launcher factory
        try new RulesVaultFactory(address(nativeHub), address(0), address(router), address(0)) returns (
            RulesVaultFactory
        ) {
            revert("a rules vault factory without a paired launcher factory was accepted");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(DirectLaunchVaultFactoryBase.ZeroAddress.selector));
        }
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
        address pile = LibClone.deployERC1967BeaconProxy(rvf.pileBeacon());
        PileVault(payable(pile)).initialize(address(tok), address(usd));
        IRuleSplitter.Rule[] memory r = _rules();
        r[1].target = pile;
        r[2].target = address(router);
        RulesVault v = RulesVault(payable(LibClone.deployERC1967BeaconProxy(rvf.beacon())));
        v.initialize(address(tok), address(usd), r);
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
