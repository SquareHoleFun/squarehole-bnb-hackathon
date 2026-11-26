// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
/// @notice Additive v2.1 reads/events. Anyone buys through the existing buyBack and burnPending entries.
interface IBoxReceiverPayInTV21 {
    /// @notice A successful own-pool buy credited T to this ledger or retained it for inside-item burning.
    event RewardsBought(uint8 indexed choice, uint8 indexed side, uint256 spentP, uint256 boughtT, uint256 ledgerT, uint256 burnT, uint256 tipP);
    /// @notice Pending inside-item T claims were actually burned.
    event RewardTBurned(uint256 amountT);
    /// @notice ItemsT Depth P allocation before a purchase: choiceP = depthP + rewardsP.
    /// Source 1 trade, 2 gift/royalty, 3 graduation; source 4 reroutes an already queued outside share
    /// when every item is back inside. Source 4 is not new income. No token code or pool action runs here.
    event ItemsDepthFunded(uint8 indexed side, uint8 indexed source, uint256 choiceP, uint256 depthP, uint256 rewardsP);
    /// @notice Anyone reads aggregate P waiting for holder/item T purchases; no funds move.
    function rewardsPendingP() external view returns (uint256);
    /// @notice Anyone reads holder, buyer-item and seller-item P debt separately; no funds move.
    function rewardsPendingByKind() external view returns (uint256 holders, uint256 buyersItems, uint256 sellersItems);
    /// @notice Anyone reads bought T claims waiting for a burn; no funds move.
    function rewardBurnPendingT() external view returns (uint256);
}
