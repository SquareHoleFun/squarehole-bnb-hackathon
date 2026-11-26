// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Historical Q-reward ledger for one Square Hole launch (ADR-0010, ADR-0011).
/// Holder Q is held as Uniswap v4 ERC-6909 claims on the PoolManager (ADR-0011 "Fee realization").
interface IRewardLedger {
    /// @notice Immutable payout selection R of the launch (spec 05, ECO-04).
    enum PayoutAsset {
        Q,
        T
    }

    /// @notice Holder Q arrived while no eligible T existed; it waits in the bootstrap bucket.
    event HolderQDeferred(uint256 amount, uint256 bootstrapTotal);
    /// @notice Holder Q (plus any released bootstrap Q) was added to the reward index.
    event HolderQAllocated(
        uint256 amount, uint256 bootstrapReleased, uint256 eligibleSupply, uint256 indexDelta, uint256 rewardIndex
    );
    /// @notice `account`'s entitlement grew by `accruedScaled` (Q × INDEX_SCALE) for holding `balance` T
    /// while the index moved from `fromIndex` to `toIndex`.
    event Settled(address indexed account, uint256 balance, uint256 fromIndex, uint256 toIndex, uint256 accruedScaled);
    /// @notice `amount` Q of `account`'s entitlement was paid to `recipient` (the account, or the converter).
    event Claimed(address indexed account, address indexed recipient, uint256 amount);
    /// @notice An unsolicited deposit (not holder Q) was moved to the treasury (`claims` = ERC-6909 claims).
    event UnaccountedSwept(address indexed asset, uint256 amount, bool claims);

    function INDEX_SCALE() external view returns (uint256);
    function token() external view returns (address);
    function mirror() external view returns (address);
    function quote() external view returns (address);
    function feeCollector() external view returns (address);
    function treasury() external view returns (address);
    function converter() external view returns (address);
    function poolManager() external view returns (address);
    function hook() external view returns (address);
    function launcher() external view returns (address);
    function payoutAsset() external view returns (PayoutAsset);

    /// @notice Called by T before every balance mutation with the pre-change balances.
    /// `from` is zero for a mint, `to` is zero for a burn.
    function beforeBalanceChange(address from, uint256 fromBalance, address to, uint256 toBalance, uint256 amount)
        external;

    /// @notice Called by the fee collector at an authenticated fee event. Pulls exactly `amount` Q claims. Reverts when
    /// `amount != 0` while `poolNetOutflow() != 0` (fail-closed flash guard).
    function notifyHolderQ(uint256 amount) external;

    /// @notice R = Q: pays the caller's own entitlement in Q (ERC-20, redeemed from the PoolManager).
    function claim(address account) external returns (uint256 amount);

    /// @notice R = T: the immutable converter consumes up to `maxAmount` of `account`'s entitlement and receives it as
    /// Q claims (partial settlement; the rest stays intact).
    function claimFor(address account, uint256 maxAmount) external returns (uint256 amount);

    function isExcluded(address account) external view returns (bool);
    function claimable(address account) external view returns (uint256);
    function accrued(address account) external view returns (uint256);
    function rewardIndex() external view returns (uint256);
    function eligibleSupply() external view returns (uint256);
    function bootstrapQ() external view returns (uint256);
    function poolNetOutflow() external view returns (uint256);
}
