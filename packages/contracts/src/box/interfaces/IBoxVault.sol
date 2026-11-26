// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxSupplyFloor} from "./IBoxToken.sol";
import {IERC721TokenReceiver} from "./IBoxCollection.sol";
import {VaultAction} from "./BoxTypes.sol";

/// @title IBoxVault (slice S3; per-box clone with immutable arguments, F61 A1)
/// @notice The box's lock/release vault: it holds the collection's N items and the T conversion escrow. A copy of
/// MisfitsVault (src/v2/MisfitsVault.sol:55-800) with T, the collection, N, firstId, the coordinator, the ticket
/// adapter, the observer and the fee rates as clone arguments (V `:237-253` are constructor inputs today).
///
/// Symbols (v2 docs/03): S = T totalSupply · E = `escrowPrincipal` · A = S − E · n = `inside` · N = `collectionSize`
/// · m = N − n · h = `hiddenCount` · t = `pendingTickets` · s = n − h (the shelf).
/// - **Quotes** from the pre-action state and E, never `balanceOf(vault)` (BC-006): withdraw ⌈A·k/n⌉, return ⌊A·k/n⌋,
///   FullMath (512-bit) for every product.
/// - **Flat fees**, burned through T (F23 C3; BoxSpecV1 DRAW_FEE_BPS 100, PICK_FEE_BPS 2,500, RETURN_FEE_BPS 500):
///   ceil(p × bps / 10,000) of the principal p.
/// - **Tickets** only through `ticketAdapter()` (hook point `vault.ticketAdapter`; the tickets add-on): hidden = N at
///   `initialize` only when the adapter is set (SH-S0-spikes § 2.1 rule for S3). Without it no item is hidden: every
///   id that never left counts as shelf, so open-art boxes serve named picks from graduation on.
/// - **Phase gate**: deliveries, named picks and returns wait for `openGate()`, which only the coordinator calls,
///   once, at graduation (F30 Q3); tickets open and close while it is closed.
/// - **The last item stays** (F23 C2; BC-007): n ≥ 1 always. A sent item outside a return is refused (BC-042).
/// - **Observer** (hook point `vault.observer`, add-on 2): `IBoxVaultObserver.onVaultAction` before n changes,
///   capped (`observerGas()`), fail-safe (`VaultObserverFailed`).
/// - No owner, admin, pause, upgrade, mint, sweep or rescue. Failure (v2, S11) adds the box's exit for the items.
/// @dev Invariants (VLT-08): T balance == E; E·n ≥ m·A; n ≥ 1; n + t + (outside items) == N; h ≤ n; E + n ≤ S.
interface IBoxVault is IBoxSupplyFloor, IERC721TokenReceiver {
    event Withdrawn(
        address indexed owner,
        uint256[] ids,
        uint256 principal,
        uint256 fee,
        uint256 supplyAfter,
        uint256 escrowAfter,
        uint256 insideAfter
    );
    event Returned(
        address indexed owner,
        uint256[] ids,
        uint256 principal,
        uint256 fee,
        uint256 supplyAfter,
        uint256 escrowAfter,
        uint256 insideAfter
    );
    event TicketsOpened(
        uint256 count,
        uint256 principal,
        uint256 fee,
        uint256 supplyAfter,
        uint256 escrowAfter,
        uint256 insideAfter,
        uint256 hiddenAfter,
        uint256 ticketsAfter
    );
    event TicketsReleased(
        address indexed to,
        uint256 count,
        uint256 principal,
        uint256 fee,
        uint256 supplyAfter,
        uint256 escrowAfter,
        uint256 insideAfter,
        uint256 hiddenAfter,
        uint256 ticketsAfter
    );
    event TicketDelivered(uint256 indexed id, address indexed to, uint256 ticketsAfter);
    /// @notice Once, by `initialize`: all N inside, h = N with a ticket adapter (else 0), the gate closed.
    event VaultInitialized(
        address token,
        address collection,
        uint256 collectionSize,
        uint256 firstId,
        address coordinator,
        address ticketAdapter,
        address observer,
        uint256 drawFeeBps,
        uint256 pickFeeBps,
        uint256 returnFeeBps
    );
    event GateOpened(address indexed coordinator, uint256 timestamp);
    event HandBackFeeWaived(address indexed coordinator, uint256 timestamp);
    /// @notice The vault observer failed (reverted or ran out of its gas) and was skipped; the action happened.
    event VaultObserverFailed(VaultAction action, address indexed account, uint256 count);

