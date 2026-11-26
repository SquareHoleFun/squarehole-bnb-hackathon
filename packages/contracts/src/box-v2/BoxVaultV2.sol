// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VaultViews} from "./libraries/VaultViews.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxCloneBase} from "../box/BoxCloneBase.sol";
import {IBoxCollection, IERC721TokenReceiver} from "../box/interfaces/IBoxCollection.sol";
import {IBoxCoordinator} from "../box/interfaces/IBoxCoordinator.sol";
import {IBoxTickets} from "../box/interfaces/IBoxTickets.sol";
import {IBoxSupplyFloor, IBoxToken} from "../box/interfaces/IBoxToken.sol";
import {BoxClones} from "../box/libraries/BoxClones.sol";
import {BoxIdSet} from "../box/libraries/BoxIdSet.sol";
import {IBoxVaultV2, IBoxVaultItemsV2, ItemLifecycleV2} from "./interfaces/IBoxVaultV2.sol";
import {IBoxTicketsItemsV2} from "./interfaces/IBoxPeripheryV2.sol";
import {IBoxReceiverItemsV2} from "./interfaces/IBoxReceiverV2.sol";
import {ItemTimes} from "./libraries/ItemTimes.sol";
import {IItemLedgerCalls} from "./interfaces/ILedgerCalls.sol";
import {BoxVaultV2Args as A} from "./libraries/BoxVaultV2Args.sol";
import {VaultFailure} from "./libraries/VaultFailure.sol";
import {BoxVaultV2LaterStubs} from "./stubs/BoxVaultV2LaterStubs.sol";

