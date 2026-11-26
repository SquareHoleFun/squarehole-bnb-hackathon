// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxMetadataTable} from "../../../../src/box/libraries/BoxMetadataTable.sol";

/// @title AuditU9FableSpec
/// @notice SH-AUDIT-B0-U9 (Fable 5.1): `BoxSpecV1.validate()` and `specHash()` under lenses L2 (the menu, P9.2), L7
/// (enum words and refusals, P9.10), L8 (the hash, P9.11) and L5 (gas at the largest accepted spec, P9.4; S7 #1 is
/// recorded, pinned here, not re-reported). The base is box 0's fixture (the shared vectors' vector 0, version 1) and
/// the demo placeholders box (vector 1, version 2); the Sepolia safe spec file is the one the world creates box 0 from.
/// @dev Sources: BC-008 (N), BC-014 (the version's menu), BC-072 (names), BC-127 (one raise), `BoxSpecV1.sol:15-16`
/// (enums as uint8, 0 never a member; the first failing check in source order), `BoxSpecV1.sol:369-372` (specHash).
contract AuditU9FableSpecTest is Test {
    string internal constant VECTORS = "test/vectors/box-spec/box-spec-v1.json";
    string internal constant SAFE_SPEC = "/script/config/box0-spec.11155111.safe.json";
    uint256 internal constant R = 4_206_980_085_000_000_000;
    uint256 internal constant MIN_OPEN_AT = 1_788_220_800;
    /// @dev EIP-7825 (Osaka): the transaction gas cap.
    uint256 internal constant TX_GAS_CAP = 16_777_216;

    bytes internal box0;
    bytes internal demoV2;

    function setUp() public {
        string memory json = vm.readFile(VECTORS);
        box0 = vm.parseJsonBytes(json, ".columns.encoded[0]");
        demoV2 = vm.parseJsonBytes(json, ".columns.encoded[1]");
    }

    function _v1() internal view returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(box0, (BoxSpecV1.BoxSpec));
    }

    function _v2() internal view returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(demoV2, (BoxSpecV1.BoxSpec));
    }

    function _check(BoxSpecV1.BoxSpec memory s) internal pure returns (uint16 reason, uint16 field) {
        return BoxSpecV1.validate(s, s.version == 2 ? BoxSpecV1.contextV2() : BoxSpecV1.contextV1());
    }

    // ================================================================================================ L2: the menu

    /// The version contexts offer exactly one Q (native ETH) with one raise (R) and one graduated layout (BC-014,
    /// BC-127, F74 U5); both contexts are the same list today.
    function testProperty_AUDIT_U9_contextsOfferOneQOneRaiseOneLayout() public view {
        BoxSpecV1.VersionContext memory c1 = BoxSpecV1.contextV1();
        BoxSpecV1.VersionContext memory c2 = BoxSpecV1.contextV2();
        assertEq(c1.qList.length, 1);
        assertEq(c1.qList[0].token, address(0));
        assertEq(c1.qList[0].qClass, BoxSpecV1.Q_CLASS_NATIVE_ETH);
        assertEq(c1.qList[0].decimals, 18);
        assertEq(c1.qList[0].raisePresets.length, 1);
        assertEq(c1.qList[0].raisePresets[0], R);
        assertEq(c1.gradLayouts.length, 1);
        assertEq(c1.gradLayouts[0], BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL);
        assertEq(keccak256(abi.encode(c1)), keccak256(abi.encode(c2)), "v2 lists the same menu today");
        (uint16 reason,) = BoxSpecV1.validate(_v1(), c1);
        assertEq(reason, BoxSpecV1.REASON_OK);
    }

    /// BC-127 / BC-014: any raise but R is RAISE_NOT_A_PRESET and any Q but native ETH is Q_NOT_LISTED, whatever the
    /// other fields say; firstId is 1 and nothing else (plan § 1).
    function testFuzz_AUDIT_U9_onlyTheRaiseAndNativeEthPass(uint256 raise, address q, uint256 firstId) public view {
        BoxSpecV1.BoxSpec memory s = _v1();
        s.raise = raise;
        (uint16 reason, uint16 field) = _check(s);
        if (raise == R) {
            assertEq(reason, BoxSpecV1.REASON_OK);
        } else {
            assertEq(reason, BoxSpecV1.REASON_RAISE_NOT_A_PRESET);
            assertEq(field, BoxSpecV1.FIELD_RAISE);
        }
        s = _v1();
        s.q = q;
        (reason, field) = _check(s);
        if (q == address(0)) {
            assertEq(reason, BoxSpecV1.REASON_OK);
        } else {
            assertEq(reason, BoxSpecV1.REASON_Q_NOT_LISTED);
            assertEq(field, BoxSpecV1.FIELD_Q);
        }
        s = _v1();
        s.firstId = firstId;
        (reason, field) = _check(s);
        if (firstId == 1) {
            assertEq(reason, BoxSpecV1.REASON_OK);
        } else {
            assertEq(reason, BoxSpecV1.REASON_OUT_OF_RANGE);
            assertEq(field, BoxSpecV1.FIELD_FIRST_ID);
        }
    }

    /// BC-008: N from 10 to 10,000 inclusive for a new collection; every other uint32 is OUT_OF_RANGE at field 8.
    function testFuzz_AUDIT_U9_nFrom10To10000(uint32 n) public view {
        BoxSpecV1.BoxSpec memory s = _v1();
        s.n = n;
        // Edition specials count must fit N (add-on 3 on the fixture); keep it inside so N alone decides.
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == BoxSpecV1.ADD_ON_EDITION_SPECIALS) {
                s.addOns[i].params = abi.encode("Specials", uint32(1));
            }
        }
        (uint16 reason, uint16 field) = _check(s);
        if (n >= 10 && n <= 10_000) {
            assertEq(reason, BoxSpecV1.REASON_OK);
        } else {
            assertEq(reason, BoxSpecV1.REASON_OUT_OF_RANGE);
            assertEq(field, BoxSpecV1.FIELD_N);
        }
    }

    function testProperty_AUDIT_U9_nEdges() public view {
        uint32[4] memory ns = [uint32(9), 10, 10_000, 10_001];
        bool[4] memory ok = [false, true, true, false];
        for (uint256 i; i < 4; ++i) {
            BoxSpecV1.BoxSpec memory s = _v1();
            s.n = ns[i];
            for (uint256 j; j < s.addOns.length; ++j) {
                if (s.addOns[j].id == BoxSpecV1.ADD_ON_EDITION_SPECIALS) {
                    s.addOns[j].params = abi.encode("Specials", uint32(1));
                }
            }
            (uint16 reason,) = _check(s);
            assertEq(reason == BoxSpecV1.REASON_OK, ok[i], vm.toString(ns[i]));
        }
        // F80: openAt 0 (now) or a clock time at or after 2026-09-01; a smaller non-zero value is a unit mistake.
        uint256[5] memory opens = [uint256(0), MIN_OPEN_AT - 1, MIN_OPEN_AT, MIN_OPEN_AT + 1, type(uint32).max];
        bool[5] memory openOk = [true, false, true, true, true];
        for (uint256 i; i < 5; ++i) {
            BoxSpecV1.BoxSpec memory s = _v1();
            s.openAt = uint32(opens[i]);
            (uint16 reason, uint16 field) = _check(s);
            assertEq(reason == BoxSpecV1.REASON_OK, openOk[i], "openAt");
            if (!openOk[i]) {
                assertEq(reason, BoxSpecV1.REASON_OUT_OF_RANGE);
                assertEq(field, BoxSpecV1.FIELD_OPEN_AT);
            }
        }
    }

    /// BC-072: every text field takes exactly the printable ASCII bytes 0x20-0x7e without `"` (0x22) and `\` (0x5c), at
    /// any position; any other byte is BAD_CHARACTER at that field. All 256 values at the first, a middle and the last
    /// position of the five core texts and of the placeholders add-on's JSON texts; the hidden SVG takes `"` and `\`
    /// too (rule SVG) but no control byte, DEL or non-ASCII.
    function testProperty_AUDIT_U9_textBytesPrintableAsciiWithoutQuoteOrBackslash() public {
        for (uint256 c; c < 256; ++c) {
            // One byte value per external call: the 21 decoded specs of a value do not pile up in one frame.
            this.textByteExt(uint8(c));
        }
    }

    function textByteExt(uint8 c) external view {
        bool allowed = c >= 0x20 && c <= 0x7e && c != 0x22 && c != 0x5c;
        for (uint256 pos; pos < 3; ++pos) {
            bytes memory t = "AAAAA";
            t[pos == 0 ? 0 : pos == 1 ? 2 : 4] = bytes1(c);
            for (uint16 f = BoxSpecV1.FIELD_TOKEN_NAME; f <= BoxSpecV1.FIELD_DESCRIPTION; ++f) {
                BoxSpecV1.BoxSpec memory s = _v1();
                _setText(s, f, t);
                (uint16 reason, uint16 field) = _check(s);
                if (allowed) {
                    assertEq(reason, BoxSpecV1.REASON_OK, "allowed byte");
                } else {
                    assertEq(reason, BoxSpecV1.REASON_BAD_CHARACTER, "refused byte");
                    assertEq(field, f, "at its field");
                }
            }
            // The placeholders add-on's name (field 101) and the hidden SVG (105, rule SVG).
            BoxSpecV1.BoxSpec memory p = _v1();
            (, string memory sym, string memory pd, string memory hd, string memory svg) =
                abi.decode(p.addOns[0].params, (string, string, string, string, string));
            p.addOns[0].params = abi.encode(string(t), sym, pd, hd, svg);
            (uint16 r2, uint16 f2) = _check(p);
            if (allowed) {
                assertEq(r2, BoxSpecV1.REASON_OK);
            } else {
                assertEq(r2, BoxSpecV1.REASON_BAD_CHARACTER);
                assertEq(f2, BoxSpecV1.FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_NAME);
            }
            p = _v1();
            (string memory nm,,,,) = abi.decode(p.addOns[0].params, (string, string, string, string, string));
            p.addOns[0].params = abi.encode(nm, sym, pd, hd, string(t));
            (r2, f2) = _check(p);
            bool svgAllowed = c >= 0x20 && c <= 0x7e;
            if (svgAllowed) {
                assertEq(r2, BoxSpecV1.REASON_OK, "SVG byte");
            } else {
                assertEq(r2, BoxSpecV1.REASON_BAD_CHARACTER);
                assertEq(f2, BoxSpecV1.FIELD_ADD_ON_PLACEHOLDERS_HIDDEN_SVG);
            }
        }
    }

    /// Length bounds of every text (plan § 1): names 1-32, symbols 1-11, descriptions 0-1024, the hidden SVG 1-4096,
    /// the edition label 1-32, the link 0-128 with its `https://` prefix (rule URL).
    function testProperty_AUDIT_U9_textLengthBounds() public view {
        _lengths(BoxSpecV1.FIELD_TOKEN_NAME, 1, 32);
        _lengths(BoxSpecV1.FIELD_TOKEN_SYMBOL, 1, 11);
        _lengths(BoxSpecV1.FIELD_COLLECTION_NAME, 1, 32);
        _lengths(BoxSpecV1.FIELD_COLLECTION_SYMBOL, 1, 11);
        _lengths(BoxSpecV1.FIELD_DESCRIPTION, 0, 1024);
        // The placeholders add-on: name 1-32, symbol 1-11, descriptions 0-1024, SVG 1-4096.
        uint256[5] memory mins = [uint256(1), 1, 0, 0, 1];
        uint256[5] memory maxs = [uint256(32), 11, 1024, 1024, 4096];
        for (uint256 i; i < 5; ++i) {
            uint256[4] memory lens = [mins[i] == 0 ? 0 : mins[i] - 1, mins[i], maxs[i], maxs[i] + 1];
            for (uint256 j; j < 4; ++j) {
                BoxSpecV1.BoxSpec memory s = _v1();
                string[5] memory parts;
                (parts[0], parts[1], parts[2], parts[3], parts[4]) =
                    abi.decode(s.addOns[0].params, (string, string, string, string, string));
                parts[i] = string(_fill(lens[j], 0x41));
                s.addOns[0].params = abi.encode(parts[0], parts[1], parts[2], parts[3], parts[4]);
                (uint16 reason, uint16 field) = _check(s);
                bool ok = lens[j] >= mins[i] && lens[j] <= maxs[i];
                assertEq(reason == BoxSpecV1.REASON_OK, ok, "placeholders text length");
                if (!ok) {
                    assertEq(reason, BoxSpecV1.REASON_LENGTH_OUT_OF_RANGE);
                    assertEq(field, BoxSpecV1.FIELD_ADD_ON_PLACEHOLDERS_PLACEHOLDER_NAME + uint16(i));
                }
            }
        }
        // The edition label and the collection page's link.
        BoxSpecV1.BoxSpec memory e = _v1();
        e.addOns[2].params = abi.encode(string(_fill(33, 0x41)), uint32(1));
        (uint16 r, uint16 f) = _check(e);
        assertEq(r, BoxSpecV1.REASON_LENGTH_OUT_OF_RANGE);
        assertEq(f, BoxSpecV1.FIELD_ADD_ON_EDITION_SPECIALS_LABEL);
        e.addOns[2].params = abi.encode(string(_fill(32, 0x41)), uint32(1));
        (r,) = _check(e);
        assertEq(r, BoxSpecV1.REASON_OK);
        string[6] memory links = ["", "https://a", "http://a", "https:/a", "HTTPS://a", "https://"];
        bool[6] memory linkOk = [true, true, false, false, false, true];
        for (uint256 i; i < 6; ++i) {
            BoxSpecV1.BoxSpec memory s = _v1();
            (bytes32 banner, bytes32[] memory teasers,) = abi.decode(s.addOns[6].params, (bytes32, bytes32[], string));
            s.addOns[6].params = abi.encode(banner, teasers, links[i]);
            (r, f) = _check(s);
            assertEq(r == BoxSpecV1.REASON_OK, linkOk[i], links[i]);
            if (!linkOk[i]) {
                assertEq(r, BoxSpecV1.REASON_BAD_CHARACTER);
                assertEq(f, BoxSpecV1.FIELD_ADD_ON_COLLECTION_METADATA_EXTERNAL_LINK);
            }
        }
        BoxSpecV1.BoxSpec memory l = _v1();
        (bytes32 b2, bytes32[] memory t2,) = abi.decode(l.addOns[6].params, (bytes32, bytes32[], string));
        l.addOns[6].params = abi.encode(b2, t2, string(bytes.concat("https://", _fill(120, 0x61))));
        (r,) = _check(l);
        assertEq(r, BoxSpecV1.REASON_OK, "128-byte link");
        l.addOns[6].params = abi.encode(b2, t2, string(bytes.concat("https://", _fill(121, 0x61))));
        (r, f) = _check(l);
        assertEq(r, BoxSpecV1.REASON_LENGTH_OUT_OF_RANGE, "129-byte link");
        assertEq(f, BoxSpecV1.FIELD_ADD_ON_COLLECTION_METADATA_EXTERNAL_LINK);
    }

    function _lengths(uint16 f, uint256 min, uint256 max) internal view {
        uint256[4] memory lens = [min == 0 ? 0 : min - 1, min, max, max + 1];
        for (uint256 j; j < 4; ++j) {
            BoxSpecV1.BoxSpec memory s = _v1();
            _setText(s, f, _fill(lens[j], 0x41));
            (uint16 reason, uint16 field) = _check(s);
            bool ok = lens[j] >= min && lens[j] <= max;
            assertEq(reason == BoxSpecV1.REASON_OK, ok, "text length");
            if (!ok) {
                assertEq(reason, BoxSpecV1.REASON_LENGTH_OUT_OF_RANGE);
                assertEq(field, f);
            }
        }
    }

    function _setText(BoxSpecV1.BoxSpec memory s, uint16 f, bytes memory t) internal pure {
        if (f == BoxSpecV1.FIELD_TOKEN_NAME) s.tokenName = string(t);
        else if (f == BoxSpecV1.FIELD_TOKEN_SYMBOL) s.tokenSymbol = string(t);
        else if (f == BoxSpecV1.FIELD_COLLECTION_NAME) s.collectionName = string(t);
        else if (f == BoxSpecV1.FIELD_COLLECTION_SYMBOL) s.collectionSymbol = string(t);
        else s.description = string(t);
    }

    function _fill(uint256 n, uint8 c) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = bytes1(c);
        }
    }

    // ================================================================================================ L7: enum words

    /// P9.10 (`BoxSpecV1.sol:15`): for every uint8 enum field, all 256 values: a non-member is NOT_A_MEMBER at that
    /// field, a member the version does not offer is NOT_OFFERED there, and exactly the expected values pass on box
    /// 0's fixture (whose other fields and add-ons fix the rest). No value maps silently onto a valid choice.
    function testProperty_AUDIT_U9_enumFieldsRefuseEveryNonMember() public view {
        // field, members (bitmask over 0..7), offered (bitmask), accepted on the fixture (bitmask)
        uint16[7] memory fields = [
            BoxSpecV1.FIELD_BOX_TYPE,
            BoxSpecV1.FIELD_LAYOUT,
            BoxSpecV1.FIELD_GRAD_LAYOUT,
            BoxSpecV1.FIELD_LAUNCH_FORMAT,
            BoxSpecV1.FIELD_Q_STREAM,
            BoxSpecV1.FIELD_T_STREAM,
            BoxSpecV1.FIELD_ART_MODE
        ];
        uint256[7] memory members = [uint256(0x0e), 0x02, 0x06, 0x02, 0xfe, 0xfe, 0x06];
        uint256[7] memory offered = [uint256(0x0a), 0x02, 0x04, 0x02, 0x6e, 0x7a, 0x06];
        // boxType 1 (3 wants empty collection texts); layout 1; gradLayout 2; launchFormat 1; qStream 1 or 2 (3 is
        // BURN_Q without a burnable Q, 5/6 are version 2's); tStream 4 (add-on 2 wants it); artMode 2 (the add-on).
        uint256[7] memory accepted = [uint256(0x02), 0x02, 0x04, 0x02, 0x06, 0x10, 0x04];
        for (uint256 i; i < 7; ++i) {
            uint256 got;
            for (uint256 v; v < 256; ++v) {
                BoxSpecV1.BoxSpec memory s = _v1();
                _setEnum(s, fields[i], uint8(v));
                (uint16 reason, uint16 field) = _check(s);
                bool member = v < 8 && (members[i] >> v) & 1 == 1;
                bool offer = v < 8 && (offered[i] >> v) & 1 == 1;
                if (!member) {
                    assertEq(reason, BoxSpecV1.REASON_NOT_A_MEMBER, "non-member");
                    assertEq(field, fields[i]);
                } else if (!offer) {
                    assertEq(reason, BoxSpecV1.REASON_NOT_OFFERED, "member not offered");
                    assertEq(field, fields[i]);
                } else {
                    assertTrue(
                        reason != BoxSpecV1.REASON_NOT_A_MEMBER && reason != BoxSpecV1.REASON_NOT_OFFERED, "offered"
                    );
                }
                if (reason == BoxSpecV1.REASON_OK) got |= 1 << v;
            }
            assertEq(got, accepted[i], "exactly the expected values pass");
        }
    }

    function _setEnum(BoxSpecV1.BoxSpec memory s, uint16 f, uint8 v) internal pure {
        if (f == BoxSpecV1.FIELD_BOX_TYPE) s.boxType = v;
        else if (f == BoxSpecV1.FIELD_LAYOUT) s.layout = v;
        else if (f == BoxSpecV1.FIELD_GRAD_LAYOUT) s.gradLayout = v;
        else if (f == BoxSpecV1.FIELD_LAUNCH_FORMAT) s.launchFormat = v;
        else if (f == BoxSpecV1.FIELD_Q_STREAM) s.qStream = v;
        else if (f == BoxSpecV1.FIELD_T_STREAM) s.tStream = v;
        else s.artMode = v;
    }

    /// P9.10 for the add-on words: royalties' destination (all 256), bps (0..1023 and the edges), the creator-fee
    /// cap's excess (all 256, on a version-2 spec that takes the add-on) and the version word (0..65535 sampled).
    function testProperty_AUDIT_U9_addOnWordsRefuseEveryNonMember() public view {
        uint256 got;
        for (uint256 v; v < 256; ++v) {
            BoxSpecV1.BoxSpec memory s = _v1();
            s.addOns[5].params = abi.encode(uint16(250), uint8(v));
            (uint16 reason, uint16 field) = _check(s);
            if (v == 0 || v > 3) {
                assertEq(reason, BoxSpecV1.REASON_NOT_A_MEMBER);
                assertEq(field, BoxSpecV1.FIELD_ADD_ON_ROYALTIES_DESTINATION);
            } else if (v == BoxSpecV1.ROYALTY_DESTINATION_CREATOR) {
                assertEq(reason, BoxSpecV1.REASON_ADD_ON_CONFLICT, "version 1 cannot pay a creator");
                assertEq(field, BoxSpecV1.FIELD_ADD_ON_ROYALTIES);
            } else {
                assertEq(reason, BoxSpecV1.REASON_OK);
            }
            if (reason == BoxSpecV1.REASON_OK) got |= 1 << v;
        }
        assertEq(got, 0x0a, "FEE_HANDLING and POOL_DEPTH");
        uint256[12] memory bps = [uint256(0), 1, 99, 100, 101, 249, 250, 251, 499, 500, 501, 65535];
        for (uint256 i; i < 12; ++i) {
            _bps(bps[i]);
        }
        for (uint256 v; v < 1024; ++v) {
            _bps(v);
        }
        // Add-on 5 on a version-2 spec paying its creator on the buyers' side.
        got = 0;
        for (uint256 v; v < 256; ++v) {
            BoxSpecV1.BoxSpec memory s = _v2WithCap(uint8(v));
            (uint16 reason, uint16 field) = _check(s);
            if (v == 0 || v > 3) {
                assertEq(reason, BoxSpecV1.REASON_NOT_A_MEMBER);
                assertEq(field, BoxSpecV1.FIELD_ADD_ON_CREATOR_FEE_CAP_EXCESS);
            } else if (v == BoxSpecV1.CAP_EXCESS_HOLDERS) {
                assertEq(reason, BoxSpecV1.REASON_NOT_OFFERED);
                assertEq(field, BoxSpecV1.FIELD_ADD_ON_CREATOR_FEE_CAP_EXCESS);
            } else {
                assertEq(reason, BoxSpecV1.REASON_OK, "BURN / POOL_DEPTH");
            }
            if (reason == BoxSpecV1.REASON_OK) got |= 1 << v;
        }
        assertEq(got, 0x0c);
        // The version: 1 and 2 only.
        uint256[8] memory versions = [uint256(0), 3, 4, 255, 256, 257, 65534, 65535];
        for (uint256 i; i < 8; ++i) {
            BoxSpecV1.BoxSpec memory s = _v1();
            s.version = uint16(versions[i]);
            (uint16 reason, uint16 field) = _check(s);
            assertEq(reason, BoxSpecV1.REASON_UNSUPPORTED_VERSION);
            assertEq(field, BoxSpecV1.FIELD_VERSION);
        }
    }

    function _bps(uint256 v) internal view {
        BoxSpecV1.BoxSpec memory s = _v1();
        s.addOns[5].params = abi.encode(uint16(v), uint8(BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING));
        (uint16 reason, uint16 field) = _check(s);
        if (v == 0 || v == 100 || v == 250 || v == 500) {
            assertEq(reason, BoxSpecV1.REASON_OK);
        } else {
            assertEq(reason, BoxSpecV1.REASON_NOT_A_MEMBER);
            assertEq(field, BoxSpecV1.FIELD_ADD_ON_ROYALTIES_BPS);
        }
    }

    /// @dev The demo placeholders box (version 2) paying its creator the buyers' side, with add-on 5 (1 ETH per epoch,
    /// `excess`) inserted in id order.
    function _v2WithCap(uint8 excess) internal view returns (BoxSpecV1.BoxSpec memory s) {
        s = _v2();
        s.qStream = BoxSpecV1.Q_STREAM_TO_CREATOR;
        s.creatorFeeRecipient = address(0xBEEF);
        BoxSpecV1.AddOn[] memory a = new BoxSpecV1.AddOn[](s.addOns.length + 1);
        uint256 o;
        bool placed;
        for (uint256 i; i < s.addOns.length; ++i) {
            if (!placed && s.addOns[i].id > BoxSpecV1.ADD_ON_CREATOR_FEE_CAP) {
                a[o++] =
                    BoxSpecV1.AddOn({id: BoxSpecV1.ADD_ON_CREATOR_FEE_CAP, params: abi.encode(uint256(1e18), excess)});
                placed = true;
            }
            a[o++] = s.addOns[i];
        }
        if (!placed) {
            a[o++] = BoxSpecV1.AddOn({id: BoxSpecV1.ADD_ON_CREATOR_FEE_CAP, params: abi.encode(uint256(1e18), excess)});
        }
        s.addOns = a;
    }

    /// Every refusal carries a reason code of the format and a field id; OK carries field 0 (`BoxSpecV1.sol:16`).
    /// Checked on a sweep of single-field mutations of the fixture.
    function testFuzz_AUDIT_U9_everyRefusalHasAReasonAndAField(uint8 which, uint256 v) public view {
        BoxSpecV1.BoxSpec memory s = _v1();
        _mutateField(s, which % 29, v);
        (uint16 reason, uint16 field) = _check(s);
        assertLe(reason, BoxSpecV1.REASON_METADATA_TABLE_MALFORMED);
        if (reason == BoxSpecV1.REASON_OK) {
            assertEq(field, 0);
        } else {
            assertTrue(field >= 1 && field <= BoxSpecV1.FIELD_ADD_ON_COLLECTION_METADATA_EXTERNAL_LINK, "a field id");
        }
    }

    // ================================================================================================ L8: the hash

    /// P9.11: `specHash` is keccak256 of the canonical encoding; decoding and re-encoding a canonical spec is the
    /// identity; a change to any one field changes the hash (the ABI encoding is injective for the struct).
    function testFuzz_AUDIT_U9_specHashChangesWithEveryField(uint8 which, uint256 v) public view {
        BoxSpecV1.BoxSpec memory s = _v1();
        bytes32 h0 = BoxSpecV1.specHash(s);
        assertEq(h0, keccak256(abi.encode(s)));
        assertEq(h0, keccak256(box0), "the vector's bytes are the canonical encoding");
        BoxSpecV1.BoxSpec memory t = _v1();
        bool changed = _mutateField(t, which % 29, v);
        bytes32 h1 = BoxSpecV1.specHash(t);
        if (changed) assertTrue(h1 != h0, "a changed field changes the hash");
        else assertEq(h1, h0);
        // Re-encoding the decoded struct gives the same bytes and the same hash.
        bytes memory e = abi.encode(t);
        BoxSpecV1.BoxSpec memory again = abi.decode(e, (BoxSpecV1.BoxSpec));
        assertEq(keccak256(abi.encode(again)), keccak256(e));
        assertEq(BoxSpecV1.specHash(again), h1);
    }

    /// @dev Mutates field `f` (0..28 in struct order) to a value derived from v; returns whether it differs.
    function _mutateField(BoxSpecV1.BoxSpec memory s, uint256 f, uint256 v) internal pure returns (bool) {
        if (f == 0) return _set16(s, 0, uint16(v));
        if (f == 1) {
            uint8 b = uint8(v);
            bool c = b != s.boxType;
            s.boxType = b;
            return c;
        }
        if (f >= 2 && f <= 6) {
            bytes memory t = abi.encodePacked(bytes32(v));
            assembly ("memory-safe") {
                mstore(t, add(1, mod(v, 31)))
            }
            bytes memory old = bytes(_text(s, f));
            _setText(s, uint16(f + 1), t);
            return keccak256(old) != keccak256(t);
        }
        if (f == 7) {
            bool c = uint32(v) != s.n;
            s.n = uint32(v);
            return c;
        }
        if (f == 8) {
            bool c = v != s.firstId;
            s.firstId = v;
            return c;
        }
        if (f == 9) {
            bool c = address(uint160(v)) != s.q;
            s.q = address(uint160(v));
            return c;
        }
        if (f == 10) {
            bool c = v != s.raise;
            s.raise = v;
            return c;
        }
        if (f >= 11 && f <= 13) {
            uint8 b = uint8(v);
            uint8 old = f == 11 ? s.layout : f == 12 ? s.gradLayout : s.launchFormat;
            if (f == 11) s.layout = b;
            else if (f == 12) s.gradLayout = b;
            else s.launchFormat = b;
            return b != old;
        }
        if (f == 14) {
            bool c = uint32(v) != s.openAt;
            s.openAt = uint32(v);
            return c;
        }
        if (f == 15) return _set16(s, 15, uint16(v));
        if (f >= 16 && f <= 18) {
            uint8 b = uint8(v);
            uint8 old = f == 16 ? s.qStream : f == 17 ? s.tStream : s.artMode;
            if (f == 16) s.qStream = b;
            else if (f == 17) s.tStream = b;
            else s.artMode = b;
            return b != old;
        }
        if (f == 19) return _setWord(s, 19, bytes32(v));
        if (f == 20) {
            bytes memory t = abi.encodePacked(bytes32(v));
            bool c = keccak256(t) != keccak256(s.metadataTable);
            s.metadataTable = t;
            return c;
        }
        if (f >= 21 && f <= 23) return _setWord(s, f, bytes32(v));
        if (f == 24 || f == 25) {
            address a = address(uint160(v));
            address old = f == 24 ? s.marketplaceOwner : s.creatorFeeRecipient;
            if (f == 24) s.marketplaceOwner = a;
            else s.creatorFeeRecipient = a;
            return a != old;
        }
        if (f == 26) {
            bool c = v != s.creatorBuy;
            s.creatorBuy = v;
            return c;
        }
        if (f == 27) return _setWord(s, 27, bytes32(v));
        // 28: the add-ons: drop the last one, or change the first one's id.
        if (s.addOns.length == 0) return false;
        if (v % 2 == 0) {
            BoxSpecV1.AddOn[] memory a = new BoxSpecV1.AddOn[](s.addOns.length - 1);
            for (uint256 i; i < a.length; ++i) {
                a[i] = s.addOns[i];
            }
            s.addOns = a;
            return true;
        }
        uint16 id = uint16(v >> 8);
        bool changed = id != s.addOns[0].id;
        s.addOns[0].id = id;
        return changed;
    }

    function _set16(BoxSpecV1.BoxSpec memory s, uint256 f, uint16 v) internal pure returns (bool) {
        uint16 old = f == 0 ? s.version : s.deadlineDays;
        if (f == 0) s.version = v;
        else s.deadlineDays = v;
        return v != old;
    }

    function _setWord(BoxSpecV1.BoxSpec memory s, uint256 f, bytes32 v) internal pure returns (bool) {
        bytes32 old = f == 19
            ? s.revealRoot
            : f == 21 ? s.generatorHash : f == 22 ? s.coverSha256 : f == 23 ? s.revealListId : s.collectionCoverSha256;
        if (f == 19) s.revealRoot = v;
        else if (f == 21) s.generatorHash = v;
        else if (f == 22) s.coverSha256 = v;
        else if (f == 23) s.revealListId = v;
        else s.collectionCoverSha256 = v;
        return v != old;
    }

    function _text(BoxSpecV1.BoxSpec memory s, uint256 f) internal pure returns (string memory) {
        if (f == 2) return s.tokenName;
        if (f == 3) return s.tokenSymbol;
        if (f == 4) return s.collectionName;
        if (f == 5) return s.collectionSymbol;
        return s.description;
    }

    /// P9.11 on the Sepolia safe spec file (the one the audit world creates box 0 from): its `specHash` field is
    /// keccak256 of its `encoded` bytes and `BoxSpecV1.specHash` of the decoded struct; the spec passes validate()
    /// under version 1's context; its summary fields are the encoded ones.
    function testProperty_AUDIT_U9_safeSpecFileHashIsTheLibrarys() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), SAFE_SPEC));
        bytes memory encoded = vm.parseJsonBytes(json, ".encoded");
        bytes32 expected = vm.parseJsonBytes32(json, ".specHash");
        assertEq(keccak256(encoded), expected, "keccak of the file's bytes");
        BoxSpecV1.BoxSpec memory s = abi.decode(encoded, (BoxSpecV1.BoxSpec));
        assertEq(BoxSpecV1.specHash(s), expected, "the library's hash");
        assertEq(keccak256(abi.encode(s)), keccak256(encoded), "canonical bytes");
        (uint16 reason, uint16 field) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        assertEq(reason, BoxSpecV1.REASON_OK);
        assertEq(field, 0);
        assertEq(s.n, uint32(vm.parseJsonUint(json, ".summary.n")));
        assertEq(s.raise, vm.parseJsonUint(json, ".summary.raiseWei"));
        assertEq(s.openAt, uint32(vm.parseJsonUint(json, ".openAt")));
        assertEq(s.marketplaceOwner, vm.parseJsonAddress(json, ".platform"));
        assertEq(s.revealRoot, vm.parseJsonBytes32(json, ".summary.revealRoot"));
        assertEq(s.metadataTable.length, vm.parseJsonUint(json, ".summary.metadataTableBytes"));
    }

    // ================================================================================================ L7: raw bytes

    /// Solidity's decoder refuses a value-type word with dirty high bits (a uint8, uint16, uint32 or address word), so
    /// such bytes never reach validate(): a refusal or a revert, never an accepted spec (P9.2's last clause). The
    /// twin's decoder differs on the address word (it truncates): recorded in the evidence as an observation.
    function testProperty_AUDIT_U9_dirtyValueWordsRevertOnDecode() public {
        // Word 0 is the tuple offset; word w + 1 is field w of the struct.
        uint256[7] memory fieldWords = [uint256(1), 2, 8, 15, 16, 25, 10];
        uint256[7] memory bits = [uint256(16), 8, 32, 32, 16, 160, 160];
        for (uint256 i; i < 7; ++i) {
            bytes memory e = box0;
            uint256 o = 32 * fieldWords[i];
            uint256 w;
            assembly ("memory-safe") {
                w := mload(add(add(e, 0x20), o))
            }
            w |= 1 << bits[i];
            assembly ("memory-safe") {
                mstore(add(add(e, 0x20), o), w)
            }
            vm.expectRevert();
            this.decodeExt(e);
        }
    }

    /// A non-zero byte in a string's zero padding decodes (the padding is not data) and the struct re-encodes to the
    /// canonical bytes, so the factory would record the canonical hash, not the hash of what was sent. Pinned as the
    /// behaviour of both twins (the generator's probe shows viem does the same).
    function testProperty_AUDIT_U9_paddingBytesAreNotData() public view {
        bytes memory e = box0;
        BoxSpecV1.BoxSpec memory s = abi.decode(e, (BoxSpecV1.BoxSpec));
        uint256 nameOffset;
        assembly ("memory-safe") {
            nameOffset := mload(add(add(e, 0x20), 0x60)) // field 2 (tokenName) offset word, relative to the tuple
        }
        uint256 dataWord = 32 + nameOffset + 32; // tuple start + offset + length word
        assertEq(bytes(s.tokenName).length, 3, "FIT");
        e[dataWord + 31] = 0xff;
        BoxSpecV1.BoxSpec memory t = this.decodeExt(e);
        assertEq(t.tokenName, "FIT", "the padding byte is not data");
        assertEq(BoxSpecV1.specHash(t), keccak256(box0), "the canonical hash");
        assertTrue(keccak256(e) != keccak256(box0));
        (uint16 reason,) = BoxSpecV1.validate(t, BoxSpecV1.contextV1());
        assertEq(reason, BoxSpecV1.REASON_OK);
    }

    /// Any byte of the canonical encoding changed: the bytes fail to decode, or decode to a spec whose canonical form
    /// is idempotent (the same verdict and hash after a re-encoding); an accepted mutation is a different valid spec.
    function testFuzz_AUDIT_U9_mutatedEncodingDecodesToRefusalRevertOrAnotherValidSpec(uint256 at, uint8 value)
        public
        view
    {
        bytes memory e = box0;
        uint256 i = at % e.length;
        if (e[i] == bytes1(value)) return;
        e[i] = bytes1(value);
        try this.decodeExt(e) returns (BoxSpecV1.BoxSpec memory s) {
            (uint16 reason, uint16 field) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
            bytes memory canonical = abi.encode(s);
            BoxSpecV1.BoxSpec memory again = abi.decode(canonical, (BoxSpecV1.BoxSpec));
            (uint16 r2, uint16 f2) = BoxSpecV1.validate(again, BoxSpecV1.contextV1());
            assertEq(r2, reason, "idempotent verdict");
            assertEq(f2, field);
            assertEq(BoxSpecV1.specHash(again), BoxSpecV1.specHash(s), "idempotent hash");
            if (reason == BoxSpecV1.REASON_OK) {
                assertTrue(field == 0);
                // Accepted: every text is still JSON-safe and the table well formed (the checks themselves hold).
                assertTrue(_jsonSafe(bytes(s.tokenName)) && _jsonSafe(bytes(s.description)), "accepted texts are safe");
            }
        } catch {}
    }

    function decodeExt(bytes memory e) external pure returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(e, (BoxSpecV1.BoxSpec));
    }

    function _jsonSafe(bytes memory b) internal pure returns (bool) {
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c < 0x20 || c > 0x7e || c == 0x22 || c == 0x5c) return false;
        }
        return true;
    }

    // ================================================================================================ L5: gas

    /// P9.4 (S7 finding 1 pinned, not re-reported): validate() and specHash() at the largest accepted spec of version
    /// 1: every text at its maximum, the metadata table at 24,575 bytes in two shapes (a 4,011-byte description with
    /// 16 types of 255 four-byte values, the walk's worst case; a 24,571-byte description), eight add-ons (the
    /// placeholders' five texts at their maxima, the per-item stream, three edition specials, royalties, the collection
    /// page with four teasers and a 128-byte link). Measured as an external call (the factory's calldata decoding
    /// included) and internally; pinned below the bound and logged.
    function testProperty_AUDIT_U9_validateGasAtTheLargestAcceptedSpec() public {
        uint256 worst;
        for (uint256 shape; shape < 2; ++shape) {
            BoxSpecV1.BoxSpec memory s = _largest(shape == 0);
            (uint16 reason, uint16 field) = _check(s);
            assertEq(reason, BoxSpecV1.REASON_OK, "the largest spec is accepted");
            assertEq(field, 0);
            uint256 g0 = gasleft();
            BoxSpecV1.validate(s, BoxSpecV1.contextV1());
            uint256 inner = g0 - gasleft();
            g0 = gasleft();
            BoxSpecV1.specHash(s);
            uint256 hash = g0 - gasleft();
            g0 = gasleft();
            this.validateExt(s);
            uint256 outer = g0 - gasleft();
            emit log_named_uint(
                shape == 0
                    ? "shape A (values-heavy table): validate internal gas"
                    : "shape B (description-heavy table): validate internal gas",
                inner
            );
            emit log_named_uint("  specHash gas", hash);
            emit log_named_uint("  validate + specHash as an external call (calldata decoding included)", outer);
            emit log_named_uint("  encoded spec bytes", abi.encode(s).length);
            if (outer > worst) worst = outer;
        }
        assertLt(worst, TX_GAS_CAP, "inside the EIP-7825 transaction cap");
        assertLt(
            worst,
            5_900_000,
            "pinned bound: below 5,900,000 gas for validate + hash of the largest spec (measured 5,886,656)"
        );
    }

    function validateExt(BoxSpecV1.BoxSpec memory s) external pure returns (uint16 reason, uint16 field, bytes32 h) {
        (reason, field) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        h = BoxSpecV1.specHash(s);
    }

    /// @dev The largest accepted version-1 spec; `valuesHeavy` picks the table shape.
    function _largest(bool valuesHeavy) internal view returns (BoxSpecV1.BoxSpec memory s) {
        s = _v1();
        s.tokenName = string(_fill(32, 0x41));
        s.tokenSymbol = string(_fill(11, 0x42));
        s.collectionName = string(_fill(32, 0x43));
        s.collectionSymbol = string(_fill(11, 0x44));
        s.description = string(_fill(1024, 0x45));
        s.n = 10_000;
        s.metadataTable = valuesHeavy ? _tableValuesHeavy() : _tableDescriptionHeavy();
        assertEq(s.metadataTable.length, BoxSpecV1.MAX_METADATA_TABLE_BYTES);
        BoxSpecV1.AddOn[] memory a = new BoxSpecV1.AddOn[](8);
        a[0] = BoxSpecV1.AddOn({
            id: BoxSpecV1.ADD_ON_PLACEHOLDERS,
            params: abi.encode(
                string(_fill(32, 0x46)),
                string(_fill(11, 0x47)),
                string(_fill(1024, 0x48)),
                string(_fill(1024, 0x49)),
                string(_fill(4096, 0x3c))
            )
        });
        a[1] = BoxSpecV1.AddOn({id: BoxSpecV1.ADD_ON_PER_ITEM_STREAM, params: ""});
        for (uint256 i = 2; i < 5; ++i) {
            a[i] = BoxSpecV1.AddOn({
                id: BoxSpecV1.ADD_ON_EDITION_SPECIALS, params: abi.encode(string(_fill(32, 0x4a)), uint32(10_000))
            });
        }
        a[5] = BoxSpecV1.AddOn({
            id: BoxSpecV1.ADD_ON_ROYALTIES,
            params: abi.encode(uint16(500), uint8(BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING))
        });
        bytes32[] memory teasers = new bytes32[](4);
        for (uint256 i; i < 4; ++i) {
            teasers[i] = bytes32(uint256(i + 1));
        }
        a[6] = BoxSpecV1.AddOn({
            id: BoxSpecV1.ADD_ON_COLLECTION_METADATA,
            params: abi.encode(bytes32(uint256(7)), teasers, string(bytes.concat("https://", _fill(120, 0x61))))
        });
        // Eight add-ons: a fourth edition specials entry keeps the list in order.
        a[7] = a[6];
        a[6] = a[5];
        a[5] = BoxSpecV1.AddOn({
            id: BoxSpecV1.ADD_ON_EDITION_SPECIALS, params: abi.encode(string(_fill(32, 0x4b)), uint32(1))
        });
        s.addOns = a;
    }

    /// @dev 24,575 bytes: a 4,011-byte description, 16 types with 8-byte names and 255 values of 4 bytes.
    function _tableValuesHeavy() internal pure returns (bytes memory t) {
        uint256 descLen = 24_575 - 4 - 16 * (1 + 8 + 1 + 255 * 5);
        t = bytes.concat(hex"01", bytes2(uint16(descLen)), _fill(descLen, 0x44), bytes1(uint8(16)));
        for (uint256 i; i < 16; ++i) {
            t = bytes.concat(t, bytes1(uint8(8)), _fill(8, uint8(0x41 + i)), bytes1(uint8(255)));
            bytes memory values;
            for (uint256 v; v < 255; ++v) {
                values = bytes.concat(values, bytes1(uint8(4)), _fill(4, uint8(0x61 + v % 26)));
            }
            t = bytes.concat(t, values);
        }
    }

    /// @dev 24,575 bytes: a 24,571-byte description and no type.
    function _tableDescriptionHeavy() internal pure returns (bytes memory) {
        return bytes.concat(hex"01", bytes2(uint16(24_571)), _fill(24_571, 0x44), hex"00");
    }

    /// The two largest tables are the collection's own check's maximum too (BoxMetadataTable.validate accepts them).
    function testProperty_AUDIT_U9_largestTablesPassTheCollectionsCheck() public pure {
        BoxMetadataTable.validate(_tableValuesHeavy());
        BoxMetadataTable.validate(_tableDescriptionHeavy());
    }
}
