// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {SepoliaBox0TestSet} from "../../../../script/lib/SepoliaBox0TestSet.sol";

/// @title AuditRevealSet
/// @notice TEST ONLY (SH-AUDIT-B0 R0-A). The Sepolia box 0 test commitment (`script/lib/SepoliaBox0TestSet.sol`) for
/// any edition size N (1 … 10,000): the same public label, the same per-id entry (traits within the neutral round-7
/// table's value counts, image, avatar, model and salt words), the same leaf, and BoxCollection's tree at its depth
/// ⌈log₂ N⌉ (`BoxCollection.treeDepth`) over positions id − 1, padded with bytes32(0). At N = 4,269 it is exactly the
/// Sepolia test set (root 0xf983…79ec, `AuditWorldSmoke.t.sol` checks it), so every item of the audit world's box 0
/// can be revealed with public data at any N, including the mainnet edition's 1,969 (F141). Ids start at 1 (box 0's
/// `firstId`). Each `proof` rebuilds the whole tree (2,048 leaves at N = 1,969; 8,192 at 4,269).
library AuditRevealSet {
    uint256 internal constant MAX_N = 10_000;
    /// @notice The root at N = 1,969, pinned so the world's setUp does not rebuild the tree (checked against `root`).
    bytes32 internal constant ROOT_1969 = 0xdd3a8032da868b4fefae513a00358387078772a7f260472afb7196384098f1a1;

    error SizeOutOfRange(uint256 n);
    error IdOutOfRange(uint256 id, uint256 n);

    /// @notice Leaf preimage of `id` (any id ≥ 1): SepoliaBox0TestSet.entry's derivation without its 4,269 bound.
    function entry(uint256 id) internal pure returns (SepoliaBox0TestSet.Entry memory e) {
        if (id == 0) revert IdOutOfRange(0, 0);
        bytes32 seed = _pair(SepoliaBox0TestSet.LABEL, bytes32(id));
        e.id = id;
        e.traitsPacked = _traits(uint256(_pair(seed, bytes32(0))));
        e.imageHash = _pair(seed, bytes32(uint256(1)));
        e.avatarHash = _pair(seed, bytes32(uint256(2)));
        e.modelHash = _pair(seed, bytes32(uint256(3)));
        e.salt = _pair(seed, bytes32(uint256(4)));
    }

    function leafOf(uint256 id) internal pure returns (bytes32) {
        SepoliaBox0TestSet.Entry memory e = entry(id);
        return keccak256(abi.encode(e.id, e.traitsPacked, e.imageHash, e.avatarHash, e.modelHash, e.salt));
    }

    /// @notice BoxCollection.treeDepth for `n` items.
    function depth(uint256 n) internal pure returns (uint256 d) {
        while ((uint256(1) << d) < n) ++d;
    }

    function root(uint256 n) internal pure returns (bytes32) {
        if (n == 1_969 && ROOT_1969 != bytes32(0)) return ROOT_1969;
        return computeRoot(n);
    }

    /// @notice The root built from the leaves (never the pinned constant).
    function computeRoot(uint256 n) internal pure returns (bytes32) {
        bytes32[] memory nodes = _leaves(n);
        for (uint256 width = nodes.length; width > 1; width >>= 1) {
            _reduce(nodes, width);
        }
        return nodes[0];
    }

    /// @notice The siblings of `id` from the leaf upwards (index-directed, as BoxCollection verifies them).
    function proof(uint256 n, uint256 id) internal pure returns (bytes32[] memory p) {
        if (id == 0 || id > n) revert IdOutOfRange(id, n);
        bytes32[] memory nodes = _leaves(n);
        p = new bytes32[](depth(n));
        uint256 index = id - 1;
        uint256 level;
        for (uint256 width = nodes.length; width > 1; width >>= 1) {
            p[level++] = nodes[index ^ 1];
            _reduce(nodes, width);
            index >>= 1;
        }
    }

    /// @notice What `BoxTickets.open` / `openDraw` / `takeByNumber` take to reveal item `id` of an N-item edition.
    function itemReveal(uint256 n, uint256 id) internal pure returns (ItemReveal memory r) {
        SepoliaBox0TestSet.Entry memory e = entry(id);
        r.traitsPacked = e.traitsPacked;
        r.imageHash = e.imageHash;
        r.avatarHash = e.avatarHash;
        r.modelHash = e.modelHash;
        r.salt = e.salt;
        r.proof = proof(n, id);
    }

    function _leaves(uint256 n) private pure returns (bytes32[] memory nodes) {
        if (n == 0 || n > MAX_N) revert SizeOutOfRange(n);
        nodes = new bytes32[](uint256(1) << depth(n));
        for (uint256 id = 1; id <= n; ++id) {
            nodes[id - 1] = leafOf(id);
        }
    }

    /// @dev One level up, in place: node i = keccak256(n[2i] ‖ n[2i + 1]) for i < width / 2.
    function _reduce(bytes32[] memory nodes, uint256 width) private pure {
        for (uint256 i; i < width >> 1; ++i) {
            nodes[i] = _pair(nodes[2 * i], nodes[2 * i + 1]);
        }
    }

    /// @dev Sixteen trait bytes, byte i in 1 … type i's value count (SepoliaBox0TestSet._traits).
    function _traits(uint256 r) private pure returns (uint128 t) {
        for (uint256 i; i < SepoliaBox0TestSet.TRAIT_TYPES; ++i) {
            // casting to 'uint128' is safe because each value is at most 86
            // forge-lint: disable-next-line(unsafe-typecast)
            t |= uint128(1 + ((r >> (8 * i)) & 0xff) % SepoliaBox0TestSet.valueCount(i)) << uint128(8 * i);
        }
    }

    function _pair(bytes32 a, bytes32 b) private pure returns (bytes32 h) {
        assembly ("memory-safe") {
            mstore(0x00, a)
            mstore(0x20, b)
            h := keccak256(0x00, 0x40)
        }
    }
}
