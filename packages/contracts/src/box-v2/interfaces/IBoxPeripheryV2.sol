// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxLaunchRouter} from "../../box/interfaces/IBoxLaunchRouter.sol";
import {IBoxRoyaltyRouter} from "../../box/interfaces/IBoxRoyaltyRouter.sol";
import {IBoxTickets} from "../../box/interfaces/IBoxTickets.sol";
import {IBoxOpenGateV2} from "./IBoxCoordinatorV2.sol";

// Core v2 M1, frozen by ticket M1-00 (integrator, review fixes): the box parts other parts call that had no v2 shape.
// Each keeps v1's interface whole (copy, never edit, ADR-0017 § 10) and says what v2 changes.

/// @title IBoxLaunchRouterV2 (CQ11-A launch router)
/// @notice v1's launch router for any pricing token, taking its open from the coordinator (`IBoxOpenGateV2`; ADR-0017
/// § 6): the window and its tax start at the effective open. `buy(qIn, minTokensOut, recipient, deadline)` keeps v1's
/// selector: native ETH as `msg.value == qIn`; an ERC-20 P with `msg.value == 0`, pulled from `msg.sender` by
/// `transferFrom` (the payer approves the router first) with the router's balance change
/// checked (`ShortTransfer`). A closing fill gives the unspent P and its tax back to `msg.sender`, the payer, in the
/// same call (`BoxLaunchRouter.sol:174-188`). `bootstrap()` and `creatorBuy(creator, qIn)` keep v1's selectors too: in
/// an ETH-priced box their ETH is `msg.value`, as v1's; for an ERC-20 P `msg.value` is 0 and the router pulls exactly
/// `bootstrapQ` (the box's `QParameters` field) and `qIn` from the coordinator, which approved them, with its balance
/// change checked (`ShortTransfer`; `IBoxCoordinatorV2`'s launch payment; wave 0's integrated review, M2) [P].
interface IBoxLaunchRouterV2 is IBoxLaunchRouter, IBoxOpenGateV2 {
    /// @notice The caller payment did not increase the recipient balance by the required amount ; refusal reverts all money movement.
    error ShortTransfer(address token, uint256 expected, uint256 received);
}

/// @title Income inbox for every new RC6 box.
/// @notice Anyone delivers P to the receiver; the inbox offers listed foreign coins for P on CoW, with a delayed
/// in-kind exit. Anyone sweeps P through phase accounting. Only the payee claims other coins in kind, in every phase.
interface IBoxRoyaltyRouterV2 is IBoxRoyaltyRouter {
    /// @notice Anyone registers/refreshes a coin order; the no-argument convenience call selects WETH.
    function refreshOrder() external;
    /// @notice Anyone registers this coin's one ComposableCoW order and approves at most 20 whole lots an hour to the
    /// VaultRelayer; first registration requires an approvable whole lot, otherwise NoOrder. WETH refresh wraps ETH.
    /// A failed box clears the approval instead. Use observe to start a below-lot coin's wait without registration.
    function refreshOrder(address coin) external;
    /// @notice Anyone delivers P (at most four int128-sized parts) to the receiver; an empty inbox returns zero.
    function sweepPriceCoin() external returns (uint256);
    /// @notice Undelivered P, including its native/wrapped representation; unreadable custody reverts.
    function pendingPriceCoin() external view returns (uint256);
    /// @notice Public reads of release wiring and per-box sale state; no funds move.
    function composableCow() external view returns (address);
    /// @notice Anyone reads CoW's settlement contract, whose on-chain domain separator every signature check uses.
    function settlement() external view returns (address);
    /// @notice Anyone reads the release's stateless order generator; no funds move.
    function cowHandler() external view returns (address);
    /// @notice Anyone reads the only spender this inbox ever approves; no funds move.
    function vaultRelayer() external view returns (address);
    /// @notice Anyone reads the listing registry whose sellable list this box captured at creation.
    function listingRegistry() external view returns (address);
    /// @notice Anyone reads the frozen list version; later listings and lot changes never reach this box.
    function listVersion() external view returns (uint256);
    /// @notice Anyone reads the box's own T, which never gets a CoW order; no funds move.
    function token() external view returns (address);
    /// @notice Anyone observes a listed coin's sale clock, with no registration and no approval increase.
    function observe(address coin) external;
    /// @notice Anyone reads the coin's raw lot at the frozen version (WETH at least the release minimum); zero: no order.
    function lotSize(address coin) external view returns (uint256);
    /// @notice Anyone reads when the coin's thirty-day wait started; zero: no unsold balance observed.
    function oldestUnsoldAt(address coin) external view returns (uint256);
    /// @notice Anyone reads whether the coin's ComposableCoW order is registered; no funds move.
    function orderRegistered(address coin) external view returns (bool);
    /// @notice WETH's lot, the Option 1 read; no funds move.
    function lotSize() external view returns (uint256);
    /// @notice WETH's wait start, the Option 1 read; no funds move.
    function oldestUnsoldAt() external view returns (uint256);
    /// @notice Whether WETH's order is registered, the Option 1 read; no funds move.
    function orderRegistered() external view returns (bool);
    /// @notice A registration or refresh: the order id, the balance it saw and the coin's wait start.
    event OrderRefreshed(bytes32 indexed id, uint256 balance, uint256 oldestUnsoldAt);

    /// @notice Only the current creator payee claims non-P coins to itself; P always stays with the box.
    function claimInKind(address token) external returns (uint256 amount);
    /// @notice Anyone reads actual ETH (zero address) or ERC-20 custody; no funds move.
    function heldBalance(address token) external view returns (uint256);
    /// @notice An authenticated in-kind payout to the current creator payee; amount is the router's debit.
    event InKindClaimed(address indexed token, address indexed payee, uint256 amount);
    /// @notice Anyone reads the box's pricing coin (address(0): native ETH); no funds move.
    function q() external view returns (address);
}

/// @title IBoxTicketsV2 (M1-30 copies the tickets add-on)
/// @notice v1's tickets taking the effective open from the coordinator (`IBoxOpenGateV2`): `take()` from it, not from the
/// spec's `openAt` (`BoxTickets.sol:86`, `:112-115`); and each drawn item's delivery handing the vault its ticket's
/// request time (`IBoxVaultV2.deliverTicket(id, to, requestedAt)`, `BoxTickets.sol:58`, `:233`).
interface IBoxTicketsV2 is IBoxTickets, IBoxOpenGateV2 {}

/// @notice S3 declared companion for the M3 adapter context; existing IBoxTicketsV2 remains unchanged.
/// @dev The adapter exposes context only around its authenticated vault call, clearing it before other external work.
/// Keys = keccak256(abi.encode(address(this), uint8(domain), nativeId)): 1 placeholder tokenId, 2 draw ticketId,
/// 3 terminal takeByNumber itemId. Keys never repeat; a terminal take requests/delivers the same key atomically.
/// Multi-placeholder take/handBack exposes one key per actual token, including release calls with ticketId zero.
/// The vault bounds reads by its validated count and authenticates the adapter; zero is never a valid ticket key.
/// No role 16 means no context work or added persistent records. No existing vault call or notice is overloaded.
interface IBoxTicketsItemsV2 {
    /// @notice Anyone reads a zero-based key in active transient context; zero outside it or out of range. No funds move.
    function activeItemTicket(uint256 index) external view returns (bytes32 ticketKey);
}
