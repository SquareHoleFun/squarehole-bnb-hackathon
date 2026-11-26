// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice M2 role-3 lifecycle contract for CQ11 coordinator wiring. M2-32/44 supply the shop implementation.
/// @dev The first three selectors match the share-vault lifecycle; shop T is H, never escrow surplus K.
interface IBoxShopLifecycleV2 {
    /// @notice Fixed coordinator only, once; validate immutable wiring, pull no starter NFTs and move no funds.
    function initialize() external;
    /// @notice Fixed coordinator only after graduation; enable the live shop, never unfreeze a failed shop.
    function openGate() external;
    /// @notice Fixed coordinator only, atomically before H is read; freeze all T outflows except provable burns.
    /// Seed and pick T, including T claims and refused burns, cannot return to creator or become failure claimants.
    /// Starter NFTs retain their separate creator-return path; this call never withdraws holder-ledger P.
    function enterFailure() external;
    /// @notice Anyone after failure retries burning frozen shop T fail-safe; a refusal preserves custody for retry.
    /// No payout, transfer of excluded T, or adjustment of the coordinator denominator is allowed.
    function burnFailedT() external returns (uint256 burned);
}
