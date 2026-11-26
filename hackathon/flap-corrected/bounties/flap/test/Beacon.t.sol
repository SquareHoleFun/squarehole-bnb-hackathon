// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPortalTypes} from "src/flap/IPortal.sol";
import {Distribution} from "src/flap/Distribution.sol";
import {DirectLaunchVaultFactoryBase} from "src/flap/DirectLaunchVaultFactoryBase.sol";
import {LaunchVaultAddresses} from "src/flap/LaunchVaultAddresses.sol";
import {UpgradeableBeacon} from "solady/utils/UpgradeableBeacon.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";
import {PileVault} from "../src/PileVault.sol";
import {PileVaultFactory} from "../src/PileVaultFactory.sol";
import {TokenPileVaultFactory} from "../src/TokenPileVaultFactory.sol";
import {RulesVault} from "../src/RulesVault.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {MockHub, MockToken20} from "./CurveLauncher.t.sol";
import {MockHubT} from "./TokenCurveLauncher.t.sol";
import {WethRouter} from "./RulesVault.t.sol";

/// @dev A next version of each vault: the same storage, a new release marker.
contract PileVaultV2 is PileVault {
    function version() external pure override returns (string memory) {
        return "pile-v2";
    }
}

contract RulesVaultV2 is RulesVault {
    function version() external pure override returns (string memory) {
        return "rules-v2";
    }
}

/// @dev A payee that refuses the native coin, so its part stays owed in the splitter.
contract Refuser {
    receive() external payable {
        revert("no");
    }
}

