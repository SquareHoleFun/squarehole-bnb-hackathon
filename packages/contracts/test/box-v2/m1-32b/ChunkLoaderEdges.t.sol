// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxData} from "../../../src/box/libraries/BoxData.sol";
import {ChunkPart, IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {ChunkLoader} from "../../../src/box-v2/libraries/ChunkLoader.sol";
import {M1_32bChunkHarness} from "./M1_32bDoubles.sol";

/// @title M1_32bChunkWords
/// @notice TEST ONLY. The harness with the loader's storage slot and v1's data writer beside it.
contract M1_32bChunkWords is M1_32bChunkHarness {
    function slot() external pure returns (bytes32) {
        return ChunkLoader.SLOT;
    }

    function writeV1(bytes calldata data) external returns (address) {
        return BoxData.write(data);
    }
}

/// @title ChunkLoaderEdgesTest
/// @notice TEST ONLY (M1-32-b, beside the red tests). The loader's paths the red list leaves out: the ERC-7201 slot
/// (file map § 1 rule 3), `init`'s refusals and its no-part no-op, `rootOf` with no chunk size, the views for `None`
/// and for a chunk not yet loaded, two parts loading in any interleaving, the EIP-170 bound of one chunk, and the
/// chunk's code as v1's `BoxData` writes it.
contract ChunkLoaderEdgesTest is Test {
    uint256 internal constant MAX = 32;
    M1_32bChunkWords internal h;

    function setUp() public {
        h = new M1_32bChunkWords();
    }

    /// File map § 1 rule 3: the slot is the namespaced formula, and the loader's word lives there.
    function test_theSlotIsTheNamespacedFormula() public {
        bytes32 want = keccak256(abi.encode(uint256(keccak256("squarehole.v2.BoxCoordinatorV2.ChunkLoader")) - 1))
            & ~bytes32(uint256(0xff));
        assertEq(h.slot(), want);
        assertEq(vm.load(address(h), want), bytes32(0));
        h.init(ChunkPart.Texts, keccak256("root"), 100, MAX);
        assertTrue(vm.load(address(h), want) != bytes32(0), "the counters' word");
    }

    /// `init` refuses what the factory never sends: `None`, a root without a length or a length without a root, no
    /// chunk size, 2^32 bytes, and a second init of one part; a part with no bytes is a no-op.
    function test_initRefusesWhatTheFactoryNeverSends() public {
        bytes32 r = keccak256("root");
        _expectInitRefused(ChunkPart.None, r, 10, MAX);
        _expectInitRefused(ChunkPart.Table, r, 0, MAX);
        _expectInitRefused(ChunkPart.Table, bytes32(0), 10, MAX);
        _expectInitRefused(ChunkPart.Table, r, 10, 0);
        _expectInitRefused(ChunkPart.Table, r, uint256(1) << 32, MAX);
        h.init(ChunkPart.Table, bytes32(0), 0, MAX);
        assertTrue(h.complete(), "no bytes: nothing kept");
        h.init(ChunkPart.Table, r, 10, MAX);
        _expectInitRefused(ChunkPart.Table, r, 10, MAX);
        (bytes32 root, uint256 len) = h.rootFor(ChunkPart.Table);
        assertEq(abi.encode(root, len), abi.encode(r, uint256(10)), "the first init stands");
    }

    /// `rootOf` with a chunk size of 0 refuses a part with bytes; an empty part is 0 at any size.
    function test_rootOfWithNoChunkSize() public {
        vm.expectRevert(ChunkLoader.ChunkSizeZero.selector);
        h.rootOf(hex"01", 0);
        assertEq(h.rootOf("", 0), bytes32(0));
        assertEq(h.rootOf(hex"01", type(uint256).max), keccak256(abi.encodePacked(hex"01", bytes32(0))), "one chunk");
    }

    /// The views for `None`, and for a chunk not yet loaded, answer zeros.
    function test_theViewsForNoneAndAChunkNotYetLoaded() public {
        bytes memory part = _bytes(40, 3);
        h.init(ChunkPart.Table, h.rootOf(part, MAX), part.length, MAX);
        assertEq(h.pointer(ChunkPart.Table, 0), address(0), "not loaded yet");
        (bytes32 n, uint256 l, uint256 t) = h.state(ChunkPart.None);
        assertEq(abi.encode(n, l, t), abi.encode(bytes32(0), uint256(0), uint256(0)));
        (bytes32 r, uint256 len) = h.rootFor(ChunkPart.None);
        assertEq(abi.encode(r, len), abi.encode(bytes32(0), uint256(0)));
        assertEq(h.pointer(ChunkPart.None, 0), address(0));
    }

    /// The two parts are independent: the texts load while the table waits, in any interleaving, each with its own
    /// counters; a one-chunk part completes at once.
    function test_twoPartsLoadInAnyInterleaving() public {
        bytes memory table = _bytes(70, 4);
        bytes memory texts = _bytes(20, 5);
        (bytes[] memory tc, bytes32[] memory th) = _cut(table);
        (bytes[] memory xc, bytes32[] memory xh) = _cut(texts);
        h.init(ChunkPart.Table, th[0], table.length, MAX);
        h.init(ChunkPart.Texts, xh[0], texts.length, MAX);
        h.load(ChunkPart.Table, tc[0], th[1]);
        (, bool done,) = h.load(ChunkPart.Texts, xc[0], xh[1]);
        assertTrue(done, "one chunk");
        _assertState(ChunkPart.Texts, bytes32(0), 1, 1);
        _assertState(ChunkPart.Table, th[1], 1, 3);
        assertFalse(h.complete());
        h.load(ChunkPart.Table, tc[1], th[2]);
        h.load(ChunkPart.Table, tc[2], th[3]);
        _assertState(ChunkPart.Table, bytes32(0), 3, 3);
        assertTrue(h.complete());
    }

    /// EIP-170: a chunk of `MAX_CHUNK_BYTES` loads (its code one byte more). `load` still refuses one byte more, here
    /// a chunk whose root was cut at another size than `init`'s, its state kept.
    function test_oneChunkHoldsAtMostMaxChunkBytes() public {
        uint256 max = ChunkLoader.MAX_CHUNK_BYTES;
        bytes memory big = _bytes(max, 6);
        h.init(ChunkPart.Table, h.rootOf(big, max), max, max);
        (,, address chunk) = h.load(ChunkPart.Table, big, bytes32(0));
        assertEq(chunk.code.length, max + 1, "24,576 bytes of code");
        bytes memory over = _bytes(max + 1, 7);
        bytes32 root = h.rootOf(over, max + 1); // one chunk: a root off the rule at `max`
        h.init(ChunkPart.Texts, root, max + 1, max);
        vm.expectRevert(abi.encodeWithSelector(ChunkLoader.ChunkWriteFailed.selector, ChunkPart.Texts, 0, max + 1));
        h.load(ChunkPart.Texts, over, bytes32(0));
        _assertState(ChunkPart.Texts, root, 0, 2);
    }

    /// Review round 1: `init` refuses a chunk size above `MAX_CHUNK_BYTES` for a part longer than that, since its first
    /// chunk could never load, so creation fails at once instead of making a box that cannot open. A part of at most
    /// `MAX_CHUNK_BYTES` bytes is one chunk at any size, so it is taken.
    function test_initRefusesAChunkSizeNoChunkCanLoad() public {
        uint256 max = ChunkLoader.MAX_CHUNK_BYTES;
        bytes32 r = keccak256("root");
        _expectInitRefused(ChunkPart.Table, r, max + 1, max + 1);
        _expectInitRefused(ChunkPart.Texts, r, 1 << 20, type(uint256).max);
        h.init(ChunkPart.Table, r, max + 1, max);
        h.init(ChunkPart.Texts, r, max, type(uint256).max);
        _assertState(ChunkPart.Table, r, 0, 2);
        _assertState(ChunkPart.Texts, r, 0, 1);
    }

    /// The chunk's code is what v1's `BoxData.write` makes of the same bytes, and v1's `BoxData.read` reads it back.
    function test_theChunksCodeIsV1sBoxDataLayout(bytes calldata raw) public {
        vm.assume(raw.length != 0);
        bytes calldata data = raw.length > 2_000 ? raw[:2_000] : raw;
        h.init(ChunkPart.Table, h.rootOf(data, data.length), data.length, data.length);
        (,, address chunk) = h.load(ChunkPart.Table, data, bytes32(0));
        assertEq(chunk.code, h.writeV1(data).code, "v1's layout");
        assertEq(this.readV1(chunk), data, "v1's reader");
    }

    function readV1(address pointer) external view returns (bytes memory) {
        return BoxData.read(pointer);
    }

    // ============================================================================================ helpers

    function _expectInitRefused(ChunkPart part, bytes32 root, uint256 length, uint256 chunkMax) internal {
        vm.expectRevert(abi.encodeWithSelector(ChunkLoader.ChunkInitRefused.selector, part, root, length, chunkMax));
        h.init(part, root, length, chunkMax);
    }

    function _assertState(ChunkPart part, bytes32 nextHash, uint256 loaded, uint256 total) internal view {
        (bytes32 n, uint256 l, uint256 t) = h.state(part);
        assertEq(n, nextHash, "next hash");
        assertEq(l, loaded, "loaded");
        assertEq(t, total, "total");
    }

    /// `part` cut at `MAX` with h_0 … h_n.
    function _cut(bytes memory part) internal pure returns (bytes[] memory c, bytes32[] memory hs) {
        c = new bytes[]((part.length + MAX - 1) / MAX);
        hs = new bytes32[](c.length + 1);
        for (uint256 i; i < c.length; ++i) {
            uint256 end = (i + 1) * MAX < part.length ? (i + 1) * MAX : part.length;
            c[i] = new bytes(end - i * MAX);
            for (uint256 j; j < c[i].length; ++j) {
                c[i][j] = part[i * MAX + j];
            }
        }
        for (uint256 i = c.length; i > 0; --i) {
            hs[i - 1] = keccak256(abi.encodePacked(c[i - 1], hs[i]));
        }
    }

    function _bytes(uint256 n, uint256 seed) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = bytes1(keccak256(abi.encode(seed, i))) | bytes1(0x01);
        }
    }
}
