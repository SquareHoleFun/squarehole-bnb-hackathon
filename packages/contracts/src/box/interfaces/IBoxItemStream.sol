// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VaultAction} from "./BoxTypes.sol";

/// @title IBoxTransferObserver (hook point `collection.transferObserver`; caller S3, implementer S8)
/// @notice The collection calls it on every ownership change, after the transfer's checks and before any owner or
/// balance changes, so the observer still reads the pre-transfer state (IMisfitsTransferObserver, src/v2/interfaces/
/// IMisfitsTransferObserver.sol:5-21). Not called for the consecutive creation of the N ids.
/// @dev The call is capped and fail-safe: at most `IBoxCollection.observerGas()`, no return data copied, a revert or
/// out-of-gas skipped with `TransferObserverFailed`; the transfer reverts `ObserverGasTooLow` when sent with too little
/// gas to give the observer its whole cap (EIP-150). An observer must detect a missed call itself (the owner it
/// recorded differs from `ownerOf`) and keep its worst case, a slot written from zero after Glamsterdam included,
/// under the cap (SH-S0-spikes § 3: 100,000 fails after Glamsterdam, the lean checkpoint needs about 174,000).
interface IBoxTransferObserver {
    function onItemTransfer(address from, address to, uint256 id) external;
}

/// @title IBoxVaultObserver (hook point `vault.observer`; caller S3, implementer S8)
/// @notice The vault calls it at its STREAM HOOK points (src/v2/MisfitsVault.sol:342, 374, 607, 656) before the count
/// of items inside changes: a ticket counts as outside from its take (ADR-0014 § G07). Ids that physically leave or
/// return are also seen by the collection's transfer observer.
/// @dev Capped and fail-safe exactly as the transfer observer (`IBoxVault.observerGas()`, `VaultObserverFailed`,
/// `ObserverGasTooLow`).
interface IBoxVaultObserver {
    /// @param action The vault action about to change the counts.
    /// @param account The owner, the ticket adapter or the recipient the action is for.
    /// @param count Items (or tickets) the action moves.
    /// @param insideBefore n before the action.
    function onVaultAction(VaultAction action, address account, uint256 count, uint256 insideBefore) external;
}

/// @title IBoxItemStream (add-on 2 `per-item-stream`; slice S8; one clone per box that carries the add-on)
/// @notice The per-item fee stream (F23 A3, ADR-0014 § G07; F61 X1: any owner earns, contracts included; F77: 13/15 of
/// box 0's sellers' fees after graduation). Box 0 only until the founder decides otherwise (BC-065; add-ons.v1.json
/// add-on 2).
///
/// - **What it streams.** After graduation box 0's receiver hands it 13/15 of every T-side batch (hook point
///   `receiver.tStreamAction`, action PER_ITEM_STREAM) and tells it with a capped, fail-safe `onStreamFunds`. The
///   stream accounts from its T balance, never from the calls.
/// - **Exact per swap, checkpointed (D2; graduation-and-gas § 2.3).** The stream's value X = F + 13·⌊(U + R)/15⌋, where
///   F is every T the stream ever received (its balance plus what it paid out and burned), U the T fees box 0's
///   positions earned and nobody collected yet (read from the pool's fee growth, read only) and R the receiver's T
///   claims not yet split (its carry included). X grows at every swap by 13/15 of the T fee that swap paid, up to the
///   floor of one fifteenth, and is continuous across `collect()`, `deepen()` and the receiver's hand-off, so the
///   per-item index J = ⌊(X − X₀)/N⌋ (X₀ at graduation) is G07's per-swap index read at any moment. Checkpoints at
///   transfers and at the vault's STREAM HOOK points (before n changes) book each owner exactly what the per-swap
///   allocation gives (BC-065), to a stated rounding bound (SH-S8-stream).
/// - **Inside burns, outside earns.** A slot is outside while its item is held outside the vault, and while its ticket
///   is open (a placeholder from graduation, a draw from its request, ADR-0014 § G07 point 4); its share accrues to the
///   owner, any address, contracts included (F61 X1). The share of the items inside is burned (`onStreamFunds`,
///   `burn`): whatever T the stream holds beyond what owners have accrued and not claimed (and one raw unit per outside
///   slot). Under D2 the amount is exact but the burn follows the batches, not each change of n (G07 point 2's timing;
///   SH-S8-stream § 3).
/// - **Claims are pulled** (`claim`, or anyone's `claimFor`, which pays the owner itself); a claim pays what the stream
///   holds and leaves the rest owed until the next `collect()`. No owner, admin, pause, upgrade, setter or rescue.
interface IBoxItemStream is IBoxTransferObserver, IBoxVaultObserver {
    /// @notice Startup completed with graduation baseline X₀ = `value`; accrual includes any delay before this call.
    event Started(uint256 value);
    /// @notice An item's accrual was booked to `account` (a transfer, a return or a claim's checkpoint).
    event Credited(address indexed account, uint256 indexed id, uint256 amount);
    /// @notice Tickets handed back or cancelled after graduation (terminal mode): their accrual to `account`.
    event TicketsCredited(address indexed account, uint256 count, uint256 amount);
    event Claimed(address indexed account, address indexed to, uint256 amount);
    event Burned(uint256 amount);
    /// @notice The T's burn was refused (the vault's supply floor); it waits for a later burn.
    event BurnRefused(uint256 amount);
    /// @notice The receiver's notice of `amount` T (informational: the stream accounts from its balance).
    event Funded(uint256 amount);
    /// @notice A checkpoint found item `id` recorded for `recorded` while `actual` owns it (a missed call): the accrual
    /// since the last checkpoint went to the recorded owner, and the record now names `actual`.
    event CheckpointRepaired(uint256 indexed id, address recorded, address actual);

