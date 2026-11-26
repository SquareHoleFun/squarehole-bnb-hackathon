// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxRegistryV2} from "../../../src/box-v2/BoxRegistryV2.sol";
import {ListingRegistry} from "../../../src/box-v2/ListingRegistry.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {SetFactoryV2Planner} from "../../../src/box-v2/set/SetFactoryV2Planner.sol";
import {SetReleaseV2} from "../../../src/box-v2/set/SetReleaseV2.sol";
import {SetSpecV2} from "../../../src/box-v2/set/SetTypesV2.sol";
import {SetConstantsV2 as C} from "../../../src/box-v2/set/SetConstantsV2.sol";
import {QParameters, ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
import {HostileERC721} from "./fixtures/HostileERC721.sol";
import {HostileToken} from "../kit/HostileToken.sol";

interface ISetPlannerQueries {
    function refusal(SetReleaseV2 calldata r, address creator, SetSpecV2 calldata s)
        external
        view
        returns (bytes memory);
    function predictHook(SetReleaseV2 calldata r, address creator, SetSpecV2 calldata s, bytes32 cs, bytes32 hs)
        external
        view
        returns (address);
}

interface ISetFactory {
    function refusal(SetSpecV2 calldata s, address creator) external view returns (bytes memory);
    function createBox(SetSpecV2 calldata s, bytes32 cs, bytes32 hs)
        external
        payable
        returns (uint256, address, address);
    function predictBox(address creator, SetSpecV2 calldata s, bytes32 cs)
        external
        view
        returns (address, address, bytes32);
    function predictHook(address creator, SetSpecV2 calldata s, bytes32 cs, bytes32 hs) external view returns (address);
    function tokenAddressLimit(address p) external pure returns (address);
    function boxQParameters(uint32 id, uint256 raise) external view returns (QParameters memory);
    function versionCodeHash() external view returns (bytes32);
    function isPileVault(address candidate) external pure returns (bool);
    function implementation(uint256 role) external view returns (address);
}

contract SetSafeFixture {
    receive() external payable {}
}

abstract contract SetReleaseFixture is Test {
    address internal constant DEPLOYER = address(0xD310);
    address internal constant CREATOR = address(0xCA11);
    ISetFactory internal factory;
    SetFactoryV2Planner internal planner;
    address internal checks;
    SetReleaseV2 internal release;
    BoxRegistryV2 internal registry;
    BoxRegistryV2 internal oldRegistry;
    ListingRegistry internal listings;
    HostileERC721 internal nft;
    bytes32 internal root;
    address internal extension;
    uint256 internal beforeFactory;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.roll(100);
        vm.deal(CREATOR, 100 ether);
        release.factory = vm.computeCreateAddress(DEPLOYER, vm.getNonce(DEPLOYER));
        release.poolManager = deployCode("PoolManager.sol:PoolManager", abi.encode(address(this)));
        release.weth = address(new HostileToken("Wrapped", "W", 18));
        release.fitSafe = address(new SetSafeFixture());
        release.platformSafe = address(this);
        oldRegistry = new BoxRegistryV2(address(0xBEEF), new address[](0));
        address[] memory directory = new address[](1);
        directory[0] = address(oldRegistry);
        registry = new BoxRegistryV2(release.factory, directory);
        release.registry = address(registry);
        listings = ListingRegistry(
            deployCode(
                "ListingRegistry.sol:ListingRegistry",
                abi.encode(release.platformSafe, address(registry), release.poolManager, release.weth)
            )
        );
        release.listingRegistry = address(listings);
        address ci =
            deployCode("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(release.poolManager, release.factory));
        release.implementations[0] = ci;
        release.implementations[1] = deployCode("BoxTokenV2.sol:BoxTokenV2", abi.encode(ci));
        extension = deployCode("BoxHookV2Extension.sol:BoxHookV2Extension", abi.encode(release.poolManager));
        release.implementations[2] =
            deployCode("BoxHookV2.sol:BoxHookV2", abi.encode(release.poolManager, ci, extension));
        release.implementations[19] = deployCode("StarterSetLoaderV2.sol:StarterSetLoaderV2", abi.encode(ci));
        release.implementations[3] =
            deployCode("SetVaultV2.sol:SetVaultV2", abi.encode(ci, release.implementations[19]));
        release.implementations[5] = deployCode(
            "BoxReceiverV2.sol:BoxReceiverV2",
            ReceiverDeploy.args(IPoolManager(release.poolManager), ci, release.fitSafe, release.platformSafe)
        );
        release.implementations[6] =
            deployCode("BoxLaunchRouterV2.sol:BoxLaunchRouterV2", abi.encode(release.poolManager, ci));
        planner = SetFactoryV2Planner(
            deployCode(
                "SetFactoryV2Planner.sol:SetFactoryV2Planner",
                abi.encode(
                    deployCode("SetSpecV2Validator.sol:SetSpecV2Validator"),
                    deployCode("BoxFactoryV2Parts.sol:BoxFactoryV2Parts")
                )
            )
        );
        checks = deployCode("SetFactoryV2Checks.sol:SetFactoryV2Checks");
        _pin();
        beforeFactory = vm.snapshotState();
        factory = ISetFactory(_deployFactory(release));
        assertEq(address(factory), release.factory);
        nft = new HostileERC721();
        for (uint256 i = 10; i != 0;) {
            --i;
            root = keccak256(abi.encode(address(nft), i * 101, uint8(0), root));
            nft.mint(CREATOR, i * 101);
        }
    }

    function _pin() internal {
        for (uint256 i; i < 24; ++i) {
            address part = release.implementations[i];
            if (part != address(0)) release.implementationHashes[i] = part.codehash;
        }
        address[13] memory deps = _dependencies();
        for (uint256 i; i < deps.length; ++i) {
            release.dependencyHashes[i] = deps[i].codehash;
        }
        release.plannerHash = address(planner).codehash;
        address[] memory directory = registry.directory();
        bytes32[] memory hashes = new bytes32[](directory.length);
        for (uint256 i; i < directory.length; ++i) {
            hashes[i] = directory[i].codehash;
        }
        release.directoryHash = keccak256(abi.encode(directory, hashes));
    }

    function _dependencies() internal view returns (address[13] memory d) {
        d[0] = address(registry);
        d[1] = address(listings);
        d[2] = release.poolManager;
        d[3] = release.weth;
        d[4] = extension;
        d[5] = vm.computeCreateAddress(release.implementations[0], 1);
        (d[6], d[7], d[8]) = BoxReceiverV2(payable(release.implementations[5])).receiverCode();
        for (uint8 i; i < 4; ++i) {
            (d[9 + i],) = BoxReceiverV2(payable(release.implementations[5])).feeModule(i + 6);
        }
    }

    function _deployFactory(SetReleaseV2 memory r) internal returns (address) {
        vm.prank(DEPLOYER);
        return deployCode("SetFactoryV2.sol:SetFactoryV2", abi.encode(r, address(planner), checks));
    }

    function _spec() internal view returns (SetSpecV2 memory s) {
        s.format = C.FORMAT;
        s.schema = C.SCHEMA;
        s.release = C.RELEASE;
        s.tokenName = "Existing set";
        s.tokenSymbol = "SET";
        s.raise = listings.listing(0).raise;
        s.deadlineDays = 30;
        s.collection = address(nft);
        s.count = 10;
        s.setHash = root;
        s.pickFeeBps = 500;
        s.description = "Only the committed set";
        s.logoSha256 = keccak256("logo");
    }

    function _salts(SetSpecV2 memory s) internal view returns (bytes32 cs, bytes32 hs) {
        address c;
        address t;
        bytes32 h;
        for (uint256 i;; ++i) {
            cs = bytes32(i);
            (c, t, h) = factory.predictBox(CREATOR, s, cs);
            if (t > s.pricing.token && t < factory.tokenAddressLimit(s.pricing.token)) break;
        }
        for (uint256 i;; ++i) {
            hs = bytes32(i);
            address hook = BoxClones.predict(c, hs, h);
            if (uint160(hook) & 0x3fff == 0x2ae0 && uint160(hook) >> 152 != 0x91) break;
        }
    }

    function _create(SetSpecV2 memory s) internal returns (BoxCoordinatorV2 c) {
        (bytes32 cs, bytes32 hs) = _salts(s);
        uint256 payment = factory.boxQParameters(s.pricing.listingId, s.raise).bootstrapQ + s.creatorBuy;
        vm.prank(CREATOR);
        (, address a,) = factory.createBox{value: s.pricing.token == address(0) ? payment : 0}(s, cs, hs);
        return BoxCoordinatorV2(a);
    }

    function _pricing() internal returns (SetSpecV2 memory s, HostileToken p) {
        s = _spec();
        // Low fixed address meets the ordinary listing address rule on either EVM.
        HostileToken original = new HostileToken("Pricing", "P", 6);
        vm.etch(address(0x100000), address(original).code);
        p = HostileToken(address(0x100000));
        p.setDecimals(6);
        p.mint(address(this), 10_000);
        p.approve(address(listings), 10_000);
        s.pricing.listingId = listings.add(address(p), ListingClass.OTHER, 100_000_000);
        s.pricing.token = address(p);
        s.raise = 100_000_000;
        p.mint(CREATOR, s.raise);
        vm.prank(CREATOR);
        p.approve(address(factory), s.raise);
    }
}
