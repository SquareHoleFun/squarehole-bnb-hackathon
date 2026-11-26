// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../../box/conformance/core/CoreBox0Kit.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {FitBuybackExecutor} from "../../../src/box/FitBuybackExecutor.sol";
import {DrandSourcePins} from "../../../src/box/randomness/DrandSourcePins.sol";
import {BoxBackedSource} from "../../../src/box/randomness/BoxBackedSource.sol";
import {BackedSourcePins} from "../../../src/box/randomness/BackedSourcePins.sol";
import {BoxRegistryV2} from "../../../src/box-v2/BoxRegistryV2.sol";
import {ListingRegistry} from "../../../src/box-v2/ListingRegistry.sol";
import {
    IListingRegistry,
    ListingClass,
    ListingKind,
    ListingRefusal
} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {WBox0Read, CQ11WDeploymentFixture} from "../m1-64/CQ11WDeployment.t.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {DeployCoreV2} from "../../../script/DeployCoreV2.s.sol";

/// A custody endpoint, not a signature/threshold simulation. The bot's co-signing is an off-chain seam.
contract SeamCustody {
    receive() external payable {}

    function fund(FitBuybackExecutor executor, uint256 amount) external {
        executor.fundBudget{value: amount}();
    }

    function burn(BoxToken token, uint256 amount) external {
        token.burn(amount);
    }
}

/// M202-BOX0-A/B/E: exercise the surviving v1 entry points on a factory-created real genesis box.
contract M2Box0SeamsTest is Test {
    CoreBox0Kit private kit;
    CoreBoxAddresses private a;

    function setUp() public {
        kit = new CoreBox0Kit();
        kit.setUpWorld();
        string memory json = vm.readFile("test/vectors/box-spec/box-spec-v1.json");
        BoxSpecV1.BoxSpec memory s = abi.decode(vm.parseJsonBytes(json, ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        s.raise = BoxSpecV1.qListV1()[0].raisePresets[0];
        kit.build(s);
        a = kit.addresses();
    }

    function test_seamA_custodyFundsGraduatedExecutorAndBurnsOnlyItsOwnFit() public {
        SeamCustody safe = new SeamCustody();
        vm.deal(address(safe), 1 ether);
        FitBuybackExecutor executor = FitBuybackExecutor(payable(a.executor));
        assertFalse(BoxCoordinator(a.coordinator).graduated());
        assertEq(address(safe).balance, 1 ether, "bot policy holds before graduation");
        kit.toGraduated();
        assertTrue(BoxCoordinator(a.coordinator).graduated());
        uint256 budget = executor.budget();
        safe.fund(executor, 1 ether);
        assertEq(executor.budget() - budget, 1 ether);
        assertEq(address(safe).balance, 0);
        BoxToken fit = BoxToken(a.token);
        uint256 amount = fit.balanceOf(kit.alice()) / 10;
        assertGt(amount, 0);
        vm.prank(kit.alice());
        fit.transfer(address(safe), amount);
        uint256 supply = fit.totalSupply();
        safe.burn(fit, amount);
        assertEq(fit.totalSupply(), supply - amount);
        assertEq(fit.balanceOf(address(safe)), 0);
    }

    function test_seamB_realFitUsesEarlierRegistryAndOnePermanentListing() public {
        address[] memory earlier = new address[](1);
        earlier[0] = kit.impls().registry;
        BoxRegistryV2 registry =
            BoxRegistryV2(deployCode("BoxRegistryV2.sol:BoxRegistryV2", abi.encode(address(this), earlier)));
        ListingRegistry listings = ListingRegistry(
            deployCode(
                "ListingRegistry.sol:ListingRegistry", abi.encode(a.platform, address(registry), a.poolManager, a.weth)
            )
        );
        assertEq(registry.directory()[0], earlier[0]);
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.ListingRefused.selector, ListingRefusal.NOT_GRADUATED));
        vm.prank(a.platform);
        listings.add(a.token, ListingClass.STANDARD, 1e18);
        kit.toGraduated();
        uint256 supply = BoxToken(a.token).totalSupply();
        vm.prank(a.platform);
        uint32 id = listings.add(a.token, ListingClass.STANDARD, 1e18);
        assertEq(uint256(listings.listing(id).kind), uint256(ListingKind.BOX_TOKEN));
        assertEq(listings.listing(id).token, a.token);
        vm.expectRevert(abi.encodeWithSelector(IListingRegistry.AlreadyListed.selector, a.token, id));
        vm.prank(a.platform);
        listings.add(a.token, ListingClass.STANDARD, 2e18);
        vm.prank(a.platform);
        listings.updateRaise(id, 2e18);
        assertEq(listings.listing(id).raise, 2e18);
        assertEq(BoxToken(a.token).totalSupply(), supply);
        assertEq(BoxToken(a.token).balanceOf(address(listings)), 0);
    }

    function test_seamE_realPlatformEpochKeepsItsThirtyDayBoundary() public {
        BoxReceiver receiver = BoxReceiver(payable(a.receiver));
        assertEq(receiver.platformSafe(), a.platform);
        (uint256 epoch, uint256 kept, uint256 remaining) = receiver.platformEpoch();
        assertEq(epoch, 0);
        assertEq(kept, 0);
        assertEq(remaining, BoxSpecV1.PLATFORM_CAP_WEI);
        kit.toGraduated();
        (epoch, kept, remaining) = receiver.platformEpoch();
        assertEq(epoch, 0);
        assertGt(kept, 0);
        assertEq(kept + remaining, BoxSpecV1.PLATFORM_CAP_WEI);
        uint256 graduated = BoxCoordinator(a.coordinator).graduatedAt();
        vm.warp(graduated + 30 days - 1);
        (epoch,,) = receiver.platformEpoch();
        assertEq(epoch, 0);
        vm.warp(graduated + 30 days);
        (epoch, kept, remaining) = receiver.platformEpoch();
        assertEq(epoch, 1);
        assertEq(kept, 0);
        assertEq(remaining, BoxSpecV1.PLATFORM_CAP_WEI);
        // F143: box 0's source is the pinned BoxBackedSource, naming the pinned DrandSource.
        assertTrue(BackedSourcePins.isPinned(a.randomness));
        assertTrue(DrandSourcePins.isPinned(address(BoxBackedSource(a.randomness).DRAND())));
    }
}

