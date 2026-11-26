// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Coin pile seed and redemption interface; v2.1 preserves these selectors.
/// @notice One listed asset, P or another listed coin, never own T. Same-P fee intake is receiver-controlled; no swaps.
/// @dev Role 3; also role 19 only when a nonzero seed is due. No collection/tickets for a pile.
/// Seeder, asset and exact amount are immutable. Every T the pile holds at failure joins H once;
/// returning the other asset must never release excluded T into the holders' claim.
interface IPileVaultV2 {
    /// @notice Fixed coordinator only, once on an authenticated clone; validate wiring, move no funds.
    function initialize() external;
    /// @notice Anyone triggers the exact ERC-20 seed pull from the recorded seeder before opening, once.
    /// @dev Native seed: only that seeder with exact msg.value; ERC-20: msg.value zero, exact debit and receipt.
    /// Only after success, role 19 calls coordinator.starterSetLoaded once. Zero seed needs neither load nor loader.
    function loadSeed() external payable;
    /// @notice Fixed coordinator only at graduation, once; enable redemption, move no funds.
    function openGate() external;
    /// @notice Anyone reads the exact redemption quote; no funds move.
    /// @dev Floor the pro-rata share, then apply the immutable 0/500 bps leave-behind. Last T takes all.
    function quoteRedeem(uint256 tIn) external view returns (uint256 assetOut);
    /// @notice Graduated holder only; this vault pulls and burns caller-approved T, then pays the fixed asset to to.
    /// @dev Check nonzero caller T, recipient, minOut and exact debits/receipts; nonReentrant, atomic on failure.
    /// Compute from pre-burn balances with full precision. No third party may spend another holder's T.
    function redeem(uint256 tIn, uint256 minOut, address to) external returns (uint256 assetOut);
    /// @notice Fixed coordinator only, once before graduation; record failure with no seed-asset transfer or call.
    /// @dev Seed payout is separate; a paused seed cannot block failure or holders' P claims.
    function enterFailure() external;
    /// @notice Anyone after failure; return the recorded seed only to its seeder, once, retryable if payment fails.
    /// @dev Pending fee P joins the closing pot separately. Never pays T excluded in H.
    function returnSeed() external returns (uint256 amount);
    /// @notice Anyone reads the fixed seeder; no funds move.
    function seeder() external view returns (address);
    /// @notice Anyone reads the fixed listed asset, address(0) for native ETH; no funds move.
    function asset() external view returns (address);
    /// @notice Anyone reads the fixed seed amount in raw asset units; no funds move.
    function seedAmount() external view returns (uint256);
    /// @notice Anyone reads zero; pile redemption has no item supply floor. No funds move.
    function supplyFloor() external view returns (uint256);
    /// @notice Anyone reads zero; a pile has no items. No funds move.
    function collectionSize() external view returns (uint256);
    /// @notice Anyone reads zero; a pile has no items inside. No funds move.
    function inside() external view returns (uint256);
}
