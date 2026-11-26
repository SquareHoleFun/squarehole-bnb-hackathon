// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title BoxIdSet
/// @notice A duplicate check over a list of IDs in O(k), in transient storage that is cleared again before it returns
/// (slot = keccak256(seed, id)). Used by `BoxVault` for the ID lists of returns.
/// @dev A verbatim copy of v2's TransientIdSet (src/v2/libraries/TransientIdSet.sol:4-43 at 46a030f6) under the box
/// core's name. Written for Square Hole (MIT, no third-party code).
library BoxIdSet {
    /// @return distinct false when `ids` names one ID twice
    function allDistinct(uint256[] memory ids, uint256 seed) internal returns (bool distinct) {
        uint256 k = ids.length;
        distinct = true;
        uint256 marked;
        for (; marked < k; ++marked) {
            bytes32 slot = _slot(seed, ids[marked]);
            uint256 seen;
            assembly ("memory-safe") {
                seen := tload(slot)
            }
            if (seen != 0) {
                distinct = false;
                break;
            }
            assembly ("memory-safe") {
                tstore(slot, 1)
            }
        }
        for (uint256 i; i < marked; ++i) {
            bytes32 slot = _slot(seed, ids[i]);
            assembly ("memory-safe") {
                tstore(slot, 0)
            }
        }
    }

    function _slot(uint256 seed, uint256 id) private pure returns (bytes32 slot) {
        assembly ("memory-safe") {
            mstore(0x00, seed)
            mstore(0x20, id)
            slot := keccak256(0x00, 0x40)
        }
    }
}
