// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title SepoliaBox0TestSet
/// @notice The TEST commitment of box 0's Sepolia rehearsal on core v1 (docs/runbooks/sepolia-core-v1.md): 4,269
/// pseudo-random leaves derived from the public label below, with no art behind them, over the neutral twin of the
/// Misfits' round-7 trait table (16 types with the round-7 value counts; the table bytes are in
/// test/vectors/box/sepolia-box0-test-set.json). Never a real edition's commitment.
///
/// Why: the rehearsal runs under neutral names (F30 Q2, as docs/v2/sepolia-full.md did), and every number a draw or the
/// graduation word picks must be revealable by anyone from public data. Every leaf, its proof and the root follow from
/// `LABEL` alone (`entry`, `leafOf`, `proof`, `root`). The off-chain builder recomputes them independently
/// (packages/artwork/src/sepolia-box0-test-set.test.ts, with box-commitment.ts) and writes the vector file;
/// test/box/sepolia/SepoliaBox0TestSet.t.sol compares the two and reveals test items on a real BoxCollection.
///
/// Leaf and tree are BoxCollection's: leaf = keccak256(abi.encode(uint256 id, uint128 traitsPacked, bytes32 imageSha256,
/// bytes32 avatarSha256, bytes32 modelSha256, bytes32 salt)); a plain binary tree of depth 13 over positions id − 1,
/// padded to 8,192 with bytes32(0), node = keccak256(left ‖ right). Per id: seed = keccak256(abi.encode(LABEL, id));
/// word k = keccak256(abi.encode(seed, k)); trait byte i (16 types) = 1 + (byte i of word 0) mod type i's value count;
/// image, avatar, model, salt = words 1 … 4. The "hashes" are not the digests of any file.
///
/// Script and test side only: nothing here reaches the chain but the root, the table and the generator hash in the spec.
library SepoliaBox0TestSet {
    uint256 internal constant COUNT = 4_269;
    uint256 internal constant DEPTH = 13;
    uint256 internal constant SLOTS = 8_192;
    /// @notice The public label every leaf follows from.
    bytes32 internal constant LABEL = keccak256("sepolia-core-v1.box0-test-set/1");
    uint256 internal constant TRAIT_TYPES = 16;
    /// @notice Each type's value count, type 0 in the first byte: the round-7 table's (Character 86, Family 6, Body 38,
    /// Material 10, Color 16, Finish 33, Frame 7, Painting 10, Outfit 8, Eyes 13, Mouth 10, Headwear 16, Accessory 8,
    /// Role 8, Environment 8, Box 8), under neutral names.
    bytes16 internal constant VALUE_COUNTS = 0x5606260a1021070a080d0a1008080808;
    /// @notice Stands in for the generator version (F29): there is no generator behind test data.
    bytes32 internal constant GENERATOR_HASH = keccak256("sepolia-core-v1.box0-test-set/1: no generator (test data)");

    /// @notice One leaf's preimage, as `BoxCollection.reveal` takes it.
    struct Entry {
        uint256 id;
        uint128 traitsPacked;
        bytes32 imageHash;
        bytes32 avatarHash;
        bytes32 modelHash;
        bytes32 salt;
    }

    error IdOutOfRange(uint256 id);

    function entry(uint256 id) internal pure returns (Entry memory e) {
        if (id == 0 || id > COUNT) revert IdOutOfRange(id);
        bytes32 seed = _pair(LABEL, bytes32(id));
        e.id = id;
        e.traitsPacked = _traits(uint256(_pair(seed, bytes32(0))));
        e.imageHash = _pair(seed, bytes32(uint256(1)));
        e.avatarHash = _pair(seed, bytes32(uint256(2)));
        e.modelHash = _pair(seed, bytes32(uint256(3)));
        e.salt = _pair(seed, bytes32(uint256(4)));
    }

    /// @notice The leaf of `id` (1 … 4,269).
    function leafOf(uint256 id) internal pure returns (bytes32 h) {
        Entry memory e = entry(id);
        h = keccak256(abi.encode(e.id, e.traitsPacked, e.imageHash, e.avatarHash, e.modelHash, e.salt));
    }

    function root() internal pure returns (bytes32) {
        bytes32[] memory n = _leaves();
        for (uint256 width = SLOTS; width > 1; width >>= 1) {
            _reduce(n, width);
        }
        return n[0];
    }

    /// @notice The 13 siblings of `id` from the leaf upwards (index-directed, as the collection verifies them).
    function proof(uint256 id) internal pure returns (bytes32[] memory p) {
        if (id == 0 || id > COUNT) revert IdOutOfRange(id);
        p = new bytes32[](DEPTH);
        bytes32[] memory n = _leaves();
        uint256 index = id - 1;
        uint256 level;
        for (uint256 width = SLOTS; width > 1; width >>= 1) {
            p[level++] = n[index ^ 1];
            _reduce(n, width);
            index >>= 1;
        }
    }

    /// @notice Type `i`'s value count (i < 16).
    function valueCount(uint256 i) internal pure returns (uint256) {
        return uint8(VALUE_COUNTS[i]);
    }

    function _leaves() private pure returns (bytes32[] memory n) {
        n = new bytes32[](SLOTS);
        for (uint256 id = 1; id <= COUNT; ++id) {
            n[id - 1] = leafOf(id);
        }
    }

    /// @dev One level up, in place: node i = keccak256(n[2i] ‖ n[2i + 1]) for i < width / 2.
    function _reduce(bytes32[] memory n, uint256 width) private pure {
        for (uint256 i; i < width >> 1; ++i) {
            n[i] = _pair(n[2 * i], n[2 * i + 1]);
        }
    }

    /// @dev Sixteen trait bytes, byte i in 1 … type i's value count.
    function _traits(uint256 r) private pure returns (uint128 t) {
        for (uint256 i; i < TRAIT_TYPES; ++i) {
            // casting to 'uint128' is safe because each value is at most 86
            // forge-lint: disable-next-line(unsafe-typecast)
            t |= uint128(1 + ((r >> (8 * i)) & 0xff) % valueCount(i)) << uint128(8 * i);
        }
    }

    /// @dev keccak256(a ‖ b) in the scratch space.
    function _pair(bytes32 a, bytes32 b) private pure returns (bytes32 h) {
        assembly ("memory-safe") {
            mstore(0x00, a)
            mstore(0x20, b)
            h := keccak256(0x00, 0x40)
        }
    }
}
