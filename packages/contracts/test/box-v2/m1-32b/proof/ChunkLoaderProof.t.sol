// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ChunkPart, IBoxCoordinatorV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {M1_32bChunkHarness} from "../M1_32bDoubles.sol";

/// BC-220: independent, byte-by-byte spec slicing and reverse hash chain; production rootOf never seeds the oracle.
contract ChunkHistory is Test {
    M1_32bChunkHarness public loader;
    mapping(uint256 => bytes[]) internal chunks;
    mapping(uint256 => bytes32[]) internal hashes;
    uint256[2] internal lengths;
    uint256[2] internal loaded;

    constructor(bytes32 seed, uint256 tableLength, uint256 textLength, uint256 width) {
        loader = new M1_32bChunkHarness();
        lengths = [tableLength, textLength];
        for (uint256 p; p < 2; ++p) {
            bytes memory spec = new bytes(lengths[p]);
            for (uint256 i; i < spec.length; ++i) {
                spec[i] = bytes1(keccak256(abi.encode(seed, p, i)));
            }
            uint256 n = (spec.length + width - 1) / width;
            for (uint256 i; i < n; ++i) {
                uint256 end = (i + 1) * width;
                if (end > spec.length) end = spec.length;
                bytes memory c = new bytes(end - i * width);
                for (uint256 j; j < c.length; ++j) {
                    c[j] = spec[i * width + j];
                }
                chunks[p].push(c);
                hashes[p].push(0);
            }
            hashes[p].push(0);
            for (uint256 i = n; i > 0; --i) {
                hashes[p][i - 1] = keccak256(abi.encodePacked(chunks[p][i - 1], hashes[p][i]));
            }
            assertEq(loader.rootOf(spec, width), hashes[p][0], "root matches independently cut spec");
            loader.init(_part(p), hashes[p][0], spec.length, width);
        }
    }

    function _part(uint256 p) internal pure returns (ChunkPart) {
        return p == 0 ? ChunkPart.Table : ChunkPart.Texts;
    }

    /// Good chunks mixed with reorder/replay, altered bytes/tails, appended bytes and chunks from the other part.
    function attempt(uint8 partSeed, uint256 seed, uint8 mode) public {
        uint256 p = partSeed % 2;
        uint256 n = chunks[p].length;
        uint256 current = loaded[p];
        uint256 candidate = current < n ? current : 0;
        mode %= 7;
        if (mode == 1 && n > 1) candidate = (candidate + 1 + seed % (n - 1)) % n;
        bytes memory data = n == 0 ? bytes("extra") : chunks[p][candidate];
        bytes32 tail = n == 0 ? bytes32(0) : hashes[p][candidate + 1];
        if (mode == 2 && data.length != 0) data[seed % data.length] ^= bytes1(uint8(1 << (seed % 8)));
        if (mode == 3) tail ^= bytes32(uint256(1) << (seed % 256));
        if (mode == 4) data = bytes.concat(data, hex"ff");
        if (mode == 5 && chunks[1 - p].length != 0) {
            data = chunks[1 - p][0];
            tail = hashes[1 - p][1];
        }
        if (mode == 6) data = "";
        _try(p, data, tail, address(uint160(0x20000 + seed % 256)));
        check();
    }

    function _try(uint256 p, bytes memory data, bytes32 tail, address sender) internal {
        uint256 i = loaded[p];
        uint256 n = chunks[p].length;
        bytes32 found = keccak256(abi.encodePacked(data, tail));
        if (i == n) {
            vm.expectRevert(abi.encodeWithSelector(IBoxCoordinatorV2.PartComplete.selector, _part(p)));
        } else if (found != hashes[p][i]) {
            vm.expectRevert(
                abi.encodeWithSelector(IBoxCoordinatorV2.ChunkHashMismatch.selector, _part(p), i, hashes[p][i], found)
            );
        } else {
            vm.prank(sender);
            (uint256 index, bool done, address pointer) = loader.load(_part(p), data, tail);
            assertEq(index, i);
            assertEq(done, i + 1 == n);
            assertEq(pointer, loader.pointer(_part(p), i));
            assertEq(pointer.code, abi.encodePacked(hex"00", chunks[p][i]), "exact committed bytes");
            loaded[p]++;
            return;
        }
        vm.prank(sender);
        loader.load(_part(p), data, tail);
        assertEq(loader.pointer(_part(p), i), address(0), "rejection creates no pointer");
    }

    function check() public view {
        bool done = true;
        for (uint256 p; p < 2; ++p) {
            (bytes32 next, uint256 count, uint256 total) = loader.state(_part(p));
            assertEq(count, loaded[p], "only accepted chunks advance");
            assertEq(total, chunks[p].length);
            assertEq(next, hashes[p][loaded[p]]);
            (bytes32 root, uint256 length) = loader.rootFor(_part(p));
            assertEq(root, hashes[p][0], "root stays fixed");
            assertEq(length, lengths[p]);
            if (count != total) done = false;
            for (uint256 i; i < count; ++i) {
                assertEq(loader.pointer(_part(p), i).code, abi.encodePacked(hex"00", chunks[p][i]));
            }
            assertEq(loader.pointer(_part(p), count), address(0));
        }
        assertEq(loader.complete(), done, "both parts must complete");
        assertEq(loader.shellWord(), 0x5ea1, "shell storage is untouched");
    }

    function finish() public {
        for (uint256 p; p < 2; ++p) {
            while (loaded[p] < chunks[p].length) {
                uint256 i = loaded[p];
                _try(p, chunks[p][i], hashes[p][i + 1], address(this));
            }
            _try(p, "extra", 0, address(this));
        }
        check();
        assertTrue(loader.complete(), "all and only spec chunks eventually load");
    }
}

contract ChunkLoaderProofTest is Test {
    ChunkHistory internal h;

    function setUp() public {
        h = new ChunkHistory(keccak256("two interleaved parts"), 97, 129, 32);
        bytes4[] memory actions = new bytes4[](1);
        actions[0] = h.attempt.selector;
        targetSelector(FuzzSelector(address(h), actions));
        targetContract(address(h));
    }

    function invariant_BC220_onlyCommittedOrderedBytes() public view {
        h.check();
    }

    function afterInvariant() public {
        h.finish();
    }

    function testFuzz_BC220_arbitrarySpecAndArrivalOrder(
        bytes32 seed,
        uint16 tableLength,
        uint16 textLength,
        uint16 width,
        uint256 order
    ) public {
        uint256 w = bound(width, 1, 512);
        ChunkHistory candidate = new ChunkHistory(seed, bound(tableLength, 0, w * 8), bound(textLength, 0, w * 8), w);
        for (uint256 i; i < 24; ++i) {
            candidate.attempt(uint8(order >> i), uint256(keccak256(abi.encode(seed, i))), uint8(order >> (i * 7)));
        }
        candidate.finish();
    }

    function test_BC220_emptyAndWordBoundaries() public {
        uint256[7] memory sizes = [uint256(0), 1, 31, 32, 33, 63, 64];
        for (uint256 i; i < sizes.length; ++i) {
            ChunkHistory candidate = new ChunkHistory(bytes32(i), sizes[i], sizes[6 - i], 32);
            candidate.finish();
        }
    }
}
