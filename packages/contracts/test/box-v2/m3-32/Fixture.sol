// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyRelease} from "../kit/RoyaltyRelease.sol";
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
import {FactoryLife, LifeCustody} from "../kit/FactoryLife.sol";
import {M132Dependency} from "../m1-32a/M132aBase.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {BoxRegistryV2} from "../../../src/box-v2/BoxRegistryV2.sol";
import {ListingRegistry} from "../../../src/box-v2/ListingRegistry.sol";
import {RoyaltyWeth} from "../cq11-c/RoyaltyRouter.t.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ShopConfigV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {MockDrandSource} from "../../box/items/BoxItemsKit.sol";

/// Real release and real PoolManager. Only assets, custody endpoints and swap actors are test fixtures.
abstract contract M332Base is FactoryLife {
    function setUp() public virtual override {
        vm.warp(1_000_000);
        vm.roll(100);
        vm.deal(CREATOR, 100 ether);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        release.factory = vm.computeCreateAddress(DEPLOYER, vm.getNonce(DEPLOYER));
        release.poolManager = address(pm);
        release.weth = address(new RoyaltyWeth());
        release.randomness = address(new MockDrandSource());
        registry =
            BoxRegistryV2(deployCode("BoxRegistryV2.sol:BoxRegistryV2", abi.encode(release.factory, new address[](0))));
        release.registry = address(registry);
        listings = ListingRegistry(
            deployCode(
                "ListingRegistry.sol:ListingRegistry",
                abi.encode(address(this), address(registry), address(pm), release.weth)
            )
        );
        release.listingRegistry = address(listings);
        fitSafe = address(new LifeCustody());
        conversionSafe = address(new M132Dependency());
        address ci = deployCode(_coordinatorCode(), abi.encode(pm, release.factory));
        release.implementations[0] = ci;
        release.implementations[1] = deployCode("BoxTokenV2.sol:BoxTokenV2", abi.encode(ci));
        address ext = deployCode(_extensionCode(), abi.encode(pm));
        release.implementations[2] = deployCode(_hookCode(), abi.encode(pm, ci, ext));
        release.implementations[3] = deployCode("BoxVaultV2.sol:BoxVaultV2", abi.encode(ci));
        release.implementations[4] = deployCode("BoxCollectionV2.sol:BoxCollectionV2", abi.encode(ci));
        release.implementations[5] =
            deployCode("BoxReceiverV2.sol:BoxReceiverV2", ReceiverDeploy.args(pm, ci, fitSafe, address(this)));
        release.implementations[6] = deployCode("BoxLaunchRouterV2.sol:BoxLaunchRouterV2", abi.encode(pm, ci));
        release.implementations[7] = deployCode("BoxTicketsV2.sol:BoxTicketsV2", abi.encode(ci));
        release.implementations[8] = deployCode("BoxRoyaltyRouterV2.sol:BoxRoyaltyRouterV2", abi.encode(RoyaltyRelease.config()));
        release.implementations[17] = deployCode("HolderLedgerV2.sol:HolderLedgerV2", abi.encode(pm));
        release.implementations[19] = deployCode("StarterSetLoaderV2.sol:StarterSetLoaderV2", abi.encode(ci));
        release.implementations[20] = deployCode("BoxTokenV2Ledger.sol:BoxTokenV2Ledger", abi.encode(ci));
        release.implementations[21] = deployCode("ShopVaultV2.sol:ShopVaultV2", abi.encode(pm, ci));
        release.implementations[16] = deployCode("ItemLedgerV2.sol:ItemLedgerV2", abi.encode(pm, ci));
        release.implementations[22] = deployCode("PileVaultV2.sol:PileVaultV2", abi.encode(ci));
        address validator = deployCode("BoxSpecV2Validator.sol:BoxSpecV2Validator");
        planner = BoxFactoryV2Planner(deployCode("BoxFactoryV2Planner.sol:BoxFactoryV2Planner", abi.encode(validator, deployCode("BoxFactoryV2Parts.sol:BoxFactoryV2Parts"))));
        address checks = deployCode("BoxFactoryV2Checks.sol:BoxFactoryV2Checks");
        vm.prank(DEPLOYER);
        factory =
            BoxFactoryV2(deployCode("BoxFactoryV2.sol:BoxFactoryV2", abi.encode(release, address(planner), checks)));
        assertEq(address(factory), release.factory);
        release.versionCodeHash = factory.versionCodeHash();
    }

    function _items(uint8 buyersPolicy, uint8 sellersPolicy) internal view returns (BoxSpec memory s) {
        s = _collectionSpec();
        if (buyersPolicy != 0) s.buyers.a = Branch(1, 8, "", abi.encode(buyersPolicy));
        if (sellersPolicy != 0) s.sellers.a = Branch(1, 8, "", abi.encode(sellersPolicy));
    }

    function _pile(address asset, uint256 seed) internal view returns (BoxSpec memory s) {
        s = _spec();
        s.boxType = 5;
        s.contentsParams = abi.encode(asset, seed);
    }

    function _coordinatorCode() internal pure virtual returns (string memory) { return "BoxCoordinatorV2.sol:BoxCoordinatorV2"; }
    function _hookCode() internal pure virtual returns (string memory) { return "BoxHookV2.sol:BoxHookV2"; }
    function _extensionCode() internal pure virtual returns (string memory) { return "BoxHookV2Extension.sol:BoxHookV2Extension"; }
}

/// S6 integration against exact local handoffs for unowned code, never a production-release proof.
/// The factory still constructs against its real pinned checker. Only tests replace that checker
/// afterwards; release-hash/provenance tests use M332Base without this substitution.
abstract contract M332IntegrationBase is M332Base {
    function setUp() public virtual override {
        super.setUp();
        address checker = deployCode("BoxFactoryV2ChecksM332Double.sol:BoxFactoryV2ChecksM332Double");
        vm.etch(address(factory.checks()), checker.code);
    }
    function _coordinatorCode() internal pure override returns (string memory) {
        return "BoxCoordinatorV2M332Double.sol:BoxCoordinatorV2M332Double";
    }
    function _hookCode() internal pure override returns (string memory) { return "BoxHookV2M332Double.sol:BoxHookV2M332Double"; }
    function _extensionCode() internal pure override returns (string memory) {
        return "BoxHookV2ExtensionM332Double.sol:BoxHookV2ExtensionM332Double";
    }
}
