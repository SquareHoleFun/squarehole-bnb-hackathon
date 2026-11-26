// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
/// @notice ShopT core events only. Anyone requests its sellers step through executeModule(true).
interface IBoxReceiverShopV21 {
    /// @notice Receiver bought exactly boughtT into its shop, with no tip.
    event ShopFunded(bool indexed sellers, uint256 spentP, uint256 boughtT);
    /// @notice Receiver assigned this original trade batch an interval of pending P.
    event ShopBatchQueued(uint256 indexed batchId, uint256 startP, uint256 endP);
    /// @notice Cumulative pending P resolved into purchases, deficits/failure or holder refunds.
    event ShopPendingConsumed(uint256 consumedP, uint256 refundedP);
    /// @notice Pending P reached the original batches' holder ledger.
    event ShopHoldersFunded(uint256 amountP);
}
