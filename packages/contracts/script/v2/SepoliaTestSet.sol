// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title SepoliaTestSet
/// @notice The TEST commitment of the Sepolia rehearsal of the whole system (docs/v2/sepolia-full.md): 4,200
/// pseudo-random leaves derived from the public label below, with no art behind them. It is clearly labelled test data
/// (the metadata table's description says so) and is never a real edition's commitment.
///
/// Why this and not the benchmark art: the rehearsal runs under neutral names by default (F30 Q2), and real art hashes
/// and trait names would spoil what those names protect; and a rehearsal must be able to reveal any number a draw or
/// the graduation word picks, so every leaf, its proof and the root must be recomputable by anyone from public data.
/// Here all of them follow from `LABEL` alone (`leafOf`, `proof`, `root`). The off-chain builder recomputes them
/// independently (`packages/artwork/src/sepolia-test-set.test.ts`, with `misfits-commitment.ts`) and writes
/// `test/vectors/sepolia-test-set.json`; `test/v2/names/SepoliaTestSet.t.sol` compares this library with that file and
/// reveals test items against a collection.
///
/// Leaf format and tree are `MisfitsCollection`'s: leaf = keccak256(abi.encode(uint256 id, uint128 traitsPacked,
/// bytes32 imageSha256, bytes32 avatarSha256, bytes32 modelSha256, bytes32 salt)); a plain binary tree of depth 13
/// over positions id − 1, padded to 8,192 with bytes32(0), node = keccak256(left ‖ right). Per id: seed =
/// keccak256(abi.encode(LABEL, id)); word k = keccak256(abi.encode(seed, k)); traits from word 0 (four trait types,
/// byte i of the word mod 8, plus 1: every value 1 … 8 is in the table); image, avatar, model, salt = words 1 … 4.
/// The "hashes" are not the digests of any file: IPFS links in a revealed test item's metadata resolve to nothing.
///
/// Script-side only (library internals are compiled into the scripts, which are never deployed): nothing here reaches
/// the chain except the root, the table and the generator hash passed to the genesis.
library SepoliaTestSet {
    uint256 internal constant COUNT = 4_200;
    uint256 internal constant DEPTH = 13;
    uint256 internal constant SLOTS = 8_192;
    /// @notice The public label every leaf follows from.
    bytes32 internal constant LABEL = keccak256("sepolia-full.test-set/1");
    uint256 internal constant TRAIT_TYPES = 4;
    uint256 internal constant VALUES_PER_TYPE = 8;
    /// @notice Stands in for the generator version (F29): there is no generator behind test data.
    bytes32 internal constant GENERATOR_HASH = keccak256("sepolia-full.test-set/1: no generator (test data)");
    string internal constant DESCRIPTION =
        "TEST SET ONLY (not launch data): pseudo-random traits and hashes, no art behind them.";

    /// @notice One leaf's preimage, as `MisfitsPlaceholders.Reveal` and `MisfitsCollection.reveal` take it.
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

    /// @notice The leaf of `id` (1 … 4,200), computed without allocating memory.
    function leafOf(uint256 id) internal pure returns (bytes32 h) {
        bytes32 seed = _pair(LABEL, bytes32(id));
        uint128 traits = _traits(uint256(_pair(seed, bytes32(0))));
        bytes32 image = _pair(seed, bytes32(uint256(1)));
        bytes32 avatar = _pair(seed, bytes32(uint256(2)));
        bytes32 model = _pair(seed, bytes32(uint256(3)));
        bytes32 salt = _pair(seed, bytes32(uint256(4)));
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, id)
            mstore(add(p, 0x20), traits)
            mstore(add(p, 0x40), image)
            mstore(add(p, 0x60), avatar)
            mstore(add(p, 0x80), model)
            mstore(add(p, 0xa0), salt)
            h := keccak256(p, 0xc0)
        }
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

    /// @notice Metadata table v1 (`MisfitsCollection`): the description, then four types "Trait A" … "Trait D" with
    /// the values "Value 1" … "Value 8" each. Printable ASCII without '"' or '\'.
    function metadataTable() internal pure returns (bytes memory t) {
        bytes memory d = bytes(DESCRIPTION);
        // casting to 'uint16' is safe because the description is a short constant
        // forge-lint: disable-next-line(unsafe-typecast)
        t = bytes.concat(hex"01", bytes2(uint16(d.length)), d, bytes1(uint8(TRAIT_TYPES)));
        for (uint256 i; i < TRAIT_TYPES; ++i) {
            // casting to 'bytes1' is safe because i < 4
            // forge-lint: disable-next-line(unsafe-typecast)
            t = bytes.concat(t, hex"07", "Trait ", bytes1(uint8(0x41 + i)), bytes1(uint8(VALUES_PER_TYPE)));
            for (uint256 v = 1; v <= VALUES_PER_TYPE; ++v) {
                // casting to 'bytes1' is safe because v ≤ 8
                // forge-lint: disable-next-line(unsafe-typecast)
                t = bytes.concat(t, hex"07", "Value ", bytes1(uint8(0x30 + v)));
            }
        }
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

    /// @dev Four trait bytes, each 1 … 8.
    function _traits(uint256 r) private pure returns (uint128 t) {
        for (uint256 i; i < TRAIT_TYPES; ++i) {
            // casting to 'uint128' is safe because each value is at most 8
            // forge-lint: disable-next-line(unsafe-typecast)
            t |= uint128(1 + ((r >> (8 * i)) & 0xff) % VALUES_PER_TYPE) << uint128(8 * i);
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
