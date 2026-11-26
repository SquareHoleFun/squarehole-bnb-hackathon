// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Holder payouts on a token that keeps no balance history: holders stake the token and are paid, evenly
/// per staked token and second, the income (native coin or one ERC-20) that arrives at this contract. One per
/// (creator, token), everything fixed at creation, no owner. Income arrives as plain payments (it can be the payee
/// of a CREATOR rule of a RuleSplitter: receiving does no work); `sync()` by anyone counts what arrived and streams
/// it over `period()` seconds to whoever is staked during them.
interface IRailStake {
    event Staked(address indexed account, uint256 amount);
    event Unstaked(address indexed account, uint256 amount);
    /// @param income what this sync counted; undistributed and streamEnd after it
    event Synced(uint256 income, uint256 undistributed, uint256 streamEnd);
    event Claimed(address indexed account, address indexed to, uint256 amount);

    error ZeroAmount();
    error NotStaked(uint256 staked);
    error TransferFailed();
    error Reentrancy();
    error WrongAsset();
    error BalanceUnreadable();
    error BadReceiver();

    // fixed at creation
    function factory() external view returns (address);
    function creator() external view returns (address);
    function token() external view returns (address);
    /// address(0) is the native coin
    function asset() external view returns (address);
    function period() external view returns (uint256);

    // actions
    /// Takes `amount` of the token from the caller (approve first); credits what the balance actually grew by.
    function stake(uint256 amount) external returns (uint256 credited);
    /// Sends `amount` of the caller's stake back to the caller. Touches only the token, never the asset.
    function unstake(uint256 amount) external;
    /// Counts income that arrived since the last count and streams it with what is still streaming; the stream's
    /// end moves to the amount-weighted mean of the leftover's seconds left and a full period. Anyone may call it.
    function sync() external returns (uint256 income);
    /// Pays the caller what it earned so far, to itself or to `to` (never the zero address or the stake itself).
    function claim() external returns (uint256 paid);
    function claimTo(address to) external returns (uint256 paid);

    // what a page reads
    function totalStaked() external view returns (uint256);
    function stakedOf(address account) external view returns (uint256);
    /// What `claim()` would pay now.
    function claimable(address account) external view returns (uint256);
    /// Income counted so far (lifetime), paid out so far, and the part still to stream.
    function arrived() external view returns (uint256);
    function claimed() external view returns (uint256);
    function undistributed() external view returns (uint256);
    /// When the current stream ends (it pauses while nobody is staked).
    function streamEnd() external view returns (uint256);
    /// Asset that arrived but no sync has counted yet.
    function unsynced() external view returns (uint256);
    /// Asset per second now streaming to all stakers together (0 while nobody is staked), in whole units (rounded
    /// down: it can read 0 while a stream pays).
    function ratePerSecond() external view returns (uint256);
    /// The same rate * 1e27, for a page that divides it itself.
    function ratePerSecondScaled() external view returns (uint256);
}

/// @notice Creates one IRailStake per (creator, token), created by that creator, at an address that commits to every
/// setting (creator, token, asset, period), so what a launch names as a payee is fixed by its address; it can be
/// computed, and paid, before the token or the stake exists.
interface IRailStakeFactory {
    event StakeCreated(
        address indexed stake, address indexed creator, address indexed token, address asset, uint256 period
    );

    error AlreadyCreated(address stake);
    error InvalidSettings(string reason);

    function MIN_PERIOD() external view returns (uint256);
    function MAX_PERIOD() external view returns (uint256);

    /// The caller is the creator. `asset` address(0) = native coin; `period` in seconds within the bounds.
    function create(address token, address asset, uint256 period) external returns (address stake);
    function stakeAddress(address creator, address token, address asset, uint256 period)
        external
        view
        returns (address);
    function isStake(address stake) external view returns (bool);
    /// The creator's stake for this token, address(0) until created (one per creator and token): a page finds it
    /// without knowing the settings.
    function stakeOf(address creator, address token) external view returns (address);
}
