// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC721TokenReceiver} from "../../box/interfaces/IBoxCollection.sol";
import {IBoxSupplyFloor} from "../../box/interfaces/IBoxToken.sol";

/// @title IBoxVaultCountV2 (ticket M1-00; ADR-0017 § 2, § 12)
/// @notice Anyone reads the preserved vault count integral. C14 retains the reviewed vault accounting;
/// the CQ11 receiver does not use these views to split fees. Reads move no funds.
interface IBoxVaultCountV2 {
    /// @notice N, the items the vault was made for (0 for a token-only box, which has no vault).
    /// @dev Anyone may read collectionSize; no funds move.
    function collectionSize() external view returns (uint256);
    /// @notice n, the items inside now. A draw counts as outside from its request: opening tickets lowers n at once
    /// (`BoxVault.sol:159-164`).
    /// @dev Anyone may read inside; no funds move.
    function inside() external view returns (uint256);
    /// @notice The time integral of n since `initialize`, in item-seconds, carried forward to `timestamp`
    /// (= block.timestamp). The vault keeps the integral and the time of its last change in its one counts word
    /// (32-bit counts, N <= 10,000); the fixed CQ11 split does not read a time-averaged count. No funds move.
    /// @dev Anyone may read insideIntegral; no funds move.
    function insideIntegral() external view returns (uint256 integral, uint256 timestamp);
}

/// @title IBoxVaultV2 (ticket M1-00 freezes it; M1-30 copies the vault, M1-31 adds its failure path, M3 builds the
/// item records)
/// @notice v1's supply-share vault (`IBoxVault`: quotes, flat burned fees, tickets through the adapter, the phase gate,
/// the last item stays) with these changes:
/// - **The pick fee is the spec's preset** (field 31: 100, 500 or 2,500 bps), a clone argument (ADR-0017 § 5).
/// - **The count integral** (`IBoxVaultCountV2`).
/// - **The item ledger at registry role 16** (`itemLedger()`; M3 builds it) replaces v1's observer. The vault calls
///   it at five points, each before the state it reports changes, with the calls M1-00 owner 2 freezes in
///   `ILedgerCalls.sol`: (1) tickets opened, with the count (`openTickets`, `BoxVault.sol:159`); (2) tickets released,
///   with the count (`releaseTickets`, `:188`); (3) a withdrawal, with its ids (`withdraw`, `withdrawBatch`, `:483`);
///   (4) a return, with its ids (`returnItem`, `returnItems`, `:533`); (5) a drawn item's delivery, with its id and
///   its ticket's request time (`deliverTicket`, `:203`; v1 calls nobody there). A delivery changes no count. Each call
///   is fail-safe as v1's observer is (`BoxVault.sol:621-634`): it runs with exactly `ITEM_LEDGER_GAS()`, behind a
///   `gasleft()` floor of cap + cap/63 + overhead (`ItemLedgerGasTooLow` otherwise), reads no return data, and a
///   revert or out-of-gas is skipped and reported (`ItemLedgerCallFailed`); the action happens either way. With role
///   16 unset (every M1 box) the vault skips the call and writes no new slot.
/// - **The ledger's rule for a failed call** (ADR-0017 § 2): the ledger resolves the move when it next learns of it
///   from `itemTimes` (the item's next call or claim), at the index that pays the item less: a missed exit at the
///   index current then, a missed entry at the index its last recorded exit started from. A failed call can only
///   underpay an item, and the ledger keeps no history.
/// - **Item records** (`itemTimes`; frozen now, built in M3): each item's last exit and entry time, packed so new
///   slots stay rare; a drawn item's exit is its ticket's request time. M1's vault refuses the view (`NOT_OFFERED`).
/// - **Failure** (M1-31; `core-v2-plan.md:91`, "On failure the items go back"; `box-factory.md:1038`): the
///   coordinator's `enterFailure()` once, inside `fail()`; then every item nobody kept goes back to the creator,
///   unrevealed, through `releaseToCreator`, in batches.
/// - **Earned coins:** F122 defers non-P earned coins to a later version. The forwardEarned selector remains a
///   NOT_OFFERED stub in this release; it moves nothing. It does not use the royalty conversion Safe.
/// - No owner, admin, pause, upgrade, mint, sweep or rescue.
interface IBoxVaultV2 is IBoxSupplyFloor, IERC721TokenReceiver, IBoxVaultCountV2 {
    /// @notice Emitted on a holder withdrawal: NFTs leave the vault, T principal enters escrow and the T fee burns.
    event Withdrawn(
        address indexed owner,
        uint256[] ids,
        uint256 principal,
        uint256 fee,
        uint256 supplyAfter,
        uint256 escrowAfter,
        uint256 insideAfter
    );
    /// @notice Emitted on an owner return: NFTs enter the vault, T principal less the burned fee goes to the owner.
    event Returned(
        address indexed owner,
        uint256[] ids,
        uint256 principal,
        uint256 fee,
        uint256 supplyAfter,
        uint256 escrowAfter,
        uint256 insideAfter
    );
    /// @notice Emitted on the adapter opening tickets: T principal enters escrow, fee burns and hidden items are reserved.
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
    /// @notice Emitted on the adapter releasing tickets: T principal less any burned fee goes to to.
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
    /// @notice A drawn item delivered, with its ticket's request time (its exit for the item ledger).
    event TicketDelivered(uint256 indexed id, address indexed to, uint256 requestedAt, uint256 ticketsAfter);
    /// @notice Once, by `initialize`. `itemLedger` is role 16 or address(0).
    event VaultInitialized(
        address token,
        address collection,
        uint256 collectionSize,
        uint256 firstId,
        address coordinator,
        address ticketAdapter,
        address itemLedger,
        uint256 drawFeeBps,
        uint256 pickFeeBps,
        uint256 returnFeeBps
    );
    /// @notice Emitted when the coordinator opens the vault gate; no funds move.
    event GateOpened(address indexed coordinator, uint256 timestamp);
    /// @notice Emitted when the coordinator waives the T hand-back fee; no funds move.
    event HandBackFeeWaived(address indexed coordinator, uint256 timestamp);
    /// @notice An item-ledger call (its `ILedgerCalls` selector) reverted or ran out of its gas and was skipped.
    event ItemLedgerCallFailed(bytes4 indexed selector, address indexed account, uint256 count);
    /// @notice Emitted on the coordinator failure transition; freezes the quote without moving funds or NFTs.
    event FailureEntered(address indexed coordinator, uint256 timestamp);
    /// @notice Emitted on permissionless recovery of unclaimed NFTs to the creator after failure.
    event ReleasedToCreator(address indexed creator, uint256[] ids);
    /// @notice Reserved item-payout event, not emitted by the NOT_OFFERED entry in this release; no funds move.
    event ItemPayoutForwarded(address indexed token, uint256 amount, address receiver);

