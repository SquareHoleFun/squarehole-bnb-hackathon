// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyCowConfig} from "../../../src/box-v2/interfaces/IRoyaltyCow.sol";
import {RoyaltyRelease} from "../kit/RoyaltyRelease.sol";
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";
import {BoxFactoryV2Planner} from "../../../src/box-v2/BoxFactoryV2Planner.sol";
import {BoxRegistryV2} from "../../../src/box-v2/BoxRegistryV2.sol";
import {ListingRegistry} from "../../../src/box-v2/ListingRegistry.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {Side} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {RoyaltyWeth} from "../cq11-c/RoyaltyRouter.t.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";

/// Local dependency only: Safe and randomness read checks are exercised by the deploy suite.
contract M132Dependency {}

abstract contract M132aBase is Test {
    IPoolManager internal pm;
    BoxFactoryV2 internal factory;
    BoxFactoryV2Planner internal planner;
    BoxRegistryV2 internal registry;
    ListingRegistry internal listings;
    BoxFactoryV2Planner.Release internal release;
    address internal constant DEPLOYER = address(0xD310);
    address internal constant CREATOR = address(0xCA11);
    address internal fitSafe;
    address internal conversionSafe;

    function setUp() public virtual {
        _startClock();
        vm.deal(CREATOR, 100 ether);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        release.factory = vm.computeCreateAddress(DEPLOYER, vm.getNonce(DEPLOYER));
        release.poolManager = address(pm);
        release.weth = _releaseWeth();
        release.randomness = _releaseRandomness();
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
        fitSafe = address(new M132Dependency());
        conversionSafe = address(new M132Dependency());
        address ci = deployCode("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(pm, release.factory));
        release.implementations[0] = ci;
        release.implementations[1] = deployCode("BoxTokenV2.sol:BoxTokenV2", abi.encode(ci));
        address ext = deployCode("BoxHookV2Extension.sol:BoxHookV2Extension", abi.encode(pm));
        release.implementations[2] = deployCode("BoxHookV2.sol:BoxHookV2", abi.encode(pm, ci, ext));
        release.implementations[3] = deployCode("BoxVaultV2.sol:BoxVaultV2", abi.encode(ci));
        release.implementations[4] = deployCode("BoxCollectionV2.sol:BoxCollectionV2", abi.encode(ci));
        release.implementations[5] =
            deployCode("BoxReceiverV2.sol:BoxReceiverV2", ReceiverDeploy.args(pm, ci, fitSafe, address(this)));
        release.implementations[6] = deployCode("BoxLaunchRouterV2.sol:BoxLaunchRouterV2", abi.encode(pm, ci));
        release.implementations[7] = deployCode("BoxTicketsV2.sol:BoxTicketsV2", abi.encode(ci));
        release.implementations[8] = deployCode("BoxRoyaltyRouterV2.sol:BoxRoyaltyRouterV2", abi.encode(_royaltyConfig()));
        address validator = deployCode("BoxSpecV2Validator.sol:BoxSpecV2Validator");
        planner = BoxFactoryV2Planner(deployCode("BoxFactoryV2Planner.sol:BoxFactoryV2Planner", abi.encode(validator, deployCode("BoxFactoryV2Parts.sol:BoxFactoryV2Parts"))));
        address checks = deployCode("BoxFactoryV2Checks.sol:BoxFactoryV2Checks");
        vm.prank(DEPLOYER);
        factory =
            BoxFactoryV2(deployCode("BoxFactoryV2.sol:BoxFactoryV2", abi.encode(release, address(planner), checks)));
        assertEq(address(factory), release.factory);
        release.versionCodeHash = factory.versionCodeHash();
    }

    function _releaseWeth() internal virtual returns (address) { return address(new RoyaltyWeth()); }
    function _releaseRandomness() internal virtual returns (address) { return address(new M132Dependency()); }
    function _startClock() internal virtual { vm.warp(1_000_000); vm.roll(100); }
    function _royaltyConfig() internal virtual returns (RoyaltyCowConfig memory) { return RoyaltyRelease.config(); }

    function _spec() internal view returns (BoxSpec memory s) {
        s.format = 2;
        s.version = 2;
        s.boxType = 3;
        s.tokenName = "CQ11 token";
        s.tokenSymbol = "CQ11";
        s.raise = listings.listing(0).raise;
        s.layout = 1;
        s.gradLayout = 3;
        s.launchFormat = 1;
        s.deadlineDays = 30;
        s.buyers.split = 1;
        s.buyers.a.leg = 2;
        s.buyers.a.dest = 1;
        s.sellers = abi.decode(abi.encode(s.buyers), (Side));
        s.coverSha256 = bytes32(uint256(1));
    }

    function _salts(BoxSpec memory s) internal view returns (bytes32 cs, bytes32 hs) {
        address c;
        address t;
        bytes32 initHash;
        for (uint256 i;; ++i) {
            cs = bytes32(i);
            (c, t, initHash) = factory.predictBox(CREATOR, s, cs);
            if (t > s.pricing.token && t < factory.tokenAddressLimit(s.pricing.token)) break;
        }
        for (uint256 i;; ++i) {
            hs = bytes32(i);
            address h = BoxClones.predict(c, hs, initHash);
            if (uint160(h) & 0x3fff == 0x2ae0 && uint160(h) >> 152 != 0x91) break;
        }
    }

    function _create(BoxSpec memory s) internal returns (BoxCoordinatorV2 box) {
        (bytes32 cs, bytes32 hs) = _salts(s);
        uint256 value = s.pricing.token == address(0)
            ? factory.boxQParameters(s.pricing.listingId, s.raise).bootstrapQ + s.creatorBuy
            : 0;
        vm.prank(CREATOR);
        (, address c,) = factory.createBox{value: value}(s, cs, hs);
        box = BoxCoordinatorV2(c);
    }

    function _collectionSpec() internal view returns (BoxSpec memory s) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/box-spec/box-spec-v1.json"));
        assertEq(vm.parseJsonString(json, ".columns.name[2]"), "demo third-party box with open art", "vector 2");
        BoxSpecV1.BoxSpec memory v = abi.decode(vm.parseJsonBytes(json, ".columns.encoded[2]"), (BoxSpecV1.BoxSpec));
        s = _spec();
        s.boxType = 1;
        (s.tokenName, s.tokenSymbol, s.collectionName, s.collectionSymbol) =
        (v.tokenName, v.tokenSymbol, v.collectionName, v.collectionSymbol);
        (s.n, s.firstId, s.artMode, s.revealRoot, s.metadataTable) =
        (v.n, v.firstId, v.artMode, v.revealRoot, v.metadataTable);
        (s.generatorHash, s.coverSha256, s.revealListId) = (v.generatorHash, v.coverSha256, v.revealListId);
        (s.marketplaceOwner, s.collectionCoverSha256) = (v.marketplaceOwner, v.collectionCoverSha256);
        s.deadlineDays = 90;
        s.pickFeeBps = uint16(BoxSpecV1.PICK_FEE_BPS);
    }

    function _hiddenSpec() internal view returns (BoxSpec memory s) {
        s = _collectionSpec();
        s.artMode = 2;
        s.revealListId = 0;
        s.addOns = new AddOn[](2);
        s.addOns[0] =
            AddOn(1, abi.encode("Tickets", "TKT", "Draw", "Hidden", '<svg xmlns="http://www.w3.org/2000/svg"></svg>'));
        s.addOns[1] = AddOn(4, abi.encode(uint16(500), uint8(1)));
        s.creatorFeeRecipient = CREATOR;
    }

    function _coldRelease() internal {
        ReceiverDeploy.cool(release.implementations[5]);
        for (uint256 i; i < 9; ++i) {
            vm.cool(release.implementations[i]);
        }
        vm.cool(address(pm));
        vm.cool(address(factory));
        vm.cool(address(planner));
        vm.cool(address(planner.parts()));
        vm.cool(address(planner.validator()));
        vm.cool(address(factory.checks()));
        vm.cool(address(registry));
        vm.cool(address(listings));
        vm.cool(address(factory));
        vm.cool(address(planner));
    }
}
