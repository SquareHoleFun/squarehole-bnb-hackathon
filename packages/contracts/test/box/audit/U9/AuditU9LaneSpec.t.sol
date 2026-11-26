// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU9LaneBase} from "./AuditU9LaneBase.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";

/// @notice BC-001/008/014/045/052/064/065, F55, F61, F70, F74 U5, F80.
contract AuditU9LaneSpec is AuditU9LaneBase {
    function decodeVerdict(bytes calldata raw) external pure returns (uint16, uint16) {
        return BoxSpecV1.validate(abi.decode(raw, (BoxSpecV1.BoxSpec)), BoxSpecV1.contextV1());
    }

    function testProperty_AUDIT_U9_menuAndEnumBytesExhaustive() public pure {
        for (uint256 v; v < 256; ++v) {
            BoxSpecV1.BoxSpec memory s = _spec();
            s.boxType = uint8(v);
            if (v == 3) {
                s.collectionName = "";
                s.collectionSymbol = "";
                s.n = 0;
                s.artMode = 0;
                s.revealRoot = 0;
                s.metadataTable = "";
                s.revealListId = 0;
                s.marketplaceOwner = address(0);
                s.collectionCoverSha256 = 0;
            }
            _verdict(
                s,
                v == 1 ? 0 : v == 2 || v == 3 ? BoxSpecV1.REASON_NOT_OFFERED : BoxSpecV1.REASON_NOT_A_MEMBER,
                v == 1 ? 0 : BoxSpecV1.FIELD_BOX_TYPE
            );
            s = _spec();
            s.layout = uint8(v);
            _verdict(s, v == 1 ? 0 : BoxSpecV1.REASON_NOT_A_MEMBER, v == 1 ? 0 : BoxSpecV1.FIELD_LAYOUT);
            s = _spec();
            s.gradLayout = uint8(v);
            _verdict(
                s,
                v == 2 ? 0 : v == 1 ? BoxSpecV1.REASON_NOT_OFFERED : BoxSpecV1.REASON_NOT_A_MEMBER,
                v == 2 ? 0 : BoxSpecV1.FIELD_GRAD_LAYOUT
            );
            s = _spec();
            s.launchFormat = uint8(v);
            _verdict(s, v == 1 ? 0 : BoxSpecV1.REASON_NOT_A_MEMBER, v == 1 ? 0 : BoxSpecV1.FIELD_LAUNCH_FORMAT);
            s = _spec();
            s.artMode = uint8(v);
            if (v == 2) s.revealListId = 0;
            _verdict(
                s,
                v == 1 ? 0 : v == 2 ? BoxSpecV1.REASON_ADD_ON_REQUIRED : BoxSpecV1.REASON_NOT_A_MEMBER,
                v == 1 ? 0 : BoxSpecV1.FIELD_ART_MODE
            );
            s = _spec();
            s.qStream = uint8(v);
            uint16 r = v < 1 || v > 7
                ? BoxSpecV1.REASON_NOT_A_MEMBER
                : v == 4 || v == 7
                    ? BoxSpecV1.REASON_NOT_OFFERED
                    : v == 3 || v == 5 || v == 6 ? BoxSpecV1.REASON_MENU_RULE : 0;
            _verdict(s, r, r == 0 ? 0 : BoxSpecV1.FIELD_Q_STREAM);
            s = _spec();
            s.tStream = uint8(v);
            r = v < 1 || v > 7
                ? BoxSpecV1.REASON_NOT_A_MEMBER
                : v == 2 || v == 7
                    ? BoxSpecV1.REASON_NOT_OFFERED
                    : v == 4 ? BoxSpecV1.REASON_ADD_ON_REQUIRED : v == 5 || v == 6 ? BoxSpecV1.REASON_MENU_RULE : 0;
            _verdict(s, r, r == 0 ? 0 : BoxSpecV1.FIELD_T_STREAM);
        }
    }

    function testProperty_AUDIT_U9_everyNameByteAndStringLimits() public pure {
        for (uint256 c; c <= 255; ++c) {
            bool allowed = c >= 32 && c <= 126 && c != 34 && c != 92;
            for (uint256 field; field < 5; ++field) {
                BoxSpecV1.BoxSpec memory s = _spec();
                string memory value = string(abi.encodePacked(bytes1(uint8(c))));
                if (field == 0) s.tokenName = value;
                if (field == 1) s.tokenSymbol = value;
                if (field == 2) s.collectionName = value;
                if (field == 3) s.collectionSymbol = value;
                if (field == 4) s.description = value;
                _verdict(s, allowed ? 0 : BoxSpecV1.REASON_BAD_CHARACTER, allowed ? 0 : uint16(3 + field));
            }
        }
        for (uint256 which; which < 5; ++which) {
            for (uint256 edge; edge < 3; ++edge) {
                BoxSpecV1.BoxSpec memory s = _spec();
                uint256 max = which == 4 ? 1024 : which % 2 == 0 ? 32 : 11;
                string memory t = _text(edge == 0 ? 0 : max + edge - 1, "A");
                if (which == 0) s.tokenName = t;
                if (which == 1) s.tokenSymbol = t;
                if (which == 2) s.collectionName = t;
                if (which == 3) s.collectionSymbol = t;
                if (which == 4) s.description = t;
                bool ok = edge == 1 || (which == 4 && edge == 0);
                _verdict(s, ok ? 0 : BoxSpecV1.REASON_LENGTH_OUT_OF_RANGE, ok ? 0 : uint16(3 + which));
            }
        }
    }

    function testFuzz_AUDIT_U9_nAndSingleRaise(uint32 n, uint256 r) public pure {
        BoxSpecV1.BoxSpec memory s = _spec();
        s.n = n;
        bool ok = n >= 10 && n <= 10_000;
        _verdict(s, ok ? 0 : BoxSpecV1.REASON_OUT_OF_RANGE, ok ? 0 : BoxSpecV1.FIELD_N);
        s.n = 10;
        ok = r == s.raise;
        s.raise = r;
        _verdict(s, ok ? 0 : BoxSpecV1.REASON_RAISE_NOT_A_PRESET, ok ? 0 : BoxSpecV1.FIELD_RAISE);
    }

    function testProperty_AUDIT_U9_nEdgesAndVersionMenu() public pure {
        uint32[6] memory ns = [uint32(0), 9, 10, 10_000, 10_001, type(uint32).max];
        for (uint256 i; i < ns.length; ++i) {
            BoxSpecV1.BoxSpec memory s = _spec();
            s.n = ns[i];
            bool ok = i == 2 || i == 3;
            _verdict(s, ok ? 0 : BoxSpecV1.REASON_OUT_OF_RANGE, ok ? 0 : BoxSpecV1.FIELD_N);
        }
        BoxSpecV1.BoxSpec memory s = _spec();
        s.version = 2;
        _verdict(s, BoxSpecV1.REASON_DEADLINE_RULE, BoxSpecV1.FIELD_DEADLINE_DAYS);
        s.deadlineDays = 30;
        _verdict(s, 0, 0);
        BoxSpecV1.VersionContext memory ctx = BoxSpecV1.contextV1();
        assertEq(ctx.qList.length, 1);
        assertEq(ctx.qList[0].raisePresets.length, 1);
        assertEq(abi.encode(ctx), abi.encode(BoxSpecV1.contextV2()));
        ctx.gradLayouts = new uint8[](0);
        (uint16 r, uint16 f) = BoxSpecV1.validate(s, ctx);
        assertEq(r, BoxSpecV1.REASON_NOT_OFFERED);
        assertEq(f, BoxSpecV1.FIELD_GRAD_LAYOUT);
    }

    /// N=0 is explicitly offered for version 2's token-only choice, never for a collection.
    function testProperty_AUDIT_U9_tokenOnlyVersionTwoException() public pure {
        BoxSpecV1.BoxSpec memory s = _spec();
        s.version = 2;
        s.deadlineDays = 30;
        s.boxType = 3;
        s.collectionName = "";
        s.collectionSymbol = "";
        s.n = 0;
        s.artMode = 0;
        s.revealRoot = 0;
        s.metadataTable = "";
        s.revealListId = 0;
        s.marketplaceOwner = address(0);
        s.collectionCoverSha256 = 0;
        _verdict(s, 0, 0);
        s.n = 10;
        _verdict(s, BoxSpecV1.REASON_MUST_BE_ZERO, BoxSpecV1.FIELD_N);
    }

    /// Raw ABI uint8 words outside the type are rejected by the decoder before menu validation.
    function testProperty_AUDIT_U9_oversizedEncodedEnumWordsRefused() public {
        uint256[7] memory slots = [uint256(1), 11, 12, 13, 16, 17, 18];
        for (uint256 i; i < slots.length; ++i) {
            bytes memory raw = abi.encode(_spec());
            uint256 at = 64 + slots[i] * 32;
            assembly ("memory-safe") { mstore(add(raw, at), 256) }
            vm.expectRevert();
            this.decodeVerdict(raw);
        }
    }

    /// Unstructured bytes may fail decoding or return a refusal; a canonical valid encoding is a positive control.
    /// The fuzzer's dictionary holds the push bytes of every compiled contract, among them the fixtures' full
    /// encodings in the twin vector contracts, and it can hand one back whole (seen in SH-AUDIT-B0-FINAL's
    /// second-model review: worker 5, run 23 returned the demo-placeholders fixture, a valid spec). Such bytes are not
    /// unstructured: the verdict is then (0, 0); the refusal branch and the control carry the property.
    function testFuzz_AUDIT_U9_randomBytesNotAccepted(bytes calldata raw) public view {
        (bool ok, bytes memory result) =
            address(this).staticcall{gas: 2_000_000}(abi.encodeCall(this.decodeVerdict, (raw)));
        if (ok) {
            (uint16 reason, uint16 field) = abi.decode(result, (uint16, uint16));
            if (reason == 0) assertEq(field, 0);
            else assertGt(field, 0);
        }
        (uint16 valid,) = this.decodeVerdict(abi.encode(_spec()));
        assertEq(valid, 0);
    }

    function testFuzz_AUDIT_U9_hashStableAndDistinct(bytes32 seed, uint32 n) public pure {
        BoxSpecV1.BoxSpec memory s = _spec();
        s.generatorHash = seed;
        s.n = uint32(bound(n, 10, 10_000));
        bytes memory encoded = abi.encode(s);
        bytes32 h = BoxSpecV1.specHash(s);
        assertEq(BoxSpecV1.specHash(abi.decode(encoded, (BoxSpecV1.BoxSpec))), h);
        assertEq(h, keccak256(encoded));
        s.generatorHash = seed ^ bytes32(uint256(1));
        _verdict(s, 0, 0);
        assertNotEq(BoxSpecV1.specHash(s), h);
    }
}
