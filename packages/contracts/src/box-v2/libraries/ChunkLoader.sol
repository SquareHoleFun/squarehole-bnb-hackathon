// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Core v2 M1: a wave-1 library frozen as a stub before wave 1 (wave 0's integrated review, finding M3; file map § 2, §
// 1 rule 8). Its owner, M1-32-b, writes the bodies and may add entries; the entries below are called by the coordinator
// (M1-30-a) and the factory's planner (M1-32-a) in wave 1, so a change to one goes through the integrator. Signatures
// [P]: the integrator's, from the frozen interfaces they serve. Bodies, storage, `MAX_CHUNK_BYTES` and the three errors
// after `NotBuilt`: M1-32-b (docs/evidence/SH-V2-M1-32B.md).

import {ChunkPart, IBoxCoordinatorV2} from "../interfaces/IBoxCoordinatorV2.sol";

/// @title ChunkLoader (the coordinator's chunk loader)
/// @notice The table and the texts loaded after creation against the hashes the factory kept (ADR-0017 § 6, F96 R20C).
/// The hash rule is `IBoxCoordinatorV2`'s: a part's bytes cut in chunks of exactly `chunkMax` bytes, the last one 1 to
/// `chunkMax`; h_n = 0 and h_i = keccak256(abi.encodePacked(chunk_i, h_{i+1})). `load` accepts the next chunk only
/// with the hash after it, so each chunk is checked on arrival, anyone may send the right one and no order but the
/// spec's loads. Each chunk is kept as data code, 0x00 ‖ bytes (v1's `BoxData` layout), created by the calling
/// contract (the coordinator) with CREATE.
/// @dev State at its own ERC-7201 slot (file map § 1 rule 3), so the shell's storage base is never touched. Per part:
/// the root, the next hash (written from the first load on; before it the root is the next hash, which saves a slot at
/// creation) and each chunk's pointer; both parts' counters share one word, so `complete()` reads one slot. The
/// coordinator emits `ChunkLoaded` from `load`'s return and the data's length.
library ChunkLoader {
    /// @notice The stub's error, kept so the wave-0 stub pin (`test/box-v2/shape/LibraryStubs.t.sol:431`) still
    /// compiles until the integrator drops it; no entry reverts with it.
    error NotBuilt();
    /// @notice `init` refused: `None`, a root without a length or a length without a root, a chunk size of 0, a length
    /// of 2^32 bytes or more, a chunk size above `MAX_CHUNK_BYTES` for a part longer than that (its first chunk could
    /// never load), or a part already initialised.
    error ChunkInitRefused(ChunkPart part, bytes32 root, uint256 length, uint256 chunkMax);
    /// @notice `rootOf` with a chunk size of 0 for a part that has bytes.
    error ChunkSizeZero();
    /// @notice The chunk's data contract was not created: more than `MAX_CHUNK_BYTES`, or CREATE ran out of gas.
    error ChunkWriteFailed(ChunkPart part, uint256 index, uint256 length);

    /// @notice The most one chunk may hold: EIP-170's 24,576 bytes of code less the STOP prefix, as v1's
    /// `BoxData.MAX_DATA_BYTES`. The release's `CHUNK_MAX` must not pass it.
    uint256 internal constant MAX_CHUNK_BYTES = 24_575;

    /// @custom:storage-location erc7201:squarehole.v2.BoxCoordinatorV2.ChunkLoader
    struct Layout {
        /// Both parts' counters, one 128-bit lane each (Table bits 0-127, Texts 128-255): length in bytes (bits 0-31),
        /// chunks in all (32-63), chunks loaded (64-95), and a pending bit (96) while the part is initialised and not
        /// complete.
        uint256 lanes;
        /// h_0 as the factory computed it (bytes32(0): no such part).
        mapping(ChunkPart => bytes32) root;
        /// The hash the next chunk must meet, from the first load on (0 once complete).
        mapping(ChunkPart => bytes32) next;
        /// Each loaded chunk's data contract, by index from 0.
        mapping(ChunkPart => mapping(uint256 => address)) pointer;
    }

    /// @notice keccak256(abi.encode(uint256(keccak256("squarehole.v2.BoxCoordinatorV2.ChunkLoader")) - 1)) &
    /// ~bytes32(uint256(0xff)) (file map § 1 rule 3; pinned by M1-32-b's tests).
    bytes32 internal constant SLOT = 0x0b1f2616fca734469d4c5384fd6e1688797799d9b2478a7b283f08676da7c000;

    uint256 private constant _M32 = 0xffffffff;
    uint256 private constant _O_TOTAL = 32;
    uint256 private constant _O_LOADED = 64;
    uint256 private constant _B_PENDING = 1 << 96;
    uint256 private constant _LANE = (1 << 128) - 1;
    /// Both lanes' pending bits.
    uint256 private constant _PENDING = _B_PENDING | (_B_PENDING << 128);
    /// The data contract's creation code before its runtime, as `BoxData.creationCode`: PUSH2 (n + 1), DUP1, PUSH1 12,
    /// PUSH1 0, CODECOPY, PUSH1 0, RETURN, then the runtime's STOP (byte 12); `_HEAD_LEN_SHIFT` places n + 1.
    uint256 private constant _HEAD = (0x61 << 248) | (0x80600c6000396000f3 << 160);
    uint256 private constant _HEAD_LEN_SHIFT = 232;
    uint256 private constant _HEAD_BYTES = 13;

    /// @notice h_0 of `part` cut in chunks of `chunkMax` bytes (`IBoxCoordinatorV2`'s hash rule); bytes32(0) for none.
    function rootOf(bytes memory part, uint256 chunkMax) internal pure returns (bytes32 root) {
        uint256 n = part.length;
        if (n == 0) return bytes32(0);
        if (chunkMax == 0) revert ChunkSizeZero();
        unchecked {
            // From the last chunk back: its start is below n, so i * chunkMax never overflows.
            uint256 i = (n - 1) / chunkMax + 1;
            uint256 end = n;
            while (i != 0) {
                --i;
                uint256 start = i * chunkMax;
                root = _hashChunk(part, start, end - start, root);
                end = start;
            }
        }
    }

    /// @notice Once, at creation: the part's h_0 and length as the factory computed them. A part with no bytes (root
    /// and length both 0) is not kept, so it is complete at once.
    /// @dev Call it only inside the coordinator's one-time initialize. A part with no bytes writes nothing, so the
    /// once-only refusal holds only for parts with bytes; a later call could add a pending part to an open box.
    function init(ChunkPart part, bytes32 root, uint256 length, uint256 chunkMax) internal {
        if (root == bytes32(0) && length == 0) return;
        if (
            part == ChunkPart.None || root == bytes32(0) || length == 0 || length > _M32 || chunkMax == 0
                || (chunkMax > MAX_CHUNK_BYTES && length > MAX_CHUNK_BYTES)
        ) revert ChunkInitRefused(part, root, length, chunkMax);
        Layout storage s = _layout();
        uint256 shift = _shift(part);
        uint256 lanes = s.lanes;
        if ((lanes >> shift) & _LANE != 0) revert ChunkInitRefused(part, root, length, chunkMax);
        uint256 total;
        unchecked {
            total = (length - 1) / chunkMax + 1;
        }
        s.root[part] = root;
        s.lanes = lanes | ((length | (total << _O_TOTAL) | _B_PENDING) << shift);
    }

    /// @notice Loads the next chunk of `part` against the stored next hash (`ChunkHashMismatch`, `PartComplete`,
    /// `UnknownPart`), keeping it as data code; the pointer is the chunk's data contract.
    function load(ChunkPart part, bytes calldata data, bytes32 nextHash)
        internal
        returns (uint256 index, bool partDone, address chunk)
    {
        if (part == ChunkPart.None) revert IBoxCoordinatorV2.UnknownPart(part);
        Layout storage s = _layout();
        bytes memory creation;
        (index, creation) = _checked(s, part, data, nextHash);
        assembly ("memory-safe") {
            chunk := create(0, add(creation, 0x20), mload(creation))
        }
        if (chunk == address(0)) revert ChunkWriteFailed(part, index, data.length);
        s.pointer[part][index] = chunk;
        partDone = _advance(s, part, nextHash);
    }

    /// @notice `IBoxCoordinatorV2.chunkState`.
    function state(ChunkPart part) internal view returns (bytes32 nextHash, uint256 loaded, uint256 total) {
        if (part == ChunkPart.None) return (bytes32(0), 0, 0);
        Layout storage s = _layout();
        uint256 lane = s.lanes >> _shift(part);
        loaded = (lane >> _O_LOADED) & _M32;
        total = (lane >> _O_TOTAL) & _M32;
        nextHash = loaded == 0 ? s.root[part] : s.next[part];
    }

    /// @notice `IBoxCoordinatorV2.chunkRoot`.
    function rootFor(ChunkPart part) internal view returns (bytes32 root, uint256 length) {
        if (part == ChunkPart.None) return (bytes32(0), 0);
        Layout storage s = _layout();
        return (s.root[part], (s.lanes >> _shift(part)) & _M32);
    }

    /// @notice `IBoxCoordinatorV2.chunkPointer`.
    function pointer(ChunkPart part, uint256 index) internal view returns (address) {
        return _layout().pointer[part][index];
    }

    /// @notice Every part complete (the gate's chunk half).
    function complete() internal view returns (bool) {
        return _layout().lanes & _PENDING == 0;
    }

    // ------------------------------------------------------------------ private

    function _layout() private pure returns (Layout storage s) {
        bytes32 slot = SLOT;
        assembly ("memory-safe") {
            s.slot := slot
        }
    }

    /// @dev The part's lane: Table 0, Texts 128 (`ChunkPart` has these two parts beside `None`).
    function _shift(ChunkPart part) private pure returns (uint256) {
        return (uint256(uint8(part)) - 1) * 128;
    }

    /// @dev The part's next chunk index and the chunk's creation code, once its hash meets the stored next hash. A part
    /// the box does not have is never pending, so it answers as complete (`PartComplete`'s NatSpec).
    function _checked(Layout storage s, ChunkPart part, bytes calldata data, bytes32 nextHash)
        private
        view
        returns (uint256 index, bytes memory creation)
    {
        uint256 lane = s.lanes >> _shift(part);
        if (lane & _B_PENDING == 0) revert IBoxCoordinatorV2.PartComplete(part);
        index = (lane >> _O_LOADED) & _M32;
        bytes32 expected = index == 0 ? s.root[part] : s.next[part];
        bytes32 found;
        (creation, found) = _creation(data, nextHash);
        if (found != expected) revert IBoxCoordinatorV2.ChunkHashMismatch(part, index, expected, found);
        if (data.length > MAX_CHUNK_BYTES) revert ChunkWriteFailed(part, index, data.length);
    }

    /// @dev After a chunk is kept: the next hash stored (or cleared at the last), the count up by one, the pending bit
    /// cleared when the part is done.
    function _advance(Layout storage s, ChunkPart part, bytes32 nextHash) private returns (bool partDone) {
        uint256 shift = _shift(part);
        uint256 lanes = s.lanes;
        partDone = nextHash == bytes32(0);
        if (partDone) {
            // The root stands in for the next hash before the first load, so a one-chunk part never wrote one.
            if ((lanes >> (shift + _O_LOADED)) & _M32 != 0) s.next[part] = bytes32(0);
            lanes &= ~(_B_PENDING << shift);
        } else {
            s.next[part] = nextHash;
        }
        // loaded <= the chain's chunk count (below 2^32), so the count never reaches the pending bit.
        s.lanes = lanes + (1 << (shift + _O_LOADED));
    }

    /// @dev keccak256(chunk ‖ next) of the chunk at `offset` with `len` bytes, hashed from a copy past the free memory
    /// pointer (scratch, not kept), so `part` is never written.
    function _hashChunk(bytes memory part, uint256 offset, uint256 len, bytes32 next) private pure returns (bytes32 h) {
        assembly ("memory-safe") {
            let buf := mload(0x40)
            mcopy(buf, add(add(part, 0x20), offset), len)
            mstore(add(buf, len), next)
            h := keccak256(buf, add(len, 0x20))
        }
    }

    /// @dev One copy of the chunk from calldata: the data contract's creation code (the 13-byte head, then the chunk)
    /// with `nextHash` after it, so the hash the rule asks for, keccak256(chunk ‖ nextHash), is read from the same
    /// bytes. `creation` is a bytes array of the head and the chunk; the next hash sits past its end.
    function _creation(bytes calldata data, bytes32 nextHash)
        private
        pure
        returns (bytes memory creation, bytes32 found)
    {
        uint256 n = data.length;
        // n + 1 fits PUSH2's two bytes only up to 65,534; `load` refuses more than `MAX_CHUNK_BYTES` before CREATE.
        uint256 head = _HEAD | (((n + 1) & 0xffff) << _HEAD_LEN_SHIFT);
        assembly ("memory-safe") {
            creation := mload(0x40)
            mstore(creation, add(_HEAD_BYTES, n))
            let code := add(creation, 0x20)
            mstore(code, head)
            let chunk := add(code, _HEAD_BYTES)
            calldatacopy(chunk, data.offset, n)
            mstore(add(chunk, n), nextHash)
            found := keccak256(chunk, add(n, 0x20))
            mstore(0x40, and(add(add(chunk, n), 0x3f), not(0x1f)))
        }
    }
}
