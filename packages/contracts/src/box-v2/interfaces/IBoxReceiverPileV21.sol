// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Additive same-P pile fee path. Seed custody remains in the pile, never in this ledger.
interface IBoxReceiverPileV21 {
    /// @notice Anyone after graduation, never after failure: move up to int128.max pending P into the fixed pile.
    /// @dev No tip, recipient or minimum. An optional capped unlock checks exact debit and receipt; refusal
    /// restores pending for retry. Insufficient admission gas reverts. Before graduation nothing moves;
    /// failure routes pending claims to the closing pot without calling the asset or returning fee money as seed.
    function moveToPile() external returns (uint256 amount);
    /// @notice Anyone reads raw pending P claims; no funds move.
    function pilePendingP() external view returns (uint256);
    /// @notice Anyone reads cumulative raw P successfully moved into this pile; no funds move.
    function pileMovedP() external view returns (uint256);
    /// @notice Exact P delivered to the immutable pile; total never includes seed or refused movements.
    event PileFeesMoved(address indexed pile, address indexed asset, uint256 amount, uint256 total);
}
