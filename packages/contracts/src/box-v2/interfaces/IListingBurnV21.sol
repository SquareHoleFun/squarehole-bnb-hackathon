// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ListingClass} from "./IListingRegistry.sol";

/// @notice Additive v2.1 listing capability; the existing row and add() retain their meanings.
interface IListingBurnV21 {
    /// @notice Lister only; admit a new coin with burn(uint256) checked in a reverting funded probe.
    /// Transfers, supply and approval consumption roll back; capability is immutable and cannot upgrade an old row.
    function addWithBurn(address token, ListingClass class, uint256 raise, bytes4 selector) external returns (uint32 id);
    /// @notice Anyone reads the checked selector, or zero for an unchecked/native/unlisted coin; no funds move.
    function checkedBurnSelector(address token) external view returns (bytes4);
    /// @notice Listing admission records a successful exact-supply probe; no funds remain moved.
    event CheckedBurnRecorded(uint32 indexed id, address indexed token, bytes4 selector);
}
