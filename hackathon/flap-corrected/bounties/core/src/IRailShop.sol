// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IRailShop: a card shop for one token launched elsewhere, fed by that token's trading tax
/// @notice Give a card of a listed collection and receive its give price in the token; pick a card and pay its pick
/// price in the token. Everything is fixed at creation; there is no owner. See `RailShop` for the properties.
interface IRailShop {
    event Stocked(address indexed nft, uint256 indexed id, address indexed from);
    event Given(address indexed nft, uint256 indexed id, address indexed holder, uint256 paid);
    event Picked(address indexed nft, uint256 indexed id, address indexed buyer, address to, uint256 paid);
    /// @notice `assetSpent`: what the refill took from the waiting asset, measured by balance (before minus after; the
    /// amount `waiting()` fell by), always exactly the eligible slice min(`waiting()`, the guard's cap): a refill whose
    /// router draws less, or whose tokens arrive short of the minimum, reverts (`RefillShort`) and emits nothing.
    event Refilled(uint256 assetSpent, uint256 tokensOut);
    event Dropped(address indexed nft, uint256 indexed id);

    error InvalidShop();
    error NotListed();
    error NotHeld();
    error LastCard();
    error BudgetShort();
    error CapReached();
    error PriceAbove();
    error TransferFailed();
    error Reentrancy();
    error NativeNotAccepted();
    error NothingWaiting();
    error BadReceiver();
    error StillHeld();
    error AmountAbove();
    error TokenNotLive();
    error BalanceUnreadable();
    error OwnerUnknown();

    /// @notice Hand in a card of a listed collection (approved to the shop) and receive its give price in the token.
    /// Refused when the shop's token balance or the period's room (`capLeft()`) cannot pay it in full, or when the
    /// price is below `minPaid`. The holder must receive exactly the give price (measured by balance).
    function give(address nft, uint256 id, uint256 minPaid) external returns (uint256 paid);
    /// @notice Pay a held card's pick price in the token (approved to the shop) and receive the card at `to` (a plain
    /// transfer: a receiver contract must be able to hold cards). The shop must receive exactly the pick price
    /// (measured by balance). The last listed card stays. A pick adds the card's give price to the current period's
    /// room, also before any give in that period.
    function pick(address nft, uint256 id, uint256 maxPrice, address to) external returns (uint256 paid);
    /// @notice Anyone hands in cards of a listed collection for nothing (each approved to the shop). Refused while the
    /// token has no code.
    function stock(address nft, uint256[] calldata ids) external;
    /// @notice Anyone turns waiting asset into the token on the router; the tokens stay in the shop. A refill buys the
    /// eligible slice, min(`waiting()`, the guard's cap of 5 bps of the pair's quote reserve), or nothing: `amount` must
    /// be at least that slice and at most `waiting()` (pass `waiting()`); at most one per minute, with a minimum output
    /// (see `PairPriceGuard`). Refused while the token has no code.
    function refill(uint256 amount) external returns (uint256 tokensOut);
    /// @notice Anyone removes a listed card the shop no longer owns (it left by its collection's own doing), so the list
    /// tells the truth again. Only on a definite answer: `ownerOf` must succeed with exactly one word naming another,
    /// nonzero owner; a reverting, short, malformed or zero answer is refused (`OwnerUnknown`).
    function drop(address nft, uint256 id) external;

    function token() external view returns (address);
    function asset() external view returns (address);
    function router() external view returns (address);
    function factory() external view returns (address);
    function creator() external view returns (address);
    function pickBps() external view returns (uint16);
    function weeklyCap() external view returns (uint256);
    function createdAt() external view returns (uint256);
    function collectionCount() external view returns (uint256);
    function collection(uint256 i) external view returns (address nft, uint256 givePrice, uint256 pickPrice);
    function pricesOf(address nft) external view returns (uint256 givePrice, uint256 pickPrice);
    function cardCount() external view returns (uint256);
    function card(uint256 i) external view returns (address nft, uint256 id);
    function cards(uint256 offset, uint256 limit) external view returns (address[] memory nfts, uint256[] memory ids);
    function holds(address nft, uint256 id) external view returns (bool);
    /// @notice The shop's token balance: what gives are paid from.
    function budget() external view returns (uint256);
    /// @notice The asset that has arrived and waits for `refill()`.
    function waiting() external view returns (uint256);
    /// @notice The current seven-day period's room for gives (periods count from creation): the cap, minus the give
    /// prices of this period's gives, plus the give prices of this period's picks. It can exceed `weeklyCap()` after
    /// picks. A new period starts at the cap.
    function capLeft() external view returns (uint256);
    /// @notice When the current seven-day period ends.
    function periodEnds() external view returns (uint256);
}
