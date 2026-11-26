// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFeeRules: a pile that every holder of one token can redeem
/// @notice One instance serves one token. Revenue is PUSHED to the instance in its asset (the native coin when
/// `asset()` is the zero address, otherwise an ERC-20 such as a wrapped coin) and is recognised by balance change:
/// a plain transfer is enough and `receive()` does no work. Any holder hands tokens in with `redeem` and is paid
/// `pile * amount / circulatingSupply`, rounded down; whoever hands in the whole circulating supply empties the pile.
/// Tokens handed in are sent to the dead address `DEAD` (works for every ERC-20, burnable or not), so they leave the
/// circulating supply for good.
/// Circulating supply leaves out tokens nobody can sell or redeem: those at DEAD, at address(0), at this contract,
/// and at up to four excluded holders fixed at construction (for example a launch engine's vault that holds the
/// unsold supply). Tokens in a trading pool stay counted: anyone can buy them. An excluded holder cannot redeem.
/// Configuration (token, asset, excluded holders) is fixed at construction:
/// `constructor(address token, address asset, address[] memory excluded)`, at most four excluded holders, none of
/// them zero, DEAD, the token or duplicated. There is no owner, no setter, no pause, no upgrade.
interface IFeeRules {
    /// @notice Revenue seen since the last recognition (by `sync`, or as the first step of `redeem`).
    event RevenueRecognised(uint256 amount, uint256 pileAfter);
    /// @notice `holder` handed in `tokensIn` and `to` was paid `assetOut` from the pile.
    event Redeemed(address indexed holder, address indexed to, uint256 tokensIn, uint256 assetOut);

    error ZeroAmount();
    error ExceedsCirculating(uint256 amount, uint256 circulating);
    error BelowMinimum(uint256 assetOut, uint256 minOut);
    error InexactMovement();
    error PaymentFailed();
    error Reentrancy();
    error ExcludedHolder(address holder);

    /// @notice The dead address tokens handed in are sent to: 0x000000000000000000000000000000000000dEaD.
    function DEAD() external view returns (address);

    /// @notice The token whose holders redeem.
    function token() external view returns (address);

    /// @notice The asset the pile is held in: address(0) = the native coin, otherwise an ERC-20.
    function asset() external view returns (address);

    /// @notice The pile: this contract's whole balance of `asset()` right now.
    function pile() external view returns (uint256);

    /// @notice The holders whose tokens are left out of the circulating supply (besides DEAD, address(0) and this
    /// contract), as fixed at construction; empty when none.
    function excludedHolders() external view returns (address[] memory);

    /// @notice token.totalSupply() minus the token balances of DEAD, address(0), this contract and every excluded
    /// holder.
    function circulatingSupply() external view returns (uint256);

    /// @notice What `redeem(amount, 0)` would pay now: pile * amount / circulatingSupply, rounded down,
    /// or the whole pile when amount equals the circulating supply. Zero for amount 0.
    function quoteRedeem(uint256 amount) external view returns (uint256 assetOut);

    /// @notice Lifetime sum of tokens handed in through `redeem`.
    function totalTokensRedeemed() external view returns (uint256);

    /// @notice Lifetime sum of the asset paid out through `redeem`.
    function totalPaidOut() external view returns (uint256);

    /// @notice Lifetime revenue: pile() + totalPaidOut().
    function totalReceived() external view returns (uint256);

    /// @notice Moves `amount` tokens from the caller to DEAD (the caller approves this contract first) and pays
    /// the caller `quoteRedeem(amount)` in the asset, computed before the hand-in. Reverts below `minOut`, for an
    /// excluded holder, and when the hand-in moves other than `amount` out of the caller, less than `amount` into
    /// DEAD, or shrinks the pile, and when the payout is not exact (the pile loses exactly the payout and, for an
    /// ERC-20, the recipient gains exactly it). Revenue that arrives during the hand-in (a tax token doing its tax
    /// work inside the transfer) stays in the pile for the remaining holders. A redemption after which nothing
    /// circulates (decided after the hand-in) is the last one and takes the whole pile. `minOut` is compared with the
    /// final payout. A native recipient that pays the pile back during its own payment fails the redemption.
    function redeem(uint256 amount, uint256 minOut) external returns (uint256 assetOut);

    /// @notice Same as `redeem`, paying `to` instead of the caller.
    function redeemTo(uint256 amount, uint256 minOut, address to) external returns (uint256 assetOut);

    /// @notice Anyone may call: emits `RevenueRecognised` for revenue that arrived since the last recognition.
    /// Never needed for correctness (the pile is always the live balance); it exists for indexers and pages.
    function sync() external;
}
