// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {HeaderVectors} from "../../backup/HeaderVectors.sol";
import {BoxDrandVectors} from "../../randomness/utils/BoxDrandVectors.sol";
import {PinnedBackedSource} from "../../randomness/utils/PinnedBackedSource.sol";
import {PinnedDrandSource} from "../../randomness/utils/PinnedDrandSource.sol";

/// @notice TEST ONLY. RLP for block headers (Yellow Paper appendix B), canonical unless a test asks otherwise.
library AuditU8ClaudeRlp {
    /// @notice A byte string: a single byte below 0x80 is itself; up to 55 bytes 0x80 + length; longer 0xb7 + the
    /// length of the length, then the length.
    function str(bytes memory b) internal pure returns (bytes memory) {
        if (b.length == 1 && uint8(b[0]) < 0x80) return b;
        return bytes.concat(_prefix(0x80, b.length), b);
    }

    /// @notice An unsigned integer: its minimal big-endian bytes as a string (0 is the empty string, 0x80).
    function uintStr(uint256 v) internal pure returns (bytes memory) {
        return str(be(v));
    }

    function list(bytes memory payload) internal pure returns (bytes memory) {
        return bytes.concat(_prefix(0xc0, payload.length), payload);
    }

    /// @notice The minimal big-endian bytes of `v` (none for 0).
    function be(uint256 v) internal pure returns (bytes memory out) {
        uint256 n;
        for (uint256 t = v; t != 0; t >>= 8) {
            ++n;
        }
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[n - 1 - i] = bytes1(uint8(v >> (8 * i)));
        }
    }

    function _prefix(uint8 base, uint256 len) private pure returns (bytes memory) {
        if (len <= 55) return abi.encodePacked(uint8(base + len));
        bytes memory l = be(len);
        return bytes.concat(abi.encodePacked(uint8(base + 55 + l.length)), l);
    }
}