    error ZeroAddress();
    error NotCoordinator(address caller);
    error AlreadyInitialised();
    /// @notice A state-changing call to a clone its coordinator never initialised (SH-S0-spikes decision 9; BC-100).
    /// Added by S3 (docs/evidence/SH-S3-items.md, interface changes).
    error NotInitialised();
    /// @notice The collection does not hold exactly N items in the vault, or not both ends of the id range.
    error CustodyMismatch(uint256 held, uint256 collectionSize);
    error DeadlineExpired(uint256 deadline, uint256 timestamp);
    error InvalidQuantity(uint256 count, uint256 available);
    error LastItem();
    error MaxTokenExceeded(uint256 total, uint256 maxTokenIn);
    error InsufficientToken(uint256 balance, uint256 total);
    error IneligibleId(uint256 id);
    error InvalidIdList();
    error NotOwner(uint256 id);
    error ReturnBelowUnit(uint256 principal, uint256 count);
    error MinTokenNotMet(uint256 net, uint256 minTokenOut);
    error EscrowInsolvent(uint256 principal, uint256 escrow);
    error TokenNotReceived(uint256 received, uint256 principal);
    error ItemNotReceived(uint256 id);
    error ForeignNft(address collection, uint256 id);
    error UnsolicitedItem(address from, uint256 id);
    error GateClosed();
    error GateAlreadyOpen();
    error HandBackFeeAlreadyWaived();
    error NotAdapter(address caller);
    error HiddenItem(uint256 id);
    error NotRevealed(uint256 id);
    error NoHiddenItem(uint256 count, uint256 hidden);
    error NoPendingTicket();
    error NotHidden(uint256 id);
    error ObserverGasTooLow(uint256 gasLeft, uint256 required);

    /// @notice The box's coordinator only (the `coordinator` argument, a clone of `coordinatorImplementation()`), once,
    /// in createBox (after the collection's `initialize`): checks custody of N items and both ends of the range, writes
    /// the one counts word.
    function initialize() external;

    // ------------------------------------------------------------------ the coordinator
    /// @notice Graduation: opens deliveries, named picks and returns for good. The coordinator only, once.
    function openGate() external;
    /// @notice The coordinator only, while the gate is closed, once (F38 (4); unused in v1, kept for S11).
    function waiveHandBackFee() external;

    // ------------------------------------------------------------------ the ticket adapter
    function openTickets(uint256 count, uint256 maxTokenIn) external returns (uint256 principal, uint256 fee);
    function releaseTickets(uint256 count, address to, uint256 minTokenOut)
        external
        returns (uint256 principal, uint256 fee);
    function deliverTicket(uint256 id, address to) external;

    // ------------------------------------------------------------------ anyone (after graduation)
    /// @notice Named pick of shelf items (revealed only): lock ⌈A·k/n⌉ plus the pick fee (burned).
    function withdraw(uint256 id, uint256 maxTokenIn, uint256 deadline)
        external
        returns (uint256 principal, uint256 fee);
    function withdrawBatch(uint256[] calldata ids, uint256 maxTokenIn, uint256 deadline)
        external
        returns (uint256 principal, uint256 fee);
    /// @notice Return revealed items you own (or unrevealed ones past the adapter's `returnableFrom`): ⌊A·k/n⌋ less
    /// the return fee. The vault pulls each item itself.
    function returnItem(uint256 id, uint256 minTokenOut, uint256 deadline)
        external
        returns (uint256 principal, uint256 fee);
    function returnItems(uint256[] calldata ids, uint256 minTokenOut, uint256 deadline)
        external
        returns (uint256 principal, uint256 fee);

    // ------------------------------------------------------------------ wiring and constants
    function token() external view returns (address);
    function collection() external view returns (address);
    function coordinator() external view returns (address);
    /// @notice The version's coordinator implementation: only a clone of it may initialise this vault (BC-100).
    function coordinatorImplementation() external view returns (address);
    /// @notice The tickets add-on, or address(0) (no hidden item exists).
    function ticketAdapter() external view returns (address);
    /// @notice The per-item stream (add-on 2), or address(0).
    function observer() external view returns (address);
    function observerGas() external view returns (uint256);
    function collectionSize() external view returns (uint256);
    function firstId() external view returns (uint256);
    function drawFeeBps() external view returns (uint256);
    function pickFeeBps() external view returns (uint256);
    function returnFeeBps() external view returns (uint256);
    /// @notice 10,000.
    function FEE_DENOMINATOR() external view returns (uint256);

    // ------------------------------------------------------------------ state and quotes (MisfitsVault.sol:470-589)
    function escrowPrincipal() external view returns (uint256);
    function inside() external view returns (uint256);
    function hiddenCount() external view returns (uint256);
    function pendingTickets() external view returns (uint256);
    function shelfCount() external view returns (uint256);
    function outside() external view returns (uint256);
    function gateOpen() external view returns (bool);
    function gateOpenedAt() external view returns (uint256);
    function handBackFeeWaived() external view returns (bool);
    function activeSupply() external view returns (uint256);
    function unsolicitedToken() external view returns (uint256);
    function quoteWithdraw(uint256 count) external view returns (uint256);
    function quoteReturn(uint256 count) external view returns (uint256);
    function quoteTake(uint256 count) external view returns (uint256 principal, uint256 fee);
    function quoteHandBack(uint256 count) external view returns (uint256 principal, uint256 fee);
    function escrowSurplus() external view returns (uint256 kFloor, uint256 kRemainder);
    function isOutside(uint256 id) external view returns (bool);
    function isInside(uint256 id) external view returns (bool);
    function hasLeftVault(uint256 id) external view returns (bool);
    function isHidden(uint256 id) external view returns (bool);
    function isOnShelf(uint256 id) external view returns (bool);
}
