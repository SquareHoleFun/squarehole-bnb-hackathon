// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {
    BoxKind,
    BoxPhase,
    DeepenSkip,
    DepthKind,
    DrawStatus,
    ModuleProceedsTo,
    RoyaltyDestination,
    TicketPhase,
    VaultAction
} from "../../../../src/box/interfaces/BoxTypes.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {DrandSourcePins} from "../../../../src/box/randomness/DrandSourcePins.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {AuditU9ClaudeTwinVectors as TV} from "./AuditU9ClaudeTwinVectors.sol";

/// @notice TEST ONLY: decodes in an external frame, so a decoding revert can be caught; and every BoxTypes enum.
contract AuditU9ClaudeSpecHarness {
    function decodeAndValidate(bytes calldata encoded) external pure returns (uint16 reason, uint16 field, bytes32 h) {
        BoxSpecV1.BoxSpec memory s = abi.decode(encoded, (BoxSpecV1.BoxSpec));
        (reason, field) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        h = BoxSpecV1.specHash(s);
    }

    function specHashOf(bytes calldata encoded) external pure returns (bytes32) {
        return BoxSpecV1.specHash(abi.decode(encoded, (BoxSpecV1.BoxSpec)));
    }

    /// @dev Decodes `word` as BoxTypes enum `which` and returns its value.
    function decodeEnum(uint256 which, bytes calldata word) external pure returns (uint256) {
        if (which == 0) return uint256(abi.decode(word, (BoxKind)));
        if (which == 1) return uint256(abi.decode(word, (BoxPhase)));
        if (which == 2) return uint256(abi.decode(word, (ModuleProceedsTo)));
        if (which == 3) return uint256(abi.decode(word, (RoyaltyDestination)));
        if (which == 4) return uint256(abi.decode(word, (VaultAction)));
        if (which == 5) return uint256(abi.decode(word, (DepthKind)));
        if (which == 6) return uint256(abi.decode(word, (DeepenSkip)));
        if (which == 7) return uint256(abi.decode(word, (TicketPhase)));
        return uint256(abi.decode(word, (DrawStatus)));
    }

    /// @dev The conversion from an integer, as the clone-argument readers do it (BoxCoordinator.sol:385,
    /// BoxReceiver.sol:414, :464).
    function convertEnum(uint256 which, uint256 v) external pure returns (uint256) {
        // forge-lint: disable-start(unsafe-typecast)
        if (which == 0) return uint256(BoxKind(uint8(v)));
        if (which == 3) return uint256(RoyaltyDestination(uint8(v)));
        return uint256(ModuleProceedsTo(uint8(v)));
        // forge-lint: disable-end(unsafe-typecast)
    }
}