    /// @notice The caller supplied a required zero address ; refusal reverts all money movement.
    error ZeroAddress();
    /// @notice The caller is not the fixed coordinator ; refusal reverts all money movement.
    error NotCoordinator(address caller);
    /// @notice The coordinator repeated initialization ; refusal reverts all money movement.
    error AlreadyInitialised();
    /// @notice The caller used an uninitialized vault ; refusal reverts all money movement.
    error NotInitialised();
    /// @notice The coordinator initialized with incorrect NFT custody ; refusal reverts all money movement.
    error CustodyMismatch(uint256 held, uint256 collectionSize);
    /// @notice The caller transaction deadline elapsed ; refusal reverts all money movement.
    error DeadlineExpired(uint256 deadline, uint256 timestamp);
    /// @notice The caller requested an unavailable item count ; refusal reverts all money movement.
    error InvalidQuantity(uint256 count, uint256 available);
    /// @notice The caller tried to take the last item ; refusal reverts all money movement.
    error LastItem();
    /// @notice The caller T input limit is too small ; refusal reverts all money movement.
    error MaxTokenExceeded(uint256 total, uint256 maxTokenIn);
    /// @notice The caller has insufficient T ; refusal reverts all money movement.
    error InsufficientToken(uint256 balance, uint256 total);
    /// @notice The caller requested an ineligible item ; refusal reverts all money movement.
    error IneligibleId(uint256 id);
    /// @notice The caller supplied an invalid list of ids ; refusal reverts all money movement.
    error InvalidIdList();
    /// @notice The caller does not own the returned item ; refusal reverts all money movement.
    error NotOwner(uint256 id);
    /// @notice The caller return is below the quoted unit ; refusal reverts all money movement.
    error ReturnBelowUnit(uint256 principal, uint256 count);
    /// @notice The caller T output minimum is not met ; refusal reverts all money movement.
    error MinTokenNotMet(uint256 net, uint256 minTokenOut);
    /// @notice The caller operation requires more T than escrow holds ; refusal reverts all money movement.
    error EscrowInsolvent(uint256 principal, uint256 escrow);
    /// @notice The caller T transfer was short ; refusal reverts all money movement.
    error TokenNotReceived(uint256 received, uint256 principal);
    /// @notice The caller NFT transfer did not reach custody ; refusal reverts all money movement.
    error ItemNotReceived(uint256 id);
    /// @notice The NFT callback names another collection ; refusal reverts all money movement.
    error ForeignNft(address collection, uint256 id);
    /// @notice The NFT callback is outside an expected return ; refusal reverts all money movement.
    error UnsolicitedItem(address from, uint256 id);
    /// @notice The caller operation requires an open gate ; refusal reverts all money movement.
    error GateClosed();
    /// @notice The coordinator repeated gate opening ; refusal reverts all money movement.
    error GateAlreadyOpen();
    /// @notice The coordinator repeated fee waiver ; refusal reverts all money movement.
    error HandBackFeeAlreadyWaived();
    /// @notice The caller is not the ticket adapter ; refusal reverts all money movement.
    error NotAdapter(address caller);
    /// @notice The caller requested an item still hidden ; refusal reverts all money movement.
    error HiddenItem(uint256 id);
    /// @notice The caller requested an item still unrevealed ; refusal reverts all money movement.
    error NotRevealed(uint256 id);
    /// @notice The adapter requested more hidden items than remain ; refusal reverts all money movement.
    error NoHiddenItem(uint256 count, uint256 hidden);
    /// @notice The adapter has no pending ticket to deliver ; refusal reverts all money movement.
    error NoPendingTicket();
    /// @notice The adapter requested an item outside the hidden set ; refusal reverts all money movement.
    error NotHidden(uint256 id);
    /// @notice Sent with too little gas for the item-ledger call's floor (role 16 set only).
    error ItemLedgerGasTooLow(uint256 gasLeft, uint256 required);
    /// @notice An entry point a later milestone builds (M3's `itemTimes`), refused in M1's release.
    error NOT_OFFERED();
    /// @notice The caller repeated failure ; refusal reverts all money movement.
    error AlreadyFailed();
    /// @notice The caller requested recovery before failure ; refusal reverts all money movement.
    error NotFailed();
    /// @notice `releaseToCreator` named an id that is not inside, or one a kept placeholder still claims.
    error NotReleasable(uint256 id);
    /// @notice `forwardEarned` given T, the collection, or a token with no box-token listing in this release.
    error NotEarnedToken(address token);

