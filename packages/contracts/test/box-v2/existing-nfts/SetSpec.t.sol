// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SetSpecV2, SetValidationContext} from "../../../src/box-v2/set/SetTypesV2.sol";
import {SetSpecV2Validator} from "../../../src/box-v2/set/SetSpecV2Validator.sol";
import {SetSpecV2Codec} from "../../../src/box-v2/set/SetSpecV2Codec.sol";
import {SetConstantsV2 as C} from "../../../src/box-v2/set/SetConstantsV2.sol";
import {BoxSpecV2} from "../../../src/box-v2/BoxSpecV2.sol";
import {BoxSpec, ReleaseContext} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {SetVectors} from "./SetVectors.sol";

contract SetSpecTest is Test {
    SetSpecV2Validator private validator;

    function setUp() public {
        validator = new SetSpecV2Validator();
    }

    function _spec(uint256 index) private pure returns (SetSpecV2 memory) {
        return SetSpecV2Codec.decode(SetVectors.encoded(index));
    }

    function _context(SetSpecV2 memory s) private pure returns (SetValidationContext memory ctx) {
        ctx.listing.id = s.pricing.listingId;
        ctx.listing.token = s.pricing.token;
        ctx.listing.kind = 1;
        ctx.listing.class = 1;
        ctx.listing.decimals = 18;
        ctx.listing.raise = s.raise;
        ctx.timestamp = 1792800000;
    }

    function _expect(SetSpecV2 memory s, SetValidationContext memory ctx, uint16 reason, uint16 field) private view {
        (uint16 r, uint16 f) = validator.validate(s, ctx);
        assertEq(r, reason);
        assertEq(f, field);
        (r, f) = validator.validateEncoded(abi.encode(s), ctx);
        assertEq(r, reason);
        assertEq(f, field);
    }

    function test_E01_crossLanguageBytesHashesAndDomains() public view {
        for (uint256 i; i < 2; ++i) {
            SetSpecV2 memory s = _spec(i);
            assertEq(SetSpecV2Codec.encode(s), SetVectors.encoded(i));
            assertEq(SetSpecV2Codec.specHash(s), SetVectors.specHash(i));
            assertEq(s.schema, C.SCHEMA);
            assertEq(s.release, C.RELEASE);
            assertEq(s.format, C.FORMAT);
            assertEq(s.setHash, SetVectors.root(i));
            assertEq(s.logoSha256, 0xabababababababababababababababababababababababababababababababab);
            assertEq(s.collection, address(0x1111111111111111111111111111111111111111));
            assertEq(s.count, i == 0 ? 33 : 10);
            assertEq(s.pricing.listingId, i == 0 ? 0 : 42);
            assertEq(s.pricing.token, i == 0 ? address(0) : address(0x2222222222222222222222222222222222222222));
            assertEq(s.raise, i == 0 ? 4206980085000000000 : type(uint256).max);
            assertEq(s.creatorBuy, i == 0 ? 0 : type(uint256).max - 1);
            assertEq(s.openAt, i == 0 ? 0 : 1794009600);
            assertEq(s.deadlineDays, i == 0 ? 30 : 180);
            assertEq(s.pickFeeBps, i == 0 ? 500 : 2500);
            _expect(s, _context(s), 0, 0);
        }
        assertEq(C.RETURN_FEE_BPS, 500);
        assertEq(C.GROW_CHOICE, 3);
        assertEq(C.TEMPLATE, keccak256("SquareHole.ExistingNFTs.PicksReturns.Grow.v1"));
    }

    function test_E01_countBoundaries() public view {
        SetSpecV2 memory s = _spec(0);
        SetValidationContext memory ctx = _context(s);
        uint32[4] memory counts = [uint32(9), 10, 10000, 10001];
        for (uint256 i; i < counts.length; ++i) {
            s.count = counts[i];
            _expect(s, ctx, i == 0 || i == 3 ? 4 : 0, i == 0 || i == 3 ? 11 : 0);
        }
    }

    function test_E01_refusalsInFieldOrder() public view {
        for (uint256 i; i < 22; ++i) {
            SetSpecV2 memory s = _spec(0);
            SetValidationContext memory ctx = _context(s);
            uint16 reason;
            uint16 field;
            if (i == 0) {
                s.format = 1;
                reason = 1;
                field = 0;
            }
            if (i == 1) {
                s.schema = 0;
                reason = 1;
                field = 1;
            }
            if (i == 2) {
                s.release = 0;
                reason = 1;
                field = 2;
            }
            if (i == 3) {
                s.tokenName = "";
                reason = 5;
                field = 3;
            }
            if (i == 4) {
                s.tokenName = "\"";
                reason = 6;
                field = 3;
            }
            if (i == 5) {
                s.tokenSymbol = "abcdefghijkl";
                reason = 5;
                field = 4;
            }
            if (i == 6) {
                s.tokenSymbol = "\\";
                reason = 6;
                field = 4;
            }
            if (i == 7) {
                s.pricing.listingId = 1;
                reason = 21;
                field = 5;
            }
            if (i == 8) {
                s.pricing.token = s.collection;
                reason = 22;
                field = 5;
            }
            if (i == 9) {
                s.raise = 0;
                reason = 10;
                field = 6;
            }
            if (i == 10) {
                ++s.raise;
                reason = 10;
                field = 6;
            }
            if (i == 11) {
                s.openAt = 1;
                reason = 4;
                field = 7;
            }
            if (i == 12) {
                s.openAt = 1794009601;
                reason = 4;
                field = 7;
            }
            if (i == 13) {
                s.deadlineDays = 31;
                reason = 12;
                field = 8;
            }
            if (i == 14) {
                s.creatorBuy = s.raise;
                reason = 4;
                field = 9;
            }
            if (i == 15) {
                s.collection = address(0);
                reason = 7;
                field = 10;
            }
            if (i == 16) {
                s.count = 9;
                reason = 4;
                field = 11;
            }
            if (i == 17) {
                s.setHash = 0;
                reason = 7;
                field = 12;
            }
            if (i == 18) {
                s.pickFeeBps = 501;
                reason = 2;
                field = 13;
            }
            if (i == 19) {
                s.description = string(new bytes(1025));
                reason = 5;
                field = 14;
            }
            if (i == 20) {
                s.description = "\n";
                reason = 6;
                field = 14;
            }
            if (i == 21) {
                s.logoSha256 = 0;
                reason = 7;
                field = 15;
            }
            _expect(s, ctx, reason, field);
        }
        SetSpecV2 memory both = _spec(0);
        both.format = 1;
        both.count = 9;
        _expect(both, _context(both), 1, 0);
    }

    function test_E01_listingTimeAndPresets() public view {
        SetSpecV2 memory s = _spec(0);
        SetValidationContext memory ctx = _context(s);
        ctx.listing.kind = 0;
        _expect(s, ctx, 21, 5);
        ctx.listing.kind = 1;
        uint16[3] memory fees = [uint16(100), 500, 2500];
        uint16[4] memory days_ = [uint16(30), 60, 90, 180];
        for (uint256 i; i < fees.length; ++i) {
            for (uint256 j; j < days_.length; ++j) {
                s.pickFeeBps = fees[i];
                s.deadlineDays = days_[j];
                s.openAt = 1794009600;
                _expect(s, ctx, 0, 0);
            }
        }
        s.openAt = 1788220800;
        _expect(s, ctx, 0, 0);
        ctx.timestamp = type(uint256).max; // No timestamp addition overflow.
        _expect(s, ctx, 0, 0);
    }

    function _badBytes(bytes memory encoded, SetValidationContext memory ctx) private view {
        (uint16 reason, uint16 field) = validator.validateEncoded(encoded, ctx);
        assertEq(reason, 29);
        assertEq(field, type(uint16).max);
    }

    function test_E01_trailingForbiddenFieldsAndNoncanonicalABI() public view {
        bytes memory b = SetVectors.encoded(0);
        SetValidationContext memory ctx = _context(_spec(0));
        _badBytes(bytes.concat(b, hex"00"), ctx);
        // ABI has no extension area for draw/reveal/payout/curator, including zero-valued words.
        _badBytes(bytes.concat(b, abi.encode(uint256(0), bytes32(0), uint8(0), address(0))), ctx);
        _badBytes(hex"", ctx);
        bytes memory truncated = new bytes(b.length - 1);
        for (uint256 i; i < truncated.length; ++i) {
            truncated[i] = b[i];
        }
        _badBytes(truncated, ctx);
        b[b.length - 1] = 0x01; // Dirty description padding.
        _badBytes(b, ctx);
        b = SetVectors.encoded(0);
        assembly ("memory-safe") { mstore(add(b, 64), 65538) } // High bits in uint16 format.
        _badBytes(b, ctx);
        b = SetVectors.encoded(0);
        bytes memory tail = new bytes(b.length - 32);
        for (uint256 i; i < tail.length; ++i) {
            tail[i] = b[i + 32];
        }
        _badBytes(bytes.concat(abi.encode(uint256(64), uint256(0)), tail), ctx);
    }

    function test_E01_invalidUtf8HasByteLevelRefusal() public view {
        bytes memory b = SetVectors.encoded(0);
        b[608] = 0xff;
        (uint16 reason, uint16 field) = validator.validateEncoded(b, _context(_spec(0)));
        assertEq(reason, 6);
        assertEq(field, 3);
    }

    function test_E01_typedEntryRejectsTrailingCalldata() public view {
        SetSpecV2 memory s = _spec(0);
        bytes memory callData = abi.encodeCall(validator.validate, (s, _context(s)));
        (bool success, bytes memory result) = address(validator).staticcall(bytes.concat(callData, hex"00"));
        assertTrue(success);
        (uint16 reason, uint16 field) = abi.decode(result, (uint16, uint16));
        assertEq(reason, 29);
        assertEq(field, type(uint16).max);
    }

    function testFuzz_E01_fullWidthAmountsRoundTrip(uint256 raise, uint256 buy) public view {
        SetSpecV2 memory s = _spec(1);
        s.raise = raise == 0 ? 1 : raise;
        s.creatorBuy = buy % s.raise;
        _expect(s, _context(s), 0, 0);
        SetSpecV2 memory decoded = SetSpecV2Codec.decode(SetSpecV2Codec.encode(s));
        assertEq(decoded.raise, s.raise);
        assertEq(decoded.creatorBuy, s.creatorBuy);
    }

    function test_E01_frozenOldValidatorRejectsExisting() public pure {
        BoxSpec memory s;
        s.format = 2;
        s.version = 2;
        s.boxType = 2;
        ReleaseContext memory ctx;
        (uint16 reason, uint16 field) = BoxSpecV2.validate(s, ctx);
        assertEq(reason, 3);
        assertEq(field, 2);
    }
}