/// @notice R4 (Flap's pre-audit): every pile and every rule splitter is an ERC-1967 beacon proxy of its factory's beacon,
/// in the pattern of Flap's SplitVaultFactory / CrowdVaultFactory. Only Flap's Guardian upgrades; an upgrade keeps each
/// vault's balance, rules and owed amounts; neither an implementation nor a proxy can be initialized twice. The sale and
/// the redemption through the proxies run in the fork suites (CurvePile, TokenPile, RulesPile).
contract BeaconTest is Test {
    address guardian = LaunchVaultAddresses.guardian();
    MockHub hub;
    PileVaultFactory pvf;
    MockToken20 tok;

    function setUp() public {
        hub = new MockHub();
        hub.setRecordedFactory(address(this)); // this test stands in for the paired launcher factory
        pvf = new PileVaultFactory(address(hub), address(this));
        tok = new MockToken20();
    }

    function _params(address vf, address quote) internal pure returns (bytes memory) {
        IPortalTypes.CreateTaxTokenParams memory p;
        p.quoteToken = quote;
        p.feeConfigs = new IPortalTypes.FeeConfig[](1);
        p.feeConfigs[0] = IPortalTypes.FeeConfig({
            feeType: IPortalTypes.FeeSlotType.VAULT,
            bps: 10_000,
            configData: abi.encode(IPortalTypes.FeeConfigVault({vaultFactory: vf, vaultData: ""}))
        });
        p.exemptAddrs = new address[](0);
        Distribution memory d;
        return abi.encode(p, d);
    }

    function _pile() internal returns (PileVault v) {
        vm.prank(address(hub));
        v = PileVault(payable(pvf.newVault(address(tok), address(0x1A), 0, _params(address(pvf), address(0)))));
    }

    function test_pile_isABeaconProxyAtThePredictedAddress() public {
        PileVault v = _pile();
        assertEq(address(v), pvf.predictVault(address(tok), address(0)));
        assertEq(v.token(), address(tok));
        assertEq(v.asset(), address(0));
        assertEq(v.factory(), address(pvf));
        assertEq(v.version(), "pile-v1");
        assertEq(UpgradeableBeacon(pvf.beacon()).owner(), address(pvf), "the factory owns the beacon");
        // the ERC-1967 beacon slot of the proxy names the factory's beacon
        bytes32 slot = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
        assertEq(address(uint160(uint256(vm.load(address(v), slot)))), pvf.beacon());
    }

    function test_onlyTheGuardianUpgrades() public {
        address v2 = address(new PileVaultV2());
        vm.expectRevert(abi.encodeWithSelector(DirectLaunchVaultFactoryBase.NotGuardian.selector, address(this)));
        pvf.upgradeVaultImplementation(v2);
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(DirectLaunchVaultFactoryBase.NotGuardian.selector, address(0xBAD)));
        pvf.upgradeVaultImplementation(v2);
        // nobody upgrades the beacon around the factory either: the factory is its owner, and has no other path
        address beacon = pvf.beacon();
        vm.expectRevert(UpgradeableBeacon.Unauthorized.selector);
        UpgradeableBeacon(beacon).upgradeTo(v2);
        vm.prank(guardian);
        vm.expectRevert(UpgradeableBeacon.Unauthorized.selector);
        UpgradeableBeacon(beacon).upgradeTo(v2);
        vm.prank(guardian);
        vm.expectEmit(address(pvf));
        emit PileVaultFactory.FlapVaultImplementationUpgraded(v2);
        pvf.upgradeVaultImplementation(v2);
        assertEq(pvf.beaconImplementation(), v2);
    }

    function test_upgrade_keepsThePileAndItsCounters() public {
        PileVault v = _pile();
        vm.deal(address(v), 3 ether);
        tok.mint(address(0xA11CE), 1000 ether);
        // a first redemption before the upgrade, so the counters are not zero
        vm.startPrank(address(0xA11CE));
        tok.approve(address(v), 100 ether);
        uint256 first = v.redeem(100 ether, v.quoteRedeem(100 ether));
        vm.stopPrank();
        assertGt(first, 0);
        assertEq(v.totalTokensRedeemed(), 100 ether);
        assertEq(v.totalPaidOut(), first);
        uint256 pileBefore = v.pile();
        uint256 quoted = v.quoteRedeem(100 ether);
        address v2 = address(new PileVaultV2());
        vm.prank(guardian);
        pvf.upgradeVaultImplementation(v2);
        assertEq(v.version(), "pile-v2", "the proxy runs the new code");
        assertEq(v.pile(), pileBefore, "the pile is untouched");
        assertEq(v.totalTokensRedeemed(), 100 ether, "the counters are kept");
        assertEq(v.totalPaidOut(), first);
        assertEq(v.token(), address(tok));
        assertEq(v.factory(), address(pvf));
        assertEq(v.quoteRedeem(100 ether), quoted);
        // and a redemption still works through the upgraded proxy
        vm.startPrank(address(0xA11CE));
        tok.approve(address(v), 100 ether);
        uint256 out = v.redeem(100 ether, quoted);
        vm.stopPrank();
        assertEq(out, quoted);
        assertEq(address(0xA11CE).balance, first + quoted);
        assertEq(v.totalTokensRedeemed(), 200 ether);
        assertEq(v.totalPaidOut(), first + quoted);
    }

    function test_noSecondInitialization_implementationNeverInitialized() public {
        PileVault v = _pile();
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        v.initialize(address(tok), address(0));
        PileVault impl = PileVault(payable(pvf.beaconImplementation()));
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        impl.initialize(address(tok), address(0));
        assertEq(impl.token(), address(0), "the implementation holds no configuration");
    }

    function test_tokenPileFactory_guardianOnly() public {
        MockHubT h = new MockHubT(address(tok));
        TokenPileVaultFactory t = new TokenPileVaultFactory(address(h), address(tok), address(this));
        address v2 = address(new PileVaultV2());
        vm.expectRevert(abi.encodeWithSelector(DirectLaunchVaultFactoryBase.NotGuardian.selector, address(this)));
        t.upgradeVaultImplementation(v2);
        vm.prank(guardian);
        t.upgradeVaultImplementation(v2);
        assertEq(t.beaconImplementation(), v2);
        PileVault fresh = new PileVault(); // a new implementation is locked from its constructor
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        fresh.initialize(address(tok), address(0));
    }

    // ── the rules vault: two beacons (the splitter in the VAULT slot, and the pile it pays) ──

    function _rulesSetUp() internal returns (RulesVaultFactory rvf, RulesVault v, address payee) {
        MockHubT h = new MockHubT(address(0));
        h.setRecordedFactory(address(this));
        WethRouter router = new WethRouter(address(0xBB));
        rvf = new RulesVaultFactory(address(h), address(0), address(router), address(this));
        payee = address(new Refuser());
        IRuleSplitter.Rule[] memory r = new IRuleSplitter.Rule[](2);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 4000, target: payee});
        r[1] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.PILE, bps: 6000, target: address(0)});
        // the rules for the Launcher this test (standing in for the paired launcher factory) would give itself
        vm.mockCall(address(this), abi.encodeWithSignature("implementation()"), abi.encode(address(0x1)));
        address launcher = rvf.launcherFor(address(this), address(this), bytes32(uint256(7)));
        rvf.setRules(address(this), bytes32(uint256(7)), r);
        vm.prank(address(h));
        v = RulesVault(payable(rvf.newVault(address(tok), launcher, 0, _params(address(rvf), address(0)))));
    }

    function test_rulesVault_upgrade_keepsRulesAndOwed() public {
        (RulesVaultFactory rvf, RulesVault v, address payee) = _rulesSetUp();
        address pile = rvf.pileOf(address(tok));
        assertEq(v.factory(), address(rvf));
        assertEq(v.version(), "rules-v1");
        vm.deal(address(v), 1000);
        v.distribute(); // the creator refuses: 400 stays owed; the pile gets 600
        assertEq(v.owed(0), 400);
        assertEq(pile.balance, 600);
        address v2 = address(new RulesVaultV2());
        vm.expectRevert(abi.encodeWithSelector(DirectLaunchVaultFactoryBase.NotGuardian.selector, address(this)));
        rvf.upgradeVaultImplementation(v2);
        vm.prank(guardian);
        rvf.upgradeVaultImplementation(v2);
        assertEq(v.version(), "rules-v2");
        assertEq(v.owed(0), 400, "owed kept");
        assertEq(v.totalOwed(), 400);
        assertEq(address(v).balance, 400);
        (IRuleSplitter.Kind k, uint16 bps, address t) = v.rule(0);
        assertTrue(k == IRuleSplitter.Kind.CREATOR && bps == 4000 && t == payee, "rules kept");
        (k, bps, t) = v.rule(1);
        assertTrue(k == IRuleSplitter.Kind.PILE && bps == 6000 && t == pile);
        assertEq(v.token(), address(tok));
        // the implementation and the proxy refuse a second initialization
        IRuleSplitter.Rule[] memory none = new IRuleSplitter.Rule[](0);
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        v.initialize(address(tok), address(0), none);
        RulesVault impl = RulesVault(payable(rvf.beaconImplementation()));
        vm.expectRevert(bytes("Initializable: contract is already initialized"));
        impl.initialize(address(tok), address(0), none);
        // the pile's own beacon: Guardian only, and the pile keeps its money
        address p2 = address(new PileVaultV2());
        vm.expectRevert(abi.encodeWithSelector(DirectLaunchVaultFactoryBase.NotGuardian.selector, address(this)));
        rvf.upgradePileImplementation(p2);
        vm.prank(guardian);
        rvf.upgradePileImplementation(p2);
        assertEq(PileVault(payable(pile)).version(), "pile-v2");
        assertEq(PileVault(payable(pile)).pile(), 600);
        assertEq(rvf.pileBeaconImplementation(), p2);
    }

    /// The vault resolves its pile for Flap's vault UI: its own token gives the PILE rule's pile (the factory's record
    /// of the token's pile); any other token reverts WrongToken; rules without a PILE revert NoPileRule.
    function test_rulesVault_pileOf_resolvesThePile() public {
        (RulesVaultFactory rvf, RulesVault v,) = _rulesSetUp();
        assertEq(v.pileOf(address(tok)), rvf.pileOf(address(tok)));
        assertTrue(v.pileOf(address(tok)) != address(0));
        vm.expectRevert(abi.encodeWithSelector(RulesVault.WrongToken.selector, address(0xBEEF)));
        v.pileOf(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(RulesVault.WrongToken.selector, address(0)));
        v.pileOf(address(0));
        // a splitter whose rules name no pile
        RulesVault bare = RulesVault(payable(LibClone.deployERC1967BeaconProxy(rvf.beacon())));
        IRuleSplitter.Rule[] memory r = new IRuleSplitter.Rule[](1);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 10_000, target: address(0xC0FFEE)});
        bare.initialize(address(tok), address(0), r);
        vm.expectRevert(RulesVault.NoPileRule.selector);
        bare.pileOf(address(tok));
    }
}
