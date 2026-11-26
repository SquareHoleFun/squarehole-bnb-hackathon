// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxSpecV2} from "../../../src/box-v2/BoxSpecV2.sol";
import {BoxSpecV2Validator} from "../../../src/box-v2/BoxSpecV2Validator.sol";
import {BoxSpec, ReleaseContext, Listing, BoxType, PileParams} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch, Side} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {FreezeRules} from "../m3-00/FreezeRules.sol";

contract M310GeneratedValidator {
    /// @notice Anyone checks pure spec admission; no custody or state.
    function validate(BoxSpec memory s, ReleaseContext memory ctx) external pure returns (uint16, uint16) {
        return BoxSpecV2.validate(s, ctx);
    }
}

contract M3SpecTest is Test {
    BoxSpecV2Validator internal validator;
    M310GeneratedValidator internal generated;
    FreezeRules internal referenceRules;
    function setUp() public {
        validator = new BoxSpecV2Validator(); generated = new M310GeneratedValidator(); referenceRules = new FreezeRules();
    }
    function context() internal pure returns (ReleaseContext memory) {
        return ReleaseContext(Listing(1, address(0x1111), 8, 4, 1, 1_000_000));
    }
    function choice(uint8 c) internal pure returns (Branch memory) {
        return Branch(c == 2 ? 2 : 1, c == 1 ? 2 : c == 2 ? 1 : c == 3 ? 4 : c == 4 ? 6 : 8,
            "", c >= 4 ? abi.encode(uint8(c == 6 ? 2 : 1)) : bytes(""));
    }
    function spec(bool pile) internal pure returns (BoxSpec memory s) {
        s.format = 2; s.version = 2; s.boxType = pile ? 5 : 1;
        s.tokenName = "Example"; s.tokenSymbol = "EX"; s.coverSha256 = bytes32(uint256(1));
        s.pricing.listingId = 1; s.pricing.token = address(0x1111); s.raise = 1_000_000;
        s.layout = 1; s.gradLayout = 3; s.launchFormat = 1; s.deadlineDays = 30;
        s.buyers = Side(choice(pile ? 3 : 5), Branch(0, 0, "", ""), 1, "");
        s.sellers = Side(choice(pile ? 4 : 6), Branch(0, 0, "", ""), 1, "");
        if (pile) s.contentsParams = abi.encode(PileParams(address(0), 0));
        else {
            s.collectionName = "Items"; s.collectionSymbol = "IT"; s.n = 10; s.firstId = 1;
            s.artMode = 1; s.revealRoot = s.coverSha256; s.revealListId = s.coverSha256;
            s.collectionCoverSha256 = s.coverSha256; s.marketplaceOwner = address(0x1111);
            s.metadataTable = hex"01000000"; s.pickFeeBps = 100;
        }
    }
    function check(BoxSpec memory s, uint16 reason, uint16 field) internal view {
        (uint16 r, uint16 f) = validator.validate(s, context());
        assertEq(r, reason, "wrapper reason"); assertEq(f, field, "wrapper field");
        (r, f) = generated.validate(s, context());
        assertEq(r, reason, "generated reason"); assertEq(f, field, "generated field");
    }
    function test_BC266_everyItemAndSeededPileTwinBoundaries() public view {
        for (uint8 b = 1; b <= 6; ++b) for (uint8 a = 1; a <= 6; ++a) {
            BoxSpec memory s = spec(false); s.buyers.a = choice(b); s.sellers.a = choice(a);
            if (b == 1 || a == 1) s.creatorFeeRecipient = address(0xCAFE);
            check(s, 0, 0);
        }
        check(spec(true), 0, 0);
        BoxSpec memory p = spec(true); p.contentsParams = abi.encode(PileParams(address(0x1111), type(uint256).max));
        check(p, 0, 0);
    }
    function test_BC259_rejectRemovedItemModesAndFilters() public view {
        for (uint256 side; side < 2; ++side) for (uint256 k; k < 6; ++k) {
            BoxSpec memory s = spec(false);
            bytes memory params = k == 0 ? bytes("") : k == 1 ? bytes(hex"01") : k == 2 ? abi.encode(uint256(257))
                : k == 3 ? bytes.concat(abi.encode(uint8(1)), hex"00")
                : k == 4 ? abi.encode(uint8(1), address(0x721)) : abi.encode(uint8(1), uint256(0), address(0));
            if (side == 0) s.buyers.a.destParams = params; else s.sellers.a.destParams = params;
            check(s, 23, uint16(17004 + side * 1000));
        }
    }
    function test_BC266_removedModesFieldsAndFeeFundingRefused() public view {
        BoxSpec memory s = spec(true); s.buyers.a.dest = 7; check(s, 23, 30); // Cross-asset fee intake stays refused.
        s.contentsParams = abi.encode(PileParams(s.pricing.token, 0)); check(s, 0, 0); // PF03: same-P is now offered.
        s = spec(true); s.buyers.a = choice(5); check(s, 3, 17002);
        s = spec(true); s.n = 10; check(s, 8, 8);
        s = spec(true); s.contentsParams = bytes.concat(s.contentsParams, hex"00"); check(s, 23, 30);
        s = spec(true); s.contentsParams = abi.encode(uint256(1) << 160, uint256(0)); check(s, 23, 30);
        s = spec(false); s.buyers.a.leg = 2; check(s, 0, 0); // T21: BuyT/Items is now canonical.
        s = spec(false); s.buyers.split = 2; s.buyers.b = choice(3); check(s, 24, 17021);
        s = spec(false); s.buyers.b.destParams = hex"00"; check(s, 8, 17014);
    }
    function testFuzz_policyWord(uint256 policy, bool seller) public view {
        BoxSpec memory s = spec(false); bytes memory p = abi.encode(policy);
        if (seller) s.sellers.a.destParams = p; else s.buyers.a.destParams = p;
        bool valid = policy == 1 || policy == 2 || policy == 3;
        check(s, valid ? 0 : policy > 255 ? 23 : 3, valid ? 0 : seller ? 18004 : 17004);
        if (valid) assertEq(referenceRules.items(BoxType.NEW_COLLECTION, p), policy);
    }
    function testFuzz_seedTuple(address asset, uint256 seed) public view {
        BoxSpec memory s = spec(true); s.contentsParams = abi.encode(PileParams(asset, seed)); check(s, 0, 0);
        // Pure spec validation deliberately cannot attest listing or future T; supply those facts only to the model.
        address predictedT = asset == address(1) ? address(2) : address(1);
        (address a, uint256 amount) = referenceRules.pile(s.contentsParams, predictedT, true);
        assertEq(a, asset); assertEq(amount, seed);
    }
    function test_sharedVectors() public view {
        string memory json = vm.readFile("test/vectors/box-spec/box-spec-v2.json");
        bytes[] memory encoded = vm.parseJsonBytesArray(json, ".columns.encoded");
        uint256[] memory reasons = vm.parseJsonUintArray(json, ".columns.reason");
        uint256[] memory fields = vm.parseJsonUintArray(json, ".columns.field");
        uint256[] memory contexts = vm.parseJsonUintArray(json, ".columns.context");
        for (uint256 i; i < encoded.length; ++i) {
            bytes memory c = vm.parseJsonBytes(json, string.concat(".contexts[", vm.toString(contexts[i]), "].encoded"));
            BoxSpec memory s = abi.decode(encoded[i], (BoxSpec)); ReleaseContext memory ctx = abi.decode(c, (ReleaseContext));
            (uint16 r, uint16 f) = validator.validate(s, ctx);
            assertEq(r, reasons[i], vm.toString(i)); assertEq(f, fields[i], vm.toString(i));
            (r, f) = generated.validate(s, ctx);
            assertEq(r, reasons[i], vm.toString(i)); assertEq(f, fields[i], vm.toString(i));
        }
    }
}
