// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M234Base} from "../box-v2/m2-34/Fixture.sol";
import {M234CreationTest} from "../box-v2/m2-34/Creation.t.sol";
import {RoyaltyRelease} from "../box-v2/kit/RoyaltyRelease.sol";
import {ReceiverDeploy} from "../box-v2/fee-modules/ReceiverDeploy.sol";
import {LifeCustody} from "../box-v2/kit/FactoryLife.sol";
import {M132Dependency} from "../box-v2/m1-32a/M132aBase.sol";
import {RoyaltyWeth} from "../box-v2/cq11-c/RoyaltyRouter.t.sol";
import {HostileCollection} from "../box-v2/kit/m2/ShopDoubles.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxFactoryV2} from "../../src/box-v2/BoxFactoryV2.sol";
import {BoxFactoryV2Planner} from "../../src/box-v2/BoxFactoryV2Planner.sol";
import {BoxRegistryV2} from "../../src/box-v2/BoxRegistryV2.sol";
import {ListingRegistry} from "../../src/box-v2/ListingRegistry.sol";
import {BoxCoordinatorV2} from "../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2Ledger} from "../../src/box-v2/BoxTokenV2Ledger.sol";
import {BoxSpec, BoxType} from "../../src/box-v2/interfaces/SpecTypes.sol";
import {IShopVaultV2, IStarterSetLoaderV2, ShopConfigV2} from "../../src/box-v2/interfaces/IShopVaultV2.sol";
import {BnbTestnet} from "../../script/bnb/BnbTestnet.sol";
import {DeployCoreV2BnbShortWait} from "../../script/bnb/DeployCoreV2BnbShortWait.s.sol";
import {ShopVaultV2ShortWait} from "../../script/bnb/ShopVaultV2ShortWait.sol";
import {BoxSpecV2ValidatorShortWait} from "../../script/bnb/BoxSpecV2ValidatorShortWait.sol";
import {IBoxSpecV2Validator} from "../../src/box-v2/BoxSpecV2Validator.sol";

/// @dev A shop spec of the release fixture with the given list delay.
abstract contract ShortWaitSpecs is M234Base {
    function _shopWaiting(uint32 wait) internal returns (BoxSpec memory s, address collection) {
        collection = address(new HostileCollection());
        s = _shop(collection, 0, 0, 100 ether);
        ShopConfigV2 memory cfg = abi.decode(s.contentsParams, (ShopConfigV2));
        cfg.listDelay = wait;
        s.contentsParams = abi.encode(cfg);
    }

    function _refusedAsNotAMember() internal pure returns (bytes memory) {
        return abi.encodeWithSignature("InvalidSpec(uint16,uint16)", uint16(2), uint16(30)); // REASON_NOT_A_MEMBER, contentsParams
    }
}

