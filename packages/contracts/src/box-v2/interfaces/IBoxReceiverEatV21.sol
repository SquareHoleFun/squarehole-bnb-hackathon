// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Additive price-coin choice; custody remains in the receiver's P claims until success.
interface IBoxReceiverEatV21 {
    /// @notice Anyone after graduation, never after failure; eat at most int128.max pending P, without a tip.
    /// Checked coins burn with exact supply/debit checks; others go to the fixed dead address, native ETH included.
    /// A refused capped call restores pending claims for retry; insufficient admission gas reverts the whole call.
    function eatPriceCoin() external returns (uint256 amount);
    /// @notice Anyone reads P waiting for eating after graduation, or the failure pot before it; no funds move.
    function eatPendingP() external view returns (uint256);
    /// @notice Anyone reads cumulative raw P successfully burned or locked by this box; no funds move.
    function eatenP() external view returns (uint256);
    /// @notice Anyone reads the creation-time checked burn selector; zero means lock at the dead address. No funds move.
    function priceBurnSelector() external view returns (bytes4);
    /// @notice Successful eating only: exact P amount, cumulative box total and burn versus lock mode.
    event PriceCoinEaten(address indexed asset, uint256 amount, uint256 total, bool burned);
}