    /// @notice The box's coordinator only, once, in createBox: checks custody of N items, writes the counts word.
    function initialize() external;

    // ------------------------------------------------------------------ the coordinator
    /// @notice Graduation: opens deliveries, named picks and returns for good. Once.
    /// @dev Coordinator only at graduation, once; permits item delivery and returns without moving funds.
    function openGate() external;
    /// @notice While the gate is closed, once (F38 (4)).
    /// @dev Coordinator only while gate closed, once; waives future T hand-back fees and moves no funds.
    function waiveHandBackFee() external;
    /// @notice M1-31: once, inside the coordinator's `fail()` or `failClosed()`.
    /// @dev Coordinator only, once; freezes the vault quote and failure window without moving funds or NFTs.
    function enterFailure() external;

    // ------------------------------------------------------------------ the ticket adapter
    /// @dev Ticket adapter only; pulls T principal and fee, escrows principal, burns fee and reserves hidden items.
    function openTickets(uint256 count, uint256 maxTokenIn) external returns (uint256 principal, uint256 fee);
    /// @notice The adapter releases a cancelled draw (`ticketId` > 0, `count` = 1), or a placeholder hand-back
    /// batch (`ticketId` = 0). The vault forwards this identity unchanged to the item ledger (CQ8-1 / R1).
    /// @dev Ticket adapter only; releases reserved items and pays T principal less any burned hand-back fee to to.
    function releaseTickets(uint256 count, address to, uint256 minTokenOut, uint256 ticketId)
        external
        returns (uint256 principal, uint256 fee);
    /// @notice A drawn item to `to`; `requestedAt` is its ticket's request time, which the tickets add-on keeps
    /// (`BoxTickets.sol:58`, `:233`) and the vault hands the item ledger as the item's exit.
    /// @dev Ticket adapter only; delivers the drawn NFT to to. Normal delivery retains T principal in vault escrow.
    /// Only delivery of a kept item after failure reduces escrow and pays its frozen T principal to the creator.
    function deliverTicket(uint256 id, address to, uint256 requestedAt) external;

