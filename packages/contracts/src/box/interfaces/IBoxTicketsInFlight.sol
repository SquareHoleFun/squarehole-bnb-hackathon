// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IBoxTicketsInFlight (R1 of the Codex architecture review of 2026-10-07)
/// @notice The tickets add-on names the draw ticket it is handing to the vault, so the per-item stream (BoxItemStream)
/// books each draw from its own request: at an opening's delivery and at a cancel's release. Apart from IBoxTickets,
/// so core v2's `IBoxTicketsV2 is IBoxTickets` keeps its shape.
interface IBoxTicketsInFlight {
    /// @notice The draw ticket whose item `openDraw` is delivering, or which `cancelDraw` is releasing: set while
    /// `openDraw`'s `_deliver` (the vault's delivery, then the item's reveal) or `cancelDraw`'s `_release` runs, and 0 at
    /// every other time (transient).
    function ticketInFlight() external view returns (uint256);
}