/// @title AuditU9ClaudeSpecTest (SH-AUDIT-B0-U9, Claude; P9.2, P9.10, P9.11; lenses L2, L4, L7, L8)
/// @notice `BoxSpecV1.validate()` against the documented rules, written here from the case texts rather than from the
/// generated code (the twin replay in AuditU9ClaudeTwin.t.sol cannot see an error both twins share, since both are
/// generated from box-spec.v1.json): the version's menu (BC-014), N 10-10,000 (BC-008), names of printable ASCII
/// without '"' or '\' (BC-072, box-spec.v1.json stringRules), one raise (BC-127), the deadline rules (BC-045, BC-064),
/// the art and reveal-list rules (BC-052, F55), the creator fields of version 1 (F61 O2, F68 (3)); every refusal a
/// reason code; arbitrary bytes never an accepted spec; BoxTypes enums never mapped; specHash stable and unique.
/// Box 0's fixture is the shared vectors' template 0 (N 4,269; `AuditU9ClaudeTwinVectors.base(0)`).
contract AuditU9ClaudeSpecTest is Test {
    AuditU9ClaudeSpecHarness internal harness;

    uint8 internal constant JSON_TEXT = 1;
    uint8 internal constant SVG = 2;
    uint8 internal constant URL = 3;

    function setUp() public {
        harness = new AuditU9ClaudeSpecHarness();
    }

    // ================================================================================================ helpers

    function _box0() internal pure returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(TV.base(0), (BoxSpecV1.BoxSpec));
    }

    function _base(uint256 i) internal pure returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(TV.base(i), (BoxSpecV1.BoxSpec));
    }

    function _v1(BoxSpecV1.BoxSpec memory s) internal pure returns (uint16 reason, uint16 field) {
        return BoxSpecV1.validate(s, BoxSpecV1.contextV1());
    }

    /// @dev Box 0's fixture without its edition specials (their counts, 12 to 69, would bind N from below).
    function _box0NoSpecials() internal pure returns (BoxSpecV1.BoxSpec memory s) {
        s = _box0();
        uint256 kept;
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id != BoxSpecV1.ADD_ON_EDITION_SPECIALS) ++kept;
        }
        BoxSpecV1.AddOn[] memory list = new BoxSpecV1.AddOn[](kept);
        uint256 j;
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id != BoxSpecV1.ADD_ON_EDITION_SPECIALS) list[j++] = s.addOns[i];
        }
        s.addOns = list;
    }

    /// @dev The rule's allowed bytes, from box-spec.v1.json `stringRules` (the case text, not the generated masks).
    function _allowed(uint8 rule, uint256 c) internal pure returns (bool) {
        if (rule == JSON_TEXT) return c >= 0x20 && c <= 0x7e && c != 0x22 && c != 0x5c;
        if (rule == SVG) return c >= 0x20 && c <= 0x7e;
        // URL: RFC 3986's URI characters: letters, digits and - . _ ~ : / ? # [ ] @ ! $ & ' ( ) * + , ; = %.
        if (c >= 0x30 && c <= 0x39) return true;
        if (c >= 0x41 && c <= 0x5a) return true;
        if (c >= 0x61 && c <= 0x7a) return true;
        bytes memory others = "-._~:/?#[]@!$&'()*+,;=%";
        for (uint256 i; i < others.length; ++i) {
            if (uint8(others[i]) == c) return true;
        }
        return false;
    }

    function _filled(uint256 len, bytes1 c) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; ++i) {
            b[i] = c;
        }
    }

    function _knownField(uint16 f) internal pure returns (bool) {
        if (f >= 1 && f <= 29) return true;
        if (f == 100 || f == 200 || f == 300 || f == 400 || f == 500 || f == 600) return true;
        if (f >= 101 && f <= 105) return true;
        if (f == 301 || f == 302 || f == 401 || f == 402 || f == 501 || f == 502) return true;
        return f >= 601 && f <= 603;
    }

    // ================================================================================================ L2: N (BC-008)

    /// BC-008 (BoxSpecV1.sol:123-126, :446-450): N from 10 to 10,000; anything else OUT_OF_RANGE at field n.
    function testFuzz_AUDIT_U9_editionSizeBounds(uint32 n) public pure {
        BoxSpecV1.BoxSpec memory s = _box0NoSpecials();
        s.n = n;
        (uint16 reason, uint16 field) = _v1(s);
        if (n >= 10 && n <= 10_000) {
            assertEq(reason, BoxSpecV1.REASON_OK);
        } else {
            assertEq(reason, BoxSpecV1.REASON_OUT_OF_RANGE);
            assertEq(field, BoxSpecV1.FIELD_N);
        }
    }

    function testProperty_AUDIT_U9_editionSizeEdges() public pure {
        uint32[13] memory ns = [uint32(0), 1, 2, 9, 10, 11, 69, 1969, 4269, 9999, 10_000, 10_001, type(uint32).max];
        for (uint256 i; i < ns.length; ++i) {
            BoxSpecV1.BoxSpec memory s = _box0NoSpecials();
            s.n = ns[i];
            (uint16 reason,) = _v1(s);
            assertEq(reason == BoxSpecV1.REASON_OK, ns[i] >= 10 && ns[i] <= 10_000, vm.toString(ns[i]));
        }
    }

    /// Edition specials (add-on 3): a count from 1 to N, so a series can never name more items than the box has.
    function testFuzz_AUDIT_U9_editionSpecialsCountWithinN(uint32 n, uint32 count) public pure {
        n = uint32(bound(n, 10, 10_000));
        BoxSpecV1.BoxSpec memory s = _box0NoSpecials();
        s.n = n;
        BoxSpecV1.AddOn[] memory list = new BoxSpecV1.AddOn[](s.addOns.length + 1);
        // Placeholders and the per-item stream stay first; the series goes after them, before the royalties.
        list[0] = s.addOns[0];
        list[1] = s.addOns[1];
        list[2] = BoxSpecV1.AddOn({id: BoxSpecV1.ADD_ON_EDITION_SPECIALS, params: abi.encode("Specials", count)});
        for (uint256 i = 2; i < s.addOns.length; ++i) {
            list[i + 1] = s.addOns[i];
        }
        s.addOns = list;
        (uint16 reason, uint16 field) = _v1(s);
        if (count >= 1 && count <= n) {
            assertEq(reason, BoxSpecV1.REASON_OK);
        } else {
            assertEq(reason, BoxSpecV1.REASON_OUT_OF_RANGE);
            assertEq(field, BoxSpecV1.FIELD_ADD_ON_EDITION_SPECIALS_COUNT);
        }
    }

    // ============================================================================================ L2: strings (BC-072)

    /// @dev Sets text field `f` (3-7 core; 101-105 the placeholders add-on's; 301 an edition label; 603 the link).
    function _withText(uint256 f, bytes memory t) internal pure returns (BoxSpecV1.BoxSpec memory s) {
        s = _box0();
        if (f == 3) {
            s.tokenName = string(t);
        } else if (f == 4) {
            s.tokenSymbol = string(t);
        } else if (f == 5) {
            s.collectionName = string(t);
        } else if (f == 6) {
            s.collectionSymbol = string(t);
        } else if (f == 7) {
            s.description = string(t);
        } else if (f >= 101 && f <= 105) {
            (string memory a, string memory b, string memory c, string memory d, string memory e) =
                abi.decode(s.addOns[0].params, (string, string, string, string, string));
            if (f == 101) a = string(t);
            if (f == 102) b = string(t);
            if (f == 103) c = string(t);
            if (f == 104) d = string(t);
            if (f == 105) e = string(t);
            s.addOns[0].params = abi.encode(a, b, c, d, e);
        } else if (f == 301) {
            (, uint32 count) = abi.decode(s.addOns[2].params, (string, uint32));
            s.addOns[2].params = abi.encode(string(t), count);
        } else {
            (bytes32 banner, bytes32[] memory teasers,) = abi.decode(s.addOns[6].params, (bytes32, bytes32[], string));
            s.addOns[6].params = abi.encode(banner, teasers, string(t));
        }
    }

    function _textRule(uint256 f) internal pure returns (uint8 rule, uint256 minBytes, uint256 maxBytes) {
        if (f == 3 || f == 5 || f == 101 || f == 301) return (JSON_TEXT, 1, 32);
        if (f == 4 || f == 6 || f == 102) return (JSON_TEXT, 1, 11);
        if (f == 7 || f == 103 || f == 104) return (JSON_TEXT, 0, 1024);
        if (f == 105) return (SVG, 1, 4096);
        return (URL, 0, 128);
    }

    /// @dev Every byte value at the first, a middle and the last position of a text of a valid length: refused with
    /// BAD_CHARACTER at the field exactly when the rule refuses the byte (the URL also needs its https:// prefix).
    function _everyByte(uint256 f) internal pure {
        (uint8 rule, uint256 minBytes, uint256 maxBytes) = _textRule(f);
        uint256 len = rule == URL ? 12 : (minBytes > 3 ? minBytes : 3);
        if (len > maxBytes) len = maxBytes;
        for (uint256 c; c < 256; ++c) {
            for (uint256 k; k < 3; ++k) {
                _byteCase(f, rule, len, c, k);
            }
        }
    }

    /// @dev `len` bytes of 'a', starting with https:// for the URL rule.
    function _textOf(uint8 rule, uint256 len) internal pure returns (bytes memory t) {
        t = _filled(len, "a");
        if (rule == URL && len >= 8) {
            bytes memory p = "https://";
            for (uint256 j; j < 8; ++j) {
                t[j] = p[j];
            }
        }
    }

    function _byteCase(uint256 f, uint8 rule, uint256 len, uint256 c, uint256 k) internal pure {
        bytes memory t = _textOf(rule, len);
        uint256 first = rule == URL ? 8 : 0;
        t[k == 0 ? first : (k == 1 ? first + (len - first) / 2 : len - 1)] = bytes1(uint8(c));
        (uint16 reason, uint16 field) = _v1(_withText(f, t));
        bool ok = _allowed(rule, c);
        if (reason != (ok ? BoxSpecV1.REASON_OK : BoxSpecV1.REASON_BAD_CHARACTER) || (!ok && field != f)) {
            revert(string.concat("field ", vm.toString(f), " byte ", vm.toString(c), " at ", vm.toString(k)));
        }
    }

    /// @dev Lengths min - 1, min, max and max + 1 of allowed bytes.
    function _lengths(uint256 f) internal pure {
        (uint8 rule, uint256 minBytes, uint256 maxBytes) = _textRule(f);
        uint256[4] memory lens = [minBytes == 0 ? 0 : minBytes - 1, minBytes, maxBytes, maxBytes + 1];
        for (uint256 i; i < 4; ++i) {
            (uint16 reason, uint16 field) = _v1(_withText(f, _textOf(rule, lens[i])));
            bool inside = lens[i] >= minBytes && lens[i] <= maxBytes;
            bool prefixOk = rule != URL || lens[i] == 0 || lens[i] >= 8;
            if (inside && prefixOk) {
                assertEq(reason, BoxSpecV1.REASON_OK, vm.toString(lens[i]));
            } else if (!inside) {
                assertEq(reason, BoxSpecV1.REASON_LENGTH_OUT_OF_RANGE, vm.toString(lens[i]));
                assertEq(field, f);
            } else {
                assertEq(reason, BoxSpecV1.REASON_BAD_CHARACTER);
            }
        }
    }

    /// BC-072 on the five core texts (fields 3-7: tokenName, tokenSymbol, collectionName, collectionSymbol,
    /// description) and the add-on texts: the placeholders add-on's five (101-105; the hidden SVG under the SVG rule,
    /// which allows '"' and '\' because it is base64-encoded into JSON), an edition label (301) and the collection
    /// page's link (603, the URL rule with its https:// prefix). Every byte value 0-255 at three positions, and the
    /// lengths min - 1, min, max, max + 1. One test per field (each about 800 validations).
    function testProperty_AUDIT_U9_text03TokenName() public pure {
        _everyByte(3);
        _lengths(3);
    }

    function testProperty_AUDIT_U9_text04TokenSymbol() public pure {
        _everyByte(4);
        _lengths(4);
    }

    function testProperty_AUDIT_U9_text05CollectionName() public pure {
        _everyByte(5);
        _lengths(5);
    }

    function testProperty_AUDIT_U9_text06CollectionSymbol() public pure {
        _everyByte(6);
        _lengths(6);
    }

    function testProperty_AUDIT_U9_text07Description() public pure {
        _everyByte(7);
        _lengths(7);
    }

    function testProperty_AUDIT_U9_text101PlaceholderName() public pure {
        _everyByte(101);
        _lengths(101);
    }

    function testProperty_AUDIT_U9_text102PlaceholderSymbol() public pure {
        _everyByte(102);
        _lengths(102);
    }

    function testProperty_AUDIT_U9_text103PlaceholderDescription() public pure {
        _everyByte(103);
        _lengths(103);
    }

    function testProperty_AUDIT_U9_text104HiddenDescription() public pure {
        _everyByte(104);
        _lengths(104);
    }

    function testProperty_AUDIT_U9_text105HiddenSvg() public pure {
        _everyByte(105);
        _lengths(105);
    }

    function testProperty_AUDIT_U9_text301EditionLabel() public pure {
        _everyByte(301);
        _lengths(301);
    }

    function testProperty_AUDIT_U9_text603ExternalLink() public pure {
        _everyByte(603);
        _lengths(603);
    }

    /// The link's prefix: a non-empty link must start with https:// (no http, no javascript: or data:).
    function testProperty_AUDIT_U9_linkNeedsHttps() public pure {
        string[6] memory bad = ["http://a.b", "javascript:x", "data:text", "https:/x", "HTTPS://A", "ftp://x"];
        for (uint256 i; i < bad.length; ++i) {
            (uint16 reason, uint16 field) = _v1(_withText(603, bytes(bad[i])));
            assertEq(reason, BoxSpecV1.REASON_BAD_CHARACTER, bad[i]);
            assertEq(field, BoxSpecV1.FIELD_ADD_ON_COLLECTION_METADATA_EXTERNAL_LINK);
        }
        (uint16 ok,) = _v1(_withText(603, "https://"));
        assertEq(ok, BoxSpecV1.REASON_OK, "the bare prefix is a link");
    }

    // ================================================================================================ L2: one raise

    /// BC-127 (F74 U5): the version's one raise for native ETH, R = BoxBuildV1.RAISE; anything else
    /// RAISE_NOT_A_PRESET at raise, under version 1's and version 2's contexts.
    function testFuzz_AUDIT_U9_oneRaise(uint256 raise) public pure {
        BoxSpecV1.BoxSpec memory s = _box0();
        s.raise = raise;
        (uint16 reason, uint16 field) = _v1(s);
        BoxSpecV1.BoxSpec memory t = _base(2);
        t.raise = raise;
        (uint16 reason2, uint16 field2) = BoxSpecV1.validate(t, BoxSpecV1.contextV2());
        if (raise == BoxBuildV1.RAISE) {
            assertEq(reason, BoxSpecV1.REASON_OK);
            assertEq(reason2, BoxSpecV1.REASON_OK);
        } else {
            assertEq(reason, BoxSpecV1.REASON_RAISE_NOT_A_PRESET);
            assertEq(field, BoxSpecV1.FIELD_RAISE);
            assertEq(reason2, BoxSpecV1.REASON_RAISE_NOT_A_PRESET);
            assertEq(field2, BoxSpecV1.FIELD_RAISE);
        }
    }

    function testProperty_AUDIT_U9_oneRaiseEdges() public pure {
        uint256 r = BoxBuildV1.RAISE;
        uint256[8] memory raises = [r, r - 1, r + 1, 0, 1 ether, 4.2 ether, 10 ether, r / 10];
        for (uint256 i; i < raises.length; ++i) {
            BoxSpecV1.BoxSpec memory s = _box0();
            s.raise = raises[i];
            (uint16 reason,) = _v1(s);
            assertEq(reason == BoxSpecV1.REASON_OK, i == 0, vm.toString(raises[i]));
        }
        assertEq(r, 4_206_980_085_000_000_000, "the mainnet build's R (default profile)");
    }

    // =========================================================================================== L2: the menu (BC-014)

    /// @dev BC-014's menu, from the case text (docs/design/launch-pipeline/conformance-cases.json BC-014) and F70, F74
    /// U1: members 1-7 on each side; holder payouts (PAY_HOLDERS_* 4 / 2 and *_HOLDERS_IN_* 7) refused everywhere;
    /// BURN_Q only for a Q with a real burn (FIT, a listed box T); SELL_FOR_Q never with BUYBACK_BURN_T;
    /// PER_ITEM_STREAM only in box 0's spec (version 1, with its add-on); a creator kind (5, 6 either side) only in
    /// version 2.
    function _menuAllows(uint16 version, uint8 qClass, uint256 qs, uint256 ts) internal pure returns (bool) {
        if (qs < 1 || qs > 7 || ts < 1 || ts > 7) return false;
        if (qs == 4 || qs == 7 || ts == 2 || ts == 7) return false;
        if (qs == 3 && qClass != BoxSpecV1.Q_CLASS_FIT && qClass != BoxSpecV1.Q_CLASS_BOX_T) return false;
        if (ts == 3 && qs == 1) return false;
        if (ts == 4 && version != 1) return false;
        if ((qs == 5 || qs == 6 || ts == 5 || ts == 6) && version != 2) return false;
        return true;
    }

    /// @dev `s` with streams (qs, ts) and what the menu rules need around them: the per-item stream's add-on exactly
    /// with PER_ITEM_STREAM, no creator-fee cap (it needs a creator kind), and a payee exactly with a creator option
    /// (a creator kind, or royalties to the creator: the payee rule is not the menu's).
    function _withStreams(BoxSpecV1.BoxSpec memory s, uint8 qs, uint8 ts) internal pure {
        s.qStream = qs;
        s.tStream = ts;
        bool stream = ts == BoxSpecV1.T_STREAM_PER_ITEM_STREAM;
        uint256 kept;
        bool royaltyCreator;
        for (uint256 i; i < s.addOns.length; ++i) {
            uint16 id = s.addOns[i].id;
            if (id != BoxSpecV1.ADD_ON_PER_ITEM_STREAM && id != BoxSpecV1.ADD_ON_CREATOR_FEE_CAP) ++kept;
            if (id == BoxSpecV1.ADD_ON_ROYALTIES) {
                (, uint8 dest) = abi.decode(s.addOns[i].params, (uint16, uint8));
                royaltyCreator = dest == BoxSpecV1.ROYALTY_DESTINATION_CREATOR;
            }
        }
        bool creator = qs == 5 || qs == 6 || ts == 5 || ts == 6 || royaltyCreator;
        s.creatorFeeRecipient = creator ? address(0xC0FFEE) : address(0);
        BoxSpecV1.AddOn[] memory list = new BoxSpecV1.AddOn[](kept + (stream ? 1 : 0));
        uint256 j;
        bool placed = !stream;
        for (uint256 i; i < s.addOns.length; ++i) {
            uint16 id = s.addOns[i].id;
            if (id == BoxSpecV1.ADD_ON_PER_ITEM_STREAM || id == BoxSpecV1.ADD_ON_CREATOR_FEE_CAP) continue;
            if (!placed && id > BoxSpecV1.ADD_ON_PER_ITEM_STREAM) {
                list[j++] = BoxSpecV1.AddOn({id: BoxSpecV1.ADD_ON_PER_ITEM_STREAM, params: ""});
                placed = true;
            }
            list[j++] = s.addOns[i];
        }
        if (!placed) list[j++] = BoxSpecV1.AddOn({id: BoxSpecV1.ADD_ON_PER_ITEM_STREAM, params: ""});
        s.addOns = list;
    }

    /// @dev Every (qStream, tStream) in 0..8 on one base and context with Q `q` (raise `raise`, class `qClass`).
    function _menuGrid(uint256 base, BoxSpecV1.VersionContext memory ctx, address q, uint256 raise, uint8 qClass)
        internal
        pure
        returns (uint256 accepted)
    {
        for (uint8 qs; qs <= 8; ++qs) {
            for (uint8 ts; ts <= 8; ++ts) {
                BoxSpecV1.BoxSpec memory s = _base(base);
                s.q = q;
                s.raise = raise;
                // The creator buy's own rule (below the raise) is not the menu's: none here.
                s.creatorBuy = 0;
                _withStreams(s, qs, ts);
                (uint16 reason, uint16 field) = BoxSpecV1.validate(s, ctx);
                bool ok = reason == BoxSpecV1.REASON_OK;
                assertEq(
                    ok, _menuAllows(s.version, qClass, qs, ts), string.concat(vm.toString(qs), "/", vm.toString(ts))
                );
                if (!ok) assertTrue(_knownField(field), "a refusal names a known field");
                if (ok) ++accepted;
            }
        }
    }

    /// BC-014 on box 0's fixture (version 1; native ETH): exactly (BUYBACK_BURN_T or ALL_TO_FIT) × (BURN_T, SELL_FOR_Q
    /// but not with BUYBACK_BURN_T, PER_ITEM_STREAM) pass validate(); template 0 then keeps only (BUYBACK_BURN_T,
    /// PER_ITEM_STREAM) (BoxFactoryV1Planner.sol:407-418).
    function testProperty_AUDIT_U9_menuVersion1() public {
        uint256 accepted =
            _menuGrid(0, BoxSpecV1.contextV1(), address(0), BoxBuildV1.RAISE, BoxSpecV1.Q_CLASS_NATIVE_ETH);
        assertEq(accepted, 5, "1/1, 1/4, 2/1, 2/3, 2/4");
        BoxFactoryV1Planner planner = new BoxFactoryV1Planner();
        for (uint8 qs = 1; qs <= 2; ++qs) {
            for (uint8 ts = 1; ts <= 4; ++ts) {
                BoxSpecV1.BoxSpec memory s = _box0();
                _withStreams(s, qs, ts);
                (uint16 reason,) = _v1(s);
                if (reason != BoxSpecV1.REASON_OK) continue;
                bytes memory refusal = planner.refusal(s, BoxSpecV1.PLATFORM_SAFE_MAINNET);
                assertEq(refusal.length == 0, qs == 1 && ts == 4, "template 0: BUYBACK_BURN_T and PER_ITEM_STREAM");
            }
        }
    }

    /// BC-014 on version 2's three demo bases with native ETH and, under the 5-Q test context, FIT and a box T (where
    /// BURN_Q is allowed) and an ERC-20 (where it is not).
    function testProperty_AUDIT_U9_menuVersion2() public pure {
        BoxSpecV1.VersionContext memory test5 = abi.decode(TV.context(2), (BoxSpecV1.VersionContext));
        for (uint256 base = 1; base <= 3; ++base) {
            _menuGrid(base, BoxSpecV1.contextV2(), address(0), BoxBuildV1.RAISE, BoxSpecV1.Q_CLASS_NATIVE_ETH);
            _menuGrid(base, test5, test5.qList[3].token, test5.qList[3].raisePresets[0], BoxSpecV1.Q_CLASS_FIT);
            _menuGrid(base, test5, test5.qList[4].token, test5.qList[4].raisePresets[1], BoxSpecV1.Q_CLASS_BOX_T);
            _menuGrid(base, test5, test5.qList[2].token, test5.qList[2].raisePresets[2], BoxSpecV1.Q_CLASS_ERC20);
        }
    }

    // ================================================================================================ L2: other rules

    /// The other uint8 choices: only members pass; a non-member is NOT_A_MEMBER (never mapped), a member the version
    /// does not offer NOT_OFFERED (EXISTING, B_PRIME), at its field; every value 0-255.
    function testProperty_AUDIT_U9_enumFieldsAcceptOnlyMembers() public pure {
        for (uint256 v; v < 256; ++v) {
            // casting to 'uint8' is safe because v < 256
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 x = uint8(v);
            BoxSpecV1.BoxSpec memory s = _box0();
            s.layout = x;
            _expectMember(s, v == 1, BoxSpecV1.FIELD_LAYOUT, false);
            s = _box0();
            s.launchFormat = x;
            _expectMember(s, v == 1, BoxSpecV1.FIELD_LAUNCH_FORMAT, false);
            s = _box0();
            s.gradLayout = x;
            _expectMember(s, v == 2, BoxSpecV1.FIELD_GRAD_LAYOUT, v == 1);
            s = _box0();
            s.boxType = x;
            (uint16 reason, uint16 field) = _v1(s);
            if (v == 1) assertEq(reason, BoxSpecV1.REASON_OK);
            else if (v == 2) assertEq(reason, BoxSpecV1.REASON_NOT_OFFERED, "EXISTING");
            else if (v != 3) assertEq(reason, BoxSpecV1.REASON_NOT_A_MEMBER);
            if (v != 1 && v != 3) assertEq(field, BoxSpecV1.FIELD_BOX_TYPE);
            s = _box0();
            s.artMode = x;
            (reason, field) = _v1(s);
            if (v == 2) assertEq(reason, BoxSpecV1.REASON_OK);
            else if (v != 1) assertEq(reason, BoxSpecV1.REASON_NOT_A_MEMBER);
        }
    }

    function _expectMember(BoxSpecV1.BoxSpec memory s, bool ok, uint16 field, bool offeredNot) internal pure {
        (uint16 reason, uint16 f) = _v1(s);
        if (ok) {
            assertEq(reason, BoxSpecV1.REASON_OK);
        } else {
            assertEq(reason, offeredNot ? BoxSpecV1.REASON_NOT_OFFERED : BoxSpecV1.REASON_NOT_A_MEMBER);
            assertEq(f, field);
        }
    }

    /// The version field: 1 and 2 only (UNSUPPORTED_VERSION otherwise); box 0's fixture as version 2 still needs a
    /// deadline (DEADLINE_RULE) and gives up its per-item stream (ADD_ON_NOT_AVAILABLE).
    function testFuzz_AUDIT_U9_versionOneOrTwo(uint16 version) public pure {
        BoxSpecV1.BoxSpec memory s = _box0();
        s.version = version;
        (uint16 reason, uint16 field) = _v1(s);
        if (version == 1) {
            assertEq(reason, BoxSpecV1.REASON_OK);
        } else if (version == 2) {
            assertEq(reason, BoxSpecV1.REASON_ADD_ON_NOT_AVAILABLE);
            assertEq(field, BoxSpecV1.FIELD_ADD_ON_PER_ITEM_STREAM);
        } else {
            assertEq(reason, BoxSpecV1.REASON_UNSUPPORTED_VERSION);
            assertEq(field, BoxSpecV1.FIELD_VERSION);
        }
    }

    /// BC-064 / F44 F4: version 1 has no deadline; BC-045: version 2 needs 30, 60, 90 or 180 days. Every value 0-400
    /// and the type's maximum, on box 0's fixture (version 1) and the demo open-art box (version 2).
    function testProperty_AUDIT_U9_deadlineRules() public pure {
        for (uint256 d; d <= 401; ++d) {
            // casting to 'uint16' is safe because d ≤ 401, and 401 stands for the type's maximum
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16 days_ = d == 401 ? type(uint16).max : uint16(d);
            bool member = days_ == 0 || days_ == 30 || days_ == 60 || days_ == 90 || days_ == 180;
            BoxSpecV1.BoxSpec memory s = _box0();
            s.deadlineDays = days_;
            (uint16 reason, uint16 field) = _v1(s);
            assertEq(reason == BoxSpecV1.REASON_OK, days_ == 0);
            if (days_ != 0) {
                assertEq(reason, member ? BoxSpecV1.REASON_DEADLINE_RULE : BoxSpecV1.REASON_NOT_A_MEMBER);
                assertEq(field, BoxSpecV1.FIELD_DEADLINE_DAYS);
            }
            BoxSpecV1.BoxSpec memory t = _base(2);
            t.deadlineDays = days_;
            (reason, field) = BoxSpecV1.validate(t, BoxSpecV1.contextV2());
            assertEq(reason == BoxSpecV1.REASON_OK, member && days_ != 0);
        }
    }

    /// F61 O2, F68 (3) on box 0 (version 1): no creator buy and no creator payee, whatever the amount or address.
    function testFuzz_AUDIT_U9_version1HasNoCreatorFields(uint256 buy, address payee) public pure {
        BoxSpecV1.BoxSpec memory s = _box0();
        s.creatorBuy = buy;
        (uint16 reason, uint16 field) = _v1(s);
        if (buy == 0) assertEq(reason, BoxSpecV1.REASON_OK);
        else assertEq(field, BoxSpecV1.FIELD_CREATOR_BUY);
        s = _box0();
        s.creatorFeeRecipient = payee;
        (reason, field) = _v1(s);
        if (payee == address(0)) {
            assertEq(reason, BoxSpecV1.REASON_OK);
        } else {
            assertEq(reason, BoxSpecV1.REASON_MUST_BE_ZERO);
            assertEq(field, BoxSpecV1.FIELD_CREATOR_FEE_RECIPIENT);
        }
    }

    // ========================================================================================= L4: art and reveal list

    /// L4 (the spec's fairness fields; BoxSpecV1.sol:673-684, F55, BC-052): box 0's hidden art refuses any published
    /// reveal list (a list known at creation would tell which item a draw gives) and needs the placeholders add-on;
    /// open art needs its list. The spec has no randomness field of its own: the source is the constant
    /// RANDOMNESS_SOURCE, the pinned BoxBackedSource (BackedSourcePins), naming the pinned DrandSource.
    function testFuzz_AUDIT_U9_hiddenArtPublishesNoRevealList(bytes32 listId) public pure {
        BoxSpecV1.BoxSpec memory s = _box0();
        assertEq(s.artMode, BoxSpecV1.ART_MODE_HIDDEN);
        s.revealListId = listId;
        (uint16 reason, uint16 field) = _v1(s);
        if (listId == bytes32(0)) {
            assertEq(reason, BoxSpecV1.REASON_OK);
        } else {
            assertEq(reason, BoxSpecV1.REASON_MUST_BE_ZERO);
            assertEq(field, BoxSpecV1.FIELD_REVEAL_LIST_ID);
        }
        // Open art on the same spec: needs a list, and the placeholders add-on then conflicts.
        s = _box0();
        s.artMode = BoxSpecV1.ART_MODE_OPEN;
        s.revealListId = listId == bytes32(0) ? bytes32(uint256(1)) : listId;
        (reason, field) = _v1(s);
        assertEq(reason, BoxSpecV1.REASON_ADD_ON_CONFLICT);
        assertEq(field, BoxSpecV1.FIELD_ADD_ON_PLACEHOLDERS);
    }

    function testProperty_AUDIT_U9_hiddenArtNeedsPlaceholders() public pure {
        BoxSpecV1.BoxSpec memory s = _box0();
        BoxSpecV1.AddOn[] memory rest = new BoxSpecV1.AddOn[](s.addOns.length - 1);
        for (uint256 i = 1; i < s.addOns.length; ++i) {
            rest[i - 1] = s.addOns[i];
        }
        s.addOns = rest;
        (uint16 reason, uint16 field) = _v1(s);
        assertEq(reason, BoxSpecV1.REASON_ADD_ON_REQUIRED);
        assertEq(field, BoxSpecV1.FIELD_ART_MODE);
    }

    function testProperty_AUDIT_U9_randomnessIsPinnedNotChosen() public pure {
        assertEq(BoxSpecV1.RANDOMNESS_SOURCE, BackedSourcePins.ADDRESS_MAINNET);
        assertEq(BoxSpecV1.RANDOMNESS_SOURCE, BackedSourcePins.ADDRESS_SEPOLIA);
        assertEq(BoxSpecV1.RANDOMNESS_SOURCE_CODE_HASH, BackedSourcePins.CODE_HASH_MAINNET);
        assertEq(BoxSpecV1.DRAND_SOURCE, DrandSourcePins.ADDRESS_MAINNET);
        assertEq(BoxSpecV1.DRAND_SOURCE_CODE_HASH, DrandSourcePins.CODE_HASH_MAINNET);
        // The wire format has 29 fields (FIELD_ADD_ONS = 29), none of them a source: 29 head words in the encoding.
        assertEq(BoxSpecV1.FIELD_ADD_ONS, 29);
        bytes memory e = TV.base(0);
        assertEq(uint256(bytes32(_wordAt(e, 0))), 0x20, "one dynamic tuple");
        assertGe(e.length, 32 + 29 * 32);
    }

    function _wordAt(bytes memory e, uint256 at) internal pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(add(e, 0x20), at))
        }
    }

    // =========================================================================================== P9.2: arbitrary bytes

    /// P9.2: arbitrary bytes decode to a refusal or a revert, never to an accepted spec. The one exception the fuzzer
    /// finds is not arbitrary: its dictionary holds this contract's code constants, the four fixtures' encodings
    /// (`AuditU9ClaudeTwinVectors.base`), which are valid specs; so an accepted input must hash as one of them.
    function testFuzz_AUDIT_U9_randomBytesNeverAccepted(bytes calldata raw) public view {
        try harness.decodeAndValidate(raw) returns (uint16 reason, uint16 field, bytes32 h) {
            if (reason == BoxSpecV1.REASON_OK) {
                bool fixture;
                for (uint256 i; i < TV.BASES; ++i) {
                    if (h == keccak256(TV.base(i))) fixture = true;
                }
                assertTrue(fixture, "random bytes accepted");
            } else {
                assertLe(reason, BoxSpecV1.REASON_METADATA_TABLE_MALFORMED);
                assertTrue(_knownField(field));
            }
        } catch {}
    }

    /// P9.2 in a shape that always decodes: box 0's encoding with every static head word replaced by a random value
    /// inside its type (the offsets of the dynamic parts kept). Never accepted; always a reason with a known field.
    function testFuzz_AUDIT_U9_randomHeadWordsNeverAccepted(uint256 seed) public view {
        bytes memory e = TV.base(0);
        // Head word i of the tuple is at 32 + 32 i; static fields and their widths in bits (0 = a dynamic offset).
        uint16[28] memory bits = [
            uint16(16),
            8,
            0,
            0,
            0,
            0,
            0,
            32,
            256,
            160,
            256,
            8,
            8,
            8,
            32,
            16,
            8,
            8,
            8,
            256,
            0,
            256,
            256,
            256,
            160,
            160,
            256,
            256
        ];
        for (uint256 i; i < 28; ++i) {
            if (bits[i] == 0) continue;
            uint256 w = uint256(keccak256(abi.encode(seed, i)));
            if (bits[i] < 256) w &= (uint256(1) << bits[i]) - 1;
            uint256 at = 32 + 32 * i;
            assembly ("memory-safe") {
                mstore(add(add(e, 0x20), at), w)
            }
        }
        (uint16 reason, uint16 field,) = harness.decodeAndValidate(e);
        assertTrue(reason != BoxSpecV1.REASON_OK, "random head words accepted");
        assertTrue(_knownField(field));
    }

    // ================================================================================================ P9.10: enums

    /// P9.10: every BoxTypes enum decodes its members and refuses the first value past them (the ABI decoder reverts;
    /// no value maps to a member). Members: BoxKind 3, BoxPhase 7, ModuleProceedsTo 4, RoyaltyDestination 4,
    /// VaultAction 5, DepthKind 3, DeepenSkip 8, TicketPhase 5, DrawStatus 5.
    function testProperty_AUDIT_U9_boxTypesEnumsRefuseOutOfRange() public {
        uint256[9] memory members = [uint256(3), 7, 4, 4, 5, 3, 8, 5, 5];
        for (uint256 w; w < 9; ++w) {
            for (uint256 v; v < members[w]; ++v) {
                assertEq(harness.decodeEnum(w, abi.encode(v)), v);
            }
            uint256[4] memory outside = [members[w], members[w] + 1, 255, type(uint256).max];
            for (uint256 k; k < 4; ++k) {
                try harness.decodeEnum(w, abi.encode(outside[k])) returns (uint256 got) {
                    emit log_named_uint("enum", w);
                    emit log_named_uint("decoded to", got);
                    fail();
                } catch (bytes memory err) {
                    assertEq(err.length, 0, "the decoder's plain revert");
                }
            }
        }
        // The clone-argument readers convert with a checked enum conversion: an out-of-range byte panics (0x21).
        uint256[3] memory conv = [uint256(0), 3, 2];
        uint256[3] memory convMembers = [uint256(3), 4, 4];
        for (uint256 k; k < 3; ++k) {
            try harness.convertEnum(conv[k], convMembers[k]) {
                fail();
            } catch (bytes memory err) {
                assertEq(err, abi.encodeWithSignature("Panic(uint256)", 0x21));
            }
        }
    }

    // ================================================================================================ P9.11: specHash

    /// P9.11: specHash is keccak256 of the canonical encoding, the encoding round-trips, and a change of any one field
    /// changes the hash (fuzz over the fields and values).
    function testFuzz_AUDIT_U9_specHashStableAndUnique(uint256 field, uint256 value) public pure {
        BoxSpecV1.BoxSpec memory s = _box0();
        bytes32 h0 = BoxSpecV1.specHash(s);
        assertEq(h0, keccak256(TV.base(0)));
        BoxSpecV1.BoxSpec memory t = _box0();
        field = field % 12;
        // forge-lint: disable-start(unsafe-typecast)
        if (field == 0) t.version = uint16(value);
        else if (field == 1) t.n = uint32(value);
        else if (field == 2) t.raise = value;
        else if (field == 3) t.openAt = uint32(value);
        else if (field == 4) t.q = address(uint160(value));
        else if (field == 5) t.revealRoot = bytes32(value);
        else if (field == 6) t.description = string(abi.encodePacked(value));
        else if (field == 7) t.metadataTable = abi.encodePacked(t.metadataTable, uint8(value));
        else if (field == 8) t.addOns[2].params = abi.encode("x", uint32(value));
        else if (field == 9) t.creatorBuy = value;
        else if (field == 10) t.generatorHash = bytes32(value);
        else t.addOns[5].id = uint16(value);
        // forge-lint: disable-end(unsafe-typecast)
        bytes memory e = abi.encode(t);
        assertEq(BoxSpecV1.specHash(t), keccak256(e));
        assertEq(keccak256(abi.encode(abi.decode(e, (BoxSpecV1.BoxSpec)))), keccak256(e), "re-encoding is stable");
        assertEq(
            BoxSpecV1.specHash(t) == h0, keccak256(e) == keccak256(TV.base(0)), "the hash changes iff the spec does"
        );
    }

    /// P9.11: encodings that are not canonical but decode (bytes after the end, a non-zero pad byte after a string, a
    /// string moved behind a gap) hash as the spec they decode to, i.e. as the canonical encoding: the factory
    /// hashes `abi.encode(spec)`, never the bytes it was sent (BoxFactoryV1.sol:236, BoxRegistry.sol:72-74).
    function testProperty_AUDIT_U9_nonCanonicalEncodingsHashCanonically() public view {
        bytes memory e = TV.base(0);
        bytes32 canonical = keccak256(e);
        // 1: 32 bytes appended.
        assertEq(harness.specHashOf(bytes.concat(e, bytes32(uint256(0xdead)))), canonical, "trailing bytes");
        // 2: tokenName ("FIT"): its offset is head word 2; set a pad byte after its 3 bytes.
        uint256 nameOffset = 32 + uint256(_wordAt(e, 32 + 32 * 2));
        bytes memory e2 = bytes.concat(e);
        e2[nameOffset + 32 + 3] = 0x01;
        assertEq(harness.specHashOf(e2), canonical, "a dirty pad byte");
        assertTrue(keccak256(e2) != canonical);
        // 3: the token name copied to the end behind a 32-byte gap, its offset pointed there.
        bytes memory nameTail = new bytes(64);
        for (uint256 i; i < 64; ++i) {
            nameTail[i] = e[nameOffset + i];
        }
        bytes memory e3 = bytes.concat(e, new bytes(32), nameTail);
        uint256 newOffset = e.length + 32 - 32;
        uint256 at = 32 + 32 * 2;
        assembly ("memory-safe") {
            mstore(add(add(e3, 0x20), at), newOffset)
        }
        assertEq(harness.specHashOf(e3), canonical, "a moved string");
        (uint16 reason,,) = harness.decodeAndValidate(e3);
        assertEq(reason, BoxSpecV1.REASON_OK, "the same spec, the same verdict");
    }

    /// P9.11 / L8: the committed Sepolia spec files (no `box0-spec.1.json`, the mainnet file, exists yet: README) give
    /// their declared specHash as keccak256 of their bytes, the bytes are canonical, and validate() under this build
    /// accepts the full-size files and refuses the rehearsal files' 1/10 raise (RAISE_NOT_A_PRESET: they are for the
    /// rehearsal build only, DeployCoreV1.s.sol:43). Template 0's rules accept each with the Safe it names.
    function testProperty_AUDIT_U9_specFilesHashAsDeclared() public {
        string[4] memory files = [
            "/script/config/box0-spec.11155111.json",
            "/script/config/box0-spec.11155111.safe.json",
            "/script/config/box0-spec.11155111.rehearsal.json",
            "/script/config/box0-spec.11155111.rehearsal.sepolia-safe.json"
        ];
        BoxFactoryV1Planner planner = new BoxFactoryV1Planner();
        for (uint256 i; i < files.length; ++i) {
            string memory json = vm.readFile(string.concat(vm.projectRoot(), files[i]));
            bytes memory encoded = vm.parseJsonBytes(json, ".encoded");
            bytes32 declared = vm.parseJsonBytes32(json, ".specHash");
            BoxSpecV1.BoxSpec memory s = abi.decode(encoded, (BoxSpecV1.BoxSpec));
            assertEq(keccak256(encoded), declared, files[i]);
            assertEq(BoxSpecV1.specHash(s), declared, "specHash(decode) = the declared hash");
            assertEq(keccak256(abi.encode(s)), keccak256(encoded), "the file's bytes are canonical");
            bool rehearsalFile = i >= 2;
            assertEq(s.raise, rehearsalFile ? 420_698_008_500_000_000 : 4_206_980_085_000_000_000);
            (uint16 reason, uint16 field) = _v1(s);
            if (rehearsalFile == BoxBuildV1.REHEARSAL) {
                assertEq(reason, BoxSpecV1.REASON_OK, files[i]);
                assertEq(planner.refusal(s, s.marketplaceOwner).length, 0, "template 0 with its Safe");
            } else {
                assertEq(reason, BoxSpecV1.REASON_RAISE_NOT_A_PRESET, files[i]);
                assertEq(field, BoxSpecV1.FIELD_RAISE);
            }
        }
    }
}