    // ------------------------------------------------------------------ anyone
    /// @dev Anyone with sufficient approved T; pulls principal and fee, escrows principal, burns fee and transfers the NFT.
    function withdraw(uint256 id, uint256 maxTokenIn, uint256 deadline)
        external
        returns (uint256 principal, uint256 fee);
    /// @dev Anyone with sufficient approved T; pulls aggregate principal and fee, escrows principal, burns fee and transfers the NFTs.
    function withdrawBatch(uint256[] calldata ids, uint256 maxTokenIn, uint256 deadline)
        external
        returns (uint256 principal, uint256 fee);
    /// @dev Item owner; takes the NFT back into custody and pays T principal less burned fee to the caller.
    function returnItem(uint256 id, uint256 minTokenOut, uint256 deadline)
        external
        returns (uint256 principal, uint256 fee);
    /// @dev Item owner; takes the NFTs back into custody and pays aggregate T principal less burned fee to the caller.
    function returnItems(uint256[] calldata ids, uint256 minTokenOut, uint256 deadline)
        external
        returns (uint256 principal, uint256 fee);
    /// @notice M1-31: anyone, after `enterFailure()`, sends inside items nobody kept to the creator, in batches.
    function releaseToCreator(uint256[] calldata ids) external;
    /// @notice Anyone calls this reserved entry; NOT_OFFERED under F122, so no funds move.
    function forwardEarned(address token) external returns (uint256 amount);

    // ------------------------------------------------------------------ wiring and constants
    /// @dev Anyone may read token; no funds move.
    function token() external view returns (address);
    /// @dev Anyone may read collection; no funds move.
    function collection() external view returns (address);
    /// @dev Anyone may read coordinator; no funds move.
    function coordinator() external view returns (address);
    /// @dev Anyone may read coordinatorImplementation; no funds move.
    function coordinatorImplementation() external view returns (address);
    /// @dev Anyone may read ticketAdapter; no funds move.
    function ticketAdapter() external view returns (address);
    /// @notice Registry role 16, or address(0) (every M1 box).
    /// @dev Anyone may read itemLedger; no funds move.
    function itemLedger() external view returns (address);
    /// @notice The item-ledger call's gas cap, at least twice its measured need under `amsterdam` (M3 measures it).
    /// @dev Anyone may read ITEM_LEDGER_GAS; no funds move.
    function ITEM_LEDGER_GAS() external view returns (uint256);
    /// @dev Anyone may read firstId; no funds move.
    function firstId() external view returns (uint256);
    /// @dev Anyone may read drawFeeBps; no funds move.
    function drawFeeBps() external view returns (uint256);
    /// @notice The spec's pick-fee preset (field 31).
    /// @dev Anyone may read pickFeeBps; no funds move.
    function pickFeeBps() external view returns (uint256);
    /// @dev Anyone may read returnFeeBps; no funds move.
    function returnFeeBps() external view returns (uint256);
    /// @dev Anyone may read FEE_DENOMINATOR; no funds move.
    function FEE_DENOMINATOR() external view returns (uint256);