/// @title BoxVaultV2 (core v2 M1, ticket M1-30-b; the implementation of every v2 box's vault clone)
/// @notice v1's supply-share vault (`BoxVault.sol`, copied, never edited; ADR-0017 § 10) with `IBoxVaultV2`'s changes:
/// - **The pick fee is the spec's preset** (field 31: 100, 500 or 2,500 bps), a clone argument (`BoxVaultV2Args`);
///   draws (1%) and returns (5%) are fixed for every v2 box, so they are constants here (BC-235).
/// - **The count integral** (`IBoxVaultCountV2`; BC-232, F89): the item-seconds of n since `initialize`, kept with the
///   time of its last change in the one counts word, so an entry or exit writes no new slot. A draw counts as outside
///   from its request (tickets opened lower n at once), as v1's.
/// - **The item ledger at registry role 16** (`itemLedger()`, M3) replaces v1's observer: the five `IItemLedgerCalls`
///   calls, after validated counts/escrow/bits and the S3 journal commit, before external transfers:
///   tickets opened and released with their counts (`openTickets`, `releaseTickets`), a named pick and a return with
///   their ids (`withdraw*`, `return*`), a drawn item's delivery with its id and its ticket's request time
///   (`deliverTicket`, which v1 called nobody at). Each is fail-safe as v1's observer (`BoxVault.sol:621-634`): exactly
///   `ITEM_LEDGER_GAS` behind a `gasleft()` floor of cap + cap/63 + overhead (`ItemLedgerGasTooLow`), no return data, a
///   revert or out-of-gas skipped and reported (`ItemLedgerCallFailed`); the action happens either way. With role 16
///   unset (every M1 box) the call is skipped and costs no slot.
/// - **Failure** (M1-31 writes `VaultFailure`): the coordinator's `enterFailure()` once, inside its `fail()`, and only
///   before graduation (a graduated vault refuses it, a failed one refuses `openGate`); then anyone sends inside items
///   to the creator through `releaseToCreator`, in batches. The vault keeps its own failed flag in the counts word (the
///   swap-free paths read it in the slot they already read). `enterFailure` freezes the hand-back quote q = ⌊A ÷ n⌋
///   from A and n read before any of the failure's burns (`failed-launch-recovery.md:427`; review round 2, H1). After
///   it no price reads the live A or n: a hand-back of k pays k·q with no fee (`quoteReturn` prices the same), the
///   escrow surplus is E − t·q, fixed from step 1 whatever the failure's burns and the releases do, and takes and
///   named picks are not quoted (`AlreadyFailed`). F114 R28B limits ordinary hand-backs to 14 days. The tickets then
///   assign kept slots with one shared word: only unassigned items may go to the creator, and opening a kept item
///   pays its frozen quote from escrow to the creator. Failure-terminal cancellations have no expiry; the creator
///   can recover all items, with releases of reserved items counted against later cancellations. No new ticket is
///   taken, the graduation gate stays shut, and n may reach 0.
/// - **Item history**: role 16 enables one-entry batches, exact adapter keys and an append-only recovery journal.
///   No role 16 means no history writes. Deferred `forwardEarned` still refuses (`NOT_OFFERED`).
/// - No owner, admin, pause, upgrade, mint, sweep or rescue. T leaves only as a return's or a released ticket's
///   principal (less the fee it burns), or a kept failure item's frozen payment to the creator, never above E;
///   the vault approves nobody.
/// @dev Symbols and invariants as v1's (`BoxVault.sol:22-44`): T balance == E; E·n ≥ m·A until a failure, and E ≥ t·q
/// after it (`failed-launch-recovery.md:427`); E + n ≤ S; n ≥ 1 in the vault until a failure; n + t + (outside items,
/// the released ones included) == N (subtract `_releasedFailureReserves` in failure terminal mode); h ≤ n.
/// Checks, effects, interactions under a transient lock. An uninitialised
/// clone (its counts' time 0) refuses every entry point. Written for Square Hole (MIT; FullMath is the pinned Uniswap
/// v4-core library, MIT).
contract BoxVaultV2 is BoxVaultV2LaterStubs, IBoxVaultItemsV2, BoxCloneBase, TransientReentrancyGuard {
    /// @notice Preserve the existing ABI error, now bubbled by the stateless inverse permutation.
    error EmptyDomain();

    /// @notice A kept failure placeholder opened: its frozen principal paid to the immutable creator.
    event FailureItemPaid(address indexed creator, uint256 indexed id, uint256 principal);

    /// @dev n, h, t, the graduation time, the integral's time, the flags and the integral in one slot: a conversion
    /// reads and writes them together. 32-bit counts (N ≤ 10,000, field 8); 72 bits of item-seconds hold 10,000 items
    /// for 4.7e13 seconds.
    struct Counts {
        uint32 inside;
        uint32 hidden;
        uint32 tickets;
        uint40 gateOpenedAt;
        /// The time of the integral's last change; non-zero once initialised.
        uint40 since;
        uint8 flags;
        uint72 integral;
    }

    uint8 private constant _FAILED = 1;
    uint8 private constant _HAND_BACK_FEE_WAIVED = 2;

    /// @notice Basis points in 100%.
    uint256 public constant FEE_DENOMINATOR = 10_000;
    /// @notice Draws pay 1% and returns 5% in every v2 box (BC-235); the named pick's fee is the box's preset.
    uint256 private constant _DRAW_FEE_BPS = 100;
    uint256 private constant _RETURN_FEE_BPS = 500;
    /// @notice The item-ledger call's gas cap [P until M3 measures it, `IBoxVaultV2`]. v1's observer cap (460,000,
    /// `BoxVault.sol:57`) does not cover the kit's role-16 mock under `amsterdam`: its healthy `onWithdrawn` writes 8
    /// new slots, 180,869 gas on the default EVM and over 460,000 under `amsterdam`'s state gas. No M1 box pays it
    /// (role 16 is unset), so M1 keeps 1,000,000 and M3 sets the measured value (at least twice its need).
    uint256 public constant ITEM_LEDGER_GAS = 1_000_000;
    /// @dev Retain gas for custody transfers and the adapter's reveal/randomness continuation after a full-cap sink.
    /// M3-22 tests the one-gas activation boundary on both forks; M3-60 owns complete release remeasurement.
    uint256 private constant _ITEM_LEDGER_RESERVE_GAS = 1_200_000;
    uint256 private constant _ITEM_LEDGER_GAS_REQUIRED =
        ITEM_LEDGER_GAS + ITEM_LEDGER_GAS / 63 + _ITEM_LEDGER_RESERVE_GAS + 10_000;
    /// @inheritdoc IBoxVaultItemsV2
    uint256 public constant ITEM_BATCH_MAX = 1;

    /// @inheritdoc IBoxVaultV2
    address public immutable coordinatorImplementation;
    VaultViews private immutable _views;

    /// @notice E: T locked by withdrawals and tickets and not yet released. The vault's T balance is exactly E.
    uint256 public escrowPrincipal;
    Counts private _counts;
    /// @dev Two bits per item, 128 per word, at offset = id − firstId (v1's, `BoxVault.sol:68-71`): bit 2·(offset mod
    /// 128) is set while the item is outside; the bit above it once it has ever left, for good.
    mapping(uint256 => uint256) private _states;
    /// @dev Failure-terminal items released ahead of their placeholders' cancellations. A later cancellation
    /// consumes this count instead of restoring an item already sent to the creator.
    uint256 private _releasedFailureReserves;
    ItemTimes.State private _items;

    /// @dev Transient: 1 + the id the vault is pulling in a return. `uint256(keccak256("squarehole.v2.vault.receipt")) - 1`.
    uint256 private constant _RECEIPT_SLOT = 0x04cf8946f2dae14b7f2dfd614da2d9d8db1297e5334c4922ce7ac28db7ba4306;
    /// @dev Seed of the transient set behind a return's duplicate check. `uint256(keccak256("squarehole.v2.vault.seen")) - 1`.
    uint256 private constant _SEEN_SEED = 0xe91539de3004cb9fa2f285223a7d00d42fa83550255be61d847ef861d4e3e6fb;

    // ------------------------------------------------------------------------------------------------------------
    // Initialise

    /// @param coordinatorImplementation_ the release's coordinator implementation: only its clones may initialise.
    constructor(address coordinatorImplementation_) {
        coordinatorImplementation = coordinatorImplementation_;
        _views = new VaultViews();
    }

    /// @inheritdoc IBoxVaultV2
    function initialize() external {
        if (msg.sender != coordinator() || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert NotCoordinator(msg.sender);
        }
        if (_counts.since != 0) revert AlreadyInitialised();
        uint256 n = collectionSize();
        uint256 first = firstId();
        address c = collection();
        // N ≥ 1 and both ends of firstId … firstId + N − 1 held (BoxVault.sol:97-106).
        uint256 held = IBoxCollection(c).balanceOf(address(this));
        if (n == 0 || held != n) revert CustodyMismatch(held, n);
        if (
            IBoxCollection(c).ownerOf(first) != address(this)
                || IBoxCollection(c).ownerOf(first + (n - 1)) != address(this)
        ) {
            revert CustodyMismatch(held, n);
        }
        address adapter = ticketAdapter();
        // casting to 'uint32' is safe because the argument is four bytes wide
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 n32 = uint32(n);
        _counts = Counts({
            inside: n32,
            hidden: adapter == address(0) ? 0 : n32,
            tickets: 0,
            gateOpenedAt: 0,
            since: _now(),
            flags: 0,
            integral: 0
        });
        emit VaultInitialized(
            token(), c, n, first, msg.sender, adapter, itemLedger(), _DRAW_FEE_BPS, pickFeeBps(), _RETURN_FEE_BPS
        );
    }

    // ------------------------------------------------------------------------------------------------------------
    // The coordinator: the phase gate (F30 Q3, F36 a) and the failure (M1-31)

    /// @inheritdoc IBoxVaultV2
    /// @dev A failed box never graduates (`AlreadyFailed`).
    function openGate() external {
        if (msg.sender != coordinator()) revert NotCoordinator(msg.sender);
        Counts memory c = _initialised();
        if (c.gateOpenedAt != 0) revert GateAlreadyOpen();
        if (c.flags & _FAILED != 0) revert AlreadyFailed();
        c.gateOpenedAt = _now();
        _storeCounts(c);
        emit GateOpened(msg.sender, block.timestamp);
    }

    /// @inheritdoc IBoxVaultV2
    function waiveHandBackFee() external {
        if (msg.sender != coordinator()) revert NotCoordinator(msg.sender);
        Counts memory c = _initialised();
        if (c.gateOpenedAt != 0) revert GateAlreadyOpen();
        if (c.flags & _HAND_BACK_FEE_WAIVED != 0) revert HandBackFeeAlreadyWaived();
        c.flags |= _HAND_BACK_FEE_WAIVED;
        _storeCounts(c);
        emit HandBackFeeWaived(msg.sender, block.timestamp);
    }

    /// @inheritdoc IBoxVaultV2
    /// @dev The shell's part (`VaultFailure.enter`'s note): the caller, `AlreadyFailed` and graduation (a box fails only
    /// with its curve open, `GateAlreadyOpen` after it, so every outside item of a failed box is a pending ticket, which
    /// the hidden count relies on), the quote frozen from the A and n of step 1, before any of the failure's burns
    /// (n ≥ 1: a ticket never takes the last item; A ≥ n by the floor, so q ≥ 1), and the flag. The library's body is
    /// M1-31's, and it emits `FailureEntered` (M1-31's body at `fec72b4c`), so the shell does not (change request 15).
    function enterFailure() external {
        if (msg.sender != coordinator()) revert NotCoordinator(msg.sender);
        Counts memory c = _initialised();
        if (c.flags & _FAILED != 0) revert AlreadyFailed();
        if (c.gateOpenedAt != 0) revert GateAlreadyOpen();
        VaultFailure.enter(activeSupply(), c.inside);
        c.flags |= _FAILED;
        _storeCounts(c);
    }

    /// @inheritdoc IBoxVaultV2
    /// @dev The shell's part (`VaultFailure.release`'s note): each id inside and released once (`NotReleasable`), at
    /// most n of them (the t items still in the vault for kept placeholders stay), the counts first; the library hands
    /// the items to the coordinator's creator (M1-31). n falls (the integral, the views and the floor count items in
    /// the vault); it reads no quote, so E stays behind exactly the pending tickets at the frozen quote. With pending
    /// placeholders, no release is allowed before assignment, then only permutation positions outside [0, slots).
    /// Failure terminal mode instead allows all remaining items, even before holders cancel their placeholders.
    function releaseToCreator(uint256[] calldata ids) external nonReentrant {
        Counts memory c = _loadCounts();
        if (c.flags & _FAILED == 0) revert NotFailed();
        uint256 k = ids.length;
        _checkItemBatch(k);
        IBoxTickets.TicketState memory s;
        if (c.tickets != 0) s = IBoxTickets(ticketAdapter()).status();
        bool terminal = s.terminalAt != 0;
        uint256 available = c.inside + (terminal ? c.tickets - _releasedFailureReserves : 0);
        if (k == 0 || k > available) revert InvalidQuantity(k, available);
        for (uint256 i; i < k; ++i) {
            (uint256 offset, bool ok) = _offset(ids[i]);
            if (!ok) revert NotReleasable(ids[i]);
            if (c.tickets != 0 && !terminal) {
                if (s.wordAcceptedAt == 0) revert NotReleasable(ids[i]);
                uint256 position =
                    _views.invert(IBoxTickets(ticketAdapter()).graduationWord(), offset, collectionSize());
                if (position < s.slots) revert NotReleasable(ids[i]);
            }
            uint256 slot = offset >> 7;
            uint256 shift = (offset & 0x7f) << 1;
            uint256 word = _states[slot];
            // Outside, or listed twice in this batch; it leaves for good (outside and "has left").
            if ((word >> shift) & 1 != 0) revert NotReleasable(ids[i]);
            _states[slot] = word | (3 << shift);
        }
        uint256 free = k > c.inside ? c.inside : k;
        _releasedFailureReserves += k - free;
        _move(c, false, free);
        // The unassigned stock stays hidden; only kept items can have been delivered since failure.
        if (c.hidden > c.inside) c.hidden = c.inside;
        _storeCounts(c);
        if (itemLedger() != address(0)) _itemRecord(6, ids[0], 0);
        VaultFailure.release(collection(), IBoxCoordinator(coordinator()).creator(), ids);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Tickets (the adapter only; BoxVault.sol:144-221)

    /// @inheritdoc IBoxVaultV2
    function openTickets(uint256 count, uint256 maxTokenIn)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        address adapter = ticketAdapter();
        if (msg.sender != adapter) revert NotAdapter(msg.sender); // no adapter: nobody
        Counts memory c = _initialised();
        if (c.flags & _FAILED != 0) revert AlreadyFailed();
        _checkItemBatch(count);
        uint256 e = escrowPrincipal;
        uint256 supply = _token().totalSupply();
        principal = _quoteWithdraw(count, c.inside, supply - e);
        if (count > c.hidden) revert NoHiddenItem(count, c.hidden);
        fee = _fee(principal, _DRAW_FEE_BPS);
        _checkPayment(principal + fee, maxTokenIn);
        uint256 insideBefore = c.inside;
        escrowPrincipal = e + principal; // ≤ S: principal ≤ A
        _move(c, false, count);
        // casting to 'uint32' is safe because count ≤ h ≤ n < 2^32 and t + count ≤ N < 2^32
        // forge-lint: disable-next-line(unsafe-typecast)
        (c.hidden, c.tickets) = (c.hidden - uint32(count), c.tickets + uint32(count));
        _storeCounts(c);
        _itemRecord(1, 0, 0);
        _ledger(abi.encodeCall(IItemLedgerCalls.onTicketsOpened, (count, insideBefore)), adapter, count);
        emit TicketsOpened(count, principal, fee, supply - fee, e + principal, c.inside, c.hidden, c.tickets);

        _pullToken(msg.sender, principal + fee);
        _burnFee(fee);
    }

    /// @inheritdoc IBoxVaultV2
    function releaseTickets(uint256 count, address to, uint256 minTokenOut, uint256 ticketId)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        if (msg.sender != ticketAdapter()) revert NotAdapter(msg.sender);
        if (to == address(0)) revert ZeroAddress();
        Counts memory c = _initialised();
        if (count == 0 || count > c.tickets) revert InvalidQuantity(count, c.tickets);
        _checkItemBatch(count);
        uint256 e = escrowPrincipal;
        uint256 supply = _token().totalSupply();
        (principal, fee) = _handBack(c, count, supply - e);
        if (principal - fee < minTokenOut) revert MinTokenNotMet(principal - fee, minTokenOut);
        if (principal > e) revert EscrowInsolvent(principal, e);
        uint256 insideBefore = c.inside;
        uint256 escrowAfter = e - principal;
        escrowPrincipal = escrowAfter;
        uint256 restored = count;
        if (_releasedFailureReserves != 0) {
            uint256 released = count > _releasedFailureReserves ? _releasedFailureReserves : count;
            _releasedFailureReserves -= released;
            restored -= released;
        }
        _move(c, true, restored);
        // casting to 'uint32' is safe because count ≤ t and n + t ≤ N < 2^32
        // forge-lint: disable-next-line(unsafe-typecast)
        (c.hidden, c.tickets) = (c.hidden + uint32(restored), c.tickets - uint32(count));
        _storeCounts(c);
        _itemRecord(3, 0, 0);
        _ledger(abi.encodeCall(IItemLedgerCalls.onTicketsReleased, (to, count, insideBefore, ticketId)), to, count);
        emit TicketsReleased(to, count, principal, fee, supply - fee, escrowAfter, c.inside, c.hidden, c.tickets);

        _burnFee(fee);
        if (!_token().transfer(to, principal - fee)) revert TokenNotReceived(0, principal - fee);
    }

    /// @inheritdoc IBoxVaultV2
    function deliverTicket(uint256 id, address to, uint256 requestedAt) external nonReentrant {
        if (msg.sender != ticketAdapter()) revert NotAdapter(msg.sender);
        Counts memory c = _initialised();
        bool failure = c.flags & _FAILED != 0;
        if (failure) {
            IBoxTickets.TicketState memory s = IBoxTickets(msg.sender).status();
            if (s.wordAcceptedAt == 0 || s.terminalAt != 0) revert GateClosed();
        } else if (c.gateOpenedAt == 0) {
            revert GateClosed();
        }
        if (c.tickets == 0) revert NoPendingTicket();
        if (to == address(0)) revert ZeroAddress();
        (uint256 offset, bool ok) = _offset(id);
        if (!ok) revert IneligibleId(id);
        uint256 slot = offset >> 7;
        uint256 shift = (offset & 0x7f) << 1;
        uint256 word = _states[slot];
        if ((word >> shift) & 3 != 0) revert NotHidden(id);
        _states[slot] = word | (3 << shift);
        uint256 principal;
        if (failure) {
            principal = VaultFailure.quoteAtFailure(1);
            escrowPrincipal -= principal;
        }
        --c.tickets;
        _storeCounts(c);
        _itemRecord(2, id, requestedAt);
        // The authenticated adapter keeps request times in 40 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        _ledger(abi.encodeCall(IItemLedgerCalls.onDelivered, (id, to, uint64(requestedAt))), to, 1);
        emit TicketDelivered(id, to, requestedAt, c.tickets);

        IBoxCollection(collection()).safeTransferFrom(address(this), to, id);
        if (failure) {
            address creator = IBoxCoordinator(coordinator()).creator();
            if (!_token().transfer(creator, principal)) revert TokenNotReceived(0, principal);
            emit FailureItemPaid(creator, id, principal);
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Named picks and returns

    /// @inheritdoc IBoxVaultV2
    function withdraw(uint256 id, uint256 maxTokenIn, uint256 deadline)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        return _withdraw(_one(id), maxTokenIn, deadline);
    }

    /// @inheritdoc IBoxVaultV2
    function withdrawBatch(uint256[] calldata ids, uint256 maxTokenIn, uint256 deadline)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        return _withdraw(ids, maxTokenIn, deadline);
    }

    /// @inheritdoc IBoxVaultV2
    function returnItem(uint256 id, uint256 minTokenOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        return _return(_one(id), minTokenOut, deadline);
    }

    /// @inheritdoc IBoxVaultV2
    function returnItems(uint256[] calldata ids, uint256 minTokenOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        return _return(ids, minTokenOut, deadline);
    }

    /// @notice Accepts an item only while this vault pulls it in a return it started (BoxVault.sol:262-274).
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata)
        external
        view
        returns (bytes4)
    {
        if (msg.sender != collection()) revert ForeignNft(msg.sender, tokenId);
        if (operator == address(this) && _isPendingReceipt(tokenId)) {
            return IERC721TokenReceiver.onERC721Received.selector;
        }
        revert UnsolicitedItem(from, tokenId);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views

    /// @inheritdoc IBoxVaultItemsV2
    function itemLifecycleCount() external view returns (uint256) {
        return _items.operations.length;
    }

    /// @inheritdoc IBoxVaultItemsV2
    function itemLifecycle(uint256 sequence) external view returns (ItemLifecycleV2 memory) {
        return ItemTimes.operation(_items, sequence);
    }

    /// @inheritdoc IBoxVaultV2
    function itemTimes(uint256 id) external view override returns (uint64 lastExit, uint64 lastEntry) {
        ItemTimes.Times storage t = _items.times[id];
        return (t.lastExit, t.lastEntry);
    }

    /// @inheritdoc IBoxSupplyFloor
    /// @dev v1's E + n, with n the items in the vault, after a failure too: no price reads A then, and a release only
    /// lowers it, so it refuses none of the failure's burns that a higher floor would allow.
    function supplyFloor() external view returns (uint256) {
        return escrowPrincipal + _counts.inside; // E + n ≤ S because A ≥ n (0 before initialize)
    }

    function inside() public view returns (uint256) {
        return _counts.inside;
    }

    /// @notice The integral of n since `initialize`, carried to now (`IBoxVaultCountV2`).
    function insideIntegral() external view returns (uint256 integral, uint256 timestamp) {
        Counts memory c = _loadCounts();
        if (c.since == 0) return (0, block.timestamp);
        return (_advance(c.integral, c.since, c.inside, block.timestamp), block.timestamp);
    }

    function hiddenCount() external view returns (uint256) {
        return _counts.hidden;
    }

    function pendingTickets() external view returns (uint256) {
        return _counts.tickets;
    }

    function shelfCount() external view returns (uint256) {
        Counts memory c = _loadCounts();
        return c.inside - c.hidden;
    }

    function outside() external view returns (uint256) {
        return collectionSize() - _counts.inside;
    }

    function gateOpen() external view returns (bool) {
        return _counts.gateOpenedAt != 0;
    }

    function gateOpenedAt() external view returns (uint256) {
        return _counts.gateOpenedAt;
    }

    function handBackFeeWaived() external view returns (bool) {
        return _counts.flags & _HAND_BACK_FEE_WAIVED != 0;
    }

    function failed() external view returns (bool) {
        return _counts.flags & _FAILED != 0;
    }

    /// @notice F114 R28B: ordinary failed hand-backs are allowed strictly before this time; zero before failure.
    function failureWindowEnds() external view returns (uint256) {
        return VaultFailure.windowEnds();
    }

    function activeSupply() public view returns (uint256) {
        return _token().totalSupply() - escrowPrincipal;
    }

    function unsolicitedToken() external view returns (uint256) {
        return _token().balanceOf(address(this)) - escrowPrincipal;
    }

    /// @dev After a failure: `AlreadyFailed` (no named pick can happen, and no price reads the live A or n).
    function quoteWithdraw(uint256 count) external view returns (uint256) {
        Counts memory c = _loadCounts();
        if (c.flags & _FAILED != 0) revert AlreadyFailed();
        return _quoteWithdraw(count, c.inside, activeSupply());
    }

    /// @dev After a failure, `count` of the t open tickets at the frozen quote (no return can happen then).
    function quoteReturn(uint256 count) external view returns (uint256) {
        Counts memory c = _loadCounts();
        if (c.flags & _FAILED != 0) return _atFailure(count, c.tickets);
        return _quoteReturn(count, c.inside, collectionSize() - c.inside, activeSupply());
    }

    /// @dev After a failure: `AlreadyFailed` (no ticket opens).
    function quoteTake(uint256 count) external view returns (uint256 principal, uint256 fee) {
        _checkItemBatch(count);
        Counts memory c = _loadCounts();
        if (c.flags & _FAILED != 0) revert AlreadyFailed();
        principal = _quoteWithdraw(count, c.inside, activeSupply());
        if (count > c.hidden) revert NoHiddenItem(count, c.hidden);
        fee = _fee(principal, _DRAW_FEE_BPS);
    }

    function quoteHandBack(uint256 count) external view returns (uint256 principal, uint256 fee) {
        Counts memory c = _loadCounts();
        if (count == 0 || count > c.tickets) revert InvalidQuantity(count, c.tickets);
        (principal, fee) = _handBack(c, count, activeSupply());
    }

    /// @dev After a failure, K = E − t·q exactly (`kRemainder` 0): a hand-back lowers E by q and t by one, so K stays
    /// what step 1 left, the `tExcluded` part `fail()` reads in step 4 whatever burns came before or after its read.
    function escrowSurplus() external view returns (uint256 kFloor, uint256 kRemainder) {
        Counts memory c = _loadCounts();
        uint256 e = escrowPrincipal;
        if (c.flags & _FAILED != 0) {
            return VaultFailure.surplusAtFailure(e, c.tickets);
        }
        uint256 n = c.inside;
        uint256 m = collectionSize() - n;
        uint256 a = activeSupply();
        // E·n ≥ m·A, so E ≥ ⌈m·A/n⌉ and nothing below underflows.
        return _views.surplus(e, m, a, n);
    }

    function isOutside(uint256 id) public view returns (bool) {
        (uint256 bits, bool ok) = _bits(id);
        return ok && bits & 1 != 0;
    }

    function isInside(uint256 id) external view returns (bool) {
        (uint256 bits, bool ok) = _bits(id);
        return ok && bits & 1 == 0;
    }

    function hasLeftVault(uint256 id) external view returns (bool) {
        (uint256 bits, bool ok) = _bits(id);
        return ok && bits & 2 != 0;
    }

    function isHidden(uint256 id) external view returns (bool) {
        (uint256 bits, bool ok) = _bits(id);
        return ok && bits == 0 && ticketAdapter() != address(0);
    }

    function isOnShelf(uint256 id) external view returns (bool) {
        (uint256 bits, bool ok) = _bits(id);
        return ok && (bits == 2 || (bits == 0 && ticketAdapter() == address(0)));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Wiring (clone arguments, `BoxVaultV2Args`) and constants

    function token() public view returns (address) {
        return _argAddress(A.TOKEN);
    }

    function collection() public view returns (address) {
        return _argAddress(A.COLLECTION);
    }

    function coordinator() public view returns (address) {
        return _argAddress(A.COORDINATOR);
    }

    function ticketAdapter() public view returns (address) {
        return _argAddress(A.TICKET_ADAPTER);
    }

    function itemLedger() public view returns (address) {
        return _argAddress(A.ITEM_LEDGER);
    }

    function collectionSize() public view returns (uint256) {
        return _argUint(A.COLLECTION_SIZE, 4);
    }

    function firstId() public view returns (uint256) {
        return uint256(_argWord(A.FIRST_ID));
    }

    function drawFeeBps() external pure returns (uint256) {
        return _DRAW_FEE_BPS;
    }

    function pickFeeBps() public view returns (uint256) {
        return _argUint(A.PICK_FEE_BPS, 2);
    }

    function returnFeeBps() external pure returns (uint256) {
        return _RETURN_FEE_BPS;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals (BoxVault.sol:456-686)

    function _token() private view returns (IBoxToken) {
        return IBoxToken(token());
    }

    /// @dev The counts of an initialised vault; an uninitialised clone (and the implementation) reverts.
    function _initialised() private view returns (Counts memory c) {
        c = _loadCounts();
        if (c.since == 0) revert NotInitialised();
    }

    /// @dev The block time in 40 bits.
    function _now() private view returns (uint40) {
        // casting to 'uint40' is safe because block timestamps stay below 2^40 for another 34,000 years
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint40(block.timestamp);
    }

    /// @dev A hand-back of `count` tickets at active supply `a`: v1's quote and the hand-back fee until a failure;
    /// after it the quote frozen at the failure with no fee during the 14-day window (F114 R28B), so the failure's
    /// own burns and the releases move no ticket holder's principal, and no fee's burn takes T counted as outstanding.
    function _handBack(Counts memory c, uint256 count, uint256 a)
        private
        view
        returns (uint256 principal, uint256 fee)
    {
        if (c.flags & _FAILED != 0) return (_atFailure(count, c.tickets), 0);
        principal = _quoteReturn(count, c.inside, collectionSize() - c.inside, a);
        fee = _handBackFee(c, principal);
    }

    /// @dev `count` of the `tickets` open at the quote frozen at the failure (M1-31's `VaultFailure.quoteAtFailure`).
    function _atFailure(uint256 count, uint256 tickets) private view returns (uint256) {
        if (count == 0 || count > tickets) revert InvalidQuantity(count, tickets);
        bool terminal =
            block.timestamp >= VaultFailure.windowEnds() && IBoxTickets(ticketAdapter()).status().terminalAt != 0;
        VaultFailure.checkHandBack(terminal);
        return VaultFailure.quoteAtFailure(count);
    }

    /// @dev n changes by `k` (in or out): the integral is carried to now at the old n first (`IBoxVaultCountV2`).
    function _move(Counts memory c, bool entering, uint256 k) private view {
        // casting to 'uint72' is safe because n ≤ 10,000 for at most 2^40 seconds is below 2^54
        // forge-lint: disable-next-line(unsafe-typecast)
        c.integral = uint72(_advance(c.integral, c.since, c.inside, block.timestamp));
        c.since = _now();
        // casting to 'uint32' is safe because k ≤ N < 2^32 (every caller bounds it by the counts)
        // forge-lint: disable-next-line(unsafe-typecast)
        c.inside = entering ? c.inside + uint32(k) : c.inside - uint32(k);
    }

    /// @dev `VaultCountIntegral.advance`'s rule (M1-40-a's library, frozen as a stub): the integral carried from `since`
    /// to `at` at n items inside. Kept here while that stub reverts, since every count change runs it and M1-30 merges
    /// before M1-40 (change request 5 in docs/evidence/SH-V2-M1-30B.md).
    function _advance(uint256 integral, uint256 since, uint256 n, uint256 at) private pure returns (uint256) {
        return integral + n * (at - since);
    }

    function _withdraw(uint256[] memory ids, uint256 maxTokenIn, uint256 deadline)
        private
        returns (uint256 principal, uint256 fee)
    {
        Counts memory c = _initialised();
        if (c.gateOpenedAt == 0) revert GateClosed();
        _checkDeadline(deadline);
        uint256 k = ids.length;
        _checkItemBatch(k);
        uint256 e = escrowPrincipal;
        uint256 supply = _token().totalSupply();
        principal = _quoteWithdraw(k, c.inside, supply - e);
        fee = _fee(principal, pickFeeBps());
        _checkPayment(principal + fee, maxTokenIn);
        IBoxCollection items = IBoxCollection(collection());
        _markShelfOutside(items, ids);
        escrowPrincipal = e + principal; // ≤ S: principal ≤ A
        _move(c, false, k);
        _storeCounts(c);
        if (itemLedger() != address(0)) _itemRecord(4, ids[0], 0);
        _ledger(abi.encodeCall(IItemLedgerCalls.onWithdrawn, (msg.sender, ids)), msg.sender, k);
        emit Withdrawn(msg.sender, ids, principal, fee, supply - fee, e + principal, c.inside);

        _pullToken(msg.sender, principal + fee);
        _burnFee(fee);
        for (uint256 i; i < k; ++i) {
            items.safeTransferFrom(address(this), msg.sender, ids[i]);
        }
    }

    /// @dev principal + fee within the caller's limit and balance (checked before anything moves).
    function _checkPayment(uint256 total, uint256 maxTokenIn) private view {
        if (total > maxTokenIn) revert MaxTokenExceeded(total, maxTokenIn);
        uint256 balance = _token().balanceOf(msg.sender);
        if (balance < total) revert InsufficientToken(balance, total);
    }

    function _return(uint256[] memory ids, uint256 minTokenOut, uint256 deadline)
        private
        returns (uint256 principal, uint256 fee)
    {
        Counts memory c = _initialised();
        if (c.gateOpenedAt == 0) revert GateClosed();
        _checkDeadline(deadline);
        uint256 k = ids.length;
        if (k == 0) revert InvalidIdList();
        _checkItemBatch(k);
        if (k > 1 && !BoxIdSet.allDistinct(ids, _SEEN_SEED)) revert InvalidIdList();
        IBoxCollection items = IBoxCollection(collection());
        for (uint256 i; i < k; ++i) {
            uint256 id = ids[i];
            // The current owner holds the return right (VLT-05); an id the vault never let out is never "outside".
            if (!isOutside(id) || items.ownerOf(id) != msg.sender) revert NotOwner(id);
            // An item that left unrevealed comes back once revealed, or once the adapter's safety net has passed.
            if (!items.isRevealed(id) && !_returnableUnrevealed(id)) revert NotRevealed(id);
        }
        uint256 e = escrowPrincipal;
        uint256 supply = _token().totalSupply();
        principal = _quoteReturn(k, c.inside, collectionSize() - c.inside, supply - e);
        fee = _fee(principal, _RETURN_FEE_BPS);
        if (principal - fee < minTokenOut) revert MinTokenNotMet(principal - fee, minTokenOut);
        if (principal > e) revert EscrowInsolvent(principal, e);
        for (uint256 i; i < k; ++i) {
            _clearOutside(ids[i]);
        }
        uint256 escrowAfter = e - principal;
        escrowPrincipal = escrowAfter;
        _move(c, true, k);
        _storeCounts(c);
        if (itemLedger() != address(0)) _itemRecord(5, ids[0], 0);
        _ledger(abi.encodeCall(IItemLedgerCalls.onReturned, (msg.sender, ids)), msg.sender, k);
        emit Returned(msg.sender, ids, principal, fee, supply - fee, escrowAfter, c.inside);

        for (uint256 i; i < k; ++i) {
            _pullItem(items, msg.sender, ids[i]);
        }
        _burnFee(fee);
        if (!_token().transfer(msg.sender, principal - fee)) revert TokenNotReceived(0, principal - fee);
    }

    function _quoteWithdraw(uint256 k, uint256 n, uint256 a) private view returns (uint256) {
        return _views.quoteWithdraw(k, n, a);
    }

    function _quoteReturn(uint256 k, uint256 n, uint256 m, uint256 a) private view returns (uint256 principal) {
        return _views.quoteReturn(k, n, m, a);
    }

    /// @dev ceil(p × bps ÷ 10,000) (ADR-0014 § G05), in 512-bit precision: p can reach 2^256 − 1.
    function _fee(uint256 principal, uint256 bps) private view returns (uint256) {
        return _views.fee(principal, bps);
    }

    /// @dev The fee withheld from a ticket release: the return fee while the gate is closed and not waived.
    function _handBackFee(Counts memory c, uint256 principal) private view returns (uint256) {
        return c.gateOpenedAt == 0 && c.flags & _HAND_BACK_FEE_WAIVED == 0 ? _fee(principal, _RETURN_FEE_BPS) : 0;
    }

    /// @dev The adapter's `returnableFrom(id)` is non-zero and reached (no adapter, a failed call, a short answer: no).
    function _returnableUnrevealed(uint256 id) private view returns (bool) {
        (address adapter, bytes4 selector, uint256 from) = (ticketAdapter(), IBoxTickets.returnableFrom.selector, 0);
        if (adapter == address(0)) return false;
        assembly ("memory-safe") {
            mstore(0, selector) // scratch space: 36 bytes of calldata, 32 of answer
            mstore(4, id)
            // The call first, then its returndatasize (BoxVault.sol:578-581).
            let ok := staticcall(gas(), adapter, 0, 36, 0, 32)
            if and(ok, gt(returndatasize(), 31)) { from := mload(0) }
        }
        return from != 0 && block.timestamp >= from;
    }

    /// @dev Burns a fee after the principal moved and the counts were written: T refuses a burn below `supplyFloor()`.
    function _burnFee(uint256 fee) private {
        if (fee != 0) _token().burn(fee);
    }

    /// @dev Pull exactly `amount` T into E's backing; a token that delivered less would underfund E.
    function _pullToken(address from, uint256 amount) private {
        IBoxToken t = _token();
        uint256 before = t.balanceOf(address(this));
        if (!t.transferFrom(from, address(this), amount)) revert TokenNotReceived(0, amount);
        uint256 received = t.balanceOf(address(this)) - before;
        if (received != amount) revert TokenNotReceived(received, amount);
    }

    /// @dev The vault starts the transfer, so its receiver callback expects this id; receipt is verified explicitly.
    function _pullItem(IBoxCollection items, address from, uint256 id) private {
        assembly ("memory-safe") {
            tstore(_RECEIPT_SLOT, add(id, 1))
        }
        items.safeTransferFrom(from, address(this), id);
        assembly ("memory-safe") {
            tstore(_RECEIPT_SLOT, 0)
        }
        if (items.ownerOf(id) != address(this)) revert ItemNotReceived(id);
    }

    function _isPendingReceipt(uint256 id) private view returns (bool) {
        uint256 pending;
        assembly ("memory-safe") {
            pending := tload(_RECEIPT_SLOT)
        }
        return pending != 0 && pending - 1 == id;
    }

    /// @dev The fail-safe item-ledger call (`IBoxVaultV2`): skipped with role 16 unset; else exactly ITEM_LEDGER_GAS,
    /// no return data, a failure reported with `ItemLedgerCallFailed`; the action happens either way.
    function _ledger(bytes memory data, address account, uint256 count) private {
        address l = itemLedger();
        if (l == address(0)) return;
        uint256 left = gasleft();
        if (left < _ITEM_LEDGER_GAS_REQUIRED) revert ItemLedgerGasTooLow(left, _ITEM_LEDGER_GAS_REQUIRED);
        bool ok;
        assembly ("memory-safe") {
            ok := call(ITEM_LEDGER_GAS, l, 0, add(data, 0x20), mload(data), 0, 0)
        }
        // casting to 'bytes4' is safe because the first four bytes of the call's data are its selector
        // forge-lint: disable-next-line(unsafe-typecast)
        if (!ok) emit ItemLedgerCallFailed(bytes4(data), account, count);
    }

    /// @dev Internal custody paths only; no added history reads/writes when role 16 is absent.
    function _itemRecord(uint8 kind, uint256 id, uint256 requestedAt) private {
        if (itemLedger() == address(0)) return;
        bytes32 key;
        if (kind <= 3) key = IBoxTicketsItemsV2(msg.sender).activeItemTicket(0);
        uint256 funding = IBoxReceiverItemsV2(IBoxCoordinator(coordinator()).receiver()).itemFundingCount();
        // The fixed adapter supplies request times within its 40-bit lifetime.
        // forge-lint: disable-next-line(unsafe-typecast)
        ItemTimes.record(_items, key, id, funding, kind, uint64(requestedAt));
    }

    function _checkItemBatch(uint256 count) private view {
        if (itemLedger() != address(0) && count > ITEM_BATCH_MAX) revert ItemBatchTooLarge(count, ITEM_BATCH_MAX);
    }

    function _checkDeadline(uint256 deadline) private view {
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
    }

    function _offset(uint256 id) private view returns (uint256 offset, bool ok) {
        uint256 first = firstId();
        unchecked {
            offset = id - first;
        }
        ok = id >= first && offset < collectionSize();
    }

    /// @dev Marks every id of a named pick outside, in list order (BoxVault.sol:648-667): revealed shelf ids only.
    function _markShelfOutside(IBoxCollection items, uint256[] memory ids) private {
        bool hidesUnmoved = ticketAdapter() != address(0);
        uint256 k = ids.length;
        for (uint256 i; i < k; ++i) {
            uint256 id = ids[i];
            (uint256 offset, bool ok) = _offset(id);
            if (!ok) revert IneligibleId(id);
            uint256 slot = offset >> 7;
            uint256 outsideBit = 1 << ((offset & 0x7f) << 1);
            uint256 word = _states[slot];
            if (word & outsideBit != 0) revert IneligibleId(id); // already outside, or listed twice in this batch
            if (hidesUnmoved && word & (outsideBit << 1) == 0) revert HiddenItem(id);
            if (!items.isRevealed(id)) revert NotRevealed(id);
            _states[slot] = word | outsideBit | (outsideBit << 1);
        }
    }

    /// @dev The two state bits of `id` (bit 0: outside; bit 1: has left before), and whether it is a collection id.
    function _bits(uint256 id) private view returns (uint256 bits, bool ok) {
        uint256 offset;
        (offset, ok) = _offset(id);
        if (ok) bits = (_states[offset >> 7] >> ((offset & 0x7f) << 1)) & 3;
    }

    /// @dev Only for ids just checked to be outside. The "has left" bit stays.
    function _clearOutside(uint256 id) private {
        (uint256 offset,) = _offset(id);
        _states[offset >> 7] &= ~(1 << ((offset & 0x7f) << 1));
    }

    function _one(uint256 id) private pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    /// @dev Decode the packed state once in runtime code; callers receive an independent memory snapshot.
    function _loadCounts() private view returns (Counts memory) {
        return _counts;
    }

    /// @dev Encode the same packed fields in one shared runtime body, without changing the storage word.
    function _storeCounts(Counts memory c) private {
        _counts = c;
    }
}
