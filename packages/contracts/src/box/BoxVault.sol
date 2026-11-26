// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TransientReentrancyGuard} from "../libraries/TransientReentrancyGuard.sol";
import {BoxCloneBase} from "./BoxCloneBase.sol";
import {VaultAction} from "./interfaces/BoxTypes.sol";
import {IBoxCollection, IERC721TokenReceiver} from "./interfaces/IBoxCollection.sol";
import {IBoxVaultObserver} from "./interfaces/IBoxItemStream.sol";
import {IBoxTickets} from "./interfaces/IBoxTickets.sol";
import {IBoxSupplyFloor, IBoxToken} from "./interfaces/IBoxToken.sol";
import {IBoxVault} from "./interfaces/IBoxVault.sol";
import {BoxCloneArgs as A} from "./libraries/BoxCloneArgs.sol";
import {BoxClones} from "./libraries/BoxClones.sol";
import {BoxIdSet} from "./libraries/BoxIdSet.sol";

/// @title BoxVault (slice S3; the implementation of every box's vault clone, F61 A1)
/// @notice A box's lock/release vault: the collection's N items and the T conversion escrow. A copy of MisfitsVault
/// (src/v2/MisfitsVault.sol:55-800 at 46a030f6) with T, the collection, N, firstId, the coordinator, the ticket adapter,
/// the observer and the fee rates as clone arguments (`BoxCloneArgs.VaultArgs`; constructor inputs at `:237-253`).
///
/// Symbols (v2 docs/03): S = T totalSupply · E = `escrowPrincipal` · A = S − E · n = `inside` · N = `collectionSize`
/// · m = N − n · h = `hiddenCount` · t = `pendingTickets` · s = n − h (the shelf).
/// - **Quotes** from the pre-action state and E, never `balanceOf(vault)` (BC-006): withdraw ⌈A·k/n⌉, return ⌊A·k/n⌋,
///   FullMath (512-bit) for every product. **Flat fees** ceil(p × bps / 10,000), burned through T under the supply
///   floor (F23 C3): draw 1%, named pick 25%, return 5% (and on a hand-back before graduation unless waived).
/// - **Tickets** only through `ticketAdapter()` (the tickets add-on): hidden = N at `initialize` only when the adapter
///   is set (SH-S0-spikes § 2.1 rule for S3). Without it no item is hidden: every id that never left is shelf, so an
///   open-art box serves named picks (of revealed items) from graduation on.
/// - **Phase gate** (F30 Q3): deliveries, named picks and returns wait for `openGate()`, which only the coordinator
///   calls, once, at graduation; tickets open and close while it is closed.
/// - **The last item stays** (F23 C2; BC-007): n ≥ 1 always. An item sent here outside a return is refused (BC-042,
///   BC-044: an item of another collection reverts `ForeignNft`).
/// - **Returns need the reveal** of an item that left unrevealed, or the adapter's `returnableFrom` (the safety net,
///   F55: RETURN_GRACE 30 days after it left).
/// - **Observer** (add-on 2): `IBoxVaultObserver.onVaultAction` at the STREAM HOOK points (`:342, 374, 607, 656`) before
///   n changes, capped at `OBSERVER_GAS` (460,000 since F90 R16H, the collection's), fail-safe (`VaultObserverFailed`).
/// - No owner, admin, pause, upgrade, mint, sweep or rescue. T leaves only as a return's or a released ticket's
///   principal (less the fee it burns), never above E; the vault approves nobody.
/// - **Only the box's coordinator initialises**, and it must be a clone of the version's coordinator implementation
///   (`coordinatorImplementation`): a stranger's clone of this code stays inert (BC-100; review of sh-core-v1).
/// @dev Invariants (VLT-08): T balance == E; E·n ≥ m·A; n ≥ 1; n + t + (outside items) == N; h ≤ n; E + n ≤ S. Checks,
/// effects, interactions under a transient lock. An uninitialised clone has n = 0 and refuses every entry point.
/// Written for Square Hole (MIT; FullMath is the pinned Uniswap v4-core library, MIT).
contract BoxVault is IBoxVault, BoxCloneBase, TransientReentrancyGuard {
    /// @dev n, h, t and the graduation time in one slot: a conversion reads and writes them together (`:68-74`).
    struct Counts {
        uint64 inside;
        uint64 hidden;
        uint64 tickets;
        uint64 gateOpenedAt;
    }

    /// @notice Basis points in 100%.
    uint256 public constant FEE_DENOMINATOR = 10_000;
    /// @notice The vault observer's gas cap: the collection's (`BoxCollection.OBSERVER_GAS`, 460,000 since F90 R16H).
    uint256 public constant OBSERVER_GAS = 460_000;
    uint256 private constant _OBSERVER_GAS_REQUIRED = OBSERVER_GAS + OBSERVER_GAS / 63 + 10_000;

    /// @inheritdoc IBoxVault
    address public immutable coordinatorImplementation;

    /// @notice E: T locked by withdrawals and tickets and not yet released. The vault's T balance is exactly E.
    uint256 public escrowPrincipal;
    Counts private _counts;
    /// @notice True once the coordinator waived the return fee on hand-backs before graduation.
    bool public handBackFeeWaived;
    /// @dev Two bits per item, 128 per word, at offset = id − firstId: bit 2·(offset mod 128) is set while the item is
    /// outside; the bit above it once it has ever left, for good. 00 never left (hidden with a ticket adapter, shelf
    /// without), 11 outside, 10 shelf (`:229-234`).
    mapping(uint256 => uint256) private _states;

    /// @dev Transient: 1 + the id the vault is pulling in a return.
    /// `uint256(keccak256("squarehole.box.vault.receipt")) - 1`.
    uint256 private constant _RECEIPT_SLOT = 0x199d5a5f3db3daa3659a7822529312c852d34677e8f1546f076eb8a34780cb5b;
    /// @dev Seed of the transient set behind a return's duplicate check.
    /// `uint256(keccak256("squarehole.box.vault.seen")) - 1`.
    uint256 private constant _SEEN_SEED = 0xe7c3f898e47e26ee554b5d45e9f96be8fc03e8beeb6e6e8b911e95fc625016a6;

    // ------------------------------------------------------------------------------------------------------------
    // Initialise

    /// @param coordinatorImplementation_ the version's BoxCoordinator implementation: only its clones may initialise.
    constructor(address coordinatorImplementation_) {
        coordinatorImplementation = coordinatorImplementation_;
    }

    /// @inheritdoc IBoxVault
    function initialize() external {
        if (msg.sender != coordinator() || !BoxClones.isCloneOf(msg.sender, coordinatorImplementation)) {
            revert NotCoordinator(msg.sender);
        }
        if (_counts.inside != 0) revert AlreadyInitialised();
        uint256 n = collectionSize();
        uint256 first = firstId();
        address c = collection();
        // N ≥ 1 and both ends of firstId … firstId + N − 1 held: the count alone would accept a shifted range
        // (MisfitsVault.sol:271-278); a nonexistent id reverts in the collection.
        uint256 held = IBoxCollection(c).balanceOf(address(this));
        if (n == 0 || held != n) revert CustodyMismatch(held, n);
        if (
            IBoxCollection(c).ownerOf(first) != address(this)
                || IBoxCollection(c).ownerOf(first + (n - 1)) != address(this)
        ) {
            revert CustodyMismatch(held, n);
        }
        address adapter = ticketAdapter();
        // casting to 'uint64' is safe because the argument is eight bytes wide
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 n64 = uint64(n);
        _counts = Counts({inside: n64, hidden: adapter == address(0) ? 0 : n64, tickets: 0, gateOpenedAt: 0});
        emit VaultInitialized(
            token(), c, n, first, msg.sender, adapter, observer(), drawFeeBps(), pickFeeBps(), returnFeeBps()
        );
    }

    // ------------------------------------------------------------------------------------------------------------
    // Phase gate (F30 Q3, F36 a)

    /// @inheritdoc IBoxVault
    function openGate() external {
        if (msg.sender != coordinator()) revert NotCoordinator(msg.sender);
        Counts memory c = _initialised();
        if (c.gateOpenedAt != 0) revert GateAlreadyOpen();
        // casting to 'uint64' is safe because a block timestamp fits 64 bits for billions of years
        // forge-lint: disable-next-line(unsafe-typecast)
        c.gateOpenedAt = uint64(block.timestamp);
        _counts = c;
        emit GateOpened(msg.sender, block.timestamp);
    }

    /// @inheritdoc IBoxVault
    function waiveHandBackFee() external {
        if (msg.sender != coordinator()) revert NotCoordinator(msg.sender);
        if (_initialised().gateOpenedAt != 0) revert GateAlreadyOpen();
        if (handBackFeeWaived) revert HandBackFeeAlreadyWaived();
        handBackFeeWaived = true;
        emit HandBackFeeWaived(msg.sender, block.timestamp);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Tickets (the adapter only; MisfitsVault.sol:323-408)

    /// @inheritdoc IBoxVault
    function openTickets(uint256 count, uint256 maxTokenIn)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        address adapter = ticketAdapter();
        if (msg.sender != adapter) revert NotAdapter(msg.sender); // no adapter: nobody
        Counts memory c = _initialised();
        uint256 e = escrowPrincipal;
        uint256 supply = _token().totalSupply();
        principal = _quoteWithdraw(count, c.inside, supply - e);
        if (count > c.hidden) revert NoHiddenItem(count, c.hidden);
        fee = _fee(principal, drawFeeBps());
        _checkPayment(principal + fee, maxTokenIn);
        _notify(VaultAction.TicketsOpened, adapter, count, c.inside); // STREAM HOOK (`:342`)
        escrowPrincipal = e + principal; // ≤ S: principal ≤ A
        // casting to 'uint64' is safe because count ≤ h ≤ n < 2^64 and t + count ≤ N < 2^64
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 k = uint64(count);
        (c.inside, c.hidden, c.tickets) = (c.inside - k, c.hidden - k, c.tickets + k);
        _counts = c;
        emit TicketsOpened(count, principal, fee, supply - fee, e + principal, c.inside, c.hidden, c.tickets);

        _pullToken(msg.sender, principal + fee);
        _burnFee(fee);
    }

    /// @inheritdoc IBoxVault
    function releaseTickets(uint256 count, address to, uint256 minTokenOut)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        if (msg.sender != ticketAdapter()) revert NotAdapter(msg.sender);
        if (to == address(0)) revert ZeroAddress();
        Counts memory c = _initialised();
        if (count == 0 || count > c.tickets) revert InvalidQuantity(count, c.tickets);
        uint256 e = escrowPrincipal;
        uint256 supply = _token().totalSupply();
        principal = _quoteReturn(count, c.inside, collectionSize() - c.inside, supply - e);
        fee = _handBackFee(c, principal);
        if (principal - fee < minTokenOut) revert MinTokenNotMet(principal - fee, minTokenOut);
        if (principal > e) revert EscrowInsolvent(principal, e);
        _notify(VaultAction.TicketsReleased, to, count, c.inside); // STREAM HOOK (`:374`)
        uint256 escrowAfter = e - principal;
        escrowPrincipal = escrowAfter;
        // casting to 'uint64' is safe because count ≤ t and n + t ≤ N < 2^64
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 k = uint64(count);
        (c.inside, c.hidden, c.tickets) = (c.inside + k, c.hidden + k, c.tickets - k);
        _counts = c;
        emit TicketsReleased(to, count, principal, fee, supply - fee, escrowAfter, c.inside, c.hidden, c.tickets);

        _burnFee(fee);
        if (!_token().transfer(to, principal - fee)) revert TokenNotReceived(0, principal - fee);
    }

    /// @inheritdoc IBoxVault
    function deliverTicket(uint256 id, address to) external nonReentrant {
        if (msg.sender != ticketAdapter()) revert NotAdapter(msg.sender);
        Counts memory c = _initialised();
        if (c.gateOpenedAt == 0) revert GateClosed();
        if (c.tickets == 0) revert NoPendingTicket();
        if (to == address(0)) revert ZeroAddress();
        (uint256 offset, bool ok) = _offset(id);
        if (!ok) revert IneligibleId(id);
        uint256 slot = offset >> 7;
        uint256 shift = (offset & 0x7f) << 1;
        uint256 word = _states[slot];
        if ((word >> shift) & 3 != 0) revert NotHidden(id);
        _states[slot] = word | (3 << shift);
        --c.tickets;
        _counts = c;
        emit TicketDelivered(id, to, c.tickets);

        IBoxCollection(collection()).safeTransferFrom(address(this), to, id);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Named picks and returns

    /// @inheritdoc IBoxVault
    function withdraw(uint256 id, uint256 maxTokenIn, uint256 deadline)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        return _withdraw(_one(id), maxTokenIn, deadline);
    }

    /// @inheritdoc IBoxVault
    function withdrawBatch(uint256[] calldata ids, uint256 maxTokenIn, uint256 deadline)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        return _withdraw(ids, maxTokenIn, deadline);
    }

    /// @inheritdoc IBoxVault
    function returnItem(uint256 id, uint256 minTokenOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        return _return(_one(id), minTokenOut, deadline);
    }

    /// @inheritdoc IBoxVault
    function returnItems(uint256[] calldata ids, uint256 minTokenOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 principal, uint256 fee)
    {
        return _return(ids, minTokenOut, deadline);
    }

    /// @notice Accepts an item only while this vault pulls it in a return it started; anything else is refused
    /// (`:450-464`): another collection's NFT `ForeignNft` (BC-044), an unsolicited item `UnsolicitedItem` (BC-042).
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
    // Views (MisfitsVault.sol:470-589)

    /// @inheritdoc IBoxSupplyFloor
    function supplyFloor() external view returns (uint256) {
        return escrowPrincipal + _counts.inside; // E + n ≤ S because A ≥ n (0 before initialize)
    }

    /// @inheritdoc IBoxVault
    function inside() public view returns (uint256) {
        return _counts.inside;
    }

    /// @inheritdoc IBoxVault
    function hiddenCount() external view returns (uint256) {
        return _counts.hidden;
    }

    /// @inheritdoc IBoxVault
    function pendingTickets() external view returns (uint256) {
        return _counts.tickets;
    }

    /// @inheritdoc IBoxVault
    function shelfCount() external view returns (uint256) {
        Counts memory c = _counts;
        return c.inside - c.hidden;
    }

    /// @inheritdoc IBoxVault
    function outside() external view returns (uint256) {
        return collectionSize() - _counts.inside;
    }

    /// @inheritdoc IBoxVault
    function gateOpen() external view returns (bool) {
        return _counts.gateOpenedAt != 0;
    }

    /// @inheritdoc IBoxVault
    function gateOpenedAt() external view returns (uint256) {
        return _counts.gateOpenedAt;
    }

    /// @inheritdoc IBoxVault
    function activeSupply() public view returns (uint256) {
        return _token().totalSupply() - escrowPrincipal;
    }

    /// @inheritdoc IBoxVault
    function unsolicitedToken() external view returns (uint256) {
        return _token().balanceOf(address(this)) - escrowPrincipal;
    }

    /// @inheritdoc IBoxVault
    function quoteWithdraw(uint256 count) external view returns (uint256) {
        return _quoteWithdraw(count, _counts.inside, activeSupply());
    }

    /// @inheritdoc IBoxVault
    function quoteReturn(uint256 count) external view returns (uint256) {
        uint256 n = _counts.inside;
        return _quoteReturn(count, n, collectionSize() - n, activeSupply());
    }

    /// @inheritdoc IBoxVault
    function quoteTake(uint256 count) external view returns (uint256 principal, uint256 fee) {
        Counts memory c = _counts;
        principal = _quoteWithdraw(count, c.inside, activeSupply());
        if (count > c.hidden) revert NoHiddenItem(count, c.hidden);
        fee = _fee(principal, drawFeeBps());
    }

    /// @inheritdoc IBoxVault
    function quoteHandBack(uint256 count) external view returns (uint256 principal, uint256 fee) {
        Counts memory c = _counts;
        if (count == 0 || count > c.tickets) revert InvalidQuantity(count, c.tickets);
        principal = _quoteReturn(count, c.inside, collectionSize() - c.inside, activeSupply());
        fee = _handBackFee(c, principal);
    }

    /// @inheritdoc IBoxVault
    function escrowSurplus() external view returns (uint256 kFloor, uint256 kRemainder) {
        uint256 n = _counts.inside;
        uint256 m = collectionSize() - n;
        uint256 a = activeSupply();
        // E·n ≥ m·A, so E ≥ ⌈m·A/n⌉ and nothing below underflows.
        kFloor = escrowPrincipal - FullMath.mulDivRoundingUp(m, a, n);
        uint256 r0 = mulmod(m, a, n);
        kRemainder = r0 == 0 ? 0 : n - r0;
    }

    /// @inheritdoc IBoxVault
    function isOutside(uint256 id) public view returns (bool) {
        (uint256 bits, bool ok) = _bits(id);
        return ok && bits & 1 != 0;
    }

    /// @inheritdoc IBoxVault
    function isInside(uint256 id) external view returns (bool) {
        (uint256 bits, bool ok) = _bits(id);
        return ok && bits & 1 == 0;
    }

    /// @inheritdoc IBoxVault
    function hasLeftVault(uint256 id) external view returns (bool) {
        (uint256 bits, bool ok) = _bits(id);
        return ok && bits & 2 != 0;
    }

    /// @inheritdoc IBoxVault
    function isHidden(uint256 id) external view returns (bool) {
        (uint256 bits, bool ok) = _bits(id);
        return ok && bits == 0 && ticketAdapter() != address(0);
    }

    /// @inheritdoc IBoxVault
    function isOnShelf(uint256 id) external view returns (bool) {
        (uint256 bits, bool ok) = _bits(id);
        return ok && (bits == 2 || (bits == 0 && ticketAdapter() == address(0)));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Wiring (clone arguments)

    /// @inheritdoc IBoxVault
    function token() public view returns (address) {
        return _argAddress(A.V_TOKEN);
    }

    /// @inheritdoc IBoxVault
    function collection() public view returns (address) {
        return _argAddress(A.V_COLLECTION);
    }

    /// @inheritdoc IBoxVault
    function coordinator() public view returns (address) {
        return _argAddress(A.V_COORDINATOR);
    }

    /// @inheritdoc IBoxVault
    function ticketAdapter() public view returns (address) {
        return _argAddress(A.V_TICKET_ADAPTER);
    }

    /// @inheritdoc IBoxVault
    function observer() public view returns (address) {
        return _argAddress(A.V_OBSERVER);
    }

    /// @inheritdoc IBoxVault
    function observerGas() external pure returns (uint256) {
        return OBSERVER_GAS;
    }

    /// @inheritdoc IBoxVault
    function collectionSize() public view returns (uint256) {
        return _argUint(A.V_COLLECTION_SIZE, 8);
    }

    /// @inheritdoc IBoxVault
    function firstId() public view returns (uint256) {
        return uint256(_argWord(A.V_FIRST_ID));
    }

    /// @inheritdoc IBoxVault
    function drawFeeBps() public view returns (uint256) {
        return _argUint(A.V_DRAW_FEE_BPS, 2);
    }

    /// @inheritdoc IBoxVault
    function pickFeeBps() public view returns (uint256) {
        return _argUint(A.V_PICK_FEE_BPS, 2);
    }

    /// @inheritdoc IBoxVault
    function returnFeeBps() public view returns (uint256) {
        return _argUint(A.V_RETURN_FEE_BPS, 2);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internals (MisfitsVault.sol:594-799)

    function _token() private view returns (IBoxToken) {
        return IBoxToken(token());
    }

    /// @dev The counts of an initialised vault (n ≥ 1 from `initialize` on); an uninitialised clone reverts.
    function _initialised() private view returns (Counts memory c) {
        c = _counts;
        if (c.inside == 0) revert NotInitialised();
    }

    function _withdraw(uint256[] memory ids, uint256 maxTokenIn, uint256 deadline)
        private
        returns (uint256 principal, uint256 fee)
    {
        Counts memory c = _initialised();
        if (c.gateOpenedAt == 0) revert GateClosed();
        _checkDeadline(deadline);
        uint256 e = escrowPrincipal;
        uint256 supply = _token().totalSupply();
        principal = _quoteWithdraw(ids.length, c.inside, supply - e);
        fee = _fee(principal, pickFeeBps());
        _checkPayment(principal + fee, maxTokenIn);
        IBoxCollection items = IBoxCollection(collection());
        _markShelfOutside(items, ids);
        _notify(VaultAction.Withdrawn, msg.sender, ids.length, c.inside); // STREAM HOOK (`:607`)
        escrowPrincipal = e + principal; // ≤ S: principal ≤ A
        // casting to 'uint64' is safe because k < n < 2^64
        // forge-lint: disable-next-line(unsafe-typecast)
        c.inside -= uint64(ids.length);
        _counts = c;
        emit Withdrawn(msg.sender, ids, principal, fee, supply - fee, e + principal, c.inside);

        _pullToken(msg.sender, principal + fee);
        _burnFee(fee);
        for (uint256 i; i < ids.length; ++i) {
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
        uint256 n = collectionSize();
        principal = _quoteReturn(k, c.inside, n - c.inside, supply - e);
        fee = _fee(principal, returnFeeBps());
        if (principal - fee < minTokenOut) revert MinTokenNotMet(principal - fee, minTokenOut);
        if (principal > e) revert EscrowInsolvent(principal, e);
        for (uint256 i; i < k; ++i) {
            _clearOutside(ids[i]);
        }
        _notify(VaultAction.Returned, msg.sender, k, c.inside); // STREAM HOOK (`:656`)
        uint256 escrowAfter = e - principal;
        escrowPrincipal = escrowAfter;
        // casting to 'uint64' is safe because n + k ≤ N < 2^64 (every returned id was outside)
        // forge-lint: disable-next-line(unsafe-typecast)
        c.inside += uint64(k);
        _counts = c;
        emit Returned(msg.sender, ids, principal, fee, supply - fee, escrowAfter, c.inside);

        for (uint256 i; i < k; ++i) {
            _pullItem(items, msg.sender, ids[i]);
        }
        _burnFee(fee);
        if (!_token().transfer(msg.sender, principal - fee)) revert TokenNotReceived(0, principal - fee);
    }

    function _quoteWithdraw(uint256 k, uint256 n, uint256 a) private pure returns (uint256) {
        if (k == 0 || k > n) revert InvalidQuantity(k, n);
        if (k == n) revert LastItem();
        return FullMath.mulDivRoundingUp(a, k, n);
    }

    function _quoteReturn(uint256 k, uint256 n, uint256 m, uint256 a) private pure returns (uint256 principal) {
        if (k == 0 || k > m) revert InvalidQuantity(k, m);
        principal = FullMath.mulDiv(a, k, n);
        if (principal < k) revert ReturnBelowUnit(principal, k);
    }

    /// @dev ceil(p × bps ÷ 10,000) (ADR-0014 § G05), in 512-bit precision: p can reach 2^256 − 1.
    function _fee(uint256 principal, uint256 bps) private pure returns (uint256) {
        return bps == 0 ? 0 : FullMath.mulDivRoundingUp(principal, bps, FEE_DENOMINATOR);
    }

    /// @dev The fee withheld from a ticket release: the return fee while the gate is closed and not waived.
    function _handBackFee(Counts memory c, uint256 principal) private view returns (uint256) {
        return c.gateOpenedAt == 0 && !handBackFeeWaived ? _fee(principal, returnFeeBps()) : 0;
    }

    /// @dev The adapter's `returnableFrom(id)` is non-zero and reached (no adapter, a failed call, a short answer: no).
    function _returnableUnrevealed(uint256 id) private view returns (bool) {
        (address adapter, bytes4 selector, uint256 from) = (ticketAdapter(), IBoxTickets.returnableFrom.selector, 0);
        if (adapter == address(0)) return false;
        assembly ("memory-safe") {
            mstore(0, selector) // scratch space: 36 bytes of calldata, 32 of answer
            mstore(4, id)
            // The call first, then its returndatasize: Yul evaluates arguments right to left, so MisfitsVault.sol:704's
            // `and(staticcall(…), gt(returndatasize(), 31))` reads the size of the call before it (S3 finding).
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
        // `id` is an outside collection id, so id + 1 cannot overflow for any N the factory builds.
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

    /// @dev The fail-safe vault observer call (BoxCollection._observe's twin): at most OBSERVER_GAS, no return data,
    /// a failure reported with `VaultObserverFailed`; the action happens either way.
    function _notify(VaultAction action, address account, uint256 count, uint256 insideBefore) private {
        address o = observer();
        if (o == address(0)) return;
        uint256 left = gasleft();
        if (left < _OBSERVER_GAS_REQUIRED) revert ObserverGasTooLow(left, _OBSERVER_GAS_REQUIRED);
        bytes memory data = abi.encodeCall(IBoxVaultObserver.onVaultAction, (action, account, count, insideBefore));
        bool ok;
        assembly ("memory-safe") {
            ok := call(OBSERVER_GAS, o, 0, add(data, 0x20), mload(data), 0, 0)
        }
        if (!ok) emit VaultObserverFailed(action, account, count);
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

    /// @dev Marks every id of a named pick outside, in list order: revealed shelf ids only (Fable R-09, R-14). Foreign,
    /// outside or listed twice: `IneligibleId`; hidden (never left, with a ticket adapter): `HiddenItem`; unrevealed:
    /// `NotRevealed`. Without a ticket adapter an id that never left is shelf.
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
            // Sets "outside" and "has left" (the latter already set for a returned item).
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
}