    // ------------------------------------------------------------------ state and quotes (as v1's)
    /// @dev Anyone may read escrowPrincipal; no funds move.
    function escrowPrincipal() external view returns (uint256);
    /// @dev Anyone may read hiddenCount; no funds move.
    function hiddenCount() external view returns (uint256);
    /// @dev Anyone may read pendingTickets; no funds move.
    function pendingTickets() external view returns (uint256);
    /// @dev Anyone may read shelfCount; no funds move.
    function shelfCount() external view returns (uint256);
    /// @dev Anyone may read outside; no funds move.
    function outside() external view returns (uint256);
    /// @dev Anyone may read gateOpen; no funds move.
    function gateOpen() external view returns (bool);
    /// @dev Anyone may read gateOpenedAt; no funds move.
    function gateOpenedAt() external view returns (uint256);
    /// @dev Anyone may read handBackFeeWaived; no funds move.
    function handBackFeeWaived() external view returns (bool);
    /// @dev Anyone may read failed; no funds move.
    function failed() external view returns (bool);
    /// @dev Anyone may read activeSupply; no funds move.
    function activeSupply() external view returns (uint256);
    /// @dev Anyone may read unsolicitedToken; no funds move.
    function unsolicitedToken() external view returns (uint256);
    /// @dev Anyone may read quoteWithdraw; no funds move.
    function quoteWithdraw(uint256 count) external view returns (uint256);
    /// @dev Anyone may read quoteReturn; no funds move.
    function quoteReturn(uint256 count) external view returns (uint256);
    /// @dev Anyone may read quoteTake; no funds move.
    function quoteTake(uint256 count) external view returns (uint256 principal, uint256 fee);
    /// @dev Anyone may read quoteHandBack; no funds move.
    function quoteHandBack(uint256 count) external view returns (uint256 principal, uint256 fee);
    /// @dev Anyone may read escrowSurplus; no funds move.
    function escrowSurplus() external view returns (uint256 kFloor, uint256 kRemainder);
    /// @dev Anyone may read isOutside; no funds move.
    function isOutside(uint256 id) external view returns (bool);
    /// @dev Anyone may read isInside; no funds move.
    function isInside(uint256 id) external view returns (bool);
    /// @dev Anyone may read hasLeftVault; no funds move.
    function hasLeftVault(uint256 id) external view returns (bool);
    /// @dev Anyone may read isHidden; no funds move.
    function isHidden(uint256 id) external view returns (bool);
    /// @dev Anyone may read isOnShelf; no funds move.
    function isOnShelf(uint256 id) external view returns (bool);
    /// @notice M3: the item's last exit and entry time (0: none yet); M1 refuses it (`NOT_OFFERED`).
    /// @dev Anyone may read itemTimes; no funds move.
    function itemTimes(uint256 id) external view returns (uint64 lastExit, uint64 lastEntry);
}

/// @notice S3: immutable custody journal record, readable by anyone; the fields themselves move no funds.
struct ItemLifecycleV2 {
    /// @notice Exact adapter key for Request/Deliver/Cancel; zero for named Withdraw/Return/FailureRelease.
    bytes32 ticketKey;
    /// @notice Zero for Request/Cancel; actual collection id for Deliver and named movements.
    uint256 itemId;
    /// @notice Last published receiver itemFundingCount before this operation; determines cross-journal order.
    uint256 fundingCursor;
    /// @notice Operation timestamp as metadata, never identity/order; itemTimes retains its existing time semantics.
    uint64 at;
    /// @notice 1 Request, 2 Deliver, 3 Cancel, 4 Withdraw, 5 Return, 6 FailureRelease; zero is invalid.
    uint8 kind;
}

/// @notice S3 declared companion for M3 vault history; existing IBoxVaultV2 and its implementations stay buildable.
/// @dev M3-22 appends consecutive sequences from 1 before each unchanged ledger notice; never rewrites history.
/// Authenticate the fixed adapter's bounded, nonzero/distinct keys. Validate inputs before notices and commit
/// custody/counts before any user-controlled token/NFT callback. Reverts roll back records and custody together;
/// a fully funded failed notice preserves the record for exact replay. ITEM_LEDGER_GAS and its gas-floor/skip
/// discipline stay unchanged. No role 16 means no added journal/timestamp writes, context work or notice cost.
/// This journal supersedes timestamp-only missed-notice inference for M3; itemTimes' selector remains unchanged.
interface IBoxVaultItemsV2 {
    /// @notice Anyone reads the last committed lifecycle sequence (zero initially); no funds move.
    function itemLifecycleCount() external view returns (uint256);
    /// @notice Anyone reads a committed operation; zero or a sequence above itemLifecycleCount reverts. No funds move.
    function itemLifecycle(uint256 sequence) external view returns (ItemLifecycleV2 memory);
    /// @notice Anyone reads the M3 operation batch bound, initially 1; no funds move.
    /// @dev Enforce only with role 16, for requests, handBacks, named batches, deliveries and failure releases.
    /// Other boxes keep their existing batch bounds. Later increases require measured headroom on both EVMs.
    function ITEM_BATCH_MAX() external view returns (uint256);
    /// @notice A caller's item-enabled batch exceeds its bound; revert the entire operation and all money movement.
    error ItemBatchTooLarge(uint256 count, uint256 max);
    /// @notice Vault custody transition records exact identity/order; this event itself transfers nothing.
    event ItemLifecycleRecorded(uint256 indexed sequence, bytes32 indexed ticketKey,
        uint256 indexed itemId, uint256 fundingCursor, uint64 at, uint8 kind);
}