    error NotCoordinator(address caller);
    error NotCollection(address caller);
    error NotVault(address caller);
    error NotReceiver(address caller);
    error AlreadyInitialised();
    error NotInitialised();
    error NotGraduated();
    error AlreadyStarted();
    /// @notice A wiring read at `initialize` does not name this stream, box 0 or the arguments' values.
    error WiringMismatch(uint256 check);
    error NotOwner(uint256 id, address account);
    error ZeroAddress();
    /// @notice The stream itself as the account or the recipient of a claim.
    error SelfClaim();
    error BurnDidNotReduceSupply();

    /// @notice The box's coordinator only (the `coordinator` argument, a clone of `coordinatorImplementation()`), once,
    /// in createBox after the receiver: checks the wiring and writes every global slot non-zero, so no observer call
    /// later writes a global slot from zero.
    function initialize() external;

    /// @notice Anyone, once, after graduation; the coordinator's graduation poke calls it (POKE_GAS, fail-safe). Runs
    /// the receiver's settlement first if nobody has, then caches the recorded graduation X₀ and burns surplus.
    /// A delayed retry keeps all post-graduation earnings, including before startup (F126 / M28).
    function onGraduation() external;

    /// @notice The receiver has just transferred `amount` T to the stream. Called by the receiver only, capped and
    /// fail-safe (`IBoxReceiver.StreamNotifyFailed`): the stream accounts from its T balance, never from the calls; it
    /// burns the items-inside share it now holds.
    function onStreamFunds(uint256 amount) external;

    /// @notice Books the caller's accrual on `ids` (each must be the caller's) and pays everything it is owed, up to what
    /// the stream holds, to `to`.
    function claim(uint256[] calldata ids, address to) external returns (uint256 paid);

    /// @notice Anyone: books `account`'s accrual on `ids` (each must be `account`'s) and pays `account` itself, up to
    /// what the stream holds (F61 X1: a contract owner that cannot call `claim` still receives its share).
    function claimFor(address account, uint256[] calldata ids) external returns (uint256 paid);

    /// @notice Anyone: burns the share of the items inside that the stream holds (its T beyond the owners' accrual not
    /// yet claimed); a burn the vault's floor refuses waits.
    function burn() external returns (uint256 burned);

    // ------------------------------------------------------------------ views
    /// @notice The per-item index J now: raw T per item accrued since graduation (0 before graduation, including when startup is delayed).
    function index() external view returns (uint256);
    /// @notice X now (see the notes): what the stream has received plus 13/15 of what is still on its way.
    function streamValue() external view returns (uint256);
    /// @notice Item `id`'s record: its owner as last checkpointed (zero: inside, or never seen) and its accrual since.
    function pendingOf(uint256 id) external view returns (address owner, uint256 amount);
    /// @notice T booked to `account` and not yet paid.
    function owedOf(address account) external view returns (uint256);
    /// @notice The owners' accrual not yet paid (booked or not). The stream keeps that, plus one raw unit per slot
    /// outside once started (J is floored), before it burns. Slots that leave the vault after a burn can leave a later
    /// full collect short by up to N − 1 − m raw units (m the outside count at that burn); the next batch covers the
    /// rest (box 0's own review W2-U5-1, F147).
    function liabilities() external view returns (uint256);
    /// @notice Slots outside (m = N − n: items held outside and open tickets), as the stream counts them.
    function outsideCount() external view returns (uint256);
    /// @notice Open placeholders and open draws, as the stream counts them, and the draws' summed index at request.
    function openTickets() external view returns (uint256 placeholders, uint256 draws, uint256 drawIndexSum);
    function started() external view returns (bool);
    /// @notice X₀: the value at the start.
    function startValue() external view returns (uint256);
    /// @notice Lifetime T paid to owners and burned.
    function totals() external view returns (uint256 claimed, uint256 burned);

    // ------------------------------------------------------------------ wiring
    function coordinator() external view returns (address);
    function coordinatorImplementation() external view returns (address);
    function poolManager() external view returns (address);
    function token() external view returns (address);
    function collection() external view returns (address);
    function vault() external view returns (address);
    /// @notice The tickets add-on, or zero.
    function tickets() external view returns (address);
    function receiver() external view returns (address);
    function hook() external view returns (address);
    function collectionSize() external view returns (uint256);
    function firstId() external view returns (uint256);
}
