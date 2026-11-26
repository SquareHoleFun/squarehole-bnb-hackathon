// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ChunkPart, IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {M1_32bChunkHarness} from "./M1_32bDoubles.sol";

/// @title ChunkLoaderRedTest
/// @notice TEST ONLY. M1-32-b's red tests for `ChunkLoader` (`src/box-v2/libraries/ChunkLoader.sol`, a frozen stub), the
/// coordinator's chunk loader, through `M1_32bChunkHarness`. Each fails with the stub's `NotBuilt()` until M1-32-b
/// writes the bodies. The hash rule and the errors are `IBoxCoordinatorV2`'s (`:60-66`, `:112-116`): chunks of exactly
/// `chunkMax` bytes, the last 1 to `chunkMax`; h_n = 0, h_i = keccak256(chunk_i ‖ h_{i+1}); each chunk kept as data
/// code (0x00 ‖ bytes). Cases:
/// - BC-220 (N14, the open gate; F96 R20C; ADR-0017 § 6): a chunk off the factory's hash refused, a right one from any
///   sender, only the spec's order, the gate's chunk half (`complete()`), a token-only box open at once;
/// - the ticket's red list (`core-v2-m1-tickets.md` M1-32: "the chunk loader refuses a chunk off the factory's hash,
///   anyone may send a right one"); the file map's § 1 rule 3 (the loader's state at its own namespaced slot).
/// The effective open (max(openAt, the completing block's time + 1)) and `failClosed()` are the coordinator's entries
/// (M1-30-a's shell, M1-31's `CoordinatorFailure`), so they are not tested here.
contract ChunkLoaderRedTest is Test {
    /// A chunk size for the tests [P]: M1-60 sets the release's `CHUNK_MAX`; the rule holds for any size.
    uint256 internal constant MAX = 32;

    M1_32bChunkHarness internal h;
    address internal alice = makeAddr("m1-32b.alice");
    address internal bob = makeAddr("m1-32b.bob");
    address internal carol = makeAddr("m1-32b.carol");

    function setUp() public virtual {
        h = new M1_32bChunkHarness();
    }

    // ============================================================================================ the hash rule

    /// BC-220: empty → 0; a short single chunk; an exact multiple has no empty last chunk; a short last chunk.
    function test_rootOfFollowsTheHashRule() public view {
        assertEq(h.rootOf("", MAX), bytes32(0), "no such part");
        bytes memory one = _bytes(16, 1);
        assertEq(h.rootOf(one, MAX), keccak256(abi.encodePacked(one, bytes32(0))), "one short chunk");
        bytes memory two = _bytes(64, 2);
        bytes32 h1 = keccak256(abi.encodePacked(_slice(two, 32, 64), bytes32(0)));
        assertEq(h.rootOf(two, MAX), keccak256(abi.encodePacked(_slice(two, 0, 32), h1)), "two full chunks");
        assertEq(h.rootOf(_table(), MAX), _hashAt(_chunks(_table(), MAX), 0), "32 + 32 + 16 bytes");
    }

    /// BC-220: the factory's h_0 for any part and chunk size equals the rule's.
    function testFuzz_rootOfFollowsTheHashRule(bytes calldata part, uint256 chunkMax) public view {
        chunkMax = bound(chunkMax, 1, 64);
        bytes32 want = part.length == 0 ? bytes32(0) : _hashAt(_chunks(part, chunkMax), 0);
        assertEq(h.rootOf(part, chunkMax), want);
    }

    // ============================================================================================ loading

    /// What the factory kept: the root, the length and the chunk count; a part it did not init answers zeros.
    function test_initKeepsTheFactorysRootAndLength() public {
        bytes32 root = h.rootOf(_table(), MAX);
        h.init(ChunkPart.Table, root, 80, MAX);
        _assertState(ChunkPart.Table, root, 0, 3);
        (bytes32 r, uint256 len) = h.rootFor(ChunkPart.Table);
        assertEq(r, root);
        assertEq(len, 80);
        _assertState(ChunkPart.Texts, bytes32(0), 0, 0);
        (r, len) = h.rootFor(ChunkPart.Texts);
        assertEq(r, bytes32(0), "no texts");
        assertEq(len, 0);
        assertFalse(h.complete(), "the table is still to load");
    }

    /// BC-220 (`caller`: creator, anyone): the right chunks count from any sender, in order; each is kept as data code
    /// (0x00 ‖ bytes) at the pointer `load` returns.
    function test_anyoneLoadsTheRightChunksInOrder() public {
        bytes[] memory c = _initTable();
        address[3] memory senders = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            vm.prank(senders[i]);
            (uint256 index, bool done, address chunk) = h.load(ChunkPart.Table, c[i], _hashAt(c, i + 1));
            assertEq(index, i, "its index");
            assertEq(done, i == 2, "done at the last");
            assertEq(chunk, h.pointer(ChunkPart.Table, i), "the pointer");
            assertEq(chunk.code, abi.encodePacked(hex"00", c[i]), "0x00 then the chunk");
            _assertState(ChunkPart.Table, _hashAt(c, i + 1), i + 1, 3);
        }
        assertTrue(h.complete());
    }

    /// BC-220: a chunk off the stored hash is refused (`ChunkHashMismatch`), wrong data or a wrong next hash, and the
    /// state does not move.
    function test_refusesAChunkOffTheStoredHash() public {
        bytes[] memory c = _initTable();
        bytes32 root = _hashAt(c, 0);
        bytes memory bad = bytes.concat(c[0]);
        bad[5] = bad[5] ^ bytes1(0x01);
        _expectMismatch(0, root, keccak256(abi.encodePacked(bad, _hashAt(c, 1))));
        h.load(ChunkPart.Table, bad, _hashAt(c, 1));
        _expectMismatch(0, root, keccak256(abi.encodePacked(c[0], bytes32(uint256(1)))));
        h.load(ChunkPart.Table, c[0], bytes32(uint256(1)));
        _assertState(ChunkPart.Table, root, 0, 3);
    }

    /// BC-220: no order but the spec's: chunk 1 first is refused, and so is chunk 0 twice.
    function test_noOrderButTheSpecs() public {
        bytes[] memory c = _initTable();
        _expectMismatch(0, _hashAt(c, 0), keccak256(abi.encodePacked(c[1], _hashAt(c, 2))));
        h.load(ChunkPart.Table, c[1], _hashAt(c, 2));
        h.load(ChunkPart.Table, c[0], _hashAt(c, 1));
        _expectMismatch(1, _hashAt(c, 1), keccak256(abi.encodePacked(c[0], _hashAt(c, 1))));
        h.load(ChunkPart.Table, c[0], _hashAt(c, 1));
    }

    /// A complete part, and a part the box does not have, refuse more (`PartComplete`); `None` is no part.
    function test_aCompleteOrMissingPartRefuses() public {
        bytes[] memory c = _initTable();
        for (uint256 i; i < 3; ++i) {
            h.load(ChunkPart.Table, c[i], _hashAt(c, i + 1));
        }
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.PartComplete.selector, ChunkPart.Table));
        h.load(ChunkPart.Table, c[2], bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.PartComplete.selector, ChunkPart.Texts));
        h.load(ChunkPart.Texts, c[0], bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.UnknownPart.selector, ChunkPart.None));
        h.load(ChunkPart.None, c[0], bytes32(0));
    }

    // ============================================================================================ the gate's chunk half

    /// BC-220 (`chunks`: never, then all in): the gate's chunk half holds until every part is in.
    function test_completeWaitsForEveryPart() public {
        bytes[] memory t = _initTable();
        bytes[] memory x = _chunks(_bytes(64, 9), MAX);
        h.init(ChunkPart.Texts, _hashAt(x, 0), 64, MAX);
        for (uint256 i; i < 3; ++i) {
            assertFalse(h.complete(), "the table not all in");
            h.load(ChunkPart.Table, t[i], _hashAt(t, i + 1));
        }
        assertFalse(h.complete(), "the texts still to load");
        h.load(ChunkPart.Texts, x[0], _hashAt(x, 1));
        assertFalse(h.complete());
        h.load(ChunkPart.Texts, x[1], bytes32(0));
        assertTrue(h.complete(), "every part in");
    }

    /// BC-220, BC-228: a box with no table and no texts (a token-only box) is complete at once, so it opens at openAt.
    function test_aBoxWithNoChunksIsCompleteAtOnce() public view {
        assertTrue(h.complete());
    }

    /// File map § 1 rule 3: the loader keeps its state at its own namespaced slot (ERC-7201 style), so it writes none
    /// of the shell's low slots and the shell's own word stays.
    function test_loaderStateStaysOffTheShellsSlots() public {
        vm.record();
        bytes[] memory c = _initTable();
        h.load(ChunkPart.Table, c[0], _hashAt(c, 1));
        (, bytes32[] memory writes) = vm.accesses(address(h));
        assertGt(writes.length, 0, "the loader keeps state");
        for (uint256 i; i < writes.length; ++i) {
            assertGt(uint256(writes[i]), type(uint64).max, "a hash-derived slot, not the shell's base");
        }
        assertEq(h.shellWord(), 0x5ea1, "the shell's word");
    }

    /// BC-220: any part, any chunk size: loaded by the rule, it comes back byte for byte and completes the part.
    function testFuzz_loadsAnyPartBackByteForByte(bytes calldata raw, uint256 chunkMax) public {
        vm.assume(raw.length != 0);
        bytes calldata part = raw.length > 320 ? raw[:320] : raw;
        chunkMax = bound(chunkMax, 1, 64);
        bytes[] memory c = _chunks(part, chunkMax);
        h.init(ChunkPart.Table, h.rootOf(part, chunkMax), part.length, chunkMax);
        bytes memory back;
        for (uint256 i; i < c.length; ++i) {
            (, bool done, address chunk) = h.load(ChunkPart.Table, c[i], _hashAt(c, i + 1));
            assertEq(done, i + 1 == c.length);
            back = bytes.concat(back, _slice(chunk.code, 1, chunk.code.length));
        }
        assertEq(back, part);
        assertTrue(h.complete());
    }

    // ============================================================================================ helpers

    /// The table these tests load: 80 bytes, so 32 + 32 + 16 at `MAX`.
    function _table() internal pure returns (bytes memory) {
        return _bytes(80, 7);
    }

    /// The table's chunks, with its root and length given to the loader as the factory would.
    function _initTable() internal returns (bytes[] memory c) {
        c = _chunks(_table(), MAX);
        h.init(ChunkPart.Table, _hashAt(c, 0), 80, MAX);
    }

    function _assertState(ChunkPart part, bytes32 nextHash, uint256 loaded, uint256 total) internal view {
        (bytes32 n, uint256 l, uint256 t) = h.state(part);
        assertEq(n, nextHash, "next hash");
        assertEq(l, loaded, "loaded");
        assertEq(t, total, "total");
    }

    function _expectMismatch(uint256 index, bytes32 expected, bytes32 found) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                IBoxCoordinatorV2.ChunkHashMismatch.selector, ChunkPart.Table, index, expected, found
            )
        );
    }

    /// The rule's chunks: `max` bytes each, the last 1 to `max`.
    function _chunks(bytes memory part, uint256 max) internal pure returns (bytes[] memory c) {
        c = new bytes[]((part.length + max - 1) / max);
        for (uint256 i; i < c.length; ++i) {
            uint256 end = (i + 1) * max < part.length ? (i + 1) * max : part.length;
            c[i] = _slice(part, i * max, end);
        }
    }

    /// h_i of the rule (h_n = 0).
    function _hashAt(bytes[] memory c, uint256 i) internal pure returns (bytes32 x) {
        for (uint256 j = c.length; j > i; --j) {
            x = keccak256(abi.encodePacked(c[j - 1], x));
        }
    }

    function _slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory s) {
        s = new bytes(to - from);
        for (uint256 i; i < s.length; ++i) {
            s[i] = b[from + i];
        }
    }

    /// `n` bytes derived from `seed`, never all zero.
    function _bytes(uint256 n, uint256 seed) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = bytes1(keccak256(abi.encode(seed, i))) | bytes1(0x01);
        }
    }
}
