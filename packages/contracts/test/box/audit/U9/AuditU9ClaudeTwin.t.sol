// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxEncoding} from "../../../../src/box/libraries/BoxEncoding.sol";
import {AuditU9ClaudeTwinVectors as TV} from "./AuditU9ClaudeTwinVectors.sol";

/// @notice TEST ONLY: reads the generated vectors (big-endian fields, a cursor into one chunk).
library AuditU9ClaudeBytes {
    function u8(bytes memory d, uint256 at) internal pure returns (uint256) {
        return uint8(d[at]);
    }

    function u16(bytes memory d, uint256 at) internal pure returns (uint256) {
        return (uint256(uint8(d[at])) << 8) | uint8(d[at + 1]);
    }

    function be(bytes memory d, uint256 at, uint256 len) internal pure returns (uint256 v) {
        require(len <= 32 && at + len <= d.length, "AuditU9ClaudeBytes: be");
        for (uint256 i; i < len; ++i) {
            v = (v << 8) | uint8(d[at + i]);
        }
    }

    function slice(bytes memory d, uint256 at, uint256 len) internal pure returns (bytes memory out) {
        require(at + len <= d.length, "AuditU9ClaudeBytes: slice");
        out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = d[at + i];
        }
    }
}

/// @notice TEST ONLY: the library calls the replay expects to revert, made external so a revert can be caught.
contract AuditU9ClaudeTwinHarness {
    function decodeAndValidate(bytes calldata encoded, bytes calldata ctx)
        external
        pure
        returns (uint16 reason, uint16 field, bytes32 hash)
    {
        BoxSpecV1.BoxSpec memory s = abi.decode(encoded, (BoxSpecV1.BoxSpec));
        (reason, field) = BoxSpecV1.validate(s, abi.decode(ctx, (BoxSpecV1.VersionContext)));
        hash = BoxSpecV1.specHash(s);
    }

    function curve(uint256 raise, bool tIsC0) external pure returns (BoxLayoutV1.Curve memory) {
        return BoxLayoutV1.curve(raise, tIsC0);
    }

    function graduated(BoxLayoutV1.Curve memory c, uint8 layout, uint256 qHeld, uint256 tAvailable)
        external
        pure
        returns (BoxLayoutV1.Graduated memory)
    {
        return BoxLayoutV1.graduated(c, layout, qHeld, tAvailable);
    }
}