/// @notice SH-300 STEP 1b: the SECOND release (ten-minute shop and validator, everything else the release's own),
/// built as the release script builds it. A card shop box with ten minutes is created through its factory's
/// `createBox`, its first collection's gives open exactly ten minutes after creation; 0, 599, 601 and 3600 seconds are
/// still refused by its factory. Every existing creation test of the release fixture runs again on this release.
contract ShortWaitReleaseTest is M234CreationTest, ShortWaitSpecs {
    function setUp() public override {
        vm.warp(1_000_000);
        vm.roll(100);
        vm.deal(CREATOR, 100 ether);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        release.factory = vm.computeCreateAddress(DEPLOYER, vm.getNonce(DEPLOYER));
        release.poolManager = address(pm);
        release.weth = address(new RoyaltyWeth());
        release.randomness = address(new M132Dependency());
        registry =
            BoxRegistryV2(deployCode("BoxRegistryV2.sol:BoxRegistryV2", abi.encode(release.factory, new address[](0))));
        release.registry = address(registry);
        listings = ListingRegistry(deployCode("ListingRegistry.sol:ListingRegistry",
            abi.encode(address(this), address(registry), address(pm), release.weth)));
        release.listingRegistry = address(listings);
        fitSafe = address(new LifeCustody());
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
        release.implementations[8] =
            deployCode("BoxRoyaltyRouterV2.sol:BoxRoyaltyRouterV2", abi.encode(RoyaltyRelease.config()));
        release.implementations[17] = deployCode("HolderLedgerV2.sol:HolderLedgerV2", abi.encode(pm));
        release.implementations[19] = deployCode("StarterSetLoaderV2.sol:StarterSetLoaderV2", abi.encode(ci));
        release.implementations[20] = deployCode("BoxTokenV2Ledger.sol:BoxTokenV2Ledger", abi.encode(ci));
        // The two ten-minute copies, as DeployCoreV2BnbShortWait puts them.
        release.implementations[21] = deployCode("ShopVaultV2ShortWait.sol:ShopVaultV2ShortWait", abi.encode(pm, ci));
        address validator = deployCode("BoxSpecV2ValidatorShortWait.sol:BoxSpecV2ValidatorShortWait");
        planner = BoxFactoryV2Planner(deployCode("BoxFactoryV2Planner.sol:BoxFactoryV2Planner",
            abi.encode(validator, deployCode("BoxFactoryV2Parts.sol:BoxFactoryV2Parts"))));
        address checks = deployCode("BoxFactoryV2Checks.sol:BoxFactoryV2Checks");
        vm.prank(DEPLOYER);
        factory = BoxFactoryV2(deployCode("BoxFactoryV2.sol:BoxFactoryV2", abi.encode(release, address(planner), checks)));
        assertEq(address(factory), release.factory);
        release.versionCodeHash = factory.versionCodeHash();
    }

    function test_tenMinuteShopBoxThroughTheSecondFactory() public {
        (BoxSpec memory s, address collection) = _shopWaiting(10 minutes);
        assertEq(factory.refusal(s, CREATOR), "");
        uint256 createdAt = block.timestamp;
        BoxCoordinatorV2 c = _assertCreation(s, hex"01050603081113");
        IShopVaultV2 shop = IShopVaultV2(c.vault());
        (,, uint256 activeAt) = shop.collectionTerms(collection);
        assertEq(activeAt, createdAt + 10 minutes);
        BoxTokenV2Ledger token = BoxTokenV2Ledger(c.token());
        address vault = c.vault();
        vm.prank(CREATOR); token.approve(vault, 100 ether);
        shop.fundSeed();
        IStarterSetLoaderV2(c.starterSetLoader()).complete();
        assertTrue(c.gateOpen());
    }

    function test_secondFactoryStillRefusesEveryOtherShortWait() public {
        uint32[4] memory others = [uint32(0), 599, 601, 3600];
        for (uint256 i; i < 4; ++i) {
            (BoxSpec memory s,) = _shopWaiting(others[i]);
            assertEq(factory.refusal(s, CREATOR), _refusedAsNotAMember());
            vm.prank(CREATOR); vm.expectRevert(_refusedAsNotAMember()); factory.createBox(s, 0, 0);
        }
    }

    function test_secondFactoryStillTakesTheThreeLongWaits() public {
        uint32[3] memory waits = [uint32(7 days), 14 days, 30 days];
        for (uint256 i; i < 3; ++i) {
            (BoxSpec memory s,) = _shopWaiting(waits[i]);
            assertEq(factory.refusal(s, CREATOR), "");
        }
    }

    /// @notice The changed line admits nothing but a shop's wait: for specs that are NOT shops, with 600 in contents
    /// word 9, the variant validator answers exactly what the release's validator answers (a refusal). For a shop with
    /// 600 the two differ, and only there.
    /// @dev The variant and the release's validator agree on every spec but a shop whose list delay (contents word 9,
    /// read raw as the validator reads it) is 600: a valid token-only box, that box carrying a shop's contents with 600
    /// at word 9, and a shop valid apart from that word at twelve waits around the accepted ones.
    function test_variantValidatorDiffersOnlyForAShopsWait() public {
        IBoxSpecV2Validator original = IBoxSpecV2Validator(deployCode("BoxSpecV2Validator.sol:BoxSpecV2Validator"));
        IBoxSpecV2Validator variant = planner.validator();
        BoxSpec memory tokenOnly = _holders();
        tokenOnly.boxType = uint8(BoxType.TOKEN_ONLY);
        (uint16 r, uint16 f) = _agree(original, variant, tokenOnly);
        assertEq(r, 0, "a valid token-only box");
        (BoxSpec memory shop,) = _shopWaiting(10 minutes);
        assertEq(shop.boxType, uint8(BoxType.SHOP));
        assertEq(_rawWord(shop.contentsParams, 9), 600, "the wait is raw word 9");
        tokenOnly.contentsParams = shop.contentsParams;
        (r, f) = _agree(original, variant, tokenOnly);
        assertTrue(r != 0); assertEq(f, 30, "refused at contentsParams by both, for the box type");
        uint32[12] memory waits = [uint32(0), 1, 599, 601, 3600, 7 days - 1, 7 days, 7 days + 1, 14 days, 30 days, 30 days + 1, 600 + 7 days];
        for (uint256 i; i < waits.length; ++i) {
            (BoxSpec memory s,) = _shopWaiting(waits[i]);
            assertEq(_rawWord(s.contentsParams, 9), waits[i]);
            (r, f) = _agree(original, variant, s);
            bool longWait = waits[i] == 7 days || waits[i] == 14 days || waits[i] == 30 days;
            assertEq(r, longWait ? 0 : 2); assertEq(f, longWait ? 0 : 30);
        }
        (uint16 refused, uint16 field) = original.validate(shop, planner.context(release, shop));
        assertEq(refused, 2); assertEq(field, 30);
        (uint16 accepted, uint16 none) = variant.validate(shop, planner.context(release, shop));
        assertEq(accepted, 0); assertEq(none, 0);
    }

    function _agree(IBoxSpecV2Validator a, IBoxSpecV2Validator b, BoxSpec memory s) internal view returns (uint16 r, uint16 f) {
        (r, f) = a.validate(s, planner.context(release, s));
        (uint16 r1, uint16 f1) = b.validate(s, planner.context(release, s));
        assertEq(r1, r); assertEq(f1, f);
    }

    function _rawWord(bytes memory p, uint256 i) internal pure returns (uint256 w) {
        assembly ("memory-safe") { w := mload(add(add(p, 32), mul(i, 32))) }
    }

    function test_releaseScriptExposesOnlyItsGuardedRun() public {
        DeployCoreV2BnbShortWait script = new DeployCoreV2BnbShortWait();
        vm.chainId(31337);
        vm.expectRevert(abi.encodeWithSelector(BnbTestnet.NotBnbTestnet.selector, 31337));
        script.run(address(pm), address(1), address(2), address(3), address(4));
        // No inherited deployment entry point: the local and production selectors are absent.
        (bool ok,) = address(script).call(abi.encodeWithSignature("run()"));
        assertFalse(ok);
        (ok,) = address(script).call(abi.encodeWithSignature("runAlpha(address,address,address,address,address)",
            address(1), address(2), address(3), address(4), address(5)));
        assertFalse(ok);
        (ok,) = address(script).call(abi.encodeWithSignature("runLocal(address,address)", address(1), address(2)));
        assertFalse(ok);
    }
}

/// @notice The FIRST release (the release's own validator and shop, unchanged) still refuses a ten-minute shop.
contract FirstReleaseRefusesTenMinutesTest is ShortWaitSpecs {
    function test_firstFactoryRefusesTenMinutes() public {
        (BoxSpec memory s,) = _shopWaiting(10 minutes);
        assertEq(factory.refusal(s, CREATOR), _refusedAsNotAMember());
        vm.prank(CREATOR); vm.expectRevert(_refusedAsNotAMember()); factory.createBox(s, 0, 0);
    }
}