/// M202-BOX0-C/D/E + CQ11-W: one concrete test owns all CORE_V2_* setup, refusals and deployment.
/// The abstract CQ11 fixture uses SafeProxyFixture with WSafe logic; it does not certify real signatures.
contract M2DeploymentSeamsTest is CQ11WDeploymentFixture {
    function test_seamsCDE_deploymentRequiresBox0AndSharesPinnedSourceAndPlatform() public {
        uint64 nonce = vm.getNonce(DEPLOYER);
        _env("CORE_V2_V1_REGISTRY", address(0xBAD));
        vm.expectRevert(DeployCoreV2.MissingBox0.selector);
        script.run();
        assertEq(vm.getNonce(DEPLOYER), nonce);
        // A valid registry cannot authorize a different genesis coordinator. Refuse before CREATE.
        _env("CORE_V2_V1_REGISTRY", address(box0));
        _env("CORE_V2_BOX0", address(fit));
        vm.expectRevert(DeployCoreV2.MissingBox0.selector);
        script.run();
        assertEq(vm.getNonce(DEPLOYER), nonce);
        _env("CORE_V2_BOX0", address(box0));
        WBox0Read wrongSource = new WBox0Read(address(platform), manager, address(fit), weth, address(fit));
        _env("CORE_V2_V1_REGISTRY", address(wrongSource));
        _env("CORE_V2_BOX0", address(wrongSource));
        vm.expectRevert(DeployCoreV2.BadReleaseInput.selector);
        script.run();
        assertEq(vm.getNonce(DEPLOYER), nonce);
        _env("CORE_V2_V1_REGISTRY", address(box0));
        _env("CORE_V2_BOX0", address(box0));
        (BoxFactoryV2 factory, string memory manifest) = _assertDeploymentPreflightAndRealManifest();
        // F143: box 0 reads its BoxBackedSource; core v2 stays drand-only, on the DrandSource that source names (a box 0
        // stand-in that names the DrandSource itself is taken as it is, as DeployCoreV2 does).
        address box0Source = box0.randomness();
        assertEq(
            factory.randomness(),
            BackedSourcePins.isPinned(box0Source) ? address(BoxBackedSource(box0Source).DRAND()) : box0Source
        );
        assertTrue(DrandSourcePins.isPinned(factory.randomness()));
        assertEq(BoxRegistryV2(factory.registry()).directory()[0], address(box0));
        assertEq(ListingRegistry(factory.listingRegistry()).lister(), box0.platformSafe());
        assertEq(BoxReceiverV2(factory.implementation(5)).PLATFORM_SAFE(), box0.platformSafe());
        assertEq(vm.parseJsonAddress(manifest, ".randomness"), factory.randomness());
    }
}