/// @title AuditU9ClaudeTwinTest (SH-AUDIT-B0-U9, Claude; P9.7, P9.9, P9.10; lenses L6, L7)
/// @notice The Solidity/TypeScript twin on random specs, not only the 270 shared vectors (BC-001; BoxSpecV1.sol:11-16,
/// :369-382; packages/box-spec/src/generated/box-spec.v1.ts:741-760). `AuditU9ClaudeTwinVectors.sol` was written
/// offline by the generator (evidence appendix A) from the TypeScript twin: per vector a base fixture, a context and
/// mutations, with the twin's verdict (reason, field) and spec hash. This contract rebuilds each spec from the same
/// base and mutations and requires `BoxSpecV1.validate()` and `specHash()` to give exactly the twin's answers.
/// Formats (one chunk is the vectors back to back):
/// - spec vector: base u8, context u8, reason u16, field u16, specHash bytes32, mutation count u8, mutations. A
///   mutation: op 1 (uint field: index u8, length u8, big-endian value), 2 (address: index, 20 bytes), 3 (bytes32:
///   index, 32 bytes), 4 (string or bytes: index, length u16, bytes), 5 (string or bytes from the pool: index, pool
///   u8), 6 (the add-on list: count u8, then per add-on id u16 and 0 + length u16 + params, or 1 + pool u8).
/// - encoded vector: base u8, the twin's validateEncodedBoxSpecV1 (0: a verdict, 1: it threw), reason u16, field
///   u16, specHashOfEncoded (0: a hash, 1: it threw), hash bytes32, patch count u8, patches (offset u16, byte u8) on
///   the base's ABI encoding.
/// - layout vector: raise uint256, tIsC0 u8, status u8 (0 ok; 1 RaiseIsZero, 2 CentreOutOfRange, 3 CurveOutOfRange,
///   4 NoExactLiquidity, 5 CurveTooLarge, 6 another throw); if ok: tickLower (3 bytes, two's complement), liquidity
///   (16 bytes), curveT, qHeld, tAvailable, then per graduated layout (B_PRIME, ASK_FULL_BID_SENTINEL) a status (0
///   ok, 1 threw, 2 a negative dust) and keccak256 of the 14 numbers' ABI encoding.
/// - encoding vector: length u8, data, base64 (length u16, bytes; Node's Buffer), base32 (length u16, bytes; the
///   generator's own bit accumulator, RFC 4648 lower case, unpadded).
contract AuditU9ClaudeTwinTest is Test {
    using AuditU9ClaudeBytes for bytes;

    AuditU9ClaudeTwinHarness internal harness;

    function setUp() public {
        harness = new AuditU9ClaudeTwinHarness();
    }

    // ================================================================================================ spec vectors

    function _contexts() internal pure returns (BoxSpecV1.VersionContext[] memory ctxs) {
        ctxs = new BoxSpecV1.VersionContext[](TV.CONTEXTS);
        for (uint256 i; i < TV.CONTEXTS; ++i) {
            ctxs[i] = abi.decode(TV.context(i), (BoxSpecV1.VersionContext));
        }
    }

    /// @dev Applies one mutation at `c`; returns the cursor after it.
    function _apply(BoxSpecV1.BoxSpec memory s, bytes memory d, uint256 c) internal pure returns (uint256) {
        uint256 op = d.u8(c);
        if (op == 6) return _applyAddOns(s, d, c + 1);
        uint256 f = d.u8(c + 1);
        if (op == 1) {
            uint256 len = d.u8(c + 2);
            _setUint(s, f, d.be(c + 3, len));
            return c + 3 + len;
        }
        if (op == 2) {
            // casting to 'uint160' is safe because be() of 20 bytes is below 2^160
            // forge-lint: disable-next-line(unsafe-typecast)
            _setAddress(s, f, address(uint160(d.be(c + 2, 20))));
            return c + 22;
        }
        if (op == 3) {
            _setWord(s, f, bytes32(d.be(c + 2, 32)));
            return c + 34;
        }
        if (op == 4) {
            uint256 len = d.u16(c + 2);
            _setBytes(s, f, d.slice(c + 4, len));
            return c + 4 + len;
        }
        if (op == 5) {
            _setBytes(s, f, TV.pool(d.u8(c + 2)));
            return c + 3;
        }
        revert("AuditU9ClaudeTwin: op");
    }

    function _applyAddOns(BoxSpecV1.BoxSpec memory s, bytes memory d, uint256 c) internal pure returns (uint256) {
        uint256 count = d.u8(c);
        ++c;
        s.addOns = new BoxSpecV1.AddOn[](count);
        for (uint256 i; i < count; ++i) {
            // casting to 'uint16' is safe because u16() reads two bytes
            // forge-lint: disable-next-line(unsafe-typecast)
            s.addOns[i].id = uint16(d.u16(c));
            uint256 kind = d.u8(c + 2);
            if (kind == 0) {
                uint256 len = d.u16(c + 3);
                s.addOns[i].params = d.slice(c + 5, len);
                c += 5 + len;
            } else {
                s.addOns[i].params = TV.pool(d.u8(c + 3));
                c += 4;
            }
        }
        return c;
    }

    function _setUint(BoxSpecV1.BoxSpec memory s, uint256 f, uint256 v) internal pure {
        // The generator writes values inside each field's type (viem refuses others); the casts below are exact.
        // forge-lint: disable-start(unsafe-typecast)
        if (f == 0) s.version = uint16(_fits(v, 16));
        else if (f == 1) s.boxType = uint8(_fits(v, 8));
        else if (f == 7) s.n = uint32(_fits(v, 32));
        else if (f == 8) s.firstId = v;
        else if (f == 10) s.raise = v;
        else if (f == 11) s.layout = uint8(_fits(v, 8));
        else if (f == 12) s.gradLayout = uint8(_fits(v, 8));
        else if (f == 13) s.launchFormat = uint8(_fits(v, 8));
        else if (f == 14) s.openAt = uint32(_fits(v, 32));
        else if (f == 15) s.deadlineDays = uint16(_fits(v, 16));
        else if (f == 16) s.qStream = uint8(_fits(v, 8));
        else if (f == 17) s.tStream = uint8(_fits(v, 8));
        else if (f == 18) s.artMode = uint8(_fits(v, 8));
        else if (f == 26) s.creatorBuy = v;
        else revert("AuditU9ClaudeTwin: uint field");
        // forge-lint: disable-end(unsafe-typecast)
    }

    function _fits(uint256 v, uint256 bits) internal pure returns (uint256) {
        require(v >> bits == 0, "AuditU9ClaudeTwin: value outside its type");
        return v;
    }

    function _setAddress(BoxSpecV1.BoxSpec memory s, uint256 f, address a) internal pure {
        if (f == 9) s.q = a;
        else if (f == 24) s.marketplaceOwner = a;
        else if (f == 25) s.creatorFeeRecipient = a;
        else revert("AuditU9ClaudeTwin: address field");
    }

    function _setWord(BoxSpecV1.BoxSpec memory s, uint256 f, bytes32 w) internal pure {
        if (f == 19) s.revealRoot = w;
        else if (f == 21) s.generatorHash = w;
        else if (f == 22) s.coverSha256 = w;
        else if (f == 23) s.revealListId = w;
        else if (f == 27) s.collectionCoverSha256 = w;
        else revert("AuditU9ClaudeTwin: word field");
    }

    function _setBytes(BoxSpecV1.BoxSpec memory s, uint256 f, bytes memory b) internal pure {
        if (f == 2) s.tokenName = string(b);
        else if (f == 3) s.tokenSymbol = string(b);
        else if (f == 4) s.collectionName = string(b);
        else if (f == 5) s.collectionSymbol = string(b);
        else if (f == 6) s.description = string(b);
        else if (f == 20) s.metadataTable = b;
        else revert("AuditU9ClaudeTwin: bytes field");
    }

    struct SpecHeader {
        uint256 base;
        uint256 ctx;
        uint256 reason;
        uint256 field;
        bytes32 hash;
        uint256 mutations;
    }

    function _header(bytes memory d, uint256 c) internal pure returns (SpecHeader memory h) {
        h.base = d.u8(c);
        h.ctx = d.u8(c + 1);
        h.reason = d.u16(c + 2);
        h.field = d.u16(c + 4);
        h.hash = bytes32(d.be(c + 6, 32));
        h.mutations = d.u8(c + 38);
    }

    /// @dev Rebuilds the vector at `c` and checks it; returns the cursor after it and whether it was accepted.
    function _checkSpecVector(bytes memory d, uint256 c, BoxSpecV1.VersionContext[] memory ctxs, uint256 index)
        internal
        returns (uint256, bool)
    {
        SpecHeader memory h = _header(d, c);
        c += 39;
        BoxSpecV1.BoxSpec memory s = abi.decode(TV.base(h.base), (BoxSpecV1.BoxSpec));
        for (uint256 m; m < h.mutations; ++m) {
            c = _apply(s, d, c);
        }
        (uint16 r, uint16 f) = BoxSpecV1.validate(s, ctxs[h.ctx]);
        bytes32 hash = BoxSpecV1.specHash(s);
        if (r != h.reason || f != h.field || hash != h.hash) {
            emit log_named_uint("vector in chunk", index);
            emit log_named_uint("twin reason", h.reason);
            emit log_named_uint("solidity reason", r);
            emit log_named_uint("twin field", h.field);
            emit log_named_uint("solidity field", f);
            emit log_named_bytes32("twin hash", h.hash);
            emit log_named_bytes32("solidity hash", hash);
            fail();
        }
        return (c, r == BoxSpecV1.REASON_OK);
    }

    /// @dev Replays one chunk: every vector's verdict, field and hash equal the twin's. Returns the counts.
    function _replaySpecChunk(uint256 chunk) internal returns (uint256 count, uint256 accepted) {
        bytes memory d = TV.specChunk(chunk);
        BoxSpecV1.VersionContext[] memory ctxs = _contexts();
        uint256 c;
        while (c < d.length) {
            bool ok;
            (c, ok) = _checkSpecVector(d, c, ctxs, count);
            if (ok) ++accepted;
            ++count;
        }
        assertGt(count, 0);
        emit log_named_uint("chunk", chunk);
        emit log_named_uint("vectors", count);
        emit log_named_uint("accepted", accepted);
    }

    /// The generated set as built: at least 2,000 random specs (here 3,200), both verdicts, every reason code.
    function testProperty_AUDIT_U9_twinVectorSetShape() public pure {
        assertGe(TV.SPEC_VECTORS, 2_000, "P9.7: at least 2,000 random specs");
        assertGt(TV.SPEC_ACCEPTED, 500, "valid specs are part of the set");
        assertGt(TV.SPEC_VECTORS - TV.SPEC_ACCEPTED, 1_000, "refused specs are part of the set");
        assertEq(TV.SPEC_CHUNKS, 16, "one test per chunk below");
        assertEq(TV.CONTEXTS, 7);
        assertEq(TV.BASES, 4);
    }

    /// @dev The cursor after the mutation at `c`, without applying it.
    function _skip(bytes memory d, uint256 c) internal pure returns (uint256) {
        uint256 op = d.u8(c);
        if (op == 1) return c + 3 + d.u8(c + 2);
        if (op == 2) return c + 22;
        if (op == 3) return c + 34;
        if (op == 4) return c + 4 + d.u16(c + 2);
        if (op == 5) return c + 3;
        require(op == 6, "AuditU9ClaudeTwin: op");
        uint256 count = d.u8(c + 1);
        c += 2;
        for (uint256 i; i < count; ++i) {
            c += d.u8(c + 2) == 0 ? 5 + d.u16(c + 3) : 4;
        }
        return c;
    }

    /// Every vector of every chunk is read whole (the count is the constant's), and every reason code 0-20 is the twin's
    /// answer to some vector (the chunk replays assert that Solidity gives the same one each time).
    function testProperty_AUDIT_U9_twinCoversEveryReason() public pure {
        bool[21] memory seen;
        uint256 count;
        uint256 accepted;
        for (uint256 k; k < TV.SPEC_CHUNKS; ++k) {
            bytes memory d = TV.specChunk(k);
            uint256 c;
            while (c < d.length) {
                uint256 reason = d.u16(c + 2);
                uint256 mutations = d.u8(c + 38);
                assertLe(reason, 20, "a known reason code");
                if (reason == 0) assertEq(d.u16(c + 4), 0, "OK carries field 0");
                else assertGt(d.u16(c + 4), 0, "a refusal names a field");
                c += 39;
                for (uint256 m; m < mutations; ++m) {
                    c = _skip(d, c);
                }
                seen[reason] = true;
                ++count;
                if (reason == 0) ++accepted;
            }
            assertEq(c, d.length, "the chunk ends on a vector");
        }
        assertEq(count, TV.SPEC_VECTORS);
        assertEq(accepted, TV.SPEC_ACCEPTED);
        for (uint256 r; r <= 20; ++r) {
            assertTrue(seen[r], string.concat("reason ", vm.toString(r)));
        }
    }

    function testProperty_AUDIT_U9_twinSpecChunk00() public {
        _replaySpecChunk(0);
    }

    function testProperty_AUDIT_U9_twinSpecChunk01() public {
        _replaySpecChunk(1);
    }

    function testProperty_AUDIT_U9_twinSpecChunk02() public {
        _replaySpecChunk(2);
    }

    function testProperty_AUDIT_U9_twinSpecChunk03() public {
        _replaySpecChunk(3);
    }

    function testProperty_AUDIT_U9_twinSpecChunk04() public {
        _replaySpecChunk(4);
    }

    function testProperty_AUDIT_U9_twinSpecChunk05() public {
        _replaySpecChunk(5);
    }

    function testProperty_AUDIT_U9_twinSpecChunk06() public {
        _replaySpecChunk(6);
    }

    function testProperty_AUDIT_U9_twinSpecChunk07() public {
        _replaySpecChunk(7);
    }

    function testProperty_AUDIT_U9_twinSpecChunk08() public {
        _replaySpecChunk(8);
    }

    function testProperty_AUDIT_U9_twinSpecChunk09() public {
        _replaySpecChunk(9);
    }

    function testProperty_AUDIT_U9_twinSpecChunk10() public {
        _replaySpecChunk(10);
    }

    function testProperty_AUDIT_U9_twinSpecChunk11() public {
        _replaySpecChunk(11);
    }

    function testProperty_AUDIT_U9_twinSpecChunk12() public {
        _replaySpecChunk(12);
    }

    function testProperty_AUDIT_U9_twinSpecChunk13() public {
        _replaySpecChunk(13);
    }

    function testProperty_AUDIT_U9_twinSpecChunk14() public {
        _replaySpecChunk(14);
    }

    function testProperty_AUDIT_U9_twinSpecChunk15() public {
        _replaySpecChunk(15);
    }

    // ================================================================================================ encoded vectors

    struct Encoded {
        bytes bytes_;
        bool tsThrew;
        uint256 tsReason;
        uint256 tsField;
        bool tsHashThrew;
        bytes32 tsHash;
        uint256 offset;
    }

    function _encoded() internal pure returns (Encoded[] memory out) {
        bytes memory d = TV.encodedVectors();
        out = new Encoded[](TV.ENCODED_VECTORS);
        uint256 c;
        for (uint256 i; i < out.length; ++i) {
            Encoded memory e = out[i];
            e.bytes_ = TV.base(d.u8(c));
            e.tsThrew = d.u8(c + 1) == 1;
            e.tsReason = d.u16(c + 2);
            e.tsField = d.u16(c + 4);
            e.tsHashThrew = d.u8(c + 6) == 1;
            e.tsHash = bytes32(d.be(c + 7, 32));
            uint256 patches = d.u8(c + 39);
            c += 40;
            for (uint256 p; p < patches; ++p) {
                e.offset = d.u16(c);
                e.bytes_[e.offset] = d[c + 2];
                c += 3;
            }
        }
        assertEq(c, d.length);
    }

    /// P9.10 (Solidity leg): an out-of-range value in encoded spec data refuses: each of the 19 encodings (box 0's
    /// fixture with high bits set in one static word: an address above 160 bits, a uint8, uint16 or uint32 above its
    /// type) reverts in `abi.decode`, so `validate()` never sees a value mapped to a member. createBox takes the spec
    /// as an ABI argument (BoxFactoryV1.sol:228), so the same bytes as its calldata revert there too.
    function testProperty_AUDIT_U9_dirtyWordsRevertInAbiDecode() public {
        Encoded[] memory e = _encoded();
        bytes memory ctx = TV.context(0);
        for (uint256 i; i < e.length; ++i) {
            vm.expectRevert();
            harness.decodeAndValidate(e[i].bytes_, ctx);
        }
        // The clean fixture decodes and is accepted (the control).
        (uint16 reason,, bytes32 hash) = harness.decodeAndValidate(TV.base(0), ctx);
        assertEq(reason, BoxSpecV1.REASON_OK);
        assertEq(hash, keccak256(TV.base(0)));
    }

    // W3-U9-1 (FQ-34, F147): fixed off chain in f7a16611b; this proof now asserts the fixed twin (SH-AUDIT-B0-FINAL).
    /// @notice Proof test 01, flipped (P9.7 / BC-001, P9.10; twin agreement on encoded bytes). Register row W3-U9-1.
    /// - Property: the TypeScript twin gives "Solidity's verdict on ABI bytes from anywhere" and throws where
    ///   `abi.decode` reverts (packages/box-spec/src/generated/box-spec.v1.ts, `validateEncodedBoxSpecV1`);
    ///   `specHashOfEncoded` is "Solidity's `specHash(abi.decode(encoded))`" (the same file); BC-001: both
    ///   implementations accept and refuse exactly the same specs; P9.10: an out-of-range value in encoded data
    ///   refuses, never maps to a valid one.
    /// - Before the fix (the proof as written at `90422e8d6`): viem's decoder kept an address word's low 20 bytes and
    ///   read a uintN word whole, so `validateEncodedBoxSpecV1` accepted 7 of the 19 dirty encodings of box 0's fixture
    ///   with (REASON_OK, 0) and `specHashOfEncoded` returned box 0's canonical hash for 6 of them.
    /// - Now (fix `f7a16611b`, packages/box-spec/scripts/lib/emit-ts.mjs: `decodeBoxSpecV1Bytes` re-encodes what it
    ///   decoded and throws unless that gives the input back): the vectors regenerated from the fixed twin
    ///   (`AuditU9ClaudeGen.mjs`) record that both functions throw on all 19, as Solidity's `abi.decode` reverts on all
    ///   19; the clean fixture still decodes, validates and hashes to keccak256 of its bytes.
    /// - Steps: box 0's canonical encoding (base 0) with one byte set in a static word (the 19 patches of
    ///   `encodedVectors()`). Amounts: none (no value moves).
    function testFixed_AUDIT_U9_01_twinRefusesEncodingsSolidityCannotDecode() public {
        Encoded[] memory e = _encoded();
        bytes memory ctx = TV.context(0);
        assertEq(e.length, 19, "the 19 dirty encodings of box 0's fixture");
        for (uint256 i; i < e.length; ++i) {
            vm.expectRevert();
            harness.decodeAndValidate(e[i].bytes_, ctx);
            assertTrue(e[i].tsThrew, "validateEncodedBoxSpecV1 throws where abi.decode reverts");
            assertTrue(e[i].tsHashThrew, "specHashOfEncoded throws where abi.decode reverts");
        }
        // The control: the clean fixture decodes, is accepted, and hashes to keccak256 of its own bytes.
        (uint16 reason,, bytes32 hash) = harness.decodeAndValidate(TV.base(0), ctx);
        assertEq(reason, BoxSpecV1.REASON_OK);
        assertEq(hash, keccak256(TV.base(0)));
    }

    // W3-U9-3 (FQ-36, F147): fixed off chain in f7a16611b; this proof now asserts the fixed twin (SH-AUDIT-B0-FINAL).
    /// @notice Proof test 03, flipped (P9.7: the twin's per-network lists, F74 U1). Register row W3-U9-3.
    /// - Property: the twin's Sepolia list leaves out only "what core v1 does not build" (box-spec.v1.ts, OFFERED_ON
    ///   and NOT_BUILT); core v1 builds the per-item stream (src/box/BoxItemStream.sol, S8), template 0 requires it
    ///   (BoxFactoryV1Planner.sol:412), and Sepolia's box 0 uses it (its spec file,
    ///   script/config/box0-spec.11155111.rehearsal.sepolia-safe.json: tStream 4).
    /// - Before the fix: `validateBoxSpecV1(box 0's fixture, CONTEXT_V1, 'sepolia')` was (NOT_OFFERED, field 18,
    ///   tStream): box-spec.v1.json:141 still marked PER_ITEM_STREAM `notBuiltOn: ["sepolia"]`.
    /// - Now (fix `f7a16611b`: the mark dropped, the twin regenerated): the vectors regenerated from the fixed twin
    ///   (`AuditU9ClaudeGen.mjs`) record (OK, 0) on mainnet, sepolia and demo; Solidity's validate() (which has no
    ///   network) accepts the fixture too.
    /// - Steps: the vectors `AuditU9ClaudeTwinVectors.networkVectors()` (the twin's verdicts on the three networks).
    ///   Amounts: none.
    function testFixed_AUDIT_U9_03_twinSepoliaListOffersBox0sStream() public view {
        bytes memory d = TV.networkVectors();
        assertEq(d.length, 12);
        // mainnet, sepolia, demo: (reason, field) each
        for (uint256 k; k < 3; ++k) {
            assertEq(d.u16(4 * k), BoxSpecV1.REASON_OK, "the twin accepts box 0's fixture on every network");
            assertEq(d.u16(4 * k + 2), 0);
        }
        BoxSpecV1.BoxSpec memory s = abi.decode(TV.base(0), (BoxSpecV1.BoxSpec));
        assertEq(s.tStream, BoxSpecV1.T_STREAM_PER_ITEM_STREAM);
        (uint16 reason,) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        assertEq(reason, BoxSpecV1.REASON_OK, "Solidity accepts it");
        BoxSpecV1.BoxSpec memory sepolia = abi.decode(
            vm.parseJsonBytes(
                vm.readFile(
                    string.concat(vm.projectRoot(), "/script/config/box0-spec.11155111.rehearsal.sepolia-safe.json")
                ),
                ".encoded"
            ),
            (BoxSpecV1.BoxSpec)
        );
        assertEq(sepolia.tStream, BoxSpecV1.T_STREAM_PER_ITEM_STREAM, "Sepolia's box 0 streams to its items");
    }

    // ================================================================================================ layout vectors

    struct LayoutVector {
        uint256 raise;
        bool tIsC0;
        uint256 status;
        int24 tickLower;
        uint128 liquidity;
        uint256 curveT;
        uint256 qHeld;
        uint256 tAvailable;
        uint256[2] gradStatus;
        bytes32[2] gradHash;
    }

    function _readLayout(bytes memory d, uint256 c) internal pure returns (LayoutVector memory v, uint256) {
        v.raise = d.be(c, 32);
        v.tIsC0 = d.u8(c + 32) == 1;
        v.status = d.u8(c + 33);
        c += 34;
        if (v.status != 0) return (v, c);
        // casting to 'int256' is safe because be() of 3 bytes is below 2^24
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 t = int256(d.be(c, 3));
        if (t >= 1 << 23) t -= 1 << 24;
        // casting to 'int24' is safe because t is a 24-bit two's complement value
        // forge-lint: disable-next-line(unsafe-typecast)
        v.tickLower = int24(t);
        // casting to 'uint128' is safe because be() of 16 bytes is below 2^128
        // forge-lint: disable-next-line(unsafe-typecast)
        v.liquidity = uint128(d.be(c + 3, 16));
        v.curveT = d.be(c + 19, 32);
        v.qHeld = d.be(c + 51, 32);
        v.tAvailable = d.be(c + 83, 32);
        c += 115;
        for (uint256 k; k < 2; ++k) {
            v.gradStatus[k] = d.u8(c);
            v.gradHash[k] = bytes32(d.be(c + 1, 32));
            c += 33;
        }
        return (v, c);
    }

    function _gradHash(BoxLayoutV1.Graduated memory g) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                g.bid.tickLower,
                g.bid.tickUpper,
                g.bid.liquidity,
                g.bid.amount,
                g.sentinel.tickLower,
                g.sentinel.tickUpper,
                g.sentinel.liquidity,
                g.sentinel.amount,
                g.ask.tickLower,
                g.ask.tickUpper,
                g.ask.liquidity,
                g.ask.amount,
                g.qDust,
                g.tDust
            )
        );
    }

    function _checkRefusedLayout(LayoutVector memory v) internal {
        bytes4[6] memory sels = [
            BoxLayoutV1.RaiseIsZero.selector,
            BoxLayoutV1.CentreOutOfRange.selector,
            BoxLayoutV1.CurveOutOfRange.selector,
            BoxLayoutV1.NoExactLiquidity.selector,
            BoxLayoutV1.CurveTooLarge.selector,
            bytes4(0)
        ];
        try harness.curve(v.raise, v.tIsC0) {
            emit log_named_uint("raise the twin refuses", v.raise);
            fail();
        } catch (bytes memory err) {
            if (v.status <= 5) assertEq(bytes4(err), sels[v.status - 1], "the twin's error");
        }
    }

    function _checkLayout(LayoutVector memory v) internal {
        BoxLayoutV1.Curve memory cv = harness.curve(v.raise, v.tIsC0);
        assertEq(cv.tickLower, v.tickLower, "tickLower");
        assertEq(cv.liquidity, v.liquidity, "liquidity");
        assertEq(cv.curveT, v.curveT, "curveT");
        for (uint256 k; k < 2; ++k) {
            // casting to 'uint8' is safe because k + 1 is 1 or 2
            // forge-lint: disable-next-line(unsafe-typecast)
            uint8 layout = uint8(k + 1);
            if (v.gradStatus[k] == 0) {
                assertEq(_gradHash(harness.graduated(cv, layout, v.qHeld, v.tAvailable)), v.gradHash[k], "layout");
            } else {
                vm.expectRevert();
                harness.graduated(cv, layout, v.qHeld, v.tAvailable);
            }
        }
    }

    function _replayLayoutChunk(uint256 chunk) internal returns (uint256 count, uint256 ok) {
        bytes memory d = TV.layoutChunk(chunk);
        uint256 c;
        while (c < d.length) {
            LayoutVector memory v;
            (v, c) = _readLayout(d, c);
            ++count;
            if (v.status != 0) {
                _checkRefusedLayout(v);
            } else {
                ++ok;
                _checkLayout(v);
            }
        }
    }

    /// P9.6 / P9.7 for the layout twin (packages/box-spec/src/layout.ts with its own port of the v4 maths,
    /// src/v4-math.ts): 420 raises from 1 wei to 2^256 - 1 in both token orders give the same ticks, liquidity and
    /// curve T, the same refusals, and both graduated layouts to the unit at random (qHeld, tAvailable).
    function testProperty_AUDIT_U9_layoutTwinAgrees() public {
        uint256 count;
        uint256 ok;
        for (uint256 i; i < TV.LAYOUT_CHUNKS; ++i) {
            (uint256 n, uint256 k) = _replayLayoutChunk(i);
            count += n;
            ok += k;
        }
        assertEq(count, TV.LAYOUT_VECTORS);
        assertEq(ok, TV.LAYOUT_OK);
        assertGt(ok, 250, "most raises lay out");
        assertGt(count - ok, 40, "and the refusals are compared too");
    }

    // ================================================================================================ encodings (P9.9)

    /// P9.9: base64 and base32 equal a reference for every input length 0..96 (every remainder class of 3 and of 5):
    /// base64 against Node's Buffer (recorded) and forge's `vm.toBase64` (Rust), base32 against the generator's own
    /// bit-accumulator encoder; `rawCidV1` against "b" + that base32 of 0x01551220 ‖ digest for six digests (box 0's
    /// cover, collection cover and banner, zero, all ones, random).
    function testProperty_AUDIT_U9_encodingsMatchReferences() public pure {
        bytes memory d = TV.encodingVectors();
        uint256 c;
        for (uint256 i; i < TV.ENCODING_VECTORS; ++i) {
            c = _checkEncodingVector(d, c, i);
        }
        assertEq(c, d.length);
        for (uint256 i; i < TV.CIDS; ++i) {
            string memory cid = BoxEncoding.rawCidV1(bytes32(TV.cidDigest(i)));
            assertEq(bytes(cid), TV.cid(i), "rawCidV1");
            assertEq(bytes(cid).length, 59);
        }
    }

    function _checkEncodingVector(bytes memory d, uint256 c, uint256 i) internal pure returns (uint256) {
        uint256 len = d.u8(c);
        assertEq(len, i, "every length 0..96");
        bytes memory data = d.slice(c + 1, len);
        c += 1 + len;
        bytes memory b64 = d.slice(c + 2, d.u16(c));
        c += 2 + b64.length;
        bytes memory b32 = d.slice(c + 2, d.u16(c));
        c += 2 + b32.length;
        assertEq(bytes(BoxEncoding.base64(data)), b64, "base64 = Node");
        assertEq(BoxEncoding.base64(data), vm.toBase64(data), "base64 = forge");
        assertEq(bytes(BoxEncoding.base32Lower(data)), b32, "base32 = reference");
        assertEq(b64.length, 4 * ((len + 2) / 3));
        assertEq(b32.length, (8 * len + 4) / 5);
        return c;
    }
}
