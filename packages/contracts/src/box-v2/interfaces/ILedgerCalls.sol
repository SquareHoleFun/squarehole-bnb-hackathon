// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice M3 vault notices, fail-safe and capped; fee ledgers receive claims without calls.
interface IItemLedgerCalls {
    /// @notice Vault only; report item custody changes, no funds move through this notice.
    function onTicketsOpened(uint256 count, uint256 insideBefore) external;
    /// @notice Vault only; report item custody changes, no funds move through this notice.
    function onTicketsReleased(address to, uint256 count, uint256 insideBefore, uint256 ticketId) external;
    /// @notice Vault only; report item custody changes, no funds move through this notice.
    function onWithdrawn(address owner, uint256[] calldata ids) external;
    /// @notice Vault only; report item custody changes, no funds move through this notice.
    function onReturned(address owner, uint256[] calldata ids) external;
    /// @notice Vault only; report item custody changes, no funds move through this notice.
    function onDelivered(uint256 id, address to, uint64 requestedAt) external;
}
