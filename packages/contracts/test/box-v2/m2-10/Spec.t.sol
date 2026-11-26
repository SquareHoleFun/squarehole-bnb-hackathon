// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV2} from "../../../src/box-v2/BoxSpecV2.sol";
import {M210ShopCases} from "./ShopCases.sol";
import {Test} from "forge-std/Test.sol";
import {BoxSpecV2Validator} from "../../../src/box-v2/BoxSpecV2Validator.sol";
import {BoxSpec, ReleaseContext, Listing, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch, Side} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ShopConfigV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";

contract M210GeneratedValidator {
    function validate(BoxSpec memory s, ReleaseContext memory ctx) external pure returns (uint16, uint16) {
        return BoxSpecV2.validate(s, ctx);
    }
}

contract M210SpecTest is Test {
    M210GeneratedValidator internal generated;
    BoxSpecV2Validator internal validator;
    function setUp() public { validator = new BoxSpecV2Validator(); generated = new M210GeneratedValidator(); }
    function context() internal pure returns (ReleaseContext memory) {
        return ReleaseContext(Listing(1, address(0x1111), 8, 4, 1, 1_000_000));
    }
    function spec() internal pure returns (BoxSpec memory s) {
        s.format = 2; s.version = 2; s.boxType = 3;
        s.tokenName = "Example"; s.tokenSymbol = "EX";
        s.pricing.listingId = 1; s.pricing.token = address(0x1111); s.raise = 1_000_000;
        s.layout = 1; s.gradLayout = 3; s.launchFormat = 1; s.deadlineDays = 30;
        s.coverSha256 = bytes32(uint256(1));
        s.buyers = Side(Branch(1, 6, "", abi.encode(uint8(1))), Branch(0, 0, "", ""), 1, "");
        s.sellers = Side(Branch(1, 6, "", abi.encode(uint8(1))), Branch(0, 0, "", ""), 1, "");
    }
    function config() internal pure returns (ShopConfigV2 memory c) {
        c.seedT = 10000; c.givePricesT = [uint256(100), 200, 300, 400];
        c.pickBps = 12500; c.weeklyBps = 1000; c.collectionBps = 250; c.listDelay = 7 days;
        c.collections = new address[](1); c.collections[0] = address(0x721);
        c.tiers = new uint8[](1);
    }
    function shop() internal pure returns (BoxSpec memory s) {
        s = spec(); s.boxType = 4; s.contentsParams = abi.encode(config());
        s.addOns = new AddOn[](2); s.addOns[0] = AddOn(7, "");
        s.addOns[1] = AddOn(8, abi.encode(bytes32(0), uint32(0)));
    }
    function check(BoxSpec memory s, uint16 reason, uint16 field) internal view {
        (uint16 r, uint16 f) = validator.validate(s, context());
        assertEq(r, reason, "reason"); assertEq(f, field, "field");
        (r, f) = generated.validate(s, context());
        assertEq(r, reason, "generated reason"); assertEq(f, field, "generated field");
    }
    function test_M210C_everyOpaqueShopCaseHasTwinParity() public view {
        for (uint256 i; i < M210ShopCases.COUNT; ++i) {
            BoxSpec memory s = shop();
            (bytes memory contents, uint16 reason, uint16 field, uint8 flags) = M210ShopCases.at(i);
            s.contentsParams = contents;
            if (flags == 0) { s.addOns = new AddOn[](1); s.addOns[0] = AddOn(7, ""); }
            if (flags == 1) {
                s.addOns = new AddOn[](2); s.addOns[0] = AddOn(7, "");
                s.addOns[1] = AddOn(8, abi.encode(bytes32(0), uint32(0)));
            }
            if (flags == 2) s.addOns = new AddOn[](0);
            if (flags == 3) s.raise += 1;
            if (flags == 4) s.n = 10;
            (uint16 r, uint16 f) = validator.validate(s, context());
            assertEq(r, reason, string.concat("wrapper reason case ", vm.toString(i)));
            assertEq(f, field, string.concat("wrapper field case ", vm.toString(i)));
            (r, f) = generated.validate(s, context());
            assertEq(r, reason, string.concat("generated reason case ", vm.toString(i)));
            assertEq(f, field, string.concat("generated field case ", vm.toString(i)));
        }
    }
    function test_M210_POnlyOnBothSidesAndAllMenuPairs() public view {
        for (uint8 b = 1; b <= 4; ++b) for (uint8 a = 1; a <= 4; ++a) {
            BoxSpec memory s = spec(); s.buyers.a = choice(b); s.sellers.a = choice(a);
            if (b == 1 || a == 1) s.creatorFeeRecipient = address(0xCAFE);
            check(s, 0, 0);
        }
    }
    function choice(uint8 c) internal pure returns (Branch memory) {
        return Branch(c == 2 ? 2 : 1, c == 1 ? 2 : c == 2 ? 1 : c == 3 ? 4 : 6,
            "", c == 4 ? abi.encode(uint8(1)) : bytes(""));
    }
    function test_M210_everyOtherLegDestinationCombinationRefused() public view {
        for (uint8 side; side < 2; ++side) for (uint8 leg; leg <= 6; ++leg) {
            for (uint8 dest; dest <= 9; ++dest) {
                BoxSpec memory s = spec();
                Branch memory a = Branch(leg, dest, "", dest == 6 ? abi.encode(uint8(1)) : bytes(""));
                if (side == 0) s.buyers.a = a; else s.sellers.a = a;
                if (dest == 2) s.creatorFeeRecipient = address(0xCAFE);
                (uint16 r,) = validator.validate(s, context());
                bool valid = (leg == 1 && (dest == 1 || dest == 2 || dest == 4 || dest == 6)) || (leg == 2 && dest == 1);
                assertEq(r == 0, valid);
            }
        }
    }
    function test_M210_canonicalHolderCurrencyAndEmptySecondBranches() public view {
        for (uint256 side; side < 2; ++side) {
            for (uint8 currency; currency < 4; ++currency) {
                BoxSpec memory s = spec();
                if (side == 0) s.buyers.a.destParams = abi.encode(currency);
                else s.sellers.a.destParams = abi.encode(currency);
                check(s, currency == 1 ? 0 : 3, currency == 1 ? 0 : uint16(17004 + side * 1000));
            }
            for (uint256 k; k < 7; ++k) {
                BoxSpec memory s = spec(); Side memory bad = spec().buyers;
                if (k == 0) bad.b.leg = 1;
                if (k == 1) bad.b.dest = 6;
                if (k == 2) bad.b.legParams = hex"00";
                if (k == 3) bad.b.destParams = hex"00";
                if (k == 4) bad.splitParams = hex"00";
                if (k == 5) bad.a.legParams = hex"00";
                if (k == 6) bad.a.destParams = bytes.concat(abi.encode(uint8(1)), hex"00");
                if (side == 0) s.buyers = bad; else s.sellers = bad;
                (uint16 r,) = validator.validate(s, context()); assertTrue(r != 0);
            }
        }
    }
    function test_M210_shopAndSeedOnlyGate() public view {
        BoxSpec memory s = shop(); check(s, 0, 0);
        ShopConfigV2 memory c = config(); c.seedT = 2 ** 200; s.contentsParams = abi.encode(c);
        s.addOns = new AddOn[](1); s.addOns[0] = AddOn(7, ""); check(s, 18, 30);
        s.addOns = new AddOn[](2); s.addOns[0] = AddOn(7, "");
        s.addOns[1] = AddOn(8, abi.encode(bytes32(0), uint32(0))); check(s, 0, 0);
        s.addOns[1].params = abi.encode(bytes32(uint256(42)), uint32(10)); check(s, 0, 0);
        s.addOns[1].params = abi.encode(bytes32(uint256(42)), uint32(10000)); check(s, 0, 0);
    }
    function test_M210_starterCommitmentBoundsAndAddonConflicts() public view {
        BoxSpec memory s = shop(); s.addOns = new AddOn[](2); s.addOns[0] = AddOn(7, "");
        for (uint32 n = 1; n < 10; ++n) {
            s.addOns[1] = AddOn(8, abi.encode(bytes32(uint256(42)), n)); check(s, 19, 800);
        }
        s.addOns[1] = AddOn(8, abi.encode(bytes32(0), uint32(10))); check(s, 19, 800);
        s.addOns[1].params = abi.encode(bytes32(uint256(42)), uint32(0)); check(s, 19, 800);
        s.addOns[1].params = abi.encode(bytes32(uint256(42)), uint32(10001)); check(s, 4, 802);
        s.addOns[1].params = hex"01"; check(s, 17, 800);
        s = shop(); s.addOns[0].params = hex"00"; check(s, 17, 700);
        s = shop(); s.addOns = new AddOn[](0); check(s, 18, 29);
        s = spec(); s.addOns = new AddOn[](1); s.addOns[0] = AddOn(7, ""); check(s, 19, 700);
        s.addOns[0] = AddOn(8, abi.encode(bytes32(0), uint32(0))); check(s, 19, 800);
        s = shop(); s.addOns[0] = AddOn(9, ""); check(s, 16, 900);
        s.addOns[0] = AddOn(10, ""); check(s, 16, 1000);
    }
    function test_M210_shopConfigPresetsAndMalformedBytes() public view {
        BoxSpec memory s = shop(); ShopConfigV2 memory c = config();
        c.givePricesT[0] = 0; s.contentsParams = abi.encode(c); check(s, 4, 30);
        c = config(); c.givePricesT[2] = c.givePricesT[1]; s.contentsParams = abi.encode(c); check(s, 4, 30);
        c = config(); c.pickBps = 11000; s.contentsParams = abi.encode(c); check(s, 2, 30);
        c = config(); c.weeklyBps = 501; s.contentsParams = abi.encode(c); check(s, 2, 30);
        c = config(); c.collectionBps = 251; s.contentsParams = abi.encode(c); check(s, 2, 30);
        c = config(); c.listDelay = 8 days; s.contentsParams = abi.encode(c); check(s, 2, 30);
        c = config(); c.collections[0] = address(0); s.contentsParams = abi.encode(c); check(s, 7, 30);
        c = config(); c.tiers[0] = 4; s.contentsParams = abi.encode(c); check(s, 4, 30);
        c = config(); c.collections = new address[](2); c.collections[0] = address(0x721);
        c.collections[1] = address(0x721); c.tiers = new uint8[](2);
        s.contentsParams = abi.encode(c); check(s, 23, 30);
        c = config(); c.tiers = new uint8[](0); s.contentsParams = abi.encode(c); check(s, 23, 30);
        s = shop(); s.contentsParams = bytes.concat(s.contentsParams, hex"00"); check(s, 23, 30);
        s = shop(); s.contentsParams[31] = bytes1(uint8(64)); check(s, 23, 30);
        s = shop(); s.contentsParams[320] = hex"01"; check(s, 23, 30); // dirty curator address
    }
    function testFuzz_M210_configAcceptedWithinFrozenBounds(uint256 seed, uint8 count) public view {
        count = uint8(bound(count, 1, 64)); seed = bound(seed, 4000, type(uint256).max); ShopConfigV2 memory c = config(); c.seedT = seed;
        c.collections = new address[](count); c.tiers = new uint8[](count);
        for (uint256 i; i < count; ++i) { c.collections[i] = address(uint160(i + 0x1000)); c.tiers[i] = uint8(i % 4); }
        BoxSpec memory s = shop(); s.contentsParams = abi.encode(c);
        s.addOns = new AddOn[](2); s.addOns[0] = AddOn(7, ""); s.addOns[1] = AddOn(8, abi.encode(bytes32(0), uint32(0)));
        check(s, 0, 0);
    }
    function test_M210_raiseIsCreationSnapshotAndShopHasNoCollectionFields() public view {
        BoxSpec memory s = shop(); ReleaseContext memory old = context();
        ReleaseContext memory fresh = context(); fresh.listing.raise *= 2;
        (uint16 r, uint16 f) = validator.validate(s, fresh); assertEq(r, 10); assertEq(f, 11);
        check(s, 0, 0); assertEq(old.listing.raise, s.raise);
        s.raise = fresh.listing.raise; (r,) = validator.validate(s, fresh); assertEq(r, 0);
        s = shop(); s.n = 10; check(s, 8, 8);
        s = shop(); s.pickFeeBps = 2500; check(s, 8, 31);
    }
    function test_M210_generatedTwinVectors() public view {
        string memory json = vm.readFile("test/vectors/box-spec/box-spec-v2.json");
        bytes[] memory encoded = vm.parseJsonBytesArray(json, ".columns.encoded");
        uint256[] memory reasons = vm.parseJsonUintArray(json, ".columns.reason");
        uint256[] memory fields = vm.parseJsonUintArray(json, ".columns.field");
        uint256[] memory contexts = vm.parseJsonUintArray(json, ".columns.context");
        for (uint256 i; i < encoded.length; ++i) {
            BoxSpec memory s = abi.decode(encoded[i], (BoxSpec));
            bytes memory ctx = vm.parseJsonBytes(json, string.concat(".contexts[", vm.toString(contexts[i]), "].encoded"));
            (uint16 r, uint16 f) = validator.validate(s, abi.decode(ctx, (ReleaseContext)));
            assertEq(r, reasons[i], vm.toString(i)); assertEq(f, fields[i], vm.toString(i));
        }
    }
}