/// @title AuditU8ClaudeHeadersTest (SH-AUDIT-B0 U8, lens L6 P8.11: header shapes per fork, and malformed RLP)
/// @notice `BoxBackedSource._prevRandao` (`BoxBackedSource.sol:262-277`) reads field 13 of an RLP header list whose first
/// 13 items are byte strings ("fixed since London; later forks only append fields"); `startBackup` and `fixBackup`
/// call it only on bytes whose keccak256 is the block's hash (`:180`, `:199`). Properties:
/// - for every header shape from Frontier's 15 fields through London (16), Shanghai (17), Cancun (20), Prague and Osaka
///   (21) to Amsterdam (23: the block-access-list hash and the slot number, as Sepolia's real header of 2026-10-20 has
///   them), with any field values (numbers up to 2^64, extra data of 0 to 32 bytes, pre-merge difficulty), the header
///   whose hash is the target's parses to its own field 13 through `fixBackup`, and is accepted as a recent header by
///   `startBackup`;
/// - the two real headers (mainnet's 21 fields, Sepolia's 23) hash to their recorded block hashes and parse to their
///   recorded mixHash;
/// - malformed lists are refused with `BadHeader`: trailing bytes, a list among the first 13 fields, field 13 not a
///   32-byte string (also a non-canonical long-form 32-byte string), an outer short list. Non-minimal lengths elsewhere
///   are parsed (the walker does not check canonical form, as `BackupReviewLight.t.sol`'s reference decoder records);
///   they cannot matter, because the chain commits to the canonical encoding: a re-encoding of the target's real header
///   with a non-minimal length has another hash and is refused `WrongHeader` before the walker runs.
/// forge-config: default.evm_version = "osaka"
contract AuditU8ClaudeHeadersTest is BoxDrandVectors {
    using AuditU8ClaudeRlp for bytes;

    DrandSource internal drand;
    BoxBackedSource internal src;
    uint256 internal r0;
    uint256 internal target;

    /// @dev Header shapes: the number of fields of each fork's header.
    uint256 internal constant FRONTIER = 15;
    uint256 internal constant LONDON = 16;
    uint256 internal constant SHANGHAI = 17;
    uint256 internal constant CANCUN = 20;
    uint256 internal constant PRAGUE = 21; // Osaka adds no header field
    uint256 internal constant AMSTERDAM = 23;

    function setUp() public virtual {
        _loadBoxDrand();
        r0 = _localFirst();
        vm.chainId(1);
        drand = PinnedDrandSource.deploy(vm);
        src = PinnedBackedSource.deploy(vm);
        vm.roll(23_000_000);
        vm.warp(src.roundTime(r0) - 12);
        vm.prank(makeAddr("audit.u8.headers.consumer"));
        src.request(1);
        vm.warp(src.roundTime(r0) + 5 days + 1);
        vm.setBlockhash(vm.getBlockNumber() - 1, keccak256(HeaderVectors.MAINNET));
        target = src.startBackup(r0, vm.getBlockNumber() - 1, HeaderVectors.MAINNET);
        vm.roll(target + 1);
        vm.warp(vm.getBlockTimestamp() + 12 * 257);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Header builders

    function _h32(uint256 seed, string memory tag) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encode(seed, tag)));
    }

    function _bytesOf(uint256 seed, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = bytes1(uint8(uint256(keccak256(abi.encode(seed, "b", i)))));
        }
    }

    /// @dev A header of `fields` fields (one of the shapes above) for block `number`, with field 13 = `mix` and every
    /// other value drawn from `seed`, canonically encoded.
    function _header(uint256 fields, uint256 number, bytes32 mix, uint256 seed) internal pure returns (bytes memory) {
        bytes memory p = _hashes(seed);
        p = bytes.concat(p, _numbers(fields, number, seed));
        p = bytes.concat(p, abi.encodePacked(mix).str(), abi.encodePacked(bytes8(uint64(seed >> 100))).str());
        p = bytes.concat(p, _appended(fields, seed));
        return AuditU8ClaudeRlp.list(p);
    }

    /// @dev Fields 0-6: parent, ommers, coinbase, state, transactions and receipts roots, the 256-byte bloom.
    function _hashes(uint256 seed) internal pure returns (bytes memory p) {
        p = bytes.concat(_h32(seed, "parent").str(), _h32(seed, "ommers").str());
        p = bytes.concat(p, abi.encodePacked(bytes20(keccak256(abi.encode(seed, "coinbase")))).str());
        p = bytes.concat(p, _h32(seed, "state").str(), _h32(seed, "txs").str(), _h32(seed, "receipts").str());
        p = bytes.concat(p, _bytesOf(seed, 256).str());
    }

    /// @dev Fields 7-12: difficulty (pre-merge only), number, gas limit, gas used, time, extra data (0 to 32 bytes).
    function _numbers(uint256 fields, uint256 number, uint256 seed) internal pure returns (bytes memory p) {
        uint256 difficulty = fields <= FRONTIER ? (seed >> 64) % (uint256(1) << 80) : 0;
        p = bytes.concat(AuditU8ClaudeRlp.uintStr(difficulty), AuditU8ClaudeRlp.uintStr(number));
        p = bytes.concat(p, AuditU8ClaudeRlp.uintStr(30_000_000 + seed % 30_000_000));
        p = bytes.concat(p, AuditU8ClaudeRlp.uintStr(seed % 30_000_000));
        p = bytes.concat(p, AuditU8ClaudeRlp.uintStr(1_600_000_000 + (seed >> 32) % 400_000_000));
        p = bytes.concat(p, _bytesOf(seed >> 8, (seed >> 16) % 33).str());
    }

    /// @dev Fields 15 on: base fee (London), withdrawals root (Shanghai), blob gas used, excess blob gas, beacon root
    /// (Cancun), requests hash (Prague), block-access-list hash and slot number (Amsterdam).
    function _appended(uint256 fields, uint256 seed) internal pure returns (bytes memory p) {
        if (fields >= LONDON) p = AuditU8ClaudeRlp.uintStr((seed >> 128) % 1_000_000_000_000);
        if (fields >= SHANGHAI) p = bytes.concat(p, _h32(seed, "withdrawals").str());
        if (fields >= CANCUN) {
            p = bytes.concat(p, AuditU8ClaudeRlp.uintStr(((seed >> 140) % 7) * 131_072));
            p = bytes.concat(p, AuditU8ClaudeRlp.uintStr((seed >> 150) % 100_000_000), _h32(seed, "beaconRoot").str());
        }
        if (fields >= PRAGUE) p = bytes.concat(p, _h32(seed, "requests").str());
        if (fields >= AMSTERDAM) {
            p = bytes.concat(p, _h32(seed, "blockAccessList").str());
            p = bytes.concat(p, AuditU8ClaudeRlp.uintStr((seed >> 170) % 50_000_000));
        }
    }

    /// @dev The number of items in an RLP list (a small independent walker, for the shape assertions).
    function _count(bytes memory h) internal pure returns (uint256 n) {
        uint256 b0 = uint8(h[0]);
        uint256 ll = b0 - 0xf7;
        uint256 p = 1 + ll;
        while (p < h.length) {
            uint256 b = uint8(h[p]);
            if (b < 0x80) {
                p += 1;
            } else if (b < 0xb8) {
                p += 1 + b - 0x80;
            } else if (b < 0xc0) {
                uint256 l2 = b - 0xb7;
                uint256 len;
                for (uint256 i; i < l2; ++i) {
                    len = len * 256 + uint8(h[p + 1 + i]);
                }
                p += 1 + l2 + len;
            } else {
                revert("a list item");
            }
            ++n;
        }
    }

    function _shape(uint256 i) internal pure returns (uint256) {
        uint256[6] memory shapes = [FRONTIER, LONDON, SHANGHAI, CANCUN, PRAGUE, AMSTERDAM];
        return shapes[i % 6];
    }

    function _fixWith(bytes memory h) internal returns (bool ok, bytes memory ret) {
        vm.setBlockhash(target, keccak256(h));
        (ok, ret) = address(src).call(abi.encodeCall(BoxBackedSource.fixBackup, (r0, h)));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Shapes

    /// @notice Every fork's shape with any field values: the header whose hash is the target's parses to its field 13.
    function testFuzz_AUDIT_U8_everyForkShapeParsesToField13(uint256 shape, uint256 seed, bytes32 mix) public {
        uint256 fields = _shape(shape);
        bytes memory h = _header(fields, target, mix, seed);
        assertEq(_count(h), fields, "the shape");
        (bool ok, bytes memory ret) = _fixWith(h);
        assertTrue(ok, "parsed");
        assertEq(abi.decode(ret, (bytes32)), mix, "field 13");
        (,,, bytes32 stored) = src.backupOf(r0);
        assertEq(stored, mix);
    }

    /// @notice Every shape is accepted as the start's recent header (the format check of `startBackup`).
    function testFuzz_AUDIT_U8_everyForkShapeStarts(uint256 shape, uint256 seed, uint256 age) public {
        uint256 fields = _shape(shape);
        // r0 + 1's start window is open: setUp's clock is round time + 5 d + 1 s + 257 blocks.
        age = bound(age, 1, 8);
        bytes memory h = _header(fields, vm.getBlockNumber() - age, keccak256(abi.encode(seed)), seed);
        vm.setBlockhash(vm.getBlockNumber() - age, keccak256(h));
        assertEq(src.startBackup(r0 + 1, vm.getBlockNumber() - age, h), vm.getBlockNumber() + 256);
    }

    /// @notice The two real headers: keccak256(RLP) is the recorded block hash, the shapes are Osaka's 21 fields
    /// (mainnet) and Amsterdam's 23 (Sepolia, with the block-access-list hash and the slot number), and each parses to
    /// its recorded mixHash.
    function testProperty_AUDIT_U8_realHeadersHashAndParse() public {
        assertEq(keccak256(HeaderVectors.MAINNET), HeaderVectors.MAINNET_HASH, "mainnet block 26,233,781");
        assertEq(keccak256(HeaderVectors.SEPOLIA), HeaderVectors.SEPOLIA_HASH, "Sepolia block 11,955,279");
        assertEq(_count(HeaderVectors.MAINNET), PRAGUE, "mainnet: 21 fields");
        assertEq(_count(HeaderVectors.SEPOLIA), AMSTERDAM, "Sepolia: 23 fields");
        uint256 snap = vm.snapshotState();
        (bool ok, bytes memory ret) = _fixWith(HeaderVectors.MAINNET);
        assertTrue(ok);
        assertEq(abi.decode(ret, (bytes32)), HeaderVectors.MAINNET_MIX);
        vm.revertToState(snap);
        (ok, ret) = _fixWith(HeaderVectors.SEPOLIA);
        assertTrue(ok);
        assertEq(abi.decode(ret, (bytes32)), HeaderVectors.SEPOLIA_MIX);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Malformed headers

    /// @notice Malformed lists whose hash is made the target's are refused with `BadHeader`: one byte appended, a list
    /// as field k < 13, field 13 of 31 or 33 bytes, field 13 as a long-form 32-byte string (0xb8 0x20), and an outer
    /// short list.
    function testFuzz_AUDIT_U8_malformedHeadersRefused(uint256 shape, uint256 seed, uint256 how) public {
        uint256 fields = _shape(shape);
        bytes memory h;
        uint256 kind = how % 5;
        if (kind == 0) {
            h = bytes.concat(_header(fields, target, keccak256("m"), seed), hex"00");
        } else if (kind == 1) {
            h = _withField(fields, seed, (seed >> 3) % 13, hex"c3010203");
        } else if (kind == 2) {
            h = _withField(
                fields,
                seed,
                13,
                seed % 2 == 0
                    ? bytes(abi.encodePacked(bytes31(0))).str()
                    : bytes(abi.encodePacked(bytes32(0), bytes1(0))).str()
            );
        } else if (kind == 3) {
            h = _withField(fields, seed, 13, bytes.concat(hex"b820", keccak256("m")));
        } else {
            h = hex"c5c0c0c0c0c0"; // a short list
        }
        (bool ok, bytes memory ret) = _fixWith(h);
        assertFalse(ok, "refused");
        assertEq(ret, abi.encodeWithSelector(BoxBackedSource.BadHeader.selector), "BadHeader, never a panic");
    }

    /// @dev The canonical header of `fields` fields with field `k` replaced by the raw item `item`.
    function _withField(uint256 fields, uint256 seed, uint256 k, bytes memory item)
        internal
        view
        returns (bytes memory)
    {
        bytes memory h = _header(fields, target, keccak256("m"), seed);
        (uint256[] memory starts, uint256 payloadStart) = _items(h);
        bytes memory payload;
        for (uint256 i; i < starts.length; ++i) {
            uint256 end = i + 1 < starts.length ? starts[i + 1] : h.length;
            payload = bytes.concat(payload, i == k ? item : _slice(h, starts[i], end));
        }
        payloadStart;
        return AuditU8ClaudeRlp.list(payload);
    }

    function _items(bytes memory h) internal pure returns (uint256[] memory starts, uint256 payloadStart) {
        uint256 n = _count(h);
        starts = new uint256[](n);
        uint256 ll = uint8(h[0]) - 0xf7;
        uint256 p = 1 + ll;
        payloadStart = p;
        for (uint256 k; k < n; ++k) {
            starts[k] = p;
            uint256 b = uint8(h[p]);
            if (b < 0x80) {
                p += 1;
            } else if (b < 0xb8) {
                p += 1 + b - 0x80;
            } else {
                uint256 l2 = b - 0xb7;
                uint256 len;
                for (uint256 i; i < l2; ++i) {
                    len = len * 256 + uint8(h[p + 1 + i]);
                }
                p += 1 + l2 + len;
            }
        }
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 i; i < out.length; ++i) {
            out[i] = b[from + i];
        }
    }

    /// @notice Non-minimal lengths: the walker parses them (an outer list length written with a leading zero byte, a
    /// field's short string written in long form), but the chain's header is canonical: when the target's hash is the
    /// canonical header's, the re-encoding is refused `WrongHeader`, and only the canonical header fixes the round.
    function testProperty_AUDIT_U8_nonMinimalLengthsCannotProveATarget() public {
        bytes memory canonical = _header(AMSTERDAM, target, keccak256("real mix"), 42);
        // The outer length in three bytes (0xfa 0x00 len16) instead of two.
        bytes memory payload = _slice(canonical, 3, canonical.length);
        bytes memory nonMinimal = bytes.concat(hex"fa00", bytes2(uint16(payload.length)), payload);
        // Alone (its own hash made the target's), the walker reads the same field 13.
        uint256 snap = vm.snapshotState();
        (bool ok, bytes memory ret) = _fixWith(nonMinimal);
        assertTrue(ok, "the walker does not check canonical form");
        assertEq(abi.decode(ret, (bytes32)), keccak256("real mix"));
        vm.revertToState(snap);
        // A field's 4-byte short string written as a long-form string (0xb8 0x04 ...): also parsed alone.
        bytes memory longForm = _withField(AMSTERDAM, 42, 9, bytes.concat(hex"b804", bytes4(0x01c9c380)));
        (ok,) = _fixWith(longForm);
        assertTrue(ok);
        vm.revertToState(snap);
        // On the chain the target's hash is the canonical header's: both re-encodings are refused before the walker.
        vm.setBlockhash(target, keccak256(canonical));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, target));
        src.fixBackup(r0, nonMinimal);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.WrongHeader.selector, target));
        src.fixBackup(r0, longForm);
        assertEq(src.fixBackup(r0, canonical), keccak256("real mix"));
    }
}

/// @notice The same under Amsterdam.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU8ClaudeHeadersAmsterdamTest is AuditU8ClaudeHeadersTest {}
