// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RoyaltyDestination} from "./BoxTypes.sol";

/// @title IBoxRoyaltyRouter (add-on 4 `royalties`, hook point `receiver.ethIntake`; slice S3; per-box clone)
/// @notice The ERC-2981 receiver of every box with the royalties add-on, at each destination (F65, F68 (4);
/// nft-royalties § 4 "The router"). Marketplaces pay in the sale currency: ETH for listings, WETH for accepted offers.
/// The Creator destination too (review of sh-core-v1): royaltyInfo never names the payee, so a payee that refuses ETH
/// cannot make royalty-paying sales revert.
///
/// - `receive()` accepts every ETH payment, 0 wei and a 2,300-gas stipend included, and does nothing else: it never
///   reverts and writes no storage (BC-114).
/// - `flush()`, anyone, from the box's graduation on (P: nothing leaves before graduation, BC-115): unwraps all its
///   WETH and sends all its ETH to the box's receiver, and nowhere else: `fundFees()` for FeeHandling (box 0: its
///   capped receiver, so the platform part counts in the 32 ETH cap, BC-107), `fundDepth()` for PoolDepth,
///   `fundCreator()` for Creator (credited to the one creator payee, F72 (3)). A reverting receiver leaves the ETH for
///   the next flush.
/// - `sweep(token)`: WETH as in `flush()`; any other ERC-20 stays (TokenNotTaken) until a version routes it (S12).
/// - No owner, admin, setter, pause, upgrade or rescue (F23 C2). Never pays the Safe directly: box 0's
///   marketplace-side royalty settings may name only this router (nft-royalties § 4, rule).
/// @dev Invariants: ETH and WETH leave only to `receiver()`; the router holds nothing of another box.
interface IBoxRoyaltyRouter {
    event Flushed(address indexed receiver, uint256 ethSent, uint256 wethUnwrapped);

    error NotGraduated();
    error NothingToFlush();
    error SinkFailed();
    error TokenNotTaken(address token);

    /// @notice Accepts any ETH payment; never reverts; writes nothing.
    receive() external payable;

    /// @notice Anyone, after graduation: unwrap WETH, send all ETH to the receiver's intake for `destination()`.
    function flush() external returns (uint256 ethSent);
    /// @notice Anyone: WETH is flushed; any other token reverts `TokenNotTaken` and stays.
    function sweep(address token) external returns (uint256 amount);

    function coordinator() external view returns (address);
    /// @notice The box's receiver: the only sink.
    function receiver() external view returns (address);
    /// @notice The chain's WETH (unwrapped on flush).
    function weth() external view returns (address);
    /// @notice FeeHandling, Creator or PoolDepth (an unknown byte reads as FeeHandling).
    function destination() external view returns (RoyaltyDestination);
}
